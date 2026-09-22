/**
 * scripts.js — 故事脚本
 * 提示词全部来自「提示词模板」（设置页可改），页面只负责收集变量、展示结果。
 * 这样改提示词不用动代码 —— 原版把提示词写死在组件里，改一个字要重新打包。
 */
import { icon, esc, relTime, extractJson, copyText, SCRIPT_TYPES, modelChoices } from '../consts.js';
import { api } from '../api.js';
import { modal, toast, empty, spinner, options, confirm } from '../ui.js';
import { head, projectPicker } from './helpers.js';
import { state, softRefresh, resolveProjectId, setActiveProject } from '../app.js';

const TAB_TPL = {
  story_concept: 'story_concept',
  plot_summary: 'plot_summary',
  episode_outline: 'episode_outline',
  episode_script: 'episode_script',
  storyboard_script: 'storyboard_script',
};

export default async function scripts(container, params) {
  let tab = params.tab && TAB_TPL[params.tab] ? params.tab : 'story_concept';
  let projectId = resolveProjectId(params.project || '');
  const targetEpisode = Math.max(1, Number(params.episode || 1));
  let templates = [];
  let result = '';
  let generating = false;
  let saved = [];
  const fields = new Map();

  container.innerHTML = `
    ${head({
      title: '故事脚本',
      desc: '用 Agnes 文本模型从构思走到单集脚本，提示词模板可在设置页调整',
      actions: `
        ${projectPicker(state.projects, projectId, { id: 'p-picker', allowEmpty: true, emptyLabel: '未选择项目' })}
        <button class="btn" id="reload">${icon('refresh', 16)}</button>`,
    })}
    <div class="grid" style="grid-template-columns:minmax(0,1.55fr) minmax(0,1fr);gap:20px">
      <div>
        <div class="segmented" id="tabs" style="grid-template-columns:repeat(5,1fr);margin-bottom:18px">
          ${SCRIPT_TYPES.map((t) => `<button data-tab="${t.value}" class="${t.value === tab ? 'on' : ''}">${esc(t.label)}</button>`).join('')}
        </div>
        <div class="card">
          <div class="card-title">${icon('wand', 15)}生成输入</div>
          <div id="fields">${spinner()}</div>
          <div class="divider"></div>
          <div class="row wrap">
            <select class="select select-sm" id="model" style="width:190px"></select>
            <button class="btn btn-primary" id="gen" style="flex:1;min-width:160px">${icon('wand', 15)}生成内容</button>
          </div>
          <div id="gen-status"></div>
        </div>

        <div id="result-wrap" style="margin-top:18px"></div>
      </div>

      <div>
        <div class="card-title" style="padding-left:4px">${icon('history', 15)}已保存脚本</div>
        <div id="saved">${spinner()}</div>
      </div>
    </div>`;

  const picker = container.querySelector('#p-picker');
  picker.onchange = () => { projectId = picker.value; setActiveProject(projectId); loadSaved(); };
  container.querySelector('#reload').onclick = () => { loadTemplates(); loadSaved(); };
  container.querySelector('#tabs').querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => { tab = b.getAttribute('data-tab'); syncTabs(); renderFields(); };
  });
  container.querySelector('#gen').onclick = generate;

  function syncTabs() {
    container.querySelectorAll('#tabs [data-tab]').forEach((b) => {
      b.classList.toggle('on', b.getAttribute('data-tab') === tab);
    });
  }

  function tplOf(type) {
    return templates.find((t) => t.template_type === type) || null;
  }

  function varsOf(tpl) {
    const set = [];
    const re = /\{\{([^}]+)\}\}/g;
    let m;
    while ((m = re.exec(tpl.content || ''))) if (!set.includes(m[1])) set.push(m[1]);
    return set;
  }

  function renderFields() {
    const tpl = tplOf(TAB_TPL[tab]);
    const box = container.querySelector('#fields');
    if (!tpl) {
      box.innerHTML = `<div class="note orange">这个类型还没有模板，去「设置 → 提示词模板」新建一个。</div>`;
      return;
    }
    const vs = varsOf(tpl);
    box.innerHTML = `
      <div style="font-size:11.5px;color:var(--text-3);margin-bottom:14px">
        模板：${esc(tpl.name)}${tpl.notes ? ` · ${esc(tpl.notes)}` : ''}
      </div>
      <div class="grid g2" style="gap:0 14px">
        ${vs.map((v) => {
          const long = /脚本|内容|梗概|大纲/.test(v);
          const val = fields.get(v) || '';
          return long
            ? `<div class="field" style="grid-column:1/-1"><label>${esc(v)}</label>
                 <textarea class="textarea" data-var="${esc(v)}" rows="5" placeholder="粘贴${esc(v)}…">${esc(val)}</textarea></div>`
            : `<div class="field"><label>${esc(v)}</label>
                 <input class="input" data-var="${esc(v)}" value="${esc(val)}" /></div>`;
        }).join('')}
      </div>`;
    box.querySelectorAll('[data-var]').forEach((el) => {
      el.oninput = () => fields.set(el.getAttribute('data-var'), el.value);
    });
    if (tab === 'episode_script') {
      box.querySelectorAll('[data-var]').forEach((el) => {
        const key = el.getAttribute('data-var') || '';
        if (/集数|第几集|episode/i.test(key) && !el.value) {
          el.value = String(targetEpisode);
          fields.set(key, el.value);
        }
      });
    }

    // 模型下拉
    const ms = container.querySelector('#model');
    const models = modelChoices(state.models, 'text', [state.settings.default_text_model || 'agnes-2.0-flash', 'agnes-2.0-pro', 'agnes-2.0-flash']);
    const current = ms.value || models[0]?.value;
    ms.innerHTML = options(models, 'value', 'label', current);
  }

  function outlineEpisode(content, ep) {
    const parsed = extractJson(content || '');
    if (!Array.isArray(parsed)) return null;
    return parsed.find((x, i) => Number(x?.episode ?? x?.episode_number ?? i + 1) === Number(ep)) || null;
  }

  async function preloadEpisodeOutline() {
    if (tab !== 'episode_script' || !projectId) return;
    const r = await api.scripts(projectId);
    if (!r.ok) return;
    const outlines = (r.data || []).filter((s) => s.script_type === 'episode_outline').sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    for (const outline of outlines) {
      const item = outlineEpisode(outline.content, targetEpisode);
      if (!item) continue;
      const text = JSON.stringify(item, null, 2);
      fields.set('本集大纲', text);
      const input = container.querySelector('[data-var="本集大纲"]');
      if (input && !input.value.trim()) input.value = text;
      return;
    }
  }

  async function generate() {
    const tpl = tplOf(TAB_TPL[tab]);
    if (!tpl) return;
    if (!state.settings.agnes_api_key) {
      toast.err('还没配置 Agnes API Key，请到「设置」页填写。');
      return;
    }
    let prompt = tpl.content || '';
    for (const [k, v] of fields) prompt = prompt.split(`{{${k}}}`).join(v || '');
    prompt = prompt.replace(/\{\{[^}]+\}\}/g, '（未填写）');

    generating = true;
    const st = container.querySelector('#gen-status');
    st.innerHTML = `<div class="row" style="margin-top:12px;color:var(--gold-light)"><div class="spinner sm"></div><span style="font-size:12.5px">Agnes 正在生成，稍候…</span></div>`;
    container.querySelector('#gen').disabled = true;

    const r = await api.genText({
      messages: [
        { role: 'system', content: tpl.system || '你是专业的AI短视频漫剧编剧。请用中文回答。' },
        { role: 'user', content: prompt },
      ],
      model: container.querySelector('#model').value,
      project_id: projectId || null,
      note: tpl.name,
    });

    generating = false;
    container.querySelector('#gen').disabled = false;
    st.innerHTML = '';

    if (!r.ok) { toast.err(r.error); return; }
    result = r.data.content || '';
    renderResult();
  }

  function renderResult() {
    const wrap = container.querySelector('#result-wrap');
    if (!result) { wrap.innerHTML = ''; return; }
    const parsed = extractJson(result);
    wrap.innerHTML = `
      <div class="card">
        <div class="row wrap" style="margin-bottom:12px">
          <div class="card-title" style="margin:0">${icon('fileText', 15)}生成结果</div>
          <div class="spacer"></div>
          <button class="btn btn-xs" id="r-copy">${icon('copy', 12)}复制</button>
          <button class="btn btn-xs" id="r-save">${icon('save', 12)}保存到项目</button>
          ${parsed && Array.isArray(parsed)
            ? `<button class="btn btn-xs" id="r-storyboard">${icon('film', 12)}导入分镜表</button>` : ''}
        </div>
        ${parsed ? `
          <div class="tabs" style="margin-bottom:12px">
            <button class="on" data-view="json">格式化</button>
            <button data-view="raw">原文</button>
          </div>` : ''}
        <pre class="json-out" id="r-out">${esc(parsed ? JSON.stringify(parsed, null, 2) : result)}</pre>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="section-label">脚本优化</div>
        <div class="chips" id="opt-chips"></div>
      </div>`;

    const out = wrap.querySelector('#r-out');
    wrap.querySelectorAll('[data-view]').forEach((b) => {
      b.onclick = () => {
        wrap.querySelectorAll('[data-view]').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        out.textContent = b.getAttribute('data-view') === 'json' ? JSON.stringify(parsed, null, 2) : result;
      };
    });
    wrap.querySelector('#r-copy').onclick = () => {
      copyText(result).then(() => toast.ok('已复制')).catch(() => toast.err('复制失败'));
    };
    wrap.querySelector('#r-save').onclick = async () => {
      if (!projectId) { toast.err('先在右上角选择项目'); return; }
      const r = await api.createScript({
        project_id: projectId,
        script_type: tab,
        episode_number: tab === 'episode_script' || tab === 'storyboard_script' ? targetEpisode : null,
        title: `${tab === 'episode_script' ? `第 ${targetEpisode} 集单集脚本` : (SCRIPT_TYPES.find((t) => t.value === tab)?.label || '脚本')} - ${new Date().toLocaleDateString('zh-CN')}`,
        content: result,
        model_name: container.querySelector('#model')?.value || '',
        generation_prompt: '',
      });
      if (r.ok) { toast.ok('已保存到项目'); loadSaved(); }
      else toast.err(r.error);
    };
    const sbBtn = wrap.querySelector('#r-storyboard');
    if (sbBtn) sbBtn.onclick = async () => {
      if (!projectId) { toast.err('请先选择项目'); return; }
      const saved = await api.createScript({ project_id: projectId, script_type: tab, episode_number: tab === 'episode_script' || tab === 'storyboard_script' ? targetEpisode : null, title: `${tab === 'episode_script' ? `第 ${targetEpisode} 集单集脚本` : (SCRIPT_TYPES.find((t) => t.value === tab)?.label || '脚本')} - ${new Date().toLocaleDateString('zh-CN')}`, content: result, model_name: container.querySelector('#model')?.value || '', generation_prompt: '' });
      if (!saved.ok) { toast.err('保存脚本失败：' + (saved.error || '未知错误')); return; }
      location.hash = `#/storyboards?project=${encodeURIComponent(projectId)}&episode=${targetEpisode}&source_script=${encodeURIComponent(saved.data.id)}`;
    };

    // 优化按钮：用 optimize 类型模板
    const opts = templates.filter((t) => t.template_type === 'optimize');
    const chips = wrap.querySelector('#opt-chips');
    chips.innerHTML = opts.map((t) => `<button class="chip" data-tpl="${esc(t.id)}">${esc(t.name)}</button>`).join('')
      || `<span style="font-size:12px;color:var(--text-3)">没有可用的优化模板</span>`;
    chips.querySelectorAll('[data-tpl]').forEach((b) => {
      b.onclick = () => optimize(opts.find((t) => t.id === b.getAttribute('data-tpl')));
    });
  }

  async function optimize(tpl) {
    if (!tpl || !result) return;
    const st = container.querySelector('#gen-status');
    st.innerHTML = `<div class="row" style="margin-top:12px;color:var(--gold-light)"><div class="spinner sm"></div><span style="font-size:12.5px">正在${esc(tpl.name)}…</span></div>`;
    const prompt = (tpl.content || '').replace(/\{\{[^}]+\}\}/g, result);
    const r = await api.genText({
      messages: [
        { role: 'system', content: tpl.system || '你是专业的AI短视频漫剧编剧。' },
        { role: 'user', content: prompt },
      ],
      model: container.querySelector('#model')?.value,
      project_id: projectId || null,
      note: tpl.name,
    });
    st.innerHTML = '';
    if (!r.ok) { toast.err(r.error); return; }
    result = r.data.content || result;
    renderResult();
    toast.ok(`已${tpl.name}`);
  }

  /** 把分镜脚本 JSON 一次性写入分镜表 */
  async function importStoryboard(parsed) {
    if (!Array.isArray(parsed) || !parsed.length) { toast.err('结果不是镜头数组，无法导入'); return; }
    if (!projectId) { toast.err('请先选择项目'); return; }
    const ep = Number(await modalEp()) || 1;
    const rows = parsed.map((s, i) => ({
      project_id: projectId,
      episode_number: ep,
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
    const r = await api.createStoryboards(rows);
    if (r.ok) {
      toast.ok(`已导入 ${r.data.inserted || rows.length} 个镜头到分镜表`);
      location.hash = `#/storyboards?project=${encodeURIComponent(projectId)}&episode=${ep}`;
    } else toast.err(r.error);
  }

  function modalEp() {
    return new Promise((resolve) => {
      modal({
        title: '导入到第几集',
        body: `<div class="field"><label>集数</label><input class="input" id="ep" type="number" min="1" value="1" /></div>`,
        footer: `<button class="btn" data-no>取消</button><button class="btn btn-primary" data-yes>导入</button>`,
        onMount(root, close) {
          const i = root.querySelector('#ep');
          i.focus();
          root.querySelector('[data-no]').onclick = () => { close(); resolve(null); };
          root.querySelector('[data-yes]').onclick = () => { const v = i.value; close(); resolve(v); };
        },
      });
    });
  }

  async function loadSaved() {
    const el = container.querySelector('#saved');
    if (!projectId) {
      el.innerHTML = `<div class="card">${empty('未选择项目', '选择项目后可查看已保存的脚本', 'folder')}</div>`;
      return;
    }
    const r = await api.scripts(projectId);
    if (!r.ok) { el.innerHTML = `<div class="note red">${esc(r.error)}</div>`; return; }
    saved = (r.data || []).filter((s) => s.script_type === tab);
    if (!saved.length) {
      el.innerHTML = `<div class="card">${empty('暂无保存记录', '生成后点「保存到项目」', 'script')}</div>`;
      return;
    }
    el.innerHTML = saved.map((s) => `
      <div class="card" style="margin-bottom:10px;padding:14px">
        <div class="row" style="align-items:flex-start">
          <div style="flex:1;min-width:0">
            <div style="font-size:12.5px;font-weight:550">${esc(s.title)}</div>
            <div style="font-size:11px;color:var(--text-4);margin-top:3px">${esc(relTime(s.created_at))}${s.model_name ? ` · ${esc(s.model_name)}` : ''}</div>
          </div>
          <button class="icon-btn" data-use="${esc(s.id)}" title="载入到结果区" style="background:rgba(255,255,255,0.07);color:var(--text-2)">${icon('edit', 13)}</button>
          <button class="icon-btn danger" data-del="${esc(s.id)}" title="删除" style="background:rgba(255,255,255,0.07);color:var(--text-2)">${icon('trash', 13)}</button>
        </div>
        <pre class="json-out" style="max-height:110px;margin-top:9px">${esc(String(s.content).slice(0, 700))}${String(s.content).length > 700 ? '\n…' : ''}</pre>
      </div>`).join('');

    el.querySelectorAll('[data-use]').forEach((b) => {
      b.onclick = () => {
        const s = saved.find((x) => x.id === b.getAttribute('data-use'));
        if (s) { result = s.content; renderResult(); toast.ok('已载入'); }
      };
    });
    el.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        const id = b.getAttribute('data-del');
        if (!(await confirm({ text: '删除这条脚本记录？', danger: true, okText: '删除' }))) return;
        const r2 = await api.deleteScript(id);
        if (r2.ok) { toast.ok('已删除'); loadSaved(); }
        else toast.err(r2.error);
      };
    });
  }

  async function loadTemplates() {
    const r = await api.templates();
    if (r.ok) templates = r.data || [];
    else templates = [];
    renderFields();
  }

  await loadTemplates();
  await preloadEpisodeOutline();
  await loadSaved();
}
