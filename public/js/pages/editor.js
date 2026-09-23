/**
 * editor.js — 剪辑台
 * 把本集已经生成好的片段按分镜顺序攒成一条时间线：排序、剔除、设入出点、加转场，
 * 然后交给 OpenReel Desktop 继续精剪。
 * 集成采用 Bridge Manifest：Agnes 输出稳定的媒体、时间线和转场数据，Desktop 端建立自己的媒体句柄。
 */
import { icon, esc } from '../consts.js';
import { api } from '../api.js';
import { modal, toast, empty, spinner, confirm } from '../ui.js';
import { head, projectPicker, episodeOptions } from './helpers.js';
import { state, onEvent, resolveProjectId, setActiveProject } from '../app.js';
import { nextEpisodeWorkflowState } from '../workflow-state.js';

const TRANSITIONS = [
  { value: 'none', label: '无' },
  { value: 'crossfade', label: '交叉淡化' },
  { value: 'fade', label: '淡入淡出' },
  { value: 'wipe', label: '擦除' },
  { value: 'slide', label: '滑动' },
];

export default async function editor(container, params) {
  let projectId = resolveProjectId(params.project || '');
  let episode = Number(params.episode || 1);
  let clips = [];
  let transitions = [];
  let planId = '';
  let planName = '';
  let dirty = false;

  container.innerHTML = `
    ${head({
      title: '剪辑台',
      desc: 'AI 出片在 Agnes 完成，需要精剪时直接打开 OpenReel',
      actions: `
        ${projectPicker(state.projects, projectId, { id: 'p-picker' })}
        <select class="select select-sm" id="ep" style="width:96px"></select>
        <button class="btn btn-sm" id="assemble">${icon('refresh', 13)}按分镜汇总</button>
        <button class="btn btn-sm" id="save">${icon('save', 13)}保存方案</button>
        <button class="btn btn-sm" id="export">${icon('download', 13)}导出交接清单</button>
        <button class="btn btn-primary btn-sm" id="openreel">${icon('arrowRight', 13)}打开 OpenReel</button>`,
    })}
    <div id="bar" style="margin-bottom:14px"></div>
    <div class="card" id="timeline">${spinner()}</div>
    <div id="plans"></div>`;

  const epSel = container.querySelector('#ep');
  epSel.innerHTML = episodeOptions(episode);

  container.querySelector('#p-picker').onchange = (e) => { projectId = e.target.value; setActiveProject(projectId); planId = ''; load(); };
  epSel.onchange = () => { episode = Number(epSel.value); planId = ''; load(); };
  container.querySelector('#assemble').onclick = assemble;
  container.querySelector('#save').onclick = save;
  // 必须包一层：直接把 doExport 挂上去的话，点击事件对象会当成 srtMode 传进去
  container.querySelector('#export').onclick = () => doExport();
  container.querySelector('#openreel').onclick = openInOpenReel;

  // 异步媒体可能在用户停留剪辑台期间完成。仅自动刷新尚未保存、也未手工调整的自动时间线；
  // 已保存方案可能包含人工排序/裁切，不能因为后台媒体事件把它静默覆盖。
  let refreshTimer = null;
  const scheduleLiveRefresh = () => {
    if (dirty || planId || !projectId) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      const r = await api.assembleEditPlan(projectId, episode);
      if (!r.ok || dirty) return;
      clips = r.data.clips || [];
      transitions = [];
      render();
    }, 250);
  };
  const offVideo = onEvent('video', (v) => {
    if (!v || v.project_id !== projectId || v.status !== 'completed') return;
    scheduleLiveRefresh();
  });
  const offStoryboard = onEvent('storyboard', (sb) => {
    if (!sb || sb.project_id !== projectId || Number(sb.episode_number || 0) !== episode) return;
    scheduleLiveRefresh();
  });

  async function load() {
    const el = container.querySelector('#timeline');
    if (!projectId) {
      el.innerHTML = empty('先选一个项目', '右上角下拉选一个项目', 'folder');
      return;
    }
    el.innerHTML = spinner();
    const r = await api.editPlans(projectId, episode);
    if (!r.ok) { el.innerHTML = empty('读取失败', r.error, 'alert'); return; }
    const existing = planId
      ? (r.data || []).find((p) => p.id === planId) || (r.data || [])[0]
      : (r.data || [])[0];
    if (existing) {
      planId = existing.id;
      planName = existing.name;
      // 保存方案保留人工排序/裁切；媒体本身则以当前分镜的有效版本为准。
      // 这样旧视频/旧配音失效并重新生成后，重新打开剪辑台不会继续显示旧素材。
      const assembled = await api.assembleEditPlan(projectId, episode);
      const currentByStoryboard = new Map((assembled.ok ? assembled.data.clips || [] : []).filter((c) => c.storyboard_id).map((c) => [c.storyboard_id, c]));
      const savedIds = new Set((existing.clips || []).map((c) => c.storyboard_id).filter(Boolean));
      clips = (existing.clips || []).flatMap((saved) => {
        if (!saved.storyboard_id) return [saved];
        const current = currentByStoryboard.get(saved.storyboard_id);
        if (!current) return []; // 分镜已删除：不能继续作为幽灵镜头留在旧方案
        const duration = Number(current.duration || saved.duration || 5);
        const trimIn = Math.min(Math.max(0, Number(saved.trim_in || 0)), Math.max(0, duration - 0.1));
        const trimOut = Math.max(trimIn + 0.1, Math.min(Number(saved.trim_out ?? duration), duration));
        return [{ ...saved, ...current, enabled: saved.enabled !== false, trim_in: trimIn, trim_out: trimOut }];
      });
      // 新增分镜追加到旧人工时间线末尾，不打乱用户已经调整好的镜头顺序。
      clips.push(...(assembled.ok ? assembled.data.clips || [] : []).filter((c) => c.storyboard_id && !savedIds.has(c.storyboard_id)));
      transitions = existing.transitions || [];
      dirty = false;
    } else {
      planId = '';
      planName = `第 ${episode} 集剪辑方案`;
      transitions = [];
      const assembled = await api.assembleEditPlan(projectId, episode);
      clips = assembled.ok ? (assembled.data.clips || []) : [];
      dirty = false;
    }
    render();
    renderPlans(r.data || []);
  }

  async function assemble() {
    if (!projectId) { toast.err('先选一个项目'); return; }
    const r = await api.assembleEditPlan(projectId, episode);
    if (!r.ok) { toast.err(r.error); return; }
    clips = r.data.clips;
    transitions = [];
    dirty = true;
    render();
    const s = r.data.stats;
    if (s.missing > 0 || s.audio_missing > 0) {
      const parts = [];
      if (s.missing > 0) parts.push(`${s.missing} 个缺视频`);
      if (s.audio_missing > 0) parts.push(`${s.audio_missing} 个有台词/旁白但缺音频`);
      toast.warn(`${s.total} 个镜头：${parts.join('，')}，已在时间线标记`, 8000);
    } else {
      toast.ok(`已汇总 ${s.ready} 个片段，音视频素材完整`);
    }
  }

  function totalDuration() {
    return clips
      .filter((c) => c.enabled !== false && !c.missing)
      .reduce((sum, c) => sum + Math.max(0.1, (c.trim_out ?? c.duration) - (c.trim_in ?? 0)), 0);
  }

  function render() {
    const el = container.querySelector('#timeline');
    if (!clips.length) {
      el.innerHTML = empty('还没有片段', '点「按分镜汇总」，自动把本集已生成的视频按镜头号排好', 'film');
      return;
    }
    const total = totalDuration();
    el.innerHTML = `
      <div class="row" style="margin-bottom:12px">
        <div class="card-title" style="margin:0">${icon('film', 15)}时间线</div>
        <div class="spacer"></div>
        <span style="font-size:12px;color:var(--text-3)">
          共 ${clips.length} 段 · 启用 ${clips.filter((c) => c.enabled !== false && !c.missing).length} 段 ·
          总时长 <b style="color:var(--gold)">${total.toFixed(1)}s</b>
          ${dirty ? ' · <span style="color:var(--warn)">未保存</span>' : ''}
        </span>
      </div>
      <div id="clips">
        ${clips.map((c, i) => {
          const off = c.enabled === false || c.missing;
          const dur = Math.max(0.1, (c.trim_out ?? c.duration) - (c.trim_in ?? 0));
          return `
          <div class="row" style="gap:10px;padding:10px;border-radius:10px;margin-bottom:8px;
               background:${off ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.04)'};opacity:${off ? 0.55 : 1}">
            <span style="font-family:var(--mono);color:var(--text-3);width:34px">#${esc(c.shot_number)}</span>
            <div style="flex:1;min-width:0">
              <div style="font-size:13px">${esc(c.name || '未命名镜头')}</div>
              <div style="font-size:11px;margin-top:2px;color:${c.audio_missing ? 'var(--warn)' : ((c.dialogue_audio || c.narration_audio || c.audio_id) ? 'var(--ok)' : 'var(--text-4)')}">${c.audio_missing ? '音频不完整' : ((c.dialogue_audio || c.narration_audio || c.audio_id) ? `${c.dialogue_audio ? '台词音频' : ''}${c.dialogue_audio && c.narration_audio ? ' + ' : ''}${c.narration_audio ? '旁白音频' : ''}${!c.dialogue_audio && !c.narration_audio ? '配音已关联' : ''}` : '无台词/旁白')}</div>
              <div style="font-size:11px;color:var(--text-4);margin-top:2px">
                ${c.missing ? '<span style="color:var(--warn)">还没生成视频</span>'
                  : `入 ${c.trim_in}s → 出 ${c.trim_out}s（${dur.toFixed(1)}s / 全 ${Number(c.duration).toFixed(1)}s）`}
                ${c.duration_mismatch
                  ? `<span style="color:var(--warn);margin-left:6px">· 实际时长与分镜填的 ${Number(c.planned_duration).toFixed(1)}s 不一致</span>`
                  : ''}
              </div>
            </div>
            <input class="input input-sm" type="number" step="0.1" min="0" style="width:74px"
                   data-in="${i}" value="${esc(c.trim_in ?? 0)}" title="入点（秒）" ${off ? 'disabled' : ''} />
            <input class="input input-sm" type="number" step="0.1" min="0" style="width:74px"
                   data-out="${i}" value="${esc(c.trim_out ?? c.duration)}" title="出点（秒）" ${off ? 'disabled' : ''} />
            <select class="select select-xs" data-tr="${i}" style="width:104px">
              ${TRANSITIONS.map((t) => `<option value="${t.value}"${transOf(i) === t.value ? ' selected' : ''}>${t.label}</option>`).join('')}
            </select>
            <button class="icon-btn" data-up="${i}" title="上移" style="background:rgba(255,255,255,0.07);color:var(--text-2)">${icon('chevronUp', 13)}</button>
            <button class="icon-btn" data-down="${i}" title="下移" style="background:rgba(255,255,255,0.07);color:var(--text-2)">${icon('chevronDown', 13)}</button>
            <button class="icon-btn ${off ? '' : 'danger'}" data-tog="${i}" title="${off ? '启用' : '停用'}"
                    style="background:rgba(255,255,255,0.07);color:var(--text-2)">${off ? icon('plus', 13) : icon('trash', 13)}</button>
          </div>`;
        }).join('')}
      </div>`;

    el.querySelectorAll('[data-in]').forEach((x) => {
      x.onchange = () => {
        const i = Number(x.getAttribute('data-in'));
        const v = Number(x.value);
        if (Number.isNaN(v) || v < 0 || v >= (clips[i].trim_out ?? clips[i].duration)) {
          toast.err('入点必须在 0 到出点之间'); x.value = clips[i].trim_in; return;
        }
        clips[i].trim_in = v; dirty = true; render();
      };
    });
    el.querySelectorAll('[data-out]').forEach((x) => {
      x.onchange = () => {
        const i = Number(x.getAttribute('data-out'));
        const v = Number(x.value);
        if (Number.isNaN(v) || v <= (clips[i].trim_in ?? 0) || v > clips[i].duration) {
          toast.err(`出点要在入点之后，且不超过整段 ${clips[i].duration}s`); x.value = clips[i].trim_out; return;
        }
        clips[i].trim_out = v; dirty = true; render();
      };
    });
    el.querySelectorAll('[data-tr]').forEach((x) => {
      x.onchange = () => {
        const i = Number(x.getAttribute('data-tr'));
        setTrans(i, x.value); dirty = true; render();
      };
    });
    el.querySelectorAll('[data-up]').forEach((x) => {
      x.onclick = () => move(Number(x.getAttribute('data-up')), -1);
    });
    el.querySelectorAll('[data-down]').forEach((x) => {
      x.onclick = () => move(Number(x.getAttribute('data-down')), 1);
    });
    el.querySelectorAll('[data-tog]').forEach((x) => {
      x.onclick = () => {
        const i = Number(x.getAttribute('data-tog'));
        clips[i].enabled = clips[i].enabled === false || clips[i].missing;
        dirty = true; render();
      };
    });
  }

  function transOf(i) {
    const t = transitions.find((x) => x.after_clip_index === i);
    return t ? t.type : 'none';
  }

  function setTrans(i, type) {
    transitions = transitions.filter((x) => x.after_clip_index !== i);
    if (type && type !== 'none') transitions.push({ after_clip_index: i, type, duration: 0.5 });
  }

  function move(i, delta) {
    const j = i + delta;
    if (j < 0 || j >= clips.length) return;
    const tmp = clips[i]; clips[i] = clips[j]; clips[j] = tmp;
    // 转场是「挂在第 i 段之后」的，跟着片段一起挪
    transitions = transitions.map((t) => {
      if (t.after_clip_index === i) return { ...t, after_clip_index: j };
      if (t.after_clip_index === j) return { ...t, after_clip_index: i };
      return t;
    });
    clips.forEach((c, k) => { c.shot_number = k + 1; });
    dirty = true;
    render();
  }

  function renderPlans(list) {
    const el = container.querySelector('#plans');
    if (!list.length) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <div class="card" style="margin-top:14px">
        <div class="card-title">${icon('layers', 15)}本集已保存的方案</div>
        ${list.map((p) => `
          <div class="row" style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
            <span style="flex:1">${esc(p.name)}</span>
            <span style="font-size:11px;color:var(--text-4)">${(p.clips || []).length} 段</span>
            <button class="btn btn-xs" data-load="${esc(p.id)}">载入</button>
            <button class="btn btn-xs danger" data-del="${esc(p.id)}">删除</button>
          </div>`).join('')}
      </div>`;
    el.querySelectorAll('[data-load]').forEach((b) => {
      b.onclick = () => { planId = b.getAttribute('data-load'); load(); };
    });
    el.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        if (!(await confirm({ text: '删除这个剪辑方案？', danger: true, okText: '删除' }))) return;
        const r = await api.deleteEditPlan(b.getAttribute('data-del'));
        if (!r.ok) { toast.err(r.error); return; }
        toast.ok('已删除');
        planId = '';
        load();
      };
    });
  }

  async function nextEpisodeTarget() {
    const [storyboards, scripts, images, videos, audios, plans] = await Promise.all([
      api.storyboards(projectId), api.scripts(projectId), api.images(projectId), api.videos(projectId), api.audioAssets(projectId), api.editPlans(projectId, null),
    ]);
    if (!storyboards.ok) return null;
    const next = nextEpisodeWorkflowState({
      projectId,
      scripts: scripts.ok ? scripts.data || [] : [],
      storyboards: storyboards.data || [],
      images: images.ok ? images.data || [] : [],
      videos: videos.ok ? videos.data || [] : [],
      audios: audios.ok ? audios.data || [] : [],
      plans: plans.ok ? plans.data || [] : [],
    }, episode);
    if (!next) return null;
    return { ...next.next, label: `第 ${next.episode} 集${next.next.label}` };
  }

  async function save() {
    if (!projectId) { toast.err('先选一个项目'); return; }
    if (!clips.length) { toast.err('还没有片段，先「按分镜汇总」'); return; }
    const payload = {
      project_id: projectId,
      episode_number: episode,
      name: planName,
      clips,
      transitions,
    };
    const r = planId ? await api.updateEditPlan(planId, payload) : await api.createEditPlan(payload);
    if (!r.ok) { toast.err(r.error || '保存失败'); return; }
    planId = r.data.id;
    dirty = false;
    const next = await nextEpisodeTarget();
    toast.ok('方案已保存');
    render();
    await load();
    if (next) {
      const actions = container.querySelector('.page-head .actions') || container.querySelector('.page-head');
      if (actions && !container.querySelector('#next-episode-flow')) {
        const b = document.createElement('button');
        b.className = 'btn btn-primary'; b.id = 'next-episode-flow'; b.textContent = '继续：' + next.label;
        b.onclick = () => { location.hash = '#/' + next.page + '?' + new URLSearchParams(next.params).toString(); };
        actions.appendChild(b);
      }
    }
  }

  function openInOpenReel() {
    // 和动画大丸家 3.0 一样保持轻量：本站负责 AI 生产与粗编排，OpenReel 作为独立剪辑器直接打开。
    // 不再要求 Desktop Bridge、协议注册或 OpenReel 源码改造。
    window.open('https://openreel.video/', '_blank', 'noopener,noreferrer');
  }

  async function doExport(srtMode) {
    if (!planId) { toast.err('先保存方案再导出'); return; }
    const mode = srtMode || 'both';
    const r = await api.exportEditPlan(planId, mode);
    if (!r.ok) { toast.err(r.error); return; }
    const d = r.data;
    const body = `
      <div class="note" style="margin-bottom:12px">
        ${icon('check', 14)} <b>${esc(d.plan.name)}</b>：${d.clips.length} 段，总时长 <b>${d.total_duration}s</b>
      </div>
      <div class="section-label">交接方式</div>
      <div style="font-size:12px;color:var(--text-3);line-height:1.7">
        1. 把下面这些文件放到<b>同一个文件夹</b>里；<br>
        2. 打开 OpenReel，一次性导入这个文件夹；<br>
        3. 按「顺序」一栏拖成这个排列，转场按清单设置。
      </div>
      <div class="note" style="margin-top:12px">视频轨 ${d.material_stats?.video || 0} 段 · 台词音频 ${d.material_stats?.dialogue_audio || 0} 段 · 旁白音频 ${d.material_stats?.narration_audio || 0} 段${d.material_stats?.missing ? ` · ${d.material_stats.missing} 项素材缺失` : ' · 素材完整'}</div>
      ${d.missing_materials?.length ? `<div class="section-label" style="margin-top:12px">缺失素材</div><div class="note red">${d.missing_materials.map((x) => `镜头 ${x.shot_number}：${esc(x.message)}`).join('<br>')}</div>` : ''}
      <div class="section-label" style="margin-top:12px">视频轨</div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>#</th><th>镜头</th><th>入</th><th>出</th><th>时长</th><th>起点</th></tr></thead>
        <tbody>${d.clips.map((c) => `
          <tr><td>${c.index + 1}</td><td>${esc(c.name)}</td>
              <td>${c.trim_in}s</td><td>${c.trim_out}s</td>
              <td>${c.duration}s</td><td>${c.start}s</td></tr>`).join('')}
        </tbody></table></div>
      ${(d.tracks?.dialogue_audio?.length || d.tracks?.narration_audio?.length) ? `<div class="section-label" style="margin-top:12px">音频轨</div><div style="font-size:12px;color:var(--text-3);line-height:1.8">${[...(d.tracks.dialogue_audio || []).map((a) => ({ ...a, label: '台词' })), ...(d.tracks.narration_audio || []).map((a) => ({ ...a, label: '旁白' }))].sort((a, b) => a.shot_number - b.shot_number).map((a) => `镜头 ${a.shot_number} · ${a.label} · ${a.start}s · ${esc(a.source)}`).join('<br>')}</div>` : ''}
      ${d.transitions.length ? `
        <div class="section-label" style="margin-top:12px">转场</div>
        <div style="font-size:12px;color:var(--text-3)">
          ${d.transitions.map((t) => `第 ${t.after_clip_index + 1} 段后：${esc(t.type)} ${t.duration}s`).join('<br>')}
        </div>` : ''}
      <div class="section-label" style="margin-top:12px">ffmpeg concat 清单</div>
      <textarea class="textarea mono" rows="3" readonly>${esc(d.ffmpeg_concat)}</textarea>
      <div class="row" style="margin-top:12px">
        <div class="section-label" style="margin:0">
          SRT 字幕${d.srt_count ? `（${d.srt_count} 条，可直接导入 OpenReel）` : '（本集分镜没填台词/旁白）'}
        </div>
        <div class="spacer"></div>
        <select class="select select-xs" id="srt-mode" style="width:150px">
          <option value="both"${mode === 'both' ? ' selected' : ''}>台词 + 旁白</option>
          <option value="dialogue"${mode === 'dialogue' ? ' selected' : ''}>只要台词</option>
          <option value="narration"${mode === 'narration' ? ' selected' : ''}>只要旁白</option>
        </select>
      </div>
      <textarea class="textarea mono" rows="4" readonly>${esc(d.srt || '（无内容）')}</textarea>`;
    modal({
      title: '导出交接清单',
      wide: true,
      body,
      footer: `<button class="btn" data-no>关闭</button>
               ${d.srt_count ? `<button class="btn" data-srt>${icon('download', 13)}下载字幕 .srt</button>` : ''}
               <button class="btn btn-primary" data-copy>${icon('copy', 13)}复制片段清单</button>`,
      onMount(root, close) {
        root.querySelector('[data-no]').onclick = close;
        // 换字幕模式就重新取一次导出结果，弹窗内容原地刷新
        const modeSel = root.querySelector('#srt-mode');
        if (modeSel) {
          modeSel.onchange = async () => {
            const next = modeSel.value;
            close();
            await doExport(next);
          };
        }
        root.querySelector('[data-copy]').onclick = async () => {
          const text = d.clips.map((c) => `${c.shot_number}\t${c.name}\t${c.trim_in}-${c.trim_out}`).join('\n');
          try { await navigator.clipboard.writeText(text); toast.ok('已复制'); }
          catch { toast.err('复制失败，请手动选中'); }
        };
        const srtBtn = root.querySelector('[data-srt]');
        if (srtBtn) {
          srtBtn.onclick = () => {
            // BOM 不能少：没有 BOM 的话中文台词在不少播放器里会乱码
            const blob = new Blob(['\uFEFF' + d.srt], { type: 'text/plain;charset=utf-8' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${d.plan.name}.srt`;
            a.click();
            URL.revokeObjectURL(a.href);
            toast.ok('字幕已下载');
          };
        }
      },
    });
  }

  container.addEventListener('DOMNodeRemovedFromDocument', () => { clearTimeout(refreshTimer); offVideo?.(); offStoryboard?.(); }, { once: true });
  await load();
}
