/**
 * editor.js — 剪辑台
 * 把本集已经生成好的片段按分镜顺序攒成一条时间线：排序、剔除、设入出点、加转场，
 * 然后导出交接清单，交给 OpenReel（浏览器版剪辑器，MIT）继续精剪。
 *
 * 这里刻意**不生成 OpenReel 工程文件**：它的 MediaItem 里带 fileHandle / blob，
 * 两者都无法序列化成 JSON，外部生成的工程打开后仍然要逐个重新关联媒体。
 * 与其给一个「看起来能用」其实打不开的文件，不如给真实的片段 + 顺序说明。
 */
import { icon, esc } from '../consts.js';
import { api } from '../api.js';
import { modal, toast, empty, spinner, confirm } from '../ui.js';
import { head, projectPicker, episodeOptions } from './helpers.js';
import { state } from '../app.js';

const TRANSITIONS = [
  { value: 'none', label: '无' },
  { value: 'crossfade', label: '交叉淡化' },
  { value: 'fade', label: '淡入淡出' },
  { value: 'wipe', label: '擦除' },
  { value: 'slide', label: '滑动' },
];

export default async function editor(container, params) {
  let projectId = params.project || (state.projects[0] && state.projects[0].id) || '';
  let episode = Number(params.episode || 1);
  let clips = [];
  let transitions = [];
  let planId = '';
  let planName = '';
  let dirty = false;

  container.innerHTML = `
    ${head({
      title: '剪辑台',
      desc: '按分镜顺序把生成好的片段攒成一条时间线，导出后交给 OpenReel 精剪',
      actions: `
        ${projectPicker(state.projects, projectId, { id: 'p-picker' })}
        <select class="select select-sm" id="ep" style="width:96px"></select>
        <button class="btn btn-sm" id="assemble">${icon('refresh', 13)}按分镜汇总</button>
        <button class="btn btn-sm" id="save">${icon('save', 13)}保存方案</button>
        <button class="btn btn-primary btn-sm" id="export">${icon('arrowRight', 13)}导出交接清单</button>`,
    })}
    <div id="bar" style="margin-bottom:14px"></div>
    <div class="card" id="timeline">${spinner()}</div>
    <div id="plans"></div>`;

  const epSel = container.querySelector('#ep');
  epSel.innerHTML = episodeOptions(episode);

  container.querySelector('#p-picker').onchange = (e) => { projectId = e.target.value; planId = ''; load(); };
  epSel.onchange = () => { episode = Number(epSel.value); planId = ''; load(); };
  container.querySelector('#assemble').onclick = assemble;
  container.querySelector('#save').onclick = save;
  container.querySelector('#export').onclick = doExport;

  async function load() {
    const el = container.querySelector('#timeline');
    if (!projectId) {
      el.innerHTML = empty('先选一个项目', '右上角下拉选一个项目', 'folder');
      return;
    }
    el.innerHTML = spinner();
    const r = await api.editPlans(projectId, episode);
    if (!r.ok) { el.innerHTML = empty('读取失败', r.error, 'alert'); return; }
    const existing = (r.data || [])[0];
    if (existing) {
      planId = existing.id;
      planName = existing.name;
      clips = existing.clips || [];
      transitions = existing.transitions || [];
      dirty = false;
    } else {
      planId = '';
      planName = `第 ${episode} 集剪辑方案`;
      clips = [];
      transitions = [];
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
    if (s.missing > 0) {
      toast.warn(`${s.total} 个镜头里有 ${s.missing} 个还没生成视频，已标记出来`, 8000);
    } else {
      toast.ok(`已汇总 ${s.ready} 个片段`);
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
              <div style="font-size:11px;color:var(--text-4);margin-top:2px">
                ${c.missing ? '<span style="color:var(--warn)">还没生成视频</span>'
                  : `入 ${c.trim_in}s → 出 ${c.trim_out}s（${dur.toFixed(1)}s / 全 ${c.duration}s）`}
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
    toast.ok('方案已保存');
    render();
    load();
  }

  async function doExport() {
    if (!planId) { toast.err('先保存方案再导出'); return; }
    const r = await api.exportEditPlan(planId);
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
      <div class="section-label" style="margin-top:12px">片段顺序</div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>#</th><th>镜头</th><th>入</th><th>出</th><th>时长</th><th>起点</th></tr></thead>
        <tbody>${d.clips.map((c) => `
          <tr><td>${c.index + 1}</td><td>${esc(c.name)}</td>
              <td>${c.trim_in}s</td><td>${c.trim_out}s</td>
              <td>${c.duration}s</td><td>${c.start}s</td></tr>`).join('')}
        </tbody></table></div>
      ${d.transitions.length ? `
        <div class="section-label" style="margin-top:12px">转场</div>
        <div style="font-size:12px;color:var(--text-3)">
          ${d.transitions.map((t) => `第 ${t.after_clip_index + 1} 段后：${esc(t.type)} ${t.duration}s`).join('<br>')}
        </div>` : ''}
      <div class="section-label" style="margin-top:12px">ffmpeg concat 清单</div>
      <textarea class="textarea mono" rows="3" readonly>${esc(d.ffmpeg_concat)}</textarea>
      <div class="section-label" style="margin-top:12px">
        SRT 字幕${d.srt_count ? `（${d.srt_count} 条，可直接导入 OpenReel）` : '（本集分镜没填台词）'}
      </div>
      <textarea class="textarea mono" rows="4" readonly>${esc(d.srt || '（无台词）')}</textarea>`;
    modal({
      title: '导出交接清单',
      wide: true,
      body,
      footer: `<button class="btn" data-no>关闭</button>
               ${d.srt_count ? `<button class="btn" data-srt>${icon('download', 13)}下载字幕 .srt</button>` : ''}
               <button class="btn btn-primary" data-copy>${icon('copy', 13)}复制片段清单</button>`,
      onMount(root, close) {
        root.querySelector('[data-no]').onclick = close;
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

  await load();
}
