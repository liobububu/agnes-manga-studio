/**
 * assets.js — 素材库
 * 图片 / 视频 / 文本三分栏，Apple Photos 风格。
 */
import { icon, esc, copyText, relTime, IMAGE_USAGES, statusBadge } from '../consts.js';
import { api } from '../api.js';
import { modal, toast, empty, spinner, confirm } from '../ui.js';
import { head, projectPicker } from './helpers.js';
import { state, navigate, resolveProjectId, setActiveProject } from '../app.js';

export default async function assets(container, params) {
  let tab = params.tab || 'image';
  let projectId = params.project === '__all__' ? '' : resolveProjectId(params.project || '');
  let favOnly = false;
  let query = '';
  let status = '';
  let images = [];
  let videos = [];
  let scripts = [];
  let entities = [];

  container.innerHTML = `
    ${head({
      title: '素材库',
      desc: '生成出来的图片、视频、剧本都在这里，全部存在本机',
      actions: `
        ${projectPicker(state.projects, projectId, { id: 'p-picker', allOption: true })}
        <button class="btn btn-sm" id="go-images">${icon('image', 13)}生成图片</button>
        <button class="btn btn-sm" id="go-videos">${icon('video', 13)}生成视频</button>
        <button class="btn btn-sm" id="go-tasks">${icon('tasks', 13)}任务</button>
        <button class="btn btn-sm" id="fav-only">${icon('star', 13)}只看收藏</button>
        <button class="btn" id="reload">${icon('refresh', 16)}</button>`,
    })}
    <div class="card" style="padding:12px 14px;margin-bottom:14px">
      <div class="row" style="gap:10px;align-items:center;flex-wrap:wrap">
        <div style="flex:1;min-width:220px">
          <input class="input" id="asset-search" placeholder="搜索名称、提示词、标签、剧本内容…" />
        </div>
        <select class="select" id="asset-status" style="width:auto;min-width:140px">
          <option value="">全部状态</option>
          <option value="completed">已完成</option>
          <option value="processing">处理中</option>
          <option value="pending">等待中</option>
          <option value="failed">失败</option>
          <option value="local">已存本机</option>
          <option value="remote">仅远程</option>
        </select>
        <div class="hint" id="asset-count" style="margin-left:auto"></div>
      </div>
    </div>
    <div class="tabs" id="tabs" style="margin-bottom:16px">
      <button data-tab="entity">资产设定</button>
      <button data-tab="image" class="on">图片素材</button>
      <button data-tab="video">视频素材</button>
      <button data-tab="text">文本素材</button>
    </div>
    <div id="grid" class="asset-grid">${spinner()}</div>`;

  container.querySelector('#p-picker').onchange = (e) => { projectId = e.target.value === '__all__' ? '' : e.target.value; if (projectId) setActiveProject(projectId); load(); };
  container.querySelector('#reload').onclick = load;
  container.querySelector('#go-images').onclick = () => navigate('images', projectId ? { project: projectId } : {});
  container.querySelector('#go-videos').onclick = () => navigate('videos', projectId ? { project: projectId } : {});
  container.querySelector('#go-tasks').onclick = () => navigate('tasks', projectId ? { project: projectId } : {});
  container.querySelector('#asset-search').oninput = (e) => { query = e.target.value.trim().toLowerCase(); render(); };
  container.querySelector('#asset-status').onchange = (e) => { status = e.target.value; render(); };
  container.querySelector('#fav-only').onclick = (e) => {
    favOnly = !favOnly;
    e.currentTarget.classList.toggle('btn-primary', favOnly);
    render();
  };
  container.querySelectorAll('#tabs [data-tab]').forEach((b) => {
    b.onclick = () => {
      tab = b.getAttribute('data-tab');
      container.querySelectorAll('#tabs [data-tab]').forEach((x) => x.classList.toggle('on', x === b));
      render();
    };
  });

  async function load() {
    const [i, v, s, e] = await Promise.all([api.images(), api.videos(), api.scripts(), api.assetEntities()]);
    if (i.ok) images = i.data || [];
    if (v.ok) videos = v.data || [];
    if (s.ok) scripts = s.data || [];
    if (e.ok) entities = e.data || [];
    render();
  }

  function filtered(list, kind) {
    return list.filter((x) => {
      if (projectId && x.project_id !== projectId) return false;
      if (favOnly && !x.is_favorited) return false;
      if (status) {
        if (status === 'local' && !x.local_file) return false;
        else if (status === 'remote' && (x.local_file || !(x.remote_url || x.video_url))) return false;
        else if (!['local', 'remote'].includes(status) && String(x.status || '').toLowerCase() !== status) return false;
      }
      if (query) {
        const hay = kind === 'text'
          ? [x.title, x.content, x.script_type, x.model_name]
          : [x.name, x.generation_prompt, x.video_prompt, x.usage_type, x.model_name, x.notes, ...(Array.isArray(x.tags) ? x.tags : [])];
        if (!hay.some((v) => String(v || '').toLowerCase().includes(query))) return false;
      }
      return true;
    });
  }

  function projectName(id) {
    return state.projects.find((p) => p.id === id)?.name || '未归属项目';
  }

  function setCount(n, total) {
    const el = container.querySelector('#asset-count');
    if (el) el.textContent = n === total ? `共 ${total} 条` : `显示 ${n} / ${total} 条`;
  }

  function render() {
    const el = container.querySelector('#grid');
    if (tab === 'entity') {
      const labels = { character: '角色', scene: '场景', prop: '道具', reference: '参考' };
      const list = entities.filter((x) => (!projectId || x.project_id === projectId) && (!query || [x.name, x.description, x.prompt, ...(x.tags || [])].some((v) => String(v || '').toLowerCase().includes(query))));
      setCount(list.length, entities.length);
      el.innerHTML = `<div class="card" style="grid-column:1/-1;padding:14px"><div class="row"><div style="flex:1"><b>项目资产设定</b><div class="hint">角色、场景、道具成为可复用资产，可在分镜和生成提示词里直接输入 @名称 调用。</div></div><button class="btn btn-primary" id="add-entity">+ 新建资产</button></div></div>` + (list.length ? list.map((a) => `<div class="card" data-eid="${esc(a.id)}" style="aspect-ratio:auto"><div class="row"><span class="badge">${esc(labels[a.asset_type] || '资产')}</span><b style="flex:1">@${esc(a.name)}</b><button class="btn btn-sm" data-bind="${esc(a.id)}">${a.image_id ? '更换主参考图' : '绑定主参考图'}</button><button class="icon-btn danger" data-de="${esc(a.id)}">${icon('trash',13)}</button></div>${a.image_id ? `<div class="hint" style="margin-top:6px;color:var(--gold-light)">已绑定主参考图</div>` : ''}<div class="hint" style="margin-top:8px">${esc(a.description || a.prompt || '暂无描述')}</div></div>`).join('') : `<div class="card" style="grid-column:1/-1">${empty('还没有资产设定','先建立角色、场景和道具，后续分镜直接 @名称 调用','folder')}</div>`);
      const add = el.querySelector('#add-entity');
      if (add) add.onclick = () => modal({ title:'新建资产', wide:true, body:`<div class="form-grid"><div class="field"><label>类型</label><select class="select" id="ae-type"><option value="character">角色</option><option value="scene">场景</option><option value="prop">道具</option><option value="reference">参考</option></select></div><div class="field"><label>名称</label><input class="input" id="ae-name" placeholder="例如：孙悟空" /></div></div><div class="field"><label>资产描述</label><textarea class="textarea" id="ae-desc" rows="5" placeholder="固定外观、服装、材质、环境等一致性描述"></textarea></div><div class="field"><label>生成提示词</label><textarea class="textarea" id="ae-prompt" rows="5"></textarea></div>`, footer:'<button class="btn" data-no>取消</button><button class="btn btn-primary" data-yes>保存资产</button>', onMount(root,close){root.querySelector('[data-no]').onclick=close;root.querySelector('[data-yes]').onclick=async()=>{const rr=await api.createAssetEntity({project_id:projectId||null,asset_type:root.querySelector('#ae-type').value,name:root.querySelector('#ae-name').value,description:root.querySelector('#ae-desc').value,prompt:root.querySelector('#ae-prompt').value});if(rr.ok){toast.ok('资产已保存');close();load();}else toast.err(rr.error);};} });
      el.querySelectorAll('[data-bind]').forEach((b)=>b.onclick=()=>{const a=entities.find((x)=>x.id===b.dataset.bind);const imgs=images.filter((i)=>!projectId||i.project_id===projectId);if(!imgs.length){toast.warn('当前项目还没有图片素材，请先生成或导入参考图');return;}modal({title:`为 @${a.name} 绑定主参考图`,body:`<div class="field"><label>主参考图</label><select class="select" id="bind-img">${imgs.map((i)=>`<option value="${esc(i.id)}" ${i.id===a.image_id?'selected':''}>${esc(i.name||'未命名图片')}</option>`).join('')}</select></div><div class="hint">后续分镜使用 @${esc(a.name)} 时，系统可以继续继承这张参考图。</div>`,footer:'<button class="btn" data-no>取消</button><button class="btn btn-primary" data-yes>绑定</button>',onMount(root,close){root.querySelector('[data-no]').onclick=close;root.querySelector('[data-yes]').onclick=async()=>{const rr=await api.updateAssetEntity(a.id,{image_id:root.querySelector('#bind-img').value});if(rr.ok){toast.ok('主参考图已绑定');close();load();}else toast.err(rr.error);};}});});
      el.querySelectorAll('[data-de]').forEach((b)=>b.onclick=async()=>{if(!(await confirm({text:'删除这个资产设定？',danger:true,okText:'删除'})))return;const rr=await api.deleteAssetEntity(b.dataset.de);if(rr.ok){toast.ok('已删除');load();}else toast.err(rr.error);});
      return;
    }
    if (tab === 'image') {
      const list = filtered(images, 'image');
      setCount(list.length, images.length);
      if (!list.length) { el.innerHTML = `<div class="card" style="grid-column:1/-1">${empty('没有图片素材', '去「图片生成」生成一张', 'image')}</div>`; return; }
      el.innerHTML = list.map((img) => `
        <div class="asset-card" data-id="${esc(img.id)}">
          ${img.is_favorited ? `<span class="flag">${icon('star', 14)}</span>` : ''}
          <img src="${esc(img.url)}" loading="lazy" alt="" />
          <div class="ovl">
            <div class="top">
              <button class="icon-btn ${img.is_favorited ? 'gold' : ''}" data-fav="${esc(img.id)}">${icon('star', 13)}</button>
              <button class="icon-btn" data-zoom="${esc(img.id)}">${icon('eye', 13)}</button>
              <button class="icon-btn danger" data-del="${esc(img.id)}">${icon('trash', 13)}</button>
            </div>
            <div class="btm">
              <span class="mini-btn">${esc(IMAGE_USAGES.find((u) => u.value === img.usage_type)?.label || img.usage_type || '图片')}</span>
              <span class="mini-btn" title="所属项目">${esc(projectName(img.project_id))}</span>
              ${img.remote_url
                ? '<span class="mini-btn" style="background:rgba(52,211,153,0.30)" title="有公网地址，可用于图生视频">可图生视频</span>'
                : '<span class="mini-btn" style="background:rgba(255,159,10,0.26)" title="只有本机地址，Agnes 抓不到，需填公网 URL">仅本机</span>'}
              <button class="mini-btn" data-cp="${esc(img.id)}">复制提示词</button>
              <button class="mini-btn gold" data-vid="${esc(img.id)}">${icon('video', 11)}生成视频</button>
            </div>
          </div>
        </div>`).join('');
      bindImage(el);
    } else if (tab === 'video') {
      const list = filtered(videos, 'video');
      setCount(list.length, videos.length);
      if (!list.length) { el.innerHTML = `<div class="card" style="grid-column:1/-1">${empty('没有视频素材', '去「视频生成」提交一个任务', 'video')}</div>`; return; }
      el.innerHTML = list.map((v) => `
        <div class="asset-card" data-vid="${esc(v.id)}">
          ${v.is_favorited ? `<span class="flag">${icon('star', 14)}</span>` : ''}
          <span class="status-flag">${statusBadge(v.status)}</span>
          ${v.local_file
            ? `<video src="/assets/videos/${esc(v.local_file.split(/[\\/]/).pop())}" muted preload="metadata" style="width:100%;height:100%;object-fit:cover"></video>`
            : v.video_url
              ? `<video src="${esc(v.video_url)}" muted preload="metadata" style="width:100%;height:100%;object-fit:cover"></video>`
              : `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-4);font-size:12px">生成中…</div>`}
          <div class="ovl">
            <div class="top">
              <button class="icon-btn ${v.is_favorited ? 'gold' : ''}" data-favv="${esc(v.id)}">${icon('star', 13)}</button>
              <button class="icon-btn" data-open="${esc(v.id)}">${icon('play', 13)}</button>
              <button class="icon-btn danger" data-delv="${esc(v.id)}">${icon('trash', 13)}</button>
            </div>
            <div class="btm">
              <span class="mini-btn">${esc(relTime(v.created_at))}</span>
              <span class="mini-btn" title="所属项目">${esc(projectName(v.project_id))}</span>
              ${v.video_url && !v.local_file ? `<button class="mini-btn gold" data-save="${esc(v.id)}">保存到本机</button>` : ''}
              ${v.local_file ? `<span class="mini-btn">已存本机</span>` : ''}
            </div>
          </div>
        </div>`).join('');
      bindVideo(el);
    } else {
      const list = filtered(scripts, 'text');
      setCount(list.length, scripts.length);
      if (!list.length) { el.innerHTML = `<div class="card" style="grid-column:1/-1">${empty('没有文本素材', '去「故事脚本」生成并保存', 'script')}</div>`; return; }
      el.innerHTML = list.map((s) => `
        <div class="card" data-sid="${esc(s.id)}" style="aspect-ratio:auto;cursor:pointer">
          <div class="row" style="align-items:flex-start">
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:550;margin-bottom:4px">${esc(s.title)}</div>
              <div style="font-size:11px;color:var(--text-4)">${esc(relTime(s.created_at))}</div>
              <div style="font-size:11px;color:var(--text-3);margin-top:3px">${esc(projectName(s.project_id))}${s.script_type ? ` · ${esc(s.script_type)}` : ''}</div>
            </div>
            <button class="icon-btn danger" data-dels="${esc(s.id)}" style="background:rgba(255,255,255,0.07);color:var(--text-3)">${icon('trash', 13)}</button>
          </div>
          <pre class="json-out" style="max-height:150px;margin-top:10px">${esc(String(s.content).slice(0, 500))}${String(s.content).length > 500 ? '\n…' : ''}</pre>
        </div>`).join('');
      el.querySelectorAll('[data-dels]').forEach((b) => {
        b.onclick = async (e) => {
          e.stopPropagation();
          if (!(await confirm({ text: '删除这条剧本？', danger: true, okText: '删除' }))) return;
          const r = await api.deleteScript(b.getAttribute('data-dels'));
          if (r.ok) { toast.ok('已删除'); load(); } else toast.err(r.error);
        };
      });
      el.querySelectorAll('[data-sid]').forEach((c) => {
        c.onclick = () => {
          const s = scripts.find((x) => x.id === c.getAttribute('data-sid'));
          modal({ title: s.title, wide: true, body: `<pre class="json-out" style="max-height:60vh">${esc(s.content)}</pre>` });
        };
      });
    }
  }

  function bindImage(el) {
    el.querySelectorAll('[data-fav]').forEach((b) => b.onclick = async (e) => {
      e.stopPropagation();
      const img = images.find((x) => x.id === b.getAttribute('data-fav'));
      const r = await api.updateImage(img.id, { is_favorited: !img.is_favorited });
      if (!r.ok) toast.err(r.error || '收藏失败');
      load();
    });
    el.querySelectorAll('[data-cp]').forEach((b) => b.onclick = (e) => {
      e.stopPropagation();
      const img = images.find((x) => x.id === b.getAttribute('data-cp'));
      copyText(img.generation_prompt || '').then(() => toast.ok('已复制提示词')).catch(() => toast.err('复制失败'));
    });
    el.querySelectorAll('[data-vid]').forEach((b) => b.onclick = (e) => {
      e.stopPropagation();
      const img = images.find((x) => x.id === b.getAttribute('data-vid'));
      navigate('videos', { image_url: img.remote_url || img.url || '', image_id: img.id, project: img.project_id || '', storyboard: img.storyboard_id || '' });
    });
    el.querySelectorAll('[data-del]').forEach((b) => b.onclick = async (e) => {
      e.stopPropagation();
      if (!(await confirm({ text: '删除这张图片？本地文件也会删。', danger: true, okText: '删除' }))) return;
      const r = await api.deleteImage(b.getAttribute('data-del'));
      if (r.ok) { toast.ok('已删除'); load(); } else toast.err(r.error);
    });
    el.querySelectorAll('[data-zoom],[data-id]').forEach((c) => {
      c.onclick = () => {
        const id = c.getAttribute('data-zoom') || c.getAttribute('data-id');
        const img = images.find((x) => x.id === id);
        if (!img) return;
        modal({
          title: img.name,
          wide: true,
          body: `<img src="${esc(img.url)}" style="width:100%;border-radius:14px" />
            <div class="field" style="margin-top:14px">
              <label>公网访问 URL（图生视频要用）</label>
              <input class="input mono" id="pub-url" value="${esc(img.remote_url || '')}" placeholder="https://…" />
              <div class="hint">Agnes 图生视频只能抓公网图片。本机生成的图没有公网地址，
                需要你先传到图床，再把链接填进这里；填了之后，关联这张图的分镜就能走图生视频。</div>
            </div>
            <div class="section-label" style="margin-top:14px">生成提示词</div>
            <pre class="json-out">${esc(img.generation_prompt || '')}</pre>`,
          footer: `
            ${state.imageHost && state.imageHost.configured
              ? `<button class="btn" id="upload-host">${icon('cloud', 13)}上传到图床</button>`
              : `<button class="btn" id="go-host">${icon('cloud', 13)}去配置图床</button>`}
            <button class="btn" id="save-url">保存公网 URL</button>
            <a class="btn btn-primary" href="${esc(img.url)}" download="${esc(img.name)}.png">下载</a>`,
          onMount(root, close) {
            const up = root.querySelector('#upload-host');
            if (up) {
              up.onclick = async () => {
                up.disabled = true;
                up.innerHTML = `<div class="spinner sm"></div>上传中…`;
                const r = await api.uploadImageHost(img.id);
                if (r.ok) { toast.ok('已上传到图床，这张图现在可用于图生视频'); load(); close(); } else {
                  up.disabled = false;
                  up.innerHTML = `${icon('cloud', 13)}上传到图床`;
                  toast.err(r.error);
                }
              };
            }
            const go = root.querySelector('#go-host');
            if (go) go.onclick = () => { close(); navigate('settings'); };
            root.querySelector('#save-url').onclick = async () => {
              const url = root.querySelector('#pub-url').value.trim();
              if (url && !/^https?:\/\//i.test(url)) { toast.err('必须是 http(s) 开头的公网地址'); return; }
              const r = await api.updateImage(img.id, { remote_url: url });
              if (r.ok) { toast.ok(url ? '已保存，这张图现在可用于图生视频' : '已清除公网 URL'); load(); close(); }
              else toast.err(r.error);
            };
          },
        });
      };
    });
  }

  function bindVideo(el) {
    el.querySelectorAll('[data-favv]').forEach((b) => b.onclick = async (e) => {
      e.stopPropagation();
      const v = videos.find((x) => x.id === b.getAttribute('data-favv'));
      const r = await api.updateVideo(v.id, { is_favorited: !v.is_favorited });
      if (!r.ok) toast.err(r.error || '收藏失败');
      load();
    });
    el.querySelectorAll('[data-save]').forEach((b) => b.onclick = async (e) => {
      e.stopPropagation();
      toast.info('正在下载…');
      const r = await api.downloadVideo(b.getAttribute('data-save'));
      if (r.ok) toast.ok('已保存到本机'); else toast.err(r.error);
      load();
    });
    el.querySelectorAll('[data-delv]').forEach((b) => b.onclick = async (e) => {
      e.stopPropagation();
      if (!(await confirm({ text: '删除这个视频？本地文件会一起删。', danger: true, okText: '删除' }))) return;
      const r = await api.deleteVideo(b.getAttribute('data-delv'));
      if (r.ok) { toast.ok('已删除'); load(); } else toast.err(r.error);
    });
    el.querySelectorAll('[data-open],[data-vid]').forEach((c) => {
      c.onclick = () => {
        const id = c.getAttribute('data-open') || c.getAttribute('data-vid');
        const v = videos.find((x) => x.id === id);
        if (!v) return;
        const src = v.local_file ? `/assets/videos/${v.local_file.split(/[\\/]/).pop()}` : v.video_url;
        modal({
          title: v.name || '视频',
          wide: true,
          body: src
            ? `<video src="${esc(src)}" controls autoplay style="width:100%;border-radius:14px"></video>
               <pre class="json-out" style="margin-top:14px">${esc(v.video_prompt || '')}</pre>`
            : `<div class="note orange">还没有视频地址，去「镜头任务」点重新获取。</div>`,
          footer: src ? `<a class="btn btn-primary" href="${esc(src)}" download>下载</a>` : '',
        });
      };
    });
  }

  await load();
}
