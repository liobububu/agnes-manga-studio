/**
 * storyboards.js — 分镜制作
 * 分镜表是整个链路的中枢：往下接图片生成，再往下接视频生成。
 * 支持批量补提示词、批量出图、批量出视频（带队列进度）。
 */
import {
  icon, esc, extractJson, copyText, SHOT_TYPES, STORYBOARD_STATUS, framesForDuration,
} from '../consts.js';
import { api } from '../api.js';
import { modal, toast, empty, spinner, confirm, options } from '../ui.js';
import { head, projectPicker, renderBatchBar } from './helpers.js';
import { state, onEvent } from '../app.js';

export default async function storyboards(container, params) {
  let projectId = params.project || (state.projects[0] && state.projects[0].id) || '';
  let episode = Number(params.episode || 1);
  let rows = [];
  const selected = new Set();
  let job = null;

  container.innerHTML = `
    ${head({
      title: '分镜制作',
      desc: '管理分镜表：补提示词 → 批量出图 → 批量出视频，一条龙',
      actions: `
        ${projectPicker(state.projects, projectId, { id: 'p-picker', allowEmpty: true, emptyLabel: '未选择项目' })}
        <select class="select select-sm" id="ep" style="width:110px"></select>
        <button class="btn" id="reload">${icon('refresh', 16)}</button>`,
    })}

    <div class="card" style="margin-bottom:18px">
      <div class="card-title">${icon('wand', 15)}从脚本一键生成分镜表</div>
      <textarea class="textarea mono" id="script-in" rows="4" placeholder="粘贴单集脚本或分镜脚本内容，点「生成分镜」由 Agnes 拆成镜头表…"></textarea>
      <div class="row wrap" style="margin-top:12px">
        <button class="btn btn-primary btn-sm" id="gen-sb">${icon('wand', 14)}生成第 ${episode} 集分镜</button>
        <button class="btn btn-sm" id="add-shot">${icon('plus', 14)}手动添加镜头</button>
        <div class="spacer"></div>
        <button class="btn btn-sm" id="gen-img-prompts">${icon('image', 14)}批量补图片提示词</button>
        <button class="btn btn-sm" id="gen-vid-prompts">${icon('video', 14)}批量补视频提示词</button>
      </div>
    </div>

    <div id="batch-bar"></div>

    <div class="card" style="padding:14px 16px;margin-bottom:14px">
      <div class="row wrap">
        <label class="row" style="gap:7px;font-size:12.5px;color:var(--text-2);cursor:pointer">
          <input type="checkbox" id="sel-all" /> 全选
        </label>
        <span style="font-size:12px;color:var(--text-3)" id="sel-count">已选 0 个镜头</span>
        <div class="spacer"></div>
        <button class="btn btn-sm" id="batch-img">${icon('image', 14)}批量生成图片</button>
        <button class="btn btn-sm" id="batch-vid">${icon('video', 14)}批量生成视频</button>
        <button class="btn btn-sm btn-danger" id="clear-ep">${icon('trash', 14)}清空本集</button>
      </div>
    </div>

    <div id="table">${spinner('加载分镜…')}</div>`;

  const picker = container.querySelector('#p-picker');
  const epSel = container.querySelector('#ep');
  epSel.innerHTML = Array.from({ length: 30 }, (_, i) => i + 1)
    .map((n) => `<option value="${n}"${n === episode ? ' selected' : ''}>第 ${n} 集</option>`).join('');
  picker.onchange = () => { projectId = picker.value; selected.clear(); load(); };
  epSel.onchange = () => { episode = Number(epSel.value); selected.clear(); load(); };
  container.querySelector('#reload').onclick = () => load();
  container.querySelector('#gen-sb').onclick = genFromScript;
  container.querySelector('#add-shot').onclick = () => editShot(null);
  container.querySelector('#gen-img-prompts').onclick = () => batchPrompts('image');
  container.querySelector('#gen-vid-prompts').onclick = () => batchPrompts('video');
  container.querySelector('#batch-img').onclick = () => batchImages();
  container.querySelector('#batch-vid').onclick = () => batchVideos();
  container.querySelector('#clear-ep').onclick = clearEpisode;
  container.querySelector('#sel-all').onchange = (e) => {
    selected.clear();
    if (e.target.checked) rows.forEach((r) => selected.add(r.id));
    renderTable();
  };

  const offBatch = onEvent('batch', (j) => {
    job = j;
    const bar = container.querySelector('#batch-bar');
    renderBatchBar(bar, j, async (id) => {
      await api.cancelBatch(id);
      toast.warn('已请求取消，当前这一项跑完就停');
    });
    if (j.status !== 'running') {
      load();
      // 结束后多留一会儿：用户要看清成功/失败数，尤其是失败原因
      setTimeout(() => { job = null; renderBatchBar(bar, null); }, 9000);
    }
  });

  // 视频在后台跑完时，服务端会把这一镜回填成「视频就绪」。
  // 不订阅的话用户盯着分镜表看，状态却一直停在「有图片」，只能手动刷新。
  const offStoryboard = onEvent('storyboard', (sb) => {
    if (!sb || !sb.id) return;
    const i = rows.findIndex((r) => r.id === sb.id);
    if (i < 0) return;                       // 不是当前这一集的镜头
    if (rows[i].status === sb.status) return; // 没变化就别重绘
    rows[i] = Object.assign({}, rows[i], sb);
    // 正在编辑镜头时重绘会把输入顶掉
    if (container.querySelector('.modal')) return;
    renderTable();
  });

  async function load() {
    const el = container.querySelector('#table');
    if (!projectId) {
      el.innerHTML = `<div class="card">${empty('请先选择项目', '右上角下拉选一个项目，或去「项目管理」新建', 'folder')}</div>`;
      return;
    }
    const [r, imgs] = await Promise.all([api.storyboards(projectId, episode), api.images(projectId)]);
    if (!r.ok) { el.innerHTML = `<div class="note red">${esc(r.error)}</div>`; return; }
    rows = r.data || [];
    // 分镜 → 图片的映射，批量生成视频时用来判断是否走图生视频
    window.__imgMap = {};
    ((imgs.ok && imgs.data) || []).forEach((i) => { window.__imgMap[i.id] = i; });
    renderTable();
  }

  function renderTable() {
    const el = container.querySelector('#table');
    container.querySelector('#sel-count').textContent = `已选 ${selected.size} 个镜头`;
    if (!rows.length) {
      el.innerHTML = `<div class="card">${empty('第 ' + episode + ' 集还没有分镜', '在上面粘贴脚本点「生成分镜」，或手动添加镜头', 'film')}</div>`;
      return;
    }
    el.innerHTML = `<div class="table-wrap"><table class="tbl">
      <thead><tr>
        <th style="width:36px"></th>
        <th style="width:52px">镜头</th>
        <th style="width:76px">景别</th>
        <th style="min-width:190px">画面描述</th>
        <th style="width:96px">人物</th>
        <th style="min-width:130px">台词</th>
        <th style="width:54px">时长</th>
        <th style="min-width:200px">图片提示词</th>
        <th style="min-width:200px">视频提示词</th>
        <th style="width:80px">状态</th>
        <th style="width:150px">操作</th>
      </tr></thead>
      <tbody>
        ${rows.map((s) => {
          const st = STORYBOARD_STATUS[s.status] || STORYBOARD_STATUS.pending;
          return `<tr>
            <td><input type="checkbox" data-sel="${esc(s.id)}" ${selected.has(s.id) ? 'checked' : ''} /></td>
            <td style="font-family:var(--mono);color:var(--text)">#${esc(s.shot_number)}</td>
            <td><span class="badge gray">${esc(s.shot_type)}</span></td>
            <td><div class="cell-ellipsis" style="max-width:260px" title="${esc(s.scene_description)}">${esc(s.scene_description || '—')}</div></td>
            <td><div class="cell-ellipsis" style="max-width:96px">${esc(s.characters || '—')}</div></td>
            <td><div class="cell-ellipsis" style="max-width:150px;color:var(--text-3)">${esc(s.dialogue || '—')}</div></td>
            <td>${esc(s.duration_seconds)}s</td>
            <td>${promptCell(s.image_prompt)}</td>
            <td>${promptCell(s.video_prompt)}</td>
            <td><span class="badge ${st.cls}">${esc(st.label)}</span></td>
            <td>
              <div class="row" style="gap:4px">
                <button class="icon-btn" data-edit="${esc(s.id)}" title="编辑" style="background:rgba(255,255,255,0.07);color:var(--text-2)">${icon('edit', 13)}</button>
                <button class="icon-btn" data-img="${esc(s.id)}" title="生成图片" style="background:rgba(255,255,255,0.07);color:var(--text-2)">${icon('image', 13)}</button>
                <button class="icon-btn" data-vid="${esc(s.id)}" title="生成视频" style="background:rgba(255,255,255,0.07);color:var(--text-2)">${icon('video', 13)}</button>
                <button class="icon-btn" data-up="${esc(s.id)}" title="上移" style="background:rgba(255,255,255,0.07);color:var(--text-2)">${icon('chevronUp', 13)}</button>
                <button class="icon-btn" data-down="${esc(s.id)}" title="下移" style="background:rgba(255,255,255,0.07);color:var(--text-2)">${icon('chevronDown', 13)}</button>
                <button class="icon-btn" data-del="${esc(s.id)}" title="删除" style="background:rgba(255,255,255,0.07);color:var(--text-2)">${icon('trash', 13)}</button>
              </div>
            </td>
          </tr>`;
        }).join('')}
      </tbody></table></div>`;

    el.querySelectorAll('[data-sel]').forEach((c) => {
      c.onchange = () => {
        const id = c.getAttribute('data-sel');
        c.checked ? selected.add(id) : selected.delete(id);
        container.querySelector('#sel-count').textContent = `已选 ${selected.size} 个镜头`;
      };
    });
    const bind = (attr, fn) => el.querySelectorAll(`[data-${attr}]`).forEach((b) => { b.onclick = () => fn(b.getAttribute(`data-${attr}`)); });
    bind('edit', (id) => editShot(rows.find((x) => x.id === id)));
    bind('img', (id) => genImage([rows.find((x) => x.id === id)]));
    bind('vid', (id) => genVideo([rows.find((x) => x.id === id)]));
    bind('del', async (id) => {
      if (!(await confirm({ text: '删除这个镜头？', danger: true, okText: '删除' }))) return;
      const r = await api.deleteStoryboard(id);
      if (r.ok) { toast.ok('已删除'); load(); } else toast.err(r.error);
    });
    bind('up', (id) => move(id, -1));
    bind('down', (id) => move(id, 1));
    el.querySelectorAll('[data-copy-prompt]').forEach((b) => {
      b.onclick = () => copyText(b.getAttribute('data-copy-prompt')).then(() => toast.ok('已复制提示词'));
    });
  }

  function promptCell(text) {
    if (!text) return `<span style="color:var(--text-4);font-size:11.5px">待生成</span>`;
    return `<div class="row" style="gap:6px">
      <span class="cell-ellipsis" style="font-family:var(--mono);font-size:11px;max-width:180px;color:var(--text-3)" title="${esc(text)}">${esc(text)}</span>
      <button class="icon-btn" data-copy-prompt="${esc(text)}" title="复制" style="width:22px;height:22px;background:rgba(255,255,255,0.06);color:var(--text-3)">${icon('copy', 11)}</button>
    </div>`;
  }

  async function move(id, dir) {
    const idx = rows.findIndex((r) => r.id === id);
    const to = idx + dir;
    if (idx < 0 || to < 0 || to >= rows.length) return;
    const arr = rows.slice();
    [arr[idx], arr[to]] = [arr[to], arr[idx]];
    const r = await api.reorderStoryboards(arr.map((x) => x.id));
    if (r.ok) { rows = arr; renderTable(); } else toast.err(r.error);
  }

  // ── 从脚本生成分镜 ───────────────────────────────────────
  async function genFromScript() {
    const text = container.querySelector('#script-in').value.trim();
    if (!text) { toast.err('请先粘贴脚本内容'); return; }
    if (!projectId) { toast.err('请先选择项目'); return; }
    const r = await api.genText({
      messages: [
        { role: 'system', content: '你是专业的AI漫剧分镜导演。请用JSON数组格式返回分镜表，每个镜头必须包含所有字段，英文图片/视频提示词要专业、详细。' },
        {
          role: 'user',
          content: `请将以下脚本内容转换为分镜表，JSON数组格式，每个镜头包含：
shot_number(数字)、shot_type(景别)、scene_description(画面描述)、characters(出场人物)、action(动作)、dialogue(台词)、narration(旁白)、sound_effect(音效)、duration_seconds(时长数字)、image_prompt(英文图片提示词)、video_prompt(英文视频提示词)、negative_prompt(英文负面提示词)。

${text}`,
        },
      ],
      project_id: projectId,
      note: '分镜生成',
    });
    if (!r.ok) { toast.err(r.error); return; }
    const parsed = extractJson(r.data.content);
    if (!Array.isArray(parsed) || !parsed.length) {
      toast.err('解析失败：模型没有返回镜头数组，请重试或换个模型');
      return;
    }
    const rows2 = parsed.map((s, i) => ({
      project_id: projectId,
      episode_number: episode,
      shot_number: Number(s.shot_number) || i + 1,
      shot_type: String(s.shot_type || '中景'),
      scene_description: String(s.scene_description || ''),
      characters: String(s.characters || ''),
      scene: String(s.scene || ''),
      action: String(s.action || ''),
      dialogue: String(s.dialogue || ''),
      narration: String(s.narration || ''),
      sound_effect: String(s.sound_effect || ''),
      duration_seconds: Number(s.duration_seconds) || 3,
      image_prompt: String(s.image_prompt || ''),
      video_prompt: String(s.video_prompt || ''),
      negative_prompt: String(s.negative_prompt || 'low quality, blurry, distorted face'),
      status: 'pending',
      sort_order: i,
    }));
    const r2 = await api.createStoryboards(rows2);
    if (r2.ok) { toast.ok(`已生成 ${r2.data.inserted} 个镜头`); container.querySelector('#script-in').value = ''; load(); }
    else toast.err(r2.error);
  }

  // ── 批量补提示词 ─────────────────────────────────────────
  async function batchPrompts(kind) {
    const targets = rows.filter((r) => !(kind === 'image' ? r.image_prompt : r.video_prompt));
    if (!targets.length) { toast.info('没有需要补充的镜头'); return; }
    const bar = container.querySelector('#batch-bar');
    let done = 0;
    for (const s of targets) {
      bar.innerHTML = `<div class="note gold"><div class="row"><div class="spinner sm"></div><span>${kind === 'image' ? '生成图片提示词' : '生成视频提示词'}：${done + 1} / ${targets.length}</span></div></div>`;
      const sys = kind === 'image'
        ? '你是专业的AI漫剧分镜图提示词工程师，请生成适合图像生成的英文提示词，风格统一，细节丰富。只输出提示词，不要解释。'
        : '你是专业的AI视频提示词工程师。请用英文输出，只描述画面运动与镜头运动，不要重复静态外观。';
      const user = kind === 'image'
        ? `为以下分镜生成英文图片提示词：景别:${s.shot_type}，画面:${s.scene_description}，人物:${s.characters}，动作:${s.action}`
        : `为以下分镜生成英文视频运动提示词：画面:${s.scene_description}，动作:${s.action}，台词:${s.dialogue}`;
      const r = await api.genText({ messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], project_id: projectId });
      if (r.ok) {
        const txt = (r.data.content || '').trim().replace(/^["']|["']$/g, '');
        await api.updateStoryboard(s.id, kind === 'image' ? { image_prompt: txt } : { video_prompt: txt });
      }
      done++;
    }
    bar.innerHTML = `<div class="note green">${icon('check', 14)} 已为 ${done} 个镜头补充${kind === 'image' ? '图片' : '视频'}提示词</div>`;
    setTimeout(() => { bar.innerHTML = ''; }, 3500);
    load();
  }

  // ── 批量任务 ─────────────────────────────────────────────
  function targetShots() {
    const sel = rows.filter((r) => selected.has(r.id));
    return sel.length ? sel : rows;
  }

  async function batchImages() {
    const shots = targetShots().filter((s) => s.image_prompt);
    if (!shots.length) { toast.err('选中的镜头还没有图片提示词，先「批量补图片提示词」'); return; }
    const r = await api.batchImages({
      items: shots.map((s) => ({
        storyboard_id: s.id,
        project_id: projectId,
        prompt: s.image_prompt,
        size: '1024x1024',
        usage_type: 'storyboard',
      })),
      concurrency: 3,
    });
    if (r.ok) toast.ok(`已提交 ${r.data.total} 张图片的批量任务`);
    else toast.err(r.error);
  }

  async function batchVideos() {
    const shots = targetShots().filter((s) => s.video_prompt);
    if (!shots.length) { toast.err('选中的镜头还没有视频提示词，先「批量补视频提示词」'); return; }
    // 有分镜图的用图生视频，没有的退回文生视频
    const items = shots.map((s) => {
      const img = s.linked_image_id ? (window.__imgMap?.[s.linked_image_id] || null) : null;
      const publicUrl = publicImageUrl(img);
      return {
        project_id: projectId,
        storyboard_id: s.id,
        mode: publicUrl ? 'image_to_video' : 'text_to_video',
        prompt: s.video_prompt,
        image: publicUrl || undefined,
        negative_prompt: s.negative_prompt,
        // 按分镜设计的时长出帧数，别一律 5 秒——镜头写 10 秒却出 5 秒，成片节奏就废了
        num_frames: framesForDuration(s.duration_seconds),
        frame_rate: 24,
        width: 1152,
        height: 768,
      };
    });
    const i2v = items.filter((i) => i.image).length;
    const degraded = items.length - i2v;
    if (degraded) {
      toast.warn(state.imageHost && state.imageHost.configured
        ? `${degraded} 个镜头没有可用的分镜图，已改用文生视频。`
        : `${degraded} 个镜头的分镜图只存在本机，Agnes 抓不到，已改用文生视频。到「设置 → 图床」配一个免费图床后，本地图片会自动上传并走图生视频。`, 8000);
    }
    const r = await api.batchVideos({ items, concurrency: 1 });
    if (r.ok) {
      toast.ok(`已提交 ${r.data.total} 个视频任务（图生视频 ${i2v} 个 / 文生视频 ${degraded} 个）`);
    } else toast.err(r.error);
  }

  /**
   * 取分镜图用于图生视频的地址。
   * 公网地址直接给；只有本机地址时，若已配置图床就把本地路径交给后端，
   * 由后端上传成公网地址再提交 Agnes；没配图床才返回空让调用方降级。
   */
  function publicImageUrl(img) {
    if (!img) return '';
    if (typeof img.remote_url === 'string' && /^https?:\/\//i.test(img.remote_url)) return img.remote_url;
    if (typeof img.url === 'string' && /^https?:\/\//i.test(img.url)) return img.url;
    if (state.imageHost && state.imageHost.configured && typeof img.url === 'string' && img.url) {
      return img.url; // 本地路径：后端会先传图床
    }
    return '';
  }

  async function genImage(shots) {
    const s = shots[0];
    if (!s?.image_prompt) { toast.err('这个镜头还没有图片提示词'); return; }
    const r = await api.genImage({
      project_id: projectId,
      storyboard_id: s.id,
      prompt: s.image_prompt,
      size: '1024x1024',
      usage_type: 'storyboard',
    });
    if (r.ok) { toast.ok('图片已生成并关联到分镜'); load(); } else toast.err(r.error);
  }

  async function genVideo(shots) {
    const s = shots[0];
    if (!s?.video_prompt) { toast.err('这个镜头还没有视频提示词'); return; }
    const img = s.linked_image_id ? (window.__imgMap?.[s.linked_image_id] || null) : null;
    const publicUrl = publicImageUrl(img);
    if (img && !publicUrl) {
      toast.warn(state.imageHost && state.imageHost.configured
        ? '这个镜头没有可用的分镜图，本次改用文生视频。'
        : '这个镜头的分镜图只存在本机，Agnes 抓不到，本次改用文生视频。到「设置 → 图床」配一个免费图床后就能自动上传。', 7000);
    }
    const r = await api.createVideo({
      project_id: projectId,
      storyboard_id: s.id,
      mode: publicUrl ? 'image_to_video' : 'text_to_video',
      prompt: s.video_prompt,
      image: publicUrl || undefined,
      negative_prompt: s.negative_prompt,
      num_frames: framesForDuration(s.duration_seconds),
      frame_rate: 24,
      width: 1152,
      height: 768,
    });
    if (r.ok) { toast.ok('视频任务已提交，去「镜头任务」看进度'); location.hash = '#/tasks'; }
    else toast.err(r.error);
  }

  async function clearEpisode() {
    if (!(await confirm({
      text: `确定清空第 ${episode} 集的全部 ${rows.length} 个镜头吗？此操作不可撤销。`,
      danger: true, okText: '清空',
    }))) return;
    const r = await api.clearStoryboards(projectId, episode);
    if (r.ok) { toast.ok(`已清空 ${r.data.removed} 个镜头`); load(); } else toast.err(r.error);
  }

  // ── 镜头编辑弹窗 ─────────────────────────────────────────
  function editShot(shot) {
    const isNew = !shot;
    const s = shot || {
      shot_number: rows.length + 1, shot_type: '中景', scene_description: '', characters: '',
      scene: '', action: '', dialogue: '', narration: '', sound_effect: '', duration_seconds: 3,
      image_prompt: '', video_prompt: '', negative_prompt: 'low quality, blurry, distorted face',
    };
    modal({
      title: isNew ? '添加镜头' : `编辑镜头 #${s.shot_number}`,
      wide: true,
      body: `
        <div class="grid g2" style="gap:0 14px">
          <div class="field"><label>镜头编号</label><input class="input" id="s-num" type="number" value="${esc(s.shot_number)}" /></div>
          <div class="field"><label>景别</label><select class="select" id="s-type">${options(SHOT_TYPES, 'v', 'v', s.shot_type)}</select></div>
          <div class="field" style="grid-column:1/-1"><label>画面描述</label><textarea class="textarea" id="s-desc" rows="2">${esc(s.scene_description)}</textarea></div>
          <div class="field"><label>人物</label><input class="input" id="s-chars" value="${esc(s.characters)}" /></div>
          <div class="field"><label>场景</label><input class="input" id="s-scene" value="${esc(s.scene)}" /></div>
          <div class="field" style="grid-column:1/-1"><label>动作</label><input class="input" id="s-action" value="${esc(s.action)}" /></div>
          <div class="field"><label>台词</label><textarea class="textarea" id="s-dlg" rows="2">${esc(s.dialogue)}</textarea></div>
          <div class="field"><label>旁白</label><textarea class="textarea" id="s-nar" rows="2">${esc(s.narration)}</textarea></div>
          <div class="field"><label>音效</label><input class="input" id="s-sfx" value="${esc(s.sound_effect)}" /></div>
          <div class="field"><label>时长（秒）</label><input class="input" id="s-dur" type="number" value="${esc(s.duration_seconds)}" /></div>
          <div class="field" style="grid-column:1/-1"><label>图片提示词</label><textarea class="textarea mono" id="s-ip" rows="3">${esc(s.image_prompt)}</textarea></div>
          <div class="field" style="grid-column:1/-1"><label>视频提示词</label><textarea class="textarea mono" id="s-vp" rows="3">${esc(s.video_prompt)}</textarea></div>
          <div class="field" style="grid-column:1/-1"><label>负面提示词</label><textarea class="textarea mono" id="s-np" rows="2">${esc(s.negative_prompt)}</textarea></div>
        </div>`,
      footer: `
        <button class="btn" data-no>取消</button>
        <button class="btn btn-primary" data-yes>${isNew ? '添加' : '保存'}</button>`,
      onMount(root, close) {
        root.querySelector('[data-no]').onclick = close;
        root.querySelector('[data-yes]').onclick = async () => {
          const payload = {
            shot_number: Number(root.querySelector('#s-num').value) || 1,
            shot_type: root.querySelector('#s-type').value,
            scene_description: root.querySelector('#s-desc').value,
            characters: root.querySelector('#s-chars').value,
            scene: root.querySelector('#s-scene').value,
            action: root.querySelector('#s-action').value,
            dialogue: root.querySelector('#s-dlg').value,
            narration: root.querySelector('#s-nar').value,
            sound_effect: root.querySelector('#s-sfx').value,
            duration_seconds: Number(root.querySelector('#s-dur').value) || 3,
            image_prompt: root.querySelector('#s-ip').value,
            video_prompt: root.querySelector('#s-vp').value,
            negative_prompt: root.querySelector('#s-np').value,
          };
          let r;
          if (isNew) {
            r = await api.createStoryboard({
              ...payload, project_id: projectId, episode_number: episode,
              status: 'pending', sort_order: rows.length,
            });
          } else {
            r = await api.updateStoryboard(s.id, payload);
          }
          if (r.ok) { toast.ok(isNew ? '已添加' : '已保存'); close(); load(); }
          else toast.err(r.error);
        };
      },
    });
  }

  await load();
  return () => { offBatch && offBatch(); offStoryboard && offStoryboard(); };
}
