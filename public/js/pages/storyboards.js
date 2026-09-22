/**
 * storyboards.js — 分镜制作
 * 分镜表是整个链路的中枢：往下接图片生成，再往下接视频生成。
 * 支持批量补提示词、批量出图、批量出视频（带队列进度）。
 */
import {
  icon, esc, extractJson, copyText, SHOT_TYPES, STORYBOARD_STATUS, framesForDuration,
} from '../consts.js';
import { api } from '../api.js';
import { modal, toast, empty, spinner, confirm, options, attachAssetMentions } from '../ui.js';
import { head, projectPicker, renderBatchBar, episodeOptions } from './helpers.js';
import { state, onEvent, navigate, resolveProjectId, setActiveProject } from '../app.js';

export default async function storyboards(container, params) {
  let projectId = resolveProjectId(params.project || '');
  let episode = Number(params.episode || 1);
  let rows = [];
  const selected = new Set();
  let job = null;
  let mentionImages = [];
  let entityAssets = [];
  let audioAssets = [];
  let generationTasks = [];
  let projectVideos = [];
  let savedScripts = [];
  const entityLabel = { character: '角色', scene: '场景', prop: '道具', reference: '参考资产' };
  const mentionAssets = () => [
    ...entityAssets.map((a) => ({ name: a.name, meta: entityLabel[a.asset_type] || '资产' })),
    ...mentionImages.map((i) => ({ name: i.name || '未命名图片', meta: i.project_id === projectId ? '当前项目图片' : '图片素材' })),
  ];

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
      <div class="row wrap" style="margin-bottom:8px"><select class="select select-sm" id="saved-script" style="min-width:220px"><option value="">选择项目已保存脚本…</option></select><span style="font-size:11px;color:var(--text-3)">选择后自动载入，也可直接粘贴</span></div>
      <textarea class="textarea mono" id="script-in" rows="4" placeholder="选择项目已保存脚本，或粘贴单集脚本内容…"></textarea>
      <div class="row wrap" style="margin-top:12px">
        <button class="btn btn-primary btn-sm" id="gen-sb">${icon('wand', 14)}生成第 ${episode} 集分镜</button>
        <button class="btn btn-sm" id="add-shot">${icon('plus', 14)}手动添加镜头</button>
        <div class="spacer"></div>
        <button class="btn btn-sm" id="gen-img-prompts">${icon('image', 14)}批量补图片提示词</button>
        <button class="btn btn-sm" id="gen-vid-prompts">${icon('video', 14)}批量补视频提示词</button>
      </div>
    </div>

    <div id="batch-bar"></div>

    <div id="production-summary"></div>

    <div class="card" style="padding:14px 16px;margin-bottom:14px">
      <div class="row wrap">
        <label class="row" style="gap:7px;font-size:12.5px;color:var(--text-2);cursor:pointer">
          <input type="checkbox" id="sel-all" /> 全选
        </label>
        <span style="font-size:12px;color:var(--text-3)" id="sel-count">已选 0 个镜头</span>
        <div class="spacer"></div>
        <button class="btn btn-sm" id="batch-img">${icon('image', 14)}只补缺失图片</button>
        <button class="btn btn-sm" id="batch-vid">${icon('video', 14)}只补缺失视频</button>
        <button class="btn btn-sm" id="batch-audio">${icon('play', 14)}只补缺失配音</button>
        <button class="btn btn-sm" id="go-images">${icon('grid', 14)}本项目图片</button>
        <button class="btn btn-sm" id="go-tasks">${icon('tasks', 14)}本项目任务</button>
        <button class="btn btn-sm btn-primary" id="go-editor">${icon('film', 14)}组装整集时间线</button>
        <button class="btn btn-sm btn-danger" id="clear-ep">${icon('trash', 14)}清空本集</button>
      </div>
    </div>

    <div id="table">${spinner('加载分镜…')}</div>`;

  const picker = container.querySelector('#p-picker');
  const epSel = container.querySelector('#ep');
  epSel.innerHTML = episodeOptions(episode);
  picker.onchange = () => { projectId = picker.value; setActiveProject(projectId); selected.clear(); load(); };
  epSel.onchange = () => { episode = Number(epSel.value); selected.clear(); load(); };
  container.querySelector('#reload').onclick = () => load();
  container.querySelector('#saved-script').onchange = (e) => {
    const s = savedScripts.find((x) => x.id === e.target.value);
    if (!s) return;
    if (s.project_id && s.project_id !== projectId) { toast.err('该脚本不属于当前项目'); return; }
    if (s.episode_number != null && Number(s.episode_number) !== episode) {
      episode = Number(s.episode_number);
      epSel.value = String(episode);
      selected.clear();
      load();
    }
    container.querySelector('#script-in').value = s.content || '';
  };
  container.querySelector('#gen-sb').onclick = genFromScript;
  container.querySelector('#add-shot').onclick = () => editShot(null);
  container.querySelector('#gen-img-prompts').onclick = () => batchPrompts('image');
  container.querySelector('#gen-vid-prompts').onclick = () => batchPrompts('video');
  container.querySelector('#batch-img').onclick = () => batchImages();
  container.querySelector('#batch-vid').onclick = () => batchVideos();
  container.querySelector('#batch-audio').onclick = () => batchAudios();
  container.querySelector('#go-images').onclick = () => navigate('images', { project: projectId, episode: String(episode) });
  container.querySelector('#go-tasks').onclick = () => navigate('tasks', { project: projectId, episode: String(episode) });
  container.querySelector('#go-editor').onclick = () => navigate('editor', { project: projectId, episode: String(episode) });
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
      const c = await api.cancelBatch(id);
      // 取消失败多半是任务已经跑完了，这时再报「已请求取消」是假消息
      if (c.ok) toast.warn('已请求取消，当前这一项跑完就停');
      else toast.err(c.error || '取消失败（任务可能已经结束）');
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
    const [r, imgs, allImgs, entities, audios, tasks, videos, scripts] = await Promise.all([api.storyboards(projectId, episode), api.images(projectId), api.images(), api.assetEntities(projectId), api.audioAssets(projectId), api.tasks(), api.videos(projectId), api.scripts(projectId)]);
    if (!r.ok) { el.innerHTML = `<div class="note red">${esc(r.error)}</div>`; return; }
    rows = r.data || [];
    mentionImages = (allImgs.ok && allImgs.data) || (imgs.ok && imgs.data) || [];
    entityAssets = (entities.ok && entities.data) || [];
    audioAssets = (audios.ok && audios.data) || [];
    generationTasks = (tasks.ok && tasks.data) || [];
    projectVideos = (videos.ok && videos.data) || [];
    savedScripts = (scripts.ok && scripts.data) || [];
    const scriptSelect = container.querySelector('#saved-script');
    const currentScript = scriptSelect.value;
    scriptSelect.innerHTML = '<option value="">选择项目已保存脚本…</option>' + savedScripts.map((s) => '<option value="' + esc(s.id) + '">' + esc(s.title || s.script_type || '未命名脚本') + '</option>').join('');
    if (savedScripts.some((s) => s.id === currentScript)) scriptSelect.value = currentScript;
    if (params.source_script) {
      const source = savedScripts.find((s) => s.id === params.source_script);
      if (source && (!source.project_id || source.project_id === projectId)) {
        if (source.episode_number != null && Number(source.episode_number) !== episode) {
          episode = Number(source.episode_number);
          epSel.value = String(episode);
        }
        scriptSelect.value = source.id;
        const input = container.querySelector('#script-in');
        if (!input.value.trim()) input.value = source.content || '';
      }
    }
    // 分镜 → 图片的映射，批量生成视频时用来判断是否走图生视频
    window.__imgMap = {};
    ((imgs.ok && imgs.data) || []).forEach((i) => { window.__imgMap[i.id] = i; });
    renderTable();
  }

  function renderTable() {
    const el = container.querySelector('#table');
    container.querySelector('#sel-count').textContent = `已选 ${selected.size} 个镜头`;
    renderProductionSummary();
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
                <button class="icon-btn" data-audio="${esc(s.id)}" title="关联配音" style="background:rgba(255,255,255,0.07);color:var(--text-2)">${icon('play', 13)}</button>
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
    bind('vid', (id) => {
      const shot = rows.find((x) => x.id === id);
      const img = shot && shot.linked_image_id ? window.__imgMap?.[shot.linked_image_id] : null;
      if (img) navigate('videos', { project: projectId, storyboard: id, image_id: img.id, image_url: img.remote_url || img.url || '' });
      else genVideo([shot]);
    });
    bind('audio', (id) => attachAudio(rows.find((x) => x.id === id)));
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

  async function attachAudio(shot) {
    const text = shot.dialogue || shot.narration || '';
    modal({
      title: `镜头 #${shot.shot_number} · 配音`,
      body: `<div class="note" style="margin-bottom:12px">把已生成或外部生成的音频关联到这个镜头。后续 TTS 也统一进入同一音频资产链。</div><label class="label">类型</label><select class="select" id="aud-type"><option value="dialogue">角色台词</option><option value="narration">旁白</option></select><label class="label">说话人</label><input class="input" id="aud-speaker" value="${esc(shot.characters || '')}" /><label class="label">对应文本</label><textarea class="textarea" id="aud-text" rows="3">${esc(text)}</textarea><label class="label">音频地址</label><input class="input" id="aud-url" placeholder="公网 URL 或本地资产地址" />`,
      footer: `<button class="btn" data-no>取消</button><button class="btn" data-generate>生成配音</button><button class="btn btn-primary" data-save>关联已有音频</button>`,
      onMount: (m, close) => {
        m.querySelector('[data-generate]').onclick = async (e) => {
          const btn = e.currentTarget; const text = m.querySelector('#aud-text').value.trim();
          if (!text) { toast.err('没有可生成的配音文本'); return; }
          btn.disabled = true; btn.textContent = '生成中…';
          const r = await api.generateTts({ project_id: projectId, storyboard_id: shot.id, audio_type: m.querySelector('#aud-type').value, speaker: m.querySelector('#aud-speaker').value, text, name: `镜头${shot.shot_number}_配音` });
          btn.disabled = false; btn.textContent = '生成配音';
          if (!r.ok) { toast.err(r.error); return; }
          toast.ok('配音已生成并自动关联'); close(); load();
        };
        m.querySelector('[data-save]').onclick = async () => {
          const url = m.querySelector('#aud-url').value.trim();
          if (!url) { toast.err('请填写音频地址'); return; }
          const r = await api.createAudioAsset({ project_id: projectId, storyboard_id: shot.id, audio_type: m.querySelector('#aud-type').value, speaker: m.querySelector('#aud-speaker').value, text: m.querySelector('#aud-text').value, url, name: `镜头${shot.shot_number}_配音` });
          if (!r.ok) { toast.err(r.error); return; }
          toast.ok('配音已关联到镜头'); close(); load();
        };
      },
    });
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

  async function extractAssetsFromScript(text) {
    const r = await api.genText({
      messages: [
        { role: 'system', content: '你是AI漫剧资产设定师。只返回JSON数组，不要解释。提取需要跨镜头保持一致的角色、场景、道具。' },
        { role: 'user', content: '从以下剧本提取角色、场景、道具。每项包含 asset_type(character/scene/prop)、name、description、prompt。name必须使用剧本中的简洁中文名称；description写固定身份/外观/环境/道具特征；prompt写适合图像生成的一致性提示词。\n\n' + text },
      ],
      project_id: projectId,
      note: '剧本资产提取',
    });
    if (!r.ok) return { ok: false, error: r.error };
    const parsed = extractJson(r.data.content);
    if (!Array.isArray(parsed)) return { ok: false, error: '资产提取结果解析失败' };
    const existing = new Map(entityAssets.map((a) => [a.asset_type + ':' + a.name, a]));
    const created = [];
    for (const a of parsed) {
      const type = ['character', 'scene', 'prop'].includes(a.asset_type) ? a.asset_type : '';
      const name = String(a.name || '').trim();
      if (!type || !name || existing.has(type + ':' + name)) continue;
      const rr = await api.createAssetEntity({ project_id: projectId, asset_type: type, name, description: String(a.description || ''), prompt: String(a.prompt || '') });
      if (rr.ok) { created.push(rr.data); existing.set(type + ':' + name, rr.data); }
    }
    if (created.length) entityAssets = entityAssets.concat(created);
    return { ok: true, created: created.length };
  }

  function assetGuide() {
    if (!entityAssets.length) return '';
    return '\n\n项目固定资产如下。分镜中的 characters、scene、image_prompt、video_prompt 必须使用完全一致的资产名称；图片/视频提示词中凡出现这些资产，必须写成 @资产名，不得自行改名或重新描述为另一个角色/场景/道具：\n' + entityAssets.map((a) => '@' + a.name + ' [' + a.asset_type + ']：' + (a.description || a.prompt || '')).join('\n');
  }

  function normalizeAssetRefs(shot) {
    const fields = ['characters', 'scene', 'scene_description', 'action', 'image_prompt', 'video_prompt'];
    const matched = [];
    entityAssets.forEach((a) => {
      const token = '@' + a.name;
      const plainHit = fields.some((f) => String(shot[f] || '').includes(a.name));
      const tokenHit = fields.some((f) => String(shot[f] || '').includes(token));
      if (plainHit || tokenHit) matched.push(a);
    });
    const byType = (type) => matched.filter((a) => a.asset_type === type);
    const chars = byType('character');
    const scenes = byType('scene');
    const props = byType('prop');
    const refs = [...chars, ...scenes, ...props];
    let imagePrompt = String(shot.image_prompt || '');
    let videoPrompt = String(shot.video_prompt || '');
    refs.forEach((a) => {
      const token = '@' + a.name;
      if (imagePrompt.includes(a.name) && !imagePrompt.includes(token)) imagePrompt = imagePrompt.split(a.name).join(token);
      if (videoPrompt.includes(a.name) && !videoPrompt.includes(token)) videoPrompt = videoPrompt.split(a.name).join(token);
      if (!imagePrompt.includes(token)) imagePrompt += (imagePrompt ? ', ' : '') + token;
      if (!videoPrompt.includes(token)) videoPrompt += (videoPrompt ? ', ' : '') + token;
    });
    return {
      ...shot,
      characters: chars.length ? chars.map((a) => '@' + a.name).join('、') : String(shot.characters || ''),
      scene: scenes.length ? scenes.map((a) => '@' + a.name).join('、') : String(shot.scene || ''),
      image_prompt: imagePrompt,
      video_prompt: videoPrompt,
    };
  }

  // ── 从脚本生成分镜 ───────────────────────────────────────
  async function genFromScript() {
    const text = container.querySelector('#script-in').value.trim();
    if (!text) { toast.err('请先粘贴脚本内容'); return; }
    if (!projectId) { toast.err('请先选择项目'); return; }
    const assetResult = await extractAssetsFromScript(text);
    if (!assetResult.ok) toast.warn('资产自动提取未完成，将继续生成分镜：' + assetResult.error);
    else if (assetResult.created) toast.info('已从剧本新增 ' + assetResult.created + ' 个角色/场景/道具资产');
    const r = await api.genText({
      messages: [
        { role: 'system', content: '你是专业的AI漫剧分镜导演。请用JSON数组格式返回分镜表，每个镜头必须包含所有字段，英文图片/视频提示词要专业、详细。' },
        {
          role: 'user',
          content: `请将以下脚本内容转换为分镜表，JSON数组格式，每个镜头包含：
shot_number(数字)、shot_type(景别)、scene_description(画面描述)、characters(出场人物)、action(动作)、dialogue(台词)、narration(旁白)、sound_effect(音效)、duration_seconds(时长数字)、image_prompt(英文图片提示词)、video_prompt(英文视频提示词)、negative_prompt(英文负面提示词)。

${text}${assetGuide()}`,
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
    const rows2 = parsed.map((raw, i) => {
      const s = normalizeAssetRefs(raw);
      return ({
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
    });
    });
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
    let failed = 0;
    for (const s of targets) {
      bar.innerHTML = `<div class="note gold"><div class="row"><div class="spinner sm"></div><span>${kind === 'image' ? '生成图片提示词' : '生成视频提示词'}：${done + failed + 1} / ${targets.length}</span></div></div>`;
      const sys = kind === 'image'
        ? '你是专业的AI漫剧分镜图提示词工程师，请生成适合图像生成的英文提示词，风格统一，细节丰富。只输出提示词，不要解释。'
        : '你是专业的AI视频提示词工程师。请用英文输出，只描述画面运动与镜头运动，不要重复静态外观。';
      const refs = assetGuide();
      const user = kind === 'image'
        ? `为以下分镜生成英文图片提示词：景别:${s.shot_type}，画面:${s.scene_description}，人物:${s.characters}，场景:${s.scene}，动作:${s.action}${refs}\n必须保留本镜头涉及的 @资产名。`
        : `为以下分镜生成英文视频运动提示词：画面:${s.scene_description}，人物:${s.characters}，场景:${s.scene}，动作:${s.action}，台词:${s.dialogue}${refs}\n必须保留本镜头涉及的 @资产名。`;
      const r = await api.genText({ messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], project_id: projectId });
      if (r.ok) {
        const txt = (r.data.content || '').trim().replace(/^["']|["']$/g, '');
        const normalized = normalizeAssetRefs({ ...s, [kind === 'image' ? 'image_prompt' : 'video_prompt']: txt });
        const saved = await api.updateStoryboard(s.id, kind === 'image' ? { image_prompt: normalized.image_prompt } : { video_prompt: normalized.video_prompt });
        // 生成已经扣过一次费了，保存失败必须说出来，不能报「已为 N 个镜头补充」
        if (!saved.ok) { failed++; toast.err(`第 ${s.shot_number} 镜保存失败：${saved.error || '未知错误'}`); continue; }
        done++;
      } else {
        // 生成失败也要说一声：否则用户只看到「已为 0 个镜头补充」，不知道为什么
        failed++;
        toast.err(`第 ${s.shot_number} 镜生成失败：${r.error || '未知错误'}`);
      }
    }
    const label = kind === 'image' ? '图片' : '视频';
    bar.innerHTML = failed
      ? `<div class="note orange">${icon('alert', 14)} 成功 ${done} 个，失败 ${failed} 个（失败原因已逐条提示）</div>`
      : `<div class="note green">${icon('check', 14)} 已为 ${done} 个镜头补充${label}提示词</div>`;
    setTimeout(() => { bar.innerHTML = ''; }, failed ? 6000 : 3500);
    load();
  }

  function renderProductionSummary() {
    const el = container.querySelector('#production-summary');
    if (!el) return;
    if (!projectId || !rows.length) { el.innerHTML = ''; return; }
    const total = rows.length;
    const imageReady = rows.filter((s) => s.linked_image_id).length;
    const videoReady = rows.filter((s) => s.linked_video_id || s.status === 'video_ready' || s.status === 'done').length;
    const missingImagePrompt = rows.filter((s) => !s.image_prompt).length;
    const missingVideoPrompt = rows.filter((s) => !s.video_prompt).length;
    const missingImages = rows.filter((s) => s.image_prompt && !s.linked_image_id).length;
    const missingVideos = rows.filter((s) => s.video_prompt && !s.linked_video_id && s.status !== 'video_ready' && s.status !== 'done').length;
    const audioByShot = new Map();
    audioAssets.filter((a) => a.status === 'completed' && ['dialogue', 'narration'].includes(a.audio_type)).forEach((a) => {
      const key = a.storyboard_id + ':' + a.audio_type;
      if (!audioByShot.has(key)) audioByShot.set(key, a);
    });
    const expectedAudio = rows.reduce((n, s) => n + (String(s.dialogue || '').trim() ? 1 : 0) + (String(s.narration || '').trim() ? 1 : 0), 0);
    const audioReady = rows.reduce((n, s) => n + (audioByShot.has(s.id + ':dialogue') ? 1 : 0) + (audioByShot.has(s.id + ':narration') ? 1 : 0), 0);
    const missingAudio = Math.max(0, expectedAudio - audioReady);
    const shotIds = new Set(rows.map((s) => s.id));
    const failedImageTasks = generationTasks.filter((t) => t.project_id === projectId && t.status === 'failed' && t.task_type === 'image' && shotIds.has(t.storyboard_id));
    const failedTextTasks = generationTasks.filter((t) => t.project_id === projectId && t.status === 'failed' && t.task_type === 'text' && shotIds.has(t.storyboard_id));
    const failedVideos = projectVideos.filter((v) => v.status === 'failed' && shotIds.has(v.storyboard_id));
    const failedTotal = failedImageTasks.length + failedTextTasks.length + failedVideos.length;
    const completeShots = rows.filter((s) => {
      const imageOk = !s.image_prompt || Boolean(s.linked_image_id);
      const videoOk = !s.video_prompt || Boolean(s.linked_video_id || s.status === 'video_ready' || s.status === 'done');
      const dialogueOk = !String(s.dialogue || '').trim() || audioByShot.has(s.id + ':dialogue');
      const narrationOk = !String(s.narration || '').trim() || audioByShot.has(s.id + ':narration');
      return imageOk && videoOk && dialogueOk && narrationOk;
    }).length;
    el.innerHTML = `<div class="card" style="padding:12px 16px;margin-bottom:14px">
      <div class="row wrap" style="gap:10px 18px;font-size:12.5px">
        <strong style="color:var(--text)">第 ${episode} 集生产进度</strong>
        <span>镜头 <b>${total}</b></span>
        <span>分镜图 <b>${imageReady}/${total}</b></span>
        <span>视频 <b>${videoReady}/${total}</b></span>
        <span>配音 <b>${audioReady}/${expectedAudio}</b></span>
        <span>完整镜头 <b>${completeShots}/${total}</b></span>
        ${missingImagePrompt ? `<span style="color:var(--warn)">缺图片提示词 ${missingImagePrompt}</span>` : ''}
        ${missingVideoPrompt ? `<span style="color:var(--warn)">缺视频提示词 ${missingVideoPrompt}</span>` : ''}
        ${missingImages ? `<button class="mini-btn" data-select-missing="image">待补图片 ${missingImages}</button>` : ''}
        ${missingVideos ? `<button class="mini-btn" data-select-missing="video">待补视频 ${missingVideos}</button>` : ''}
        ${missingAudio ? `<button class="mini-btn" data-select-missing="audio">待补配音 ${missingAudio}</button>` : ''}
        ${failedTotal ? `<button class="mini-btn" data-failed-tasks="1" style="color:var(--danger)">失败任务 ${failedTotal}</button>` : ''}
        ${completeShots === total ? `<span class="badge green">本集素材已出齐</span>` : ''}
      </div>
    </div>`;
  }

  container.querySelector('#production-summary')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-select-missing]');
    if (b) selectMissing(b.getAttribute('data-select-missing'));
  });
  container.querySelector('#production-summary')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-failed-tasks]');
    if (b) navigate('tasks', { project: projectId, episode: String(episode), status: 'failed' });
  });

  function selectMissing(kind) {
    const audioKeys = new Set(audioAssets.filter((a) => a.status === 'completed').map((a) => a.storyboard_id + ':' + a.audio_type));
    selected.clear();
    rows.forEach((s) => {
      const missing = kind === 'image'
        ? Boolean(s.image_prompt && !s.linked_image_id)
        : kind === 'video'
          ? Boolean(s.video_prompt && !s.linked_video_id && s.status !== 'video_ready' && s.status !== 'done')
          : Boolean((String(s.dialogue || '').trim() && !audioKeys.has(s.id + ':dialogue')) || (String(s.narration || '').trim() && !audioKeys.has(s.id + ':narration')));
      if (missing) selected.add(s.id);
    });
    container.querySelector('#sel-all').checked = selected.size === rows.length;
    renderTable();
    toast.info(`已选中 ${selected.size} 个待补${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '配音'}镜头`);
  }

  // ── 批量任务 ─────────────────────────────────────────────
  function targetShots() {
    const sel = rows.filter((r) => selected.has(r.id));
    return sel.length ? sel : rows;
  }

  function assetSnapshot(text) {
    const used = entityAssets.filter((a) => String(text || '').includes('@' + a.name));
    if (!used.length) return null;
    return {
      captured_at: new Date().toISOString(),
      assets: used.map((a) => ({ id: a.id, name: a.name, asset_type: a.asset_type, description: a.description || '', prompt: a.prompt || '', image_id: a.image_id || null })),
    };
  }

  function expandAssetMentions(text) {
    let out = String(text || '');
    entityAssets.forEach((a) => {
      const detail = String(a.prompt || a.description || '').trim();
      if (detail && out.includes('@' + a.name)) out = out.split('@' + a.name).join('@' + a.name + '（' + detail + '）');
    });
    return out;
  }

  function mentionReference(text) {
    for (const a of entityAssets) {
      if (!a.image_id || !String(text || '').includes('@' + a.name)) continue;
      const img = mentionImages.find((i) => i.id === a.image_id);
      if (img && (img.remote_url || (state.imageHost && state.imageHost.configured && img.url))) return img.remote_url || img.url;
    }
    return '';
  }

  async function batchImages() {
    const base = targetShots();
    const already = base.filter((s) => s.linked_image_id).length;
    const shots = base.filter((s) => s.image_prompt && !s.linked_image_id);
    if (!shots.length) {
      const noPrompt = base.filter((s) => !s.image_prompt).length;
      if (already) toast.info(`没有缺失图片需要生成；已跳过 ${already} 个已有图片的镜头${noPrompt ? `，另有 ${noPrompt} 个缺图片提示词` : ''}`);
      else toast.err('选中的镜头还没有图片提示词，先「批量补图片提示词」');
      return;
    }
    await Promise.all(shots.map((s) => {
      const snap = assetSnapshot(s.image_prompt);
      return snap ? api.updateStoryboard(s.id, { asset_snapshot: snap }) : Promise.resolve({ ok: true });
    }));
    const r = await api.batchImages({
      items: shots.map((s) => ({
        storyboard_id: s.id,
        project_id: projectId,
        prompt: expandAssetMentions(s.image_prompt),
        image: mentionReference(s.image_prompt) || undefined,
        size: '1024x1024',
        usage_type: 'storyboard',
      })),
      concurrency: 3,
    });
    if (r.ok) {
      toast.ok(`已提交 ${r.data.total} 张缺失图片${already ? `，跳过 ${already} 个已有图片的镜头` : ''}`);
      // 批量任务完成后 onEvent('batch') 会自动刷新分镜与图片映射，无需用户手动来回切页。
    } else toast.err(r.error);
  }

  function videoAssetContext(text, shot = null) {
    let prompt = String(text || '');
    const refs = [];
    const roleMap = { character: '角色参考', scene: '场景参考', prop: '道具参考', reference: '参考图' };
    const snapAssets = Array.isArray(shot?.asset_snapshot?.assets) ? shot.asset_snapshot.assets : [];
    const sourceAssets = snapAssets.length ? snapAssets : entityAssets;
    sourceAssets.forEach((a) => {
      if (!prompt.includes('@' + a.name)) return;
      const detail = String(a.prompt || a.description || '').trim();
      if (detail) prompt = prompt.split('@' + a.name).join('@' + a.name + '（' + detail + '）');
      if (!a.image_id) return;
      const img = mentionImages.find((i) => i.id === a.image_id);
      const url = publicImageUrl(img);
      if (url && !refs.some((r) => r.url === url)) refs.push({ url, role: roleMap[a.asset_type] || '参考图' });
    });
    return { prompt, refs };
  }

  async function batchAudios() {
    const base = targetShots();
    const existing = new Set(audioAssets.filter((a) => a.status === 'completed').map((a) => a.storyboard_id + ':' + a.audio_type));
    const items = [];
    let skipped = 0;
    base.forEach((s) => {
      [['dialogue', s.dialogue], ['narration', s.narration]].forEach(([type, raw]) => {
        const text = String(raw || '').trim();
        if (!text) return;
        if (existing.has(s.id + ':' + type)) { skipped += 1; return; }
        items.push({ shot: s, type, text });
      });
    });
    if (!items.length) {
      toast.info(skipped ? `没有缺失配音需要生成；已跳过 ${skipped} 条已有音轨` : '当前镜头没有可生成的台词或旁白');
      return;
    }
    const btn = container.querySelector('#batch-audio');
    btn.disabled = true;
    let ok = 0; const failed = [];
    for (let i = 0; i < items.length; i += 1) {
      const { shot: s, type, text } = items[i];
      btn.textContent = `配音 ${i + 1}/${items.length}`;
      const r = await api.generateTts({ project_id: projectId, storyboard_id: s.id, audio_type: type, speaker: s.characters || '', text, name: `镜头${s.shot_number}_${type === 'dialogue' ? '台词' : '旁白'}` });
      if (r.ok) ok += 1; else failed.push(`#${s.shot_number}${type === 'dialogue' ? '台词' : '旁白'} ${r.error || '生成失败'}`);
    }
    btn.disabled = false; btn.innerHTML = `${icon('play', 14)}只补缺失配音`;
    await load();
    if (failed.length) toast.warn(`配音完成 ${ok}/${items.length} 条；失败 ${failed.length} 条：${failed.slice(0, 3).join('；')}`);
    else toast.ok(`已补齐 ${ok} 条缺失音轨${skipped ? `，跳过 ${skipped} 条已有音轨` : ''}`);
  }

  async function batchVideos() {
    const base = targetShots();
    const already = base.filter((s) => s.linked_video_id || s.status === 'video_ready' || s.status === 'done').length;
    const shots = base.filter((s) => s.video_prompt && !s.linked_video_id && s.status !== 'video_ready' && s.status !== 'done');
    if (!shots.length) {
      const noPrompt = base.filter((s) => !s.video_prompt).length;
      if (already) toast.info(`没有缺失视频需要生成；已跳过 ${already} 个已有视频的镜头${noPrompt ? `，另有 ${noPrompt} 个缺视频提示词` : ''}`);
      else toast.err('选中的镜头还没有视频提示词，先「批量补视频提示词」');
      return;
    }
    // 有分镜图的用图生视频，没有的退回文生视频
    const items = shots.map((s) => {
      const img = s.linked_image_id ? (window.__imgMap?.[s.linked_image_id] || null) : null;
      const publicUrl = publicImageUrl(img);
      const ctx = videoAssetContext(s.video_prompt, s);
      const refs = ctx.refs.filter((r) => r.url !== publicUrl);
      const useMulti = Boolean(publicUrl && refs.length);
      return {
        project_id: projectId,
        storyboard_id: s.id,
        mode: useMulti ? 'multi_image' : (publicUrl ? 'image_to_video' : 'text_to_video'),
        prompt: ctx.prompt,
        image: !useMulti ? (publicUrl || undefined) : undefined,
        source_images: useMulti ? [{ url: publicUrl, role: '当前镜头' }, ...refs].slice(0, 8) : undefined,
        negative_prompt: s.negative_prompt,
        // 按分镜设计的时长出帧数，别一律 5 秒——镜头写 10 秒却出 5 秒，成片节奏就废了
        num_frames: framesForDuration(s.duration_seconds),
        frame_rate: 24,
        width: 1152,
        height: 768,
      };
    });
    const multi = items.filter((i) => i.mode === 'multi_image').length;
    const i2v = items.filter((i) => i.mode === 'image_to_video').length;
    const degraded = items.filter((i) => i.mode === 'text_to_video').length;
    if (degraded) {
      toast.warn(state.imageHost && state.imageHost.configured
        ? `${degraded} 个镜头没有可用的分镜图，已改用文生视频。`
        : `${degraded} 个镜头的分镜图只存在本机，Agnes 抓不到，已改用文生视频。到「设置 → 图床」配一个免费图床后，本地图片会自动上传并走图生视频。`, 8000);
    }
    const r = await api.batchVideos({ items, concurrency: 1 });
    if (r.ok) {
      toast.ok(`已提交 ${r.data.total} 个缺失视频（多图一致性 ${multi} / 图生视频 ${i2v} / 文生视频 ${degraded}${already ? ` / 跳过已有 ${already}` : ''}）`);
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
    const snap = assetSnapshot(s.image_prompt);
    if (snap) await api.updateStoryboard(s.id, { asset_snapshot: snap });
    const r = await api.genImage({
      project_id: projectId,
      storyboard_id: s.id,
      prompt: expandAssetMentions(s.image_prompt),
      image: mentionReference(s.image_prompt) || undefined,
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
      prompt: videoAssetContext(s.video_prompt, s).prompt,
      image: publicUrl || undefined,
      negative_prompt: s.negative_prompt,
      num_frames: framesForDuration(s.duration_seconds),
      frame_rate: 24,
      width: 1152,
      height: 768,
    });
    if (r.ok) { toast.ok('视频任务已提交，去「镜头任务」看进度'); navigate('tasks', { project: projectId }); }
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
      fullscreen: true,
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
        ['#s-desc', '#s-chars', '#s-scene', '#s-action', '#s-ip', '#s-vp'].forEach((sel) => attachAssetMentions(root.querySelector(sel), mentionAssets));
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
