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
  const merged = store.update('video_assets', assetId, updates);
  events.emit('video', merged);
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

    if (merged.status === 'completed' && merged.video_url) {
      stop(assetId);
      pushLog({ level: 'ok', msg: `视频生成完成 ${merged.id.slice(0, 8)}` });
      // 回填分镜状态：分镜表是用户盯进度的主要界面，
      // 视频都出完了，分镜还停在「有图片」就等于没告诉用户结果
      linkStoryboard(merged);
      maybeAutoDownload(merged);
      return;
    }
    if (merged.status === 'failed' || merged.status === 'video_url_missing') {
      stop(assetId);
      pushLog({ level: merged.status === 'failed' ? 'error' : 'warn', msg: `任务 ${merged.id.slice(0, 8)} → ${merged.status}` });
      return;
    }
  } catch (e) {
    // 单次查询异常不改状态，下一轮继续
    pushLog({ level: 'warn', msg: `轮询异常：${e.message}` });
  }

  counts.set(assetId, count + 1);
  schedule(assetId, intervalMs());
}

/** 视频完成后把结果挂回分镜：状态 + 关联视频 id */
function linkStoryboard(asset) {
  if (!asset || !asset.storyboard_id || !store) return;
  const sb = store.get('storyboards', asset.storyboard_id);
  if (!sb) return;
  const patch = { status: 'video_ready', linked_video_id: asset.id };
  store.update('storyboards', asset.storyboard_id, patch);
  events.emit('storyboard', Object.assign({}, sb, patch));
}

/** 设置里开了「自动保存视频」就顺手落盘，免得远端链接过期 */
async function maybeAutoDownload(asset) {
  try {
    const s = store.getSettings();
    if (s.auto_download_video !== '1' || !asset.video_url) return;
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = store.videosDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${asset.id}.mp4`);
    await agnes.downloadVideo(asset.video_url, file);
    store.update('video_assets', asset.id, { local_file: file });
    events.emit('video', store.get('video_assets', asset.id));
  } catch (e) {
    pushLog({ level: 'warn', msg: `自动保存视频失败：${e.message}` });
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
