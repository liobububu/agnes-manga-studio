/**
 * images.js — 图片生成
 * 文生图 / 图生图。生成结果直接落盘到本地素材库（不再依赖公网图床）。
 */
import { icon, esc, copyText, IMAGE_SIZES, IMAGE_USAGES, modelChoices } from '../consts.js';
import { api } from '../api.js';
import { modal, toast, empty, spinner, confirm, options, attachAssetMentions } from '../ui.js';
import { head, projectPicker } from './helpers.js';
import { state, navigate, resolveProjectId, setActiveProject } from '../app.js';

export default async function images(container, params) {
  let projectId = resolveProjectId(params.project || '');
  let storyboardId = params.storyboard || '';
  let episode = Number(params.episode || 0);
  let mode = 't2i';
  let items = [];
  let generating = false;
  let referenceImages = [];
  let entityAssets = [];
  const entityLabel = { character: '角色', scene: '场景', prop: '道具', reference: '参考资产' };
  const mentionAssets = () => [
    ...entityAssets.map((a) => ({ name: a.name, meta: entityLabel[a.asset_type] || '资产' })),
    ...referenceImages.map((i) => ({ name: i.name || '未命名图片', meta: i.project_id === projectId ? '当前项目图片' : '图片素材' })),
  ];
  const expandEntityPrompt = (text) => {
    let out = text;
    entityAssets.forEach((a) => {
      const detail = String(a.prompt || a.description || '').trim();
      if (detail && out.includes('@' + a.name)) out = out.split('@' + a.name).join('@' + a.name + '（' + detail + '）');
    });
    return out;
  };

  container.innerHTML = `
    ${head({
      title: '图片生成',
      desc: 'Agnes 图像模型 · 生成结果自动保存到本机素材库',
      actions: `
        ${projectPicker(state.projects, projectId, { id: 'p-picker', allowEmpty: true, emptyLabel: '未选择项目' })}
        <button class="btn btn-sm" id="back-storyboards">${icon('film', 13)}回到分镜</button>
        <button class="btn btn-sm" id="go-assets">${icon('grid', 13)}素材库</button>
        <button class="btn" id="reload">${icon('refresh', 16)}</button>`,
    })}
    <div class="grid" style="grid-template-columns:minmax(320px,0.85fr) minmax(0,2fr);gap:20px">
      <div>
        <div class="card">
          <div class="card-title">${icon('image', 15)}生成参数</div>
          <div class="field">
            <label>模型</label>
            <select class="select" id="model"></select>
          </div>
          <div class="segmented" id="mode" style="grid-template-columns:1fr 1fr;margin-bottom:16px">
            <button data-mode="t2i" class="on">文生图</button>
            <button data-mode="i2i">图生图</button>
          </div>

          <div id="t2i-box">
            ${projectId ? `<div class="field"><label>关联分镜（可选）</label><select class="select" id="sb-sel"></select></div>` : ''}
            <div class="field">
              <label>图片提示词</label>
              <textarea class="textarea mono" id="t2i-prompt" rows="6" placeholder="描述画面，支持中英文&#10;例：cinematic anime style, a young woman in red dress, golden hour, detailed background"></textarea>
            </div>
            <div class="grid g2" style="gap:0 12px">
              <div class="field"><label>尺寸</label><select class="select" id="t2i-size">${options(IMAGE_SIZES, 'value', 'label', '1024x1024')}</select></div>
              <div class="field"><label>用途</label><select class="select" id="t2i-usage">${options(IMAGE_USAGES, 'value', 'label', 'storyboard')}</select></div>
            </div>
          </div>

          <div id="i2i-box" style="display:none">
            <div class="field">
              <label>原图</label>
              <input class="input mono" id="i2i-url" placeholder="可粘贴公网 URL，或从素材库选择" />
              <select class="select select-sm" id="i2i-pick" style="margin-top:8px"></select>
              <div class="hint">优先从素材库选择。已配置图床时，本机图片也可直接选，提交时自动上传；未配置时只能使用已有公网地址的素材。</div>
            </div>
            <div class="field">
              <label>编辑指令</label>
              <textarea class="textarea" id="i2i-prompt" rows="5" placeholder="描述想怎么改这张图…"></textarea>
            </div>
            <div class="grid g2" style="gap:0 12px">
              <div class="field"><label>输出尺寸</label><select class="select" id="i2i-size">${options(IMAGE_SIZES, 'value', 'label', '1024x1024')}</select></div>
              <div class="field">
                <label>保留原构图</label>
                <div class="row"><div class="switch on" id="i2i-keep"></div><span style="font-size:12px;color:var(--text-3)">开启后追加 preserve composition</span></div>
              </div>
            </div>
          </div>

          <button class="btn btn-primary btn-block" id="gen">${icon('wand', 15)}生成图片</button>
          <div id="status"></div>
        </div>
      </div>

      <div>
        <div class="row" style="margin-bottom:12px">
          <div class="card-title" style="margin:0">${icon('grid', 15)}已生成图片</div>
          <span class="badge gray" id="count">0</span>
        </div>
        <div id="gallery" class="asset-grid">${spinner()}</div>
      </div>
    </div>`;

  const picker = container.querySelector('#p-picker');
  picker.onchange = () => { projectId = picker.value; storyboardId = ''; setActiveProject(projectId); loadStoryboards(); load(); };
  container.querySelector('#reload').onclick = () => load();
  container.querySelector('#back-storyboards').onclick = () => projectId ? navigate('storyboards', { project: projectId, ...(episode ? { episode: String(episode) } : {}) }) : toast.warn('先选择一个项目');
  container.querySelector('#go-assets').onclick = () => navigate('assets', projectId ? { project: projectId } : {});
  container.querySelector('#gen').onclick = generate;
  attachAssetMentions(container.querySelector('#t2i-prompt'), mentionAssets);
  attachAssetMentions(container.querySelector('#i2i-prompt'), mentionAssets);
  container.querySelectorAll('#mode [data-mode]').forEach((b) => {
    b.onclick = () => {
      mode = b.getAttribute('data-mode');
      container.querySelectorAll('#mode [data-mode]').forEach((x) => x.classList.toggle('on', x === b));
      container.querySelector('#t2i-box').style.display = mode === 't2i' ? '' : 'none';
      container.querySelector('#i2i-box').style.display = mode === 'i2i' ? '' : 'none';
    };
  });
  const keep = container.querySelector('#i2i-keep');
  keep.onclick = () => keep.classList.toggle('on');

  // 模型下拉
  const ms = modelChoices(state.models, 'image', [state.settings.default_image_model || 'agnes-image-2.1-flash', 'agnes-image-2.0-flash']);
  container.querySelector('#model').innerHTML = options(ms, 'value', 'label', ms[0]?.value);

  // 分镜下拉
  async function loadStoryboards() {
    if (!projectId) return;
    const r = await api.storyboards(projectId, episode || undefined);
    const sel = container.querySelector('#sb-sel');
    if (!sel) return;
    const list = (r.ok && r.data) || [];
    sel.innerHTML = `<option value="">不关联</option>`
      + list.map((s) => `<option value="${esc(s.id)}">#${esc(s.shot_number)} ${esc(s.shot_type)} - ${esc(String(s.scene_description).slice(0, 22))}</option>`).join('');
    if (storyboardId) {
      sel.value = storyboardId;
      const s = list.find((x) => x.id === storyboardId);
      if (s && s.image_prompt) container.querySelector('#t2i-prompt').value = s.image_prompt;
    }
    sel.onchange = () => {
      storyboardId = sel.value;
      const s = list.find((x) => x.id === storyboardId);
      if (s && s.image_prompt) container.querySelector('#t2i-prompt').value = s.image_prompt;
    };
  }

  function mentionedReference(text) {
    for (const a of entityAssets) {
      if (!a.image_id || !String(text || '').includes('@' + a.name)) continue;
      const img = referenceImages.find((i) => i.id === a.image_id);
      if (img && (img.remote_url || (state.imageHost && state.imageHost.configured && img.url))) return img.remote_url || img.url;
    }
    return '';
  }

  async function generate() {
    if (generating) return;
    const model = container.querySelector('#model').value;
    const st = container.querySelector('#status');
    let payload = { model, project_id: projectId || null };

    if (mode === 't2i') {
      const prompt = expandEntityPrompt(container.querySelector('#t2i-prompt').value.trim());
      if (!prompt) { toast.err('请输入图片提示词'); return; }
      const size = container.querySelector('#t2i-size').value;
      const sz = IMAGE_SIZES.find((s) => s.value === size) || IMAGE_SIZES[0];
      Object.assign(payload, {
        prompt, size, width: sz.w, height: sz.h,
        usage_type: container.querySelector('#t2i-usage').value,
        storyboard_id: container.querySelector('#sb-sel')?.value || null,
      });
      const ref = mentionedReference(container.querySelector('#t2i-prompt').value);
      if (ref) payload.image = ref;
    } else {
      const url = container.querySelector('#i2i-url').value.trim();
      const prompt = expandEntityPrompt(container.querySelector('#i2i-prompt').value.trim());
      if (!prompt) { toast.err('请输入编辑指令'); return; }
      if (!url) { toast.err('请填写原图公网 URL'); return; }
      const size = container.querySelector('#i2i-size').value;
      const sz = IMAGE_SIZES.find((s) => s.value === size) || IMAGE_SIZES[0];
      Object.assign(payload, {
        prompt: keep.classList.contains('on') ? `${prompt}, preserve the original composition` : prompt,
        size, width: sz.w, height: sz.h, image: url, usage_type: 'reference',
      });
    }

    generating = true;
    container.querySelector('#gen').disabled = true;
    st.innerHTML = `<div class="row" style="margin-top:12px;color:var(--gold-light)"><div class="spinner sm"></div><span style="font-size:12.5px">生成中，Agnes 出图通常需要十几秒…</span></div>`;

    const r = await api.genImage(payload);
    generating = false;
    container.querySelector('#gen').disabled = false;
    st.innerHTML = '';
    if (!r.ok) { toast.err(r.error); return; }
    toast.ok(storyboardId ? '图片已生成并自动回填当前镜头' : '图片已生成并保存到素材库');
    await load();
    if (storyboardId) await loadStoryboards();
  }

  async function load() {
    const [r, all, entities] = await Promise.all([api.images(projectId || undefined), api.images(), api.assetEntities(projectId)]);
    const el = container.querySelector('#gallery');
    if (!r.ok) { el.innerHTML = `<div class="note red">${esc(r.error)}</div>`; return; }
    items = r.data || [];
    referenceImages = (all.ok && all.data) || items;
    entityAssets = (entities.ok && entities.data) || [];
    container.querySelector('#count').textContent = items.length;

    // 图生图素材选择器：当前项目优先，但允许跨项目复用收藏/历史素材。
    const pick = container.querySelector('#i2i-pick');
    if (pick) {
      const usable = referenceImages.filter((i) => i.remote_url || (state.imageHost && state.imageHost.configured && i.url));
      pick.innerHTML = `<option value="">从素材库选择参考图…</option>`
        + usable.map((i) => `<option value="${esc(i.remote_url || i.url)}">${esc(i.project_id === projectId ? '当前项目 · ' : '')}${esc(i.name || '未命名图片')}</option>`).join('');
      pick.onchange = () => { if (pick.value) container.querySelector('#i2i-url').value = pick.value; };
    }

    if (!items.length) {
      el.innerHTML = `<div class="card" style="grid-column:1/-1">${empty('还没有生成的图片', '在左侧写提示词点「生成图片」', 'image')}</div>`;
      return;
    }
    el.innerHTML = items.map((img) => `
      <div class="asset-card" data-id="${esc(img.id)}">
        ${img.is_favorited ? `<span class="flag">${icon('star', 14)}</span>` : ''}
        <img src="${esc(img.url)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'loading-wrap',textContent:'图片加载失败'}))" />
        <div class="ovl">
          <div class="top">
            <button class="icon-btn ${img.is_favorited ? 'gold' : ''}" data-fav="${esc(img.id)}" title="收藏">${icon('star', 13)}</button>
            <button class="icon-btn" data-zoom="${esc(img.id)}" title="预览">${icon('eye', 13)}</button>
            <button class="icon-btn danger" data-del="${esc(img.id)}" title="删除">${icon('trash', 13)}</button>
          </div>
          <div class="btm">
            <button class="mini-btn" data-copyurl="${esc(img.id)}">复制 URL</button>
            <button class="mini-btn" data-copyprompt="${esc(img.id)}">复制提示词</button>
            <button class="mini-btn gold" data-tovideo="${esc(img.id)}">${icon('video', 11)}生成视频</button>
            <button class="mini-btn" data-dl="${esc(img.id)}">下载</button>
          </div>
        </div>
      </div>`).join('');

    const bind = (attr, fn) => el.querySelectorAll(`[data-${attr}]`).forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); fn(b.getAttribute(`data-${attr}`)); };
    });
    bind('fav', async (id) => {
      const img = items.find((x) => x.id === id);
      const r = await api.updateImage(id, { is_favorited: !img.is_favorited });
      if (!r.ok) toast.err(r.error || '收藏失败');
      load();
    });
    bind('zoom', (id) => zoom(items.find((x) => x.id === id)));
    bind('del', async (id) => {
      if (!(await confirm({ text: '删除这张图片？本地文件也会一起删。', danger: true, okText: '删除' }))) return;
      const r2 = await api.deleteImage(id);
      if (r2.ok) { toast.ok('已删除'); load(); } else toast.err(r2.error);
    });
    bind('copyurl', (id) => {
      const img = items.find((x) => x.id === id);
      copyText(img.remote_url || img.url).then(() => toast.ok('已复制 URL')).catch(() => toast.err('复制失败'));
    });
    bind('copyprompt', (id) => {
      const img = items.find((x) => x.id === id);
      copyText(img.generation_prompt || '').then(() => toast.ok('已复制提示词')).catch(() => toast.err('复制失败'));
    });
    bind('dl', (id) => {
      const img = items.find((x) => x.id === id);
      const a = document.createElement('a');
      a.href = img.url; a.download = `${img.name}.png`; a.click();
    });
    bind('tovideo', (id) => {
      const img = items.find((x) => x.id === id);
      // 视频页能识别 image_id；本机图片在已配置图床时会由后端自动公网化，不在这里错误阻断。
      const url = img.remote_url || (img.url.startsWith('http') ? img.url : '');
      navigate('videos', { project: img.project_id || projectId, ...(episode ? { episode: String(episode) } : {}), image_url: url, image_id: img.id, storyboard: img.storyboard_id || '' });
      if (!url && !(state.imageHost && state.imageHost.configured)) toast.warn('这张图只有本地地址。配置图床后可自动上传并用于图生视频；当前仍可进入视频页改用文生视频。', 6500);
    });
    el.querySelectorAll('[data-id]').forEach((c) => {
      c.onclick = (e) => {
        if (e.target.closest('button')) return;
        zoom(items.find((x) => x.id === c.getAttribute('data-id')));
      };
    });
  }

  function zoom(img) {
    if (!img) return;
    modal({
      title: img.name || '图片',
      wide: true,
      body: `
        <img src="${esc(img.url)}" style="width:100%;border-radius:14px;display:block" />
        <div style="margin-top:14px">
          <div class="section-label">提示词</div>
          <pre class="json-out">${esc(img.generation_prompt || '（无）')}</pre>
          <div class="kv" style="margin-top:10px"><span class="k">模型</span><span class="v">${esc(img.model_name || '—')}</span></div>
          <div class="kv"><span class="k">尺寸</span><span class="v">${esc(img.size || '—')}</span></div>
          <div class="kv"><span class="k">公网 URL</span><span class="v">${esc(img.remote_url || '（仅本地）')}</span></div>
        </div>`,
      footer: `
        <button class="btn" data-copy>复制提示词</button>
        <a class="btn btn-primary" href="${esc(img.url)}" download="${esc(img.name)}.png">下载</a>`,
      onMount(root, close) {
        root.querySelector('[data-copy]').onclick = () => {
          copyText(img.generation_prompt || '').then(() => toast.ok('已复制')).catch(() => toast.err('复制失败'));
        };
      },
    });
  }

  await loadStoryboards();
  await load();
}
