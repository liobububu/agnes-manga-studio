/**
 * settings.js — 设置（macOS 系统设置风格）
 * API 配置 / 模型 / 任务 / 提示词模板 / 数据管理 / 关于
 */
import { icon, esc, TEMPLATE_TYPES, modelChoices, fmtTime } from '../consts.js';
import { api } from '../api.js';
import { modal, toast, spinner, confirm, options } from '../ui.js';
import { head } from './helpers.js';
import { state, refreshState } from '../app.js';

const SECTIONS = [
  { id: 'api', label: 'Agnes API', icon: 'key' },
  { id: 'model', label: '模型配置', icon: 'cpu' },
  { id: 'host', label: '图床', icon: 'cloud' },
  { id: 'task', label: '任务配置', icon: 'layers' },
  { id: 'templates', label: '提示词模板', icon: 'template' },
  { id: 'data', label: '数据管理', icon: 'database' },
  { id: 'about', label: '关于', icon: 'info' },
];

export default async function settings(container) {
  let section = 'api';
  let settings = {};
  let templates = [];
  let keyVisible = false;
  let draftKey = '';

  container.innerHTML = `
    ${head({ title: '设置', desc: 'API Key 只写进本机配置文件，不会上传到任何地方' })}
    <div class="grid" style="grid-template-columns:190px minmax(0,1fr);gap:22px">
      <div class="nav" style="gap:3px">
        ${SECTIONS.map((s) => `<button class="nav-item" data-sec="${s.id}">${icon(s.icon, 16)}<span class="lbl">${esc(s.label)}</span></button>`).join('')}
      </div>
      <div id="panel"></div>
    </div>`;

  container.querySelectorAll('[data-sec]').forEach((b) => {
    b.onclick = () => { section = b.getAttribute('data-sec'); render(); };
  });

  async function load() {
    const [s, t] = await Promise.all([api.settings(), api.templates()]);
    if (s.ok) settings = s.data || {};
    if (t.ok) templates = t.data || [];
    render();
  }

  async function save(patch, msg = '已保存') {
    const r = await api.saveSettings(patch);
    if (r.ok) {
      settings = r.data.settings || settings;
      toast.ok(msg);
      // 首次配置 Key / 更换 Base URL 后顺手同步一次模型目录；失败不影响设置保存。
      if (patch.agnes_api_key || patch.agnes_api_base_url) {
        const mr = await api.refreshModels();
        if (mr.ok) state.models = mr.data.models;
        else if (mr.data?.models) state.models = mr.data.models;
      }
      await refreshState();
      render();
    } else toast.err(r.error);
  }

  function render() {
    container.querySelectorAll('[data-sec]').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-sec') === section);
    });
    const p = container.querySelector('#panel');
    p.innerHTML = ({
      api: renderApi, model: renderModel, host: renderHost, task: renderTask,
      templates: renderTemplates, data: renderData, about: renderAbout,
    })[section]();
    bindPanel(p);
  }

  // ── API ───────────────────────────────────────────────────
  function renderApi() {
    const has = !!settings.agnes_api_key;
    return `
      <div class="card">
        <div class="card-title">${icon('key', 15)}Agnes API 配置</div>
        <div class="field">
          <label>API Base URL</label>
          <input class="input mono" id="s-base" value="${esc(settings.agnes_api_base_url || '')}" placeholder="https://apihub.agnes-ai.com/v1" />
          <div class="hint">文本走 /v1/chat/completions，图片走 /v1/images/generations，视频创建走 /v1/videos，查询走 /agnesapi。</div>
        </div>
        <div class="field">
          <label>Agnes API Key</label>
          <div class="row">
            <input class="input mono" id="s-key" type="${keyVisible ? 'text' : 'password'}"
              value="${esc(keyVisible ? draftKey : (settings.agnes_api_key_masked || ''))}"
              placeholder="${has ? '已配置，留空表示不修改' : 'sk-…'}" ${keyVisible ? '' : 'disabled'} />
            <button class="btn btn-icon" id="toggle-key" title="显示/编辑">${icon(keyVisible ? 'eye' : 'edit', 15)}</button>
          </div>
          <div class="hint">${has ? `当前：${esc(settings.agnes_api_key_masked || '***')}。点右侧按钮可重新填写。` : '还没有配置 Key，填了才能生成内容。'}</div>
        </div>
        <div class="row wrap">
          <button class="btn btn-primary" id="save-api">${icon('save', 14)}保存配置</button>
          <button class="btn btn-sm" id="refresh-models-api">${icon('refresh', 13)}拉取模型目录</button>
          <div class="spacer"></div>
          <button class="btn btn-sm" data-test="text">${icon('zap', 13)}测试文本</button>
          <button class="btn btn-sm" data-test="image">${icon('image', 13)}测试图片</button>
          <button class="btn btn-sm" data-test="video">${icon('video', 13)}测试视频</button>
        </div>
        <div id="test-out" style="margin-top:12px"></div>
      </div>
      <div class="note gold" style="margin-top:16px">
        ${icon('shield', 14)} Key 保存在本机 <span style="font-family:var(--mono)">settings.json</span>，
        前端永远拿不到明文 —— 所有 Agnes 请求都由本地服务代发。
      </div>`;
  }

  // ── 模型 ──────────────────────────────────────────────────
  function renderModel() {
    const textModels = modelChoices(state.models, 'text', [settings.default_text_model || 'agnes-2.0-flash', 'agnes-2.0-pro']);
    const imageModels = modelChoices(state.models, 'image', [settings.default_image_model || 'agnes-image-2.1-flash']);
    const videoModels = modelChoices(state.models, 'video', [settings.default_video_model || 'agnes-video-v2.0']);
    const cache = state.models || {};
    const cacheText = cache.updated_at ? `上次更新：${esc(fmtTime(cache.updated_at))}` : '尚未拉取过';
    return `
      <div class="card">
        <div class="row" style="margin-bottom:14px">
          <div class="card-title" style="margin:0">${icon('cpu', 15)}模型目录与默认模型</div>
          <div class="spacer"></div>
          <button class="btn btn-sm" id="refresh-models">${icon('refresh', 13)}从 Agnes 拉取模型</button>
        </div>
        <div class="note ${cache.error ? 'orange' : 'gold'}" style="margin-bottom:16px">
          ${cache.error ? icon('alert', 13) + esc(cache.error) : icon('info', 13) + '模型目录会缓存到本机，Agnes 更新模型后点上面的按钮即可刷新。'}
          <span style="margin-left:8px;color:var(--text-3)">${esc(cacheText)} · ${esc(cache.source || 'fallback')} · ${Array.isArray(cache.models) ? cache.models.length : 0} 个模型</span>
        </div>
        <div class="field"><label>默认文本模型</label>
          <select class="select" id="m-text">${options(textModels, 'value', 'label', settings.default_text_model)}</select></div>
        <div class="field"><label>默认图像模型</label>
          <select class="select" id="m-image">${options(imageModels, 'value', 'label', settings.default_image_model)}</select></div>
        <div class="field"><label>默认视频模型</label>
          <select class="select" id="m-video">${options(videoModels, 'value', 'label', settings.default_video_model)}</select></div>
        <div class="hint" style="margin-bottom:14px">模型列表来自 Agnes 的 OpenAI 兼容 <span style="font-family:var(--mono)">GET /v1/models</span>。即使新模型暂时无法识别类型，也会保留为可选项；旧模型会作为回退项保留。</div>
        <div class="grid g2" style="gap:0 14px">
          <div class="field"><label>自动刷新模型目录</label>
            <div class="row"><div class="switch ${settings.auto_refresh_models === '1' ? 'on' : ''}" id="m-auto"></div><span style="font-size:12px;color:var(--text-3)">程序启动时检查缓存是否过期</span></div>
          </div>
          <div class="field"><label>模型缓存有效期（小时）</label><input class="input" id="m-ttl" type="number" min="1" value="${esc(settings.model_cache_ttl_hours || 24)}" /></div>
        </div>
        <button class="btn btn-primary" id="save-model">${icon('save', 14)}保存模型设置</button>
      </div>`;
  }

  // ── 图床 ──────────────────────────────────────────────────
  function renderHost() {
    const hosts = (state.imageHost && state.imageHost.hosts) || [];
    const configured = !!(state.imageHost && state.imageHost.configured);
    const cur = hosts.find((h) => h.value === settings.image_host_type);
    return `
      <div class="card">
        <div class="card-title">${icon('cloud', 15)}图床（让本地图片能用于图生视频）</div>
        <div class="note ${configured ? 'green' : 'orange'}" style="margin-bottom:16px">
          ${configured
            ? `${icon('check', 13)} 已配置 ${esc(state.imageHost.label || '')}：提交图生视频时，本机图片会自动上传成公网地址。`
            : `${icon('alert', 13)} 未配置：本机生成的图片没有公网地址，Agnes 抓不到，图生视频用不了（会自动降级为文生视频）。`}
        </div>
        <div class="field">
          <label>图床服务</label>
          <select class="select" id="h-type">
            <option value="">未启用</option>
            ${hosts.map((h) => `<option value="${esc(h.value)}"${settings.image_host_type === h.value ? ' selected' : ''}>${esc(h.label)}</option>`).join('')}
          </select>
          <div class="hint">都是免费自助申请的服务。程序只在你主动提交图生视频时才上传图片。</div>
        </div>
        <div class="field">
          <label>API Key / Token</label>
          <input class="input mono" id="h-key" type="password" value=""
            placeholder="${esc(cur ? cur.keyHint : (settings.image_host_key_masked ? `已保存（${esc(settings.image_host_key_masked)}），留空表示不修改` : '选择图床后填写'))}" />
        </div>
        ${settings.image_host_type === 'custom'
          ? `<div class="field"><label>上传接口地址</label>
               <input class="input mono" id="h-endpoint" value="${esc(settings.image_host_endpoint || '')}" placeholder="https://…/upload" /></div>`
          : ''}
        <div class="field">
          <label>提交图生视频前自动上传本地图片</label>
          <div class="row">
            <div class="switch ${settings.auto_upload_image === '1' ? 'on' : ''}" id="h-auto"></div>
            <span style="font-size:12px;color:var(--text-3)">关闭后，只有已填公网 URL 的图片能用于图生视频</span>
          </div>
        </div>
        <div class="row wrap">
          <button class="btn btn-primary" id="save-host">${icon('save', 14)}保存图床</button>
          <button class="btn btn-sm" id="test-host">${icon('zap', 13)}测试上传</button>
        </div>
        <div id="host-out" style="margin-top:12px"></div>
      </div>
      <div class="note gold" style="margin-top:16px">
        ${icon('info', 13)} 图床是可选功能。不配置也能正常用文生视频；配置后，本机生成的分镜图可
        直接用于图生视频，不需要你手动传图再复制链接。Key 只存在本机，不会随项目备份导出。
      </div>`;
  }

  // ── 任务 ──────────────────────────────────────────────────
  function renderTask() {
    return `
      <div class="card">
        <div class="card-title">${icon('layers', 15)}任务与轮询</div>
        <div class="grid g2" style="gap:0 14px">
          <div class="field"><label>视频轮询间隔（秒）</label>
            <input class="input" id="t-interval" type="number" min="2" value="${esc(settings.video_poll_interval || 8)}" /></div>
          <div class="field"><label>最大轮询次数</label>
            <input class="input" id="t-max" type="number" min="1" value="${esc(settings.video_max_polls || 60)}" /></div>
          <div class="field"><label>批量默认并发数</label>
            <input class="input" id="t-conc" type="number" min="1" max="8" value="${esc(settings.default_concurrent_tasks || 3)}" /></div>
          <div class="field"><label>提交超时（毫秒）</label>
            <input class="input" id="t-timeout" type="number" min="10000" step="5000" value="${esc(settings.request_timeout_ms || 150000)}" /></div>
        </div>
        <div class="field" style="margin-top:6px">
          <label>视频完成后自动保存到本机</label>
          <div class="row">
            <div class="switch ${settings.auto_download_video === '1' ? 'on' : ''}" id="t-auto"></div>
            <span style="font-size:12px;color:var(--text-3)">开启后生成的视频会自动下载到本地素材库，不怕远端链接过期</span>
          </div>
        </div>
        <button class="btn btn-primary" id="save-task">${icon('save', 14)}保存</button>
      </div>
      <div class="note gold" style="margin-top:16px">
        轮询跑在本地服务里，关掉浏览器也会继续。下次打开程序时，没跑完的任务会自动接着查。
      </div>`;
  }

  // ── 模板 ──────────────────────────────────────────────────
  function renderTemplates() {
    return `
      <div class="card">
        <div class="row" style="margin-bottom:14px">
          <div class="card-title" style="margin:0">${icon('template', 15)}提示词模板</div>
          <div class="spacer"></div>
          <button class="btn btn-sm" id="t-new">${icon('plus', 13)}新建模板</button>
        </div>
        <div class="hint" style="margin-bottom:14px">
          脚本页、分镜页的生成与优化按钮都取自这里。用 <span style="font-family:var(--mono)">{{变量}}</span> 占位，页面会自动生成输入框。
        </div>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>名称</th><th style="width:110px">类型</th><th style="width:52px">内置</th><th style="width:110px">操作</th></tr></thead>
          <tbody>
            ${templates.map((t) => `
              <tr>
                <td>
                  <div style="color:var(--text)">${esc(t.name)}</div>
                  ${t.notes ? `<div style="font-size:11px;color:var(--text-3);margin-top:2px">${esc(t.notes)}</div>` : ''}
                </td>
                <td><span class="badge gray">${esc(TEMPLATE_TYPES.find((x) => x.value === t.template_type)?.label || t.template_type)}</span></td>
                <td>${t.is_builtin ? '<span class="badge gold">内置</span>' : '<span class="badge gray">自定义</span>'}</td>
                <td>
                  <div class="row" style="gap:4px">
                    <button class="icon-btn" data-edit="${esc(t.id)}" style="background:rgba(255,255,255,0.07);color:var(--text-2)">${icon('edit', 13)}</button>
                    <button class="icon-btn danger" data-del="${esc(t.id)}" style="background:rgba(255,255,255,0.07);color:var(--text-3)">${icon('trash', 13)}</button>
                  </div>
                </td>
              </tr>`).join('')}
          </tbody>
        </table></div>
      </div>`;
  }

  // ── 数据 ──────────────────────────────────────────────────
  function renderData() {
    return `
      <div class="card">
        <div class="card-title">${icon('database', 15)}数据管理</div>
        <div class="kv"><span class="k">数据目录</span><span class="v">${esc(state.home || '—')}</span></div>
        <div class="kv"><span class="k">图片素材</span><span class="v">${esc(state.home || '')}/assets/images</span></div>
        <div class="kv"><span class="k">视频素材</span><span class="v">${esc(state.home || '')}/assets/videos</span></div>
        <div class="divider"></div>
        <div class="row wrap">
          <a class="btn" href="/api/export" target="_blank">${icon('download', 14)}导出全量备份</a>
          <button class="btn" id="import-btn">${icon('upload', 14)}导入备份</button>
          <div class="spacer"></div>
          <button class="btn btn-danger" id="wipe">${icon('trash', 14)}清空全部数据</button>
        </div>
        <div class="hint">备份是单个 JSON 文件，包含项目、剧本、分镜、素材记录和任务历史（不含图片/视频文件本身）。</div>
      </div>`;
  }

  // ── 关于 ──────────────────────────────────────────────────
  function renderAbout() {
    return `
      <div class="card">
        <div class="card-title">${icon('info', 15)}关于</div>
        <div class="kv"><span class="k">版本</span><span class="v">${esc(state.version || '1.0.0')}（本地版）</span></div>
        <div class="kv"><span class="k">形态</span><span class="v">本机 HTTP 服务 + 浏览器界面，零云端依赖</span></div>
        <div class="divider"></div>
        <div style="font-size:13px;line-height:1.85;color:var(--text-2)">
          本地版相对云端版做了这些改动：<br>
          · 去掉用户系统：没有注册登录，数据不需要跨账号隔离<br>
          · 去掉 Supabase：项目、剧本、分镜、素材全存本机 JSON 文件<br>
          · 去掉 Edge Function：Agnes 请求由本地服务直接代发，少一层超时<br>
          · 图片生成结果落盘到本地素材库，不再依赖公网图床<br>
          · 视频轮询搬到本地服务后台，关掉浏览器也继续跑<br>
          · 新增：批量生成队列、提示词模板管理、项目导出、全量备份导入<br>
          · 修复：文本/图片任务不再只写库不记录，任务页文本、图片标签有历史了
        </div>
      </div>`;
  }

  function bindPanel(p) {
    if (section === 'api') {
      const keyInput = p.querySelector('#s-key');
      p.querySelector('#toggle-key').onclick = () => {
        keyVisible = !keyVisible;
        if (keyVisible) { draftKey = ''; keyInput.value = ''; keyInput.disabled = false; keyInput.focus(); }
        render();
      };
      p.querySelector('#save-api').onclick = async () => {
        const patch = { agnes_api_base_url: p.querySelector('#s-base').value.trim() };
        if (keyVisible && keyInput.value.trim()) patch.agnes_api_key = keyInput.value.trim();
        await save(patch);
        keyVisible = false;
      };
      p.querySelector('#refresh-models-api').onclick = async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.innerHTML = `<div class="spinner sm"></div>拉取中…`;
        const r = await api.refreshModels();
        btn.disabled = false;
        btn.innerHTML = `${icon('refresh', 13)}拉取模型目录`;
        if (r.ok) {
          state.models = r.data.models;
          toast.ok(`已拉取 ${r.data.models.models.length} 个模型`);
        } else {
          if (r.data?.models) state.models = r.data.models;
          toast.warn(r.error || '模型拉取失败，已保留原目录');
        }
      };
      p.querySelectorAll('[data-test]').forEach((b) => {
        b.onclick = async () => {
          const kind = b.getAttribute('data-test');
          const out = p.querySelector('#test-out');
          out.innerHTML = `<div class="note gold"><div class="row"><div class="spinner sm"></div><span>正在测试${kind === 'text' ? '文本' : kind === 'image' ? '图片' : '视频'}接口…</span></div></div>`;
          const r = await api.testSettings(kind);
          out.innerHTML = r.ok
            ? `<div class="note green">${icon('check', 13)} ${esc(r.data.message)}</div>`
            : `<div class="note red">${icon('x', 13)} ${esc(r.error)}</div>`;
        };
      });
    } else if (section === 'model') {
      p.querySelector('#m-auto').onclick = () => p.querySelector('#m-auto').classList.toggle('on');
      p.querySelector('#refresh-models').onclick = async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.innerHTML = `<div class="spinner sm"></div>拉取中…`;
        const r = await api.refreshModels();
        btn.disabled = false;
        btn.innerHTML = `${icon('refresh', 13)}重新拉取模型`;
        if (r.ok) {
          state.models = r.data.models;
          toast.ok(`已拉取 ${r.data.models.models.length} 个模型`);
        } else {
          if (r.data?.models) state.models = r.data.models;
          toast.warn(r.error || '模型拉取失败，已保留原目录');
        }
        render();
      };
      p.querySelector('#save-model').onclick = () => save({
        default_text_model: p.querySelector('#m-text').value,
        default_image_model: p.querySelector('#m-image').value,
        default_video_model: p.querySelector('#m-video').value,
        auto_refresh_models: p.querySelector('#m-auto').classList.contains('on') ? '1' : '0',
        model_cache_ttl_hours: p.querySelector('#m-ttl').value,
      });
    } else if (section === 'host') {
      p.querySelector('#h-auto').onclick = () => p.querySelector('#h-auto').classList.toggle('on');
      p.querySelector('#save-host').onclick = () => save({
        image_host_type: p.querySelector('#h-type').value,
        image_host_key: p.querySelector('#h-key').value.trim(), // 留空=不修改
        image_host_endpoint: p.querySelector('#h-endpoint') ? p.querySelector('#h-endpoint').value.trim() : '',
        auto_upload_image: p.querySelector('#h-auto').classList.contains('on') ? '1' : '0',
      }, '图床已保存');
      p.querySelector('#test-host').onclick = async (e) => {
        const btn = e.currentTarget;
        const out = p.querySelector('#host-out');
        btn.disabled = true;
        btn.innerHTML = `<div class="spinner sm"></div>测试中…`;
        // 先落盘再测，否则测的是旧配置，会得出「填了却说没配置」的假失败
        await api.saveSettings({
          image_host_type: p.querySelector('#h-type').value,
          image_host_key: p.querySelector('#h-key').value.trim(),
          image_host_endpoint: p.querySelector('#h-endpoint') ? p.querySelector('#h-endpoint').value.trim() : '',
        });
        const r = await api.testImageHost();
        btn.disabled = false;
        btn.innerHTML = `${icon('zap', 13)}测试上传`;
        out.innerHTML = r.ok
          ? `<div class="note green">${icon('check', 13)} ${esc(r.data.message)}</div>`
          : `<div class="note red">${icon('x', 13)} ${esc(r.error || '图床测试失败')}</div>`;
        await refreshState();
        render();
      };
    } else if (section === 'task') {
      const auto = p.querySelector('#t-auto');
      auto.onclick = () => auto.classList.toggle('on');
      p.querySelector('#save-task').onclick = () => save({
        video_poll_interval: p.querySelector('#t-interval').value,
        video_max_polls: p.querySelector('#t-max').value,
        default_concurrent_tasks: p.querySelector('#t-conc').value,
        request_timeout_ms: p.querySelector('#t-timeout').value,
        auto_download_video: auto.classList.contains('on') ? '1' : '0',
      });
    } else if (section === 'templates') {
      p.querySelector('#t-new').onclick = () => templateForm(null);
      p.querySelectorAll('[data-edit]').forEach((b) => {
        b.onclick = () => templateForm(templates.find((t) => t.id === b.getAttribute('data-edit')));
      });
      p.querySelectorAll('[data-del]').forEach((b) => {
        b.onclick = async () => {
          const id = b.getAttribute('data-del');
          if (!(await confirm({ text: '删除这个模板？', danger: true, okText: '删除' }))) return;
          const r = await api.deleteTemplate(id);
          if (r.ok) { toast.ok('已删除'); load(); } else toast.err(r.error);
        };
      });
    } else if (section === 'data') {
      p.querySelector('#import-btn').onclick = importData;
      p.querySelector('#wipe').onclick = async () => {
        const ok = await confirm({
          title: '清空全部数据',
          text: '这会删掉所有项目、剧本、分镜、素材记录和任务历史，<b>不可撤销</b>。<br><br>建议先「导出全量备份」。',
          danger: true, okText: '确认清空',
        });
        if (!ok) return;
        const r = await api.importData({ collections: {} }, 'replace');
        if (r.ok) { toast.ok('已清空'); await refreshState(); } else toast.err(r.error);
      };
    }
  }

  function templateForm(t) {
    const isNew = !t;
    const x = t || { name: '', template_type: 'story_concept', system: '', content: '', negative_prompt: '', notes: '' };
    modal({
      title: isNew ? '新建模板' : '编辑模板',
      wide: true,
      body: `
        <div class="grid g2" style="gap:0 14px">
          <div class="field"><label>名称</label><input class="input" id="tf-name" value="${esc(x.name)}" /></div>
          <div class="field"><label>类型</label><select class="select" id="tf-type">${options(TEMPLATE_TYPES, 'value', 'label', x.template_type)}</select></div>
        </div>
        <div class="field"><label>System 提示词</label><textarea class="textarea" id="tf-sys" rows="2">${esc(x.system)}</textarea></div>
        <div class="field"><label>提示词正文（可用 {{变量}}）</label><textarea class="textarea mono" id="tf-content" rows="8">${esc(x.content)}</textarea></div>
        <div class="field"><label>负面提示词</label><textarea class="textarea mono" id="tf-neg" rows="2">${esc(x.negative_prompt)}</textarea></div>
        <div class="field"><label>备注</label><input class="input" id="tf-notes" value="${esc(x.notes)}" /></div>`,
      footer: `<button class="btn" data-no>取消</button><button class="btn btn-primary" data-yes>保存</button>`,
      onMount(root, close) {
        root.querySelector('[data-no]').onclick = close;
        root.querySelector('[data-yes]').onclick = async () => {
          const payload = {
            name: root.querySelector('#tf-name').value.trim(),
            template_type: root.querySelector('#tf-type').value,
            system: root.querySelector('#tf-sys').value,
            content: root.querySelector('#tf-content').value,
            negative_prompt: root.querySelector('#tf-neg').value,
            notes: root.querySelector('#tf-notes').value,
          };
          if (!payload.name) { toast.err('模板名称不能为空'); return; }
          const r = isNew ? await api.createTemplate(payload) : await api.updateTemplate(x.id, payload);
          if (r.ok) { toast.ok('已保存'); close(); load(); } else toast.err(r.error);
        };
      },
    });
  }

  function importData() {
    modal({
      title: '导入备份',
      body: `
        <div class="field">
          <label>选择备份 JSON 文件</label>
          <input type="file" id="imp-file" accept=".json" class="input" />
        </div>
        <div class="field">
          <label>导入方式</label>
          <select class="select" id="imp-mode">
            <option value="merge">合并（保留现有数据，跳过重复 ID）</option>
            <option value="replace">替换（清空后导入）</option>
          </select>
        </div>`,
      footer: `<button class="btn" data-no>取消</button><button class="btn btn-primary" data-yes>开始导入</button>`,
      onMount(root, close) {
        root.querySelector('[data-no]').onclick = close;
        root.querySelector('[data-yes]').onclick = async () => {
          const f = root.querySelector('#imp-file').files[0];
          if (!f) { toast.err('请选择文件'); return; }
          try {
            const data = JSON.parse(await f.text());
            const r = await api.importData(data, root.querySelector('#imp-mode').value);
            if (r.ok) { toast.ok(`已导入 ${r.data.imported} 条数据`); close(); await refreshState(); }
            else toast.err(r.error);
          } catch (e) { toast.err(`文件解析失败：${e.message}`); }
        };
      },
    });
  }

  await load();
}
