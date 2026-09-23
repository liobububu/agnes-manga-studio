/**
 * poller.js — 视频任务轮询调度 + SSE 广播
 * ------------------------------------------------------------------
 * 原版轮询跑在浏览器里：切个页面、合上笔记本盖子，轮询就断了，
 * 视频明明生成完了本地状态还停在「生成中」，得手动点刷新。
 * 本地版把轮询搬到服务端：
 *   · 关掉浏览器照样轮询，回来就看到结果
 *   · 服务重启时自动把没跑完的任务捡回来接着查
 *   · 状态变化通过 SSE 推给前端，界面不用自己瞎转圈
 */
'use strict';

const agnes = require('./agnes');

const AUTO_POLL_STATUS = new Set(['queued', 'in_progress', 'remote_submitted']);
const AUTO_POLL_LOCAL = new Set(['polling', 'remote_submitted']);

let store = null;
const timers = new Map();   // assetId -> Timeout
const counts = new Map();   // assetId -> 已轮询次数
const clients = new Set();  // SSE 连接

function bus() {
  return {
    add(res) { clients.add(res); },
    remove(res) { clients.delete(res); },
    emit(event, payload) {
      const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
      for (const res of clients) {
        try { res.write(frame); } catch { clients.delete(res); }
      }
    },
    size() { return clients.size; },
  };
}

const events = bus();
const log = [];
function pushLog(entry) {
  log.unshift(Object.assign({ t: new Date().toISOString() }, entry));
  if (log.length > 200) log.pop();
  events.emit('log', entry);
}

function intervalMs() {
  const s = store.getSettings();
  return Math.max(2, Number(s.video_poll_interval) || 8) * 1000;
}
function maxPolls() {
  const s = store.getSettings();
  return Math.max(1, Number(s.video_max_polls) || 60);
}

function isActive(v) {
  return !!v.agnes_video_id
    && (AUTO_POLL_STATUS.has(v.status) || AUTO_POLL_LOCAL.has(v.local_status));
}

function stop(assetId) {
  const t = timers.get(assetId);
  if (t) clearTimeout(t);
  timers.delete(assetId);
  counts.delete(assetId);
}

/** 查一次并落库；返回结果供调用方使用 */
async function pollOnce(assetId) {
  const asset = store.get('video_assets', assetId);
  if (!asset || !asset.agnes_video_id) return null;

  const { data } = await agnes.queryVideo(asset.agnes_video_id);
  const updates = agnes.buildSafeStatusUpdate(data);
  let merged = store.update('video_assets', assetId, updates);
  events.emit('video', merged);

  // 完成后的副作用放在这里，而不是放在轮询循环里：
  // 「镜头任务」页的手动刷新、批量补链接走的都是 pollOnce，
  // 写进 run() 的话手动查到完成也不会回填分镜、不会自动保存。
  if (merged.status === 'completed' && merged.video_url) {
    pushLog({ level: 'ok', msg: `视频生成完成 ${merged.id.slice(0, 8)}` });
    linkStoryboard(merged);
    // 要 await：不等待的话接口先返回了、文件还没落盘，
    // 前端拿到的 local_file 是空的，看着像「自动保存没生效」
    const saved = await maybeAutoDownload(merged);
    if (saved) merged = saved;
  } else if (merged.status === 'failed' || merged.status === 'video_url_missing') {
    pushLog({ level: merged.status === 'failed' ? 'error' : 'warn', msg: `任务 ${merged.id.slice(0, 8)} → ${merged.status}` });
  }
  return merged;
}

function schedule(assetId, delay) {
  const t = setTimeout(() => { run(assetId); }, delay);
  if (t.unref) t.unref();
  timers.set(assetId, t);
}

