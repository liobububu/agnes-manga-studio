/**
 * tasks.js — 镜头任务
 * 视频异步任务的指挥中心：状态、进度、补录 video_id、保存视频到本地。
 * 状态变化通过 SSE 实时推过来，不用手动刷。
 */
import {
  icon, esc, statusBadge, VIDEO_STATUS, REMOTE_STATUS, LOCAL_STATUS,
  relTime, fmtTime, copyText,
} from '../consts.js';
import { api } from '../api.js';
import { modal, toast, empty, spinner, confirm, prompt as promptDlg, options } from '../ui.js';
import { head } from './helpers.js';
import { onEvent } from '../app.js';

const MODE_LABELS = {
  text_to_video: '文生视频',
  image_to_video: '图生视频',
  multi_image: '多图参考',
  keyframe: '关键帧动画',
};
const TYPE_LABELS = { text: '文本', image: '图片', video: '视频' };
const REF_STATUS = new Set(['poll_timeout', 'video_url_missing', 'remote_submitted', 'sync_failed', 'result_parse_failed']);

export default async function tasks(container) {
  let tab = 'all';
  let statusFilter = 'all';
  let search = '';
  let videos = [];
  let others = [];
  const busy = new Set();

  container.innerHTML = `
    ${head({
      title: '镜头任务',
      desc: '视频由本地服务后台轮询，关掉浏览器也会继续跑',
      actions: `
        <button class="btn btn-sm" id="batch-fix">${icon('wand', 13)}批量补充视频地址</button>
        <button class="btn" id="reload">${icon('refresh', 16)}刷新</button>`,
    })}
    <div class="row wrap" style="margin-bottom:16px">
      <div class="tabs" id="tabs">
        <button data-tab="all" class="on">全部</button>
        <button data-tab="video">视频</button>
        <button data-tab="image">图片</button>
        <button data-tab="text">文本</button>
      </div>
      <select class="select select-sm" id="status" style="width:130px">
        <option value="all">全部状态</option>
        ${Object.entries(VIDEO_STATUS).map(([k, v]) => `<option value="${esc(k)}">${esc(v.label)}</option>`).join('')}
      </select>
      <div style="position:relative;flex:1;min-width:180px">
        <span style="position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--text-3)">${icon('search', 13)}</span>
        <input class="input" id="search" placeholder="搜索提示词…" style="padding-left:32px;height:34px;border-radius:10px" />
      </div>
    </div>
    <div id="list">${spinner('加载任务…')}</div>`;

  container.querySelector('#reload').onclick = load;
  container.querySelector('#batch-fix').onclick = batchFix;
  container.querySelectorAll('#tabs [data-tab]').forEach((b) => {
    b.onclick = () => {
      tab = b.getAttribute('data-tab');
      container.querySelectorAll('#tabs [data-tab]').forEach((x) => x.classList.toggle('on', x === b));
      render();
    };
  });
  container.querySelector('#status').onchange = (e) => { statusFilter = e.target.value; render(); };
  let timer;
  container.querySelector('#search').oninput = (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { search = e.target.value.trim().toLowerCase(); render(); }, 220);
  };

  const off = onEvent('video', (v) => {
    const i = videos.findIndex((x) => x.id === v.id);
    if (i >= 0) videos[i] = v; else videos.unshift(v);
    render();
  });

  async function load() {
    const [v, t] = await Promise.all([api.videos(), api.tasks()]);
    if (v.ok) videos = v.data || [];
    if (t.ok) others = t.data || [];
    render();
  }

  function render() {
    const el = container.querySelector('#list');
    const showVideo = tab === 'all' || tab === 'video';
    const showOther = tab === 'all' || tab === 'image' || tab === 'text';

    const vRows = showVideo ? videos.filter((v) => {
      if (statusFilter !== 'all' && v.status !== statusFilter) return false;
      if (search && !String(v.video_prompt).toLowerCase().includes(search)
        && !String(v.name).toLowerCase().includes(search)) return false;
      return true;
    }) : [];

    const oRows = showOther ? others.filter((t) => {
      if (tab !== 'all' && t.task_type !== tab) return false;
      if (statusFilter !== 'all' && t.status !== statusFilter) return false;
      if (search && !JSON.stringify(t.input_content || {}).toLowerCase().includes(search)) return false;
      return true;
    }) : [];

    if (!vRows.length && !oRows.length) {
      el.innerHTML = `<div class="card">${empty('没有符合条件的任务', '换个筛选条件，或去「视频生成」提交一个任务', 'tasks')}</div>`;
      return;
    }

    el.innerHTML = vRows.map(videoRow).join('') + oRows.map(taskRow).join('');
    bind();
  }

  function videoRow(v) {
    const needsRefetch = REF_STATUS.has(v.status) || REF_STATUS.has(v.local_status);
    const running = ['queued', 'in_progress'].includes(v.status);
    const isBusy = busy.has(v.id);
    return `
      <div class="task-row" style="margin-bottom:12px" data-vid="${esc(v.id)}">
        <div class="side">
          ${statusBadge(v.status)}
          ${running ? `<span class="badge gray" style="font-size:10px">${icon('clock', 9)}轮询中</span>` : ''}
          <span class="badge gray" style="font-size:10px">视频</span>
          ${v.remote_status ? `<span class="badge blue" style="font-size:10px">远端：${esc(REMOTE_STATUS[v.remote_status] || v.remote_status)}</span>` : ''}
          ${v.local_status ? `<span class="badge gray" style="font-size:10px">本地：${esc(LOCAL_STATUS[v.local_status] || v.local_status)}</span>` : ''}
        </div>
        <div class="body">
          <div class="row wrap" style="font-size:11.5px;color:var(--text-3);gap:8px">
            <span>${esc(MODE_LABELS[v.generation_mode] || v.generation_mode)}</span><span>·</span>
            <span>${esc(v.num_frames)}帧 ${esc(v.frame_rate)}fps</span><span>·</span>
            <span>${esc(v.model_name)}</span>
            <span>·</span><span>${esc(relTime(v.created_at))}</span>
          </div>
          <div class="prompt-line">${esc(v.video_prompt)}</div>
          ${v.progress > 0 && v.progress < 100 ? `
            <div style="max-width:240px">
              <div class="row" style="justify-content:space-between;margin-bottom:3px">
                <span style="font-size:10px;color:var(--text-3)">生成进度</span>
                <span style="font-size:10px;color:var(--gold-light)">${esc(v.progress)}%</span>
              </div>
              <div class="progress"><i style="width:${esc(v.progress)}%"></i></div>
            </div>` : ''}
          ${v.source_image_url ? `<div class="row" style="gap:8px">
              <img src="${esc(v.source_image_url)}" style="width:48px;height:34px;object-fit:cover;border-radius:8px;border:1px solid var(--border)" onerror="this.style.display='none'" />
              <span style="font-size:11px;color:var(--text-3)">来源图片</span>
            </div>` : ''}
          ${v.local_file ? `<video src="/assets/videos/${esc(v.local_file.split(/[\\/]/).pop())}" controls style="max-width:320px;max-height:130px;border-radius:10px;border:1px solid rgba(214,181,109,0.15)"></video>`
            : v.video_url ? `<video src="${esc(v.video_url)}" controls style="max-width:320px;max-height:130px;border-radius:10px;border:1px solid rgba(214,181,109,0.15)"></video>` : ''}
          ${!v.video_url && v.agnes_video_id && needsRefetch ? `
            <div class="note orange" style="font-size:11.5px">
              ${v.local_status === 'poll_timeout' ? 'Agnes 已接收，查询超时——不代表失败，可点「重新获取」' : ''}
              ${v.local_status === 'result_parse_failed' ? 'Agnes 已完成，但视频地址解析失败——可点「重新获取」' : ''}
              ${v.status === 'remote_submitted' ? 'Agnes 已接收（提交超时），任务可能仍在排队' : ''}
            </div>` : ''}
          ${!v.agnes_video_id && v.local_status === 'submit_timeout_unknown' ? `
            <div class="note orange" style="font-size:11.5px">
              提交超时，Agnes 未及时返回任务 ID。若 Agnes 账单有消费记录，点「绑定任务 ID」补录即可追踪。
              <b>未确认前请勿重复提交。</b>
            </div>` : ''}
          ${v.error_message ? `<div class="note red" style="font-size:11.5px">${esc(v.error_message)}</div>` : ''}
        </div>
        <div class="acts">
          <button class="icon-btn" data-fav="${esc(v.id)}" title="收藏" style="background:rgba(255,255,255,0.07);color:${v.is_favorited ? 'var(--gold-light)' : 'var(--text-3)'}">${icon('star', 14)}</button>
          <button class="icon-btn" data-refresh="${esc(v.id)}" title="重新获取结果" style="background:rgba(255,255,255,0.07);color:var(--text-2)">${isBusy ? '<div class="spinner sm"></div>' : icon('refresh', 14)}</button>
          ${!v.agnes_video_id ? `<button class="icon-btn" data-bind="${esc(v.id)}" title="绑定任务 ID" style="background:rgba(255,255,255,0.07);color:var(--gold-light)">${icon('link', 14)}</button>` : ''}
          ${v.video_url && !v.local_file ? `<button class="icon-btn" data-save="${esc(v.id)}" title="保存到本机" style="background:rgba(255,255,255,0.07);color:var(--text-2)">${icon('download', 14)}</button>` : ''}
          <button class="icon-btn" data-detail="${esc(v.id)}" title="查看原始响应" style="background:rgba(255,255,255,0.07);color:var(--text-2)">${icon('eye', 14)}</button>
          <button class="icon-btn danger" data-del="${esc(v.id)}" title="删除" style="background:rgba(255,255,255,0.07);color:var(--text-3)">${icon('trash', 14)}</button>
        </div>
      </div>`;
  }

  function taskRow(t) {
    const input = t.input_content || {};
    const preview = t.task_type === 'text'
      ? (Array.isArray(input.messages) ? String(input.messages[input.messages.length - 1]?.content || '').slice(0, 220) : JSON.stringify(input).slice(0, 220))
      : String(input.prompt || JSON.stringify(input)).slice(0, 220);
    return `
      <div class="task-row" style="margin-bottom:12px">
        <div class="side">
          <span class="badge ${t.status === 'completed' ? 'green' : t.status === 'failed' ? 'red' : 'gold'}">${t.status === 'completed' ? '已完成' : t.status === 'failed' ? '失败' : '进行中'}</span>
          <span class="badge gray" style="font-size:10px">${esc(TYPE_LABELS[t.task_type] || t.task_type)}</span>
        </div>
        <div class="body">
          <div class="row wrap" style="font-size:11.5px;color:var(--text-3);gap:8px">
            <span>${esc(t.model_name || '—')}</span><span>·</span><span>${esc(relTime(t.created_at))}</span>
          </div>
          <div class="prompt-line">${esc(preview)}</div>
          ${t.error_message ? `<div class="note red" style="font-size:11.5px">${esc(t.error_message)}</div>` : ''}
        </div>
        <div class="acts">
          <button class="icon-btn" data-favt="${esc(t.id)}" title="收藏" style="background:rgba(255,255,255,0.07);color:${t.is_favorited ? 'var(--gold-light)' : 'var(--text-3)'}">${icon('star', 14)}</button>
          <button class="icon-btn" data-detailt="${esc(t.id)}" title="详情" style="background:rgba(255,255,255,0.07);color:var(--text-2)">${icon('eye', 14)}</button>
          <button class="icon-btn danger" data-delt="${esc(t.id)}" title="删除" style="background:rgba(255,255,255,0.07);color:var(--text-3)">${icon('trash', 14)}</button>
        </div>
      </div>`;
  }

  function bind() {
    const el = container.querySelector('#list');
    const bindOne = (attr, fn) => el.querySelectorAll(`[data-${attr}]`).forEach((b) => {
      b.onclick = () => fn(b.getAttribute(`data-${attr}`), b);
    });

    bindOne('fav', async (id) => {
      const v = videos.find((x) => x.id === id);
      await api.updateVideo(id, { is_favorited: !v.is_favorited });
      load();
    });
    bindOne('favt', async (id) => {
      const t = others.find((x) => x.id === id);
      await api.updateTask(id, { is_favorited: !t.is_favorited });
      load();
    });
    bindOne('refresh', async (id, btn) => {
      busy.add(id); render();
      const r = await api.refreshVideo(id);
      busy.delete(id);
      if (!r.ok) { toast.err(r.error); render(); return; }
      toast.ok('状态已刷新');
      load();
    });
    bindOne('bind', async (id) => {
      const vid = await promptDlg({
        title: '绑定 Agnes 任务 ID',
        label: 'video_id',
        placeholder: '从 Agnes 账单或后台复制的 video_id',
        hint: '补录后会立刻开始轮询这个任务的进度。',
        mono: true,
      });
      if (!vid) return;
      const r = await api.bindVideo(id, vid);
      if (r.ok) { toast.ok('已绑定，开始查询'); load(); } else toast.err(r.error);
    });
    bindOne('save', async (id) => {
      toast.info('正在下载视频到本地…');
      const r = await api.downloadVideo(id);
      if (r.ok) { toast.ok(`已保存到本机（${(r.data.bytes / 1024 / 1024).toFixed(1)} MB）`); load(); }
      else toast.err(r.error);
    });
    bindOne('detail', (id) => {
      const v = videos.find((x) => x.id === id);
      modal({
        title: '任务详情',
        wide: true,
        body: `
          <div class="kv"><span class="k">video_id</span><span class="v">${esc(v.agnes_video_id || '—')}</span></div>
          <div class="kv"><span class="k">task_id</span><span class="v">${esc(v.agnes_task_id || '—')}</span></div>
          <div class="kv"><span class="k">状态</span><span class="v">${esc(v.status)} / 远端 ${esc(v.remote_status)} / 本地 ${esc(v.local_status)}</span></div>
          <div class="kv"><span class="k">视频地址</span><span class="v">${esc(v.video_url || '—')}</span></div>
          <div class="kv"><span class="k">本地文件</span><span class="v">${esc(v.local_file || '—')}</span></div>
          <div class="kv"><span class="k">创建时间</span><span class="v">${esc(fmtTime(v.created_at))}</span></div>
          <div class="divider"></div>
          <div class="section-label">提交时的请求日志</div>
          <pre class="json-out">${esc(JSON.stringify(v.request_log || {}, null, 2))}</pre>
          <div class="section-label" style="margin-top:14px">Agnes 创建响应</div>
          <pre class="json-out">${esc(JSON.stringify(v.raw_create_response || {}, null, 2))}</pre>
          <div class="section-label" style="margin-top:14px">最近一次状态响应</div>
          <pre class="json-out">${esc(JSON.stringify(v.raw_status_response || {}, null, 2))}</pre>`,
        footer: `<button class="btn" data-copy>复制 video_id</button>`,
        onMount(root) {
          root.querySelector('[data-copy]').onclick = () => {
            copyText(v.agnes_video_id || '').then(() => toast.ok('已复制')).catch(() => toast.err('复制失败'));
          };
        },
      });
    });
    bindOne('detailt', (id) => {
      const t = others.find((x) => x.id === id);
      modal({
        title: '任务详情',
        wide: true,
        body: `
          <div class="kv"><span class="k">类型</span><span class="v">${esc(t.task_type)}</span></div>
          <div class="kv"><span class="k">模型</span><span class="v">${esc(t.model_name || '—')}</span></div>
          <div class="divider"></div>
          <div class="section-label">输入</div>
          <pre class="json-out">${esc(JSON.stringify(t.input_content || {}, null, 2))}</pre>
          <div class="section-label" style="margin-top:14px">输出</div>
          <pre class="json-out">${esc(JSON.stringify(t.output_result || {}, null, 2))}</pre>`,
      });
    });
    bindOne('del', async (id) => {
      if (!(await confirm({ text: '删除这个视频任务？已保存到本机的视频文件也会一起删。', danger: true, okText: '删除' }))) return;
      const r = await api.deleteVideo(id);
      if (r.ok) { toast.ok('已删除'); load(); } else toast.err(r.error);
    });
    bindOne('delt', async (id) => {
      const r = await api.deleteTask(id);
      if (r.ok) { toast.ok('已删除'); load(); } else toast.err(r.error);
    });
  }

  async function batchFix() {
    toast.info('正在查询缺失地址的任务…');
    const r = await api.batchRefreshVideos();
    if (!r.ok) { toast.err(r.error); return; }
    if (r.data.found) toast.ok(`已为 ${r.data.found} / ${r.data.total} 个任务补到视频地址`);
    else toast.warn(`查了 ${r.data.total} 个任务，都还没返回地址，稍后再试`);
    load();
  }

  await load();
  return () => off && off();
}