async function run(assetId) {
  const asset = store.get('video_assets', assetId);
  if (!asset || !isActive(asset)) { stop(assetId); return; }

  const count = counts.get(assetId) || 0;
  if (count >= maxPolls()) {
    stop(assetId);
    const merged = store.update('video_assets', assetId, {
      status: 'poll_timeout',
      local_status: 'poll_timeout',
      error_message: `已轮询 ${count} 次仍未出结果（不代表失败，可稍后手动刷新）`,
    });
    events.emit('video', merged);
    pushLog({ level: 'warn', msg: `任务 ${assetId.slice(0, 8)} 查询超时` });
    return;
  }

  try {
    const merged = await pollOnce(assetId);
    if (!merged) { stop(assetId); return; }

    if (merged.status === 'completed' && merged.video_url) { stop(assetId); return; }
    if (merged.status === 'failed' || merged.status === 'video_url_missing') { stop(assetId); return; }
  } catch (e) {
    // 单次查询异常不改状态，下一轮继续
    pushLog({ level: 'warn', msg: `轮询异常：${e.message}` });
  }

  // 查询期间任务可能已被删除或手动终止，别再排下一轮
  const after = store.get('video_assets', assetId);
  if (!after || !isActive(after)) { stop(assetId); return; }

  counts.set(assetId, count + 1);
  schedule(assetId, intervalMs());
}

/** 视频完成后把结果挂回分镜：状态 + 关联视频 id */
function linkStoryboard(asset) {
  if (!asset || !asset.storyboard_id || !store) return;
  const sb = store.get('storyboards', asset.storyboard_id);
  if (!sb) return;
  // 分镜在任务提交后可能已被修改；迟到的旧任务只能留作历史素材，不能重新绑定当前版本。
  if (asset.storyboard_revision != null && Number(asset.storyboard_revision) !== Number(sb.video_revision || sb.production_revision || 1)) return;
  const patch = { status: 'video_ready', linked_video_id: asset.id };
  store.update('storyboards', asset.storyboard_id, patch);
  events.emit('storyboard', Object.assign({}, sb, patch));
}

/** 设置里开了「自动保存视频」就顺手落盘，免得远端链接过期 */
async function maybeAutoDownload(asset) {
  try {
    const s = store.getSettings();
    if (s.auto_download_video !== '1' || !asset.video_url) return null;
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = store.videosDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${asset.id}.mp4`);
    await agnes.downloadVideo(asset.video_url, file);
    const updated = store.update('video_assets', asset.id, { local_file: file });
    events.emit('video', updated);
    return updated;
  } catch (e) {
    pushLog({ level: 'warn', msg: `自动保存视频失败：${e.message}` });
    return null;
  }
}

function watch(assetId, immediate = false) {
  if (!assetId) return;
  const asset = store.get('video_assets', assetId);
  if (!asset || !isActive(asset)) return;
  if (timers.has(assetId)) return;
  counts.set(assetId, 0);
  schedule(assetId, immediate ? 500 : intervalMs());
}

/** 启动时把没跑完的任务捡回来 */
function resume() {
  const pending = store.list('video_assets').filter(isActive);
  const seenRemote = new Set(pending.map((v) => v.agnes_video_id).filter(Boolean));
  // 兼容旧版本曾把远端 id 只记在 generation_tasks 的情况：启动时先恢复为
  // video_asset 交给统一 poller 查询，避免分镜页把它误判成缺失后再次提交。
  const taskPending = store.list('generation_tasks').filter((t) => {
    const remoteId = t.remote_task_id || t.agnes_video_id || t.video_id;
    return t.task_type === 'video' && remoteId && ['queued', 'in_progress', 'remote_submitted', 'polling', 'pending', 'running'].includes(t.status) && !seenRemote.has(remoteId);
  });
  for (const t of taskPending) {
    const remoteId = t.remote_task_id || t.agnes_video_id || t.video_id;
    const asset = store.insert('video_assets', {
      project_id: t.project_id || null,
      storyboard_id: t.storyboard_id || null,
      storyboard_revision: t.storyboard_revision ?? null,
      name: t.name || `恢复任务_${String(remoteId).slice(0, 8)}`,
      prompt: t.input_content?.prompt || t.prompt || '',
      status: 'remote_submitted', remote_status: 'queued', local_status: 'remote_submitted',
      agnes_task_id: t.agnes_task_id || remoteId, agnes_video_id: remoteId,
      recovered_from_task_id: t.id,
    });
    pending.push(asset);
    seenRemote.add(remoteId);
    store.update('generation_tasks', t.id, { status: 'remote_submitted', recovered_video_asset_id: asset.id });
  }
  for (const v of pending) watch(v.id, true);
  return pending.length;
}

function init(s) {
  store = s;
  return { resume, watch, stop, pollOnce, events, log, pushLog, isActive };
}

module.exports = {
  init, resume, watch, stop, pollOnce,
  get events() { return events; },
  get log() { return log; },
  pushLog,
  activeCount: () => timers.size,
};
