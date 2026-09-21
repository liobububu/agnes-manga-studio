/**
 * store.js — 本地 JSON 数据层
 * ------------------------------------------------------------------
 * 原版本地版之前跑在 Supabase（云端 Postgres + RLS + user_id 隔离）。
 * 这里整个换成单机 JSON 文件：
 *   · 没有用户系统 → 所有 user_id 字段消失，数据天然属于这台机器
 *   · 写入走「临时文件 + rename」的原子替换，中途断电不会留下半个文件
 *   · 每次写盘顺带留一个 .bak，遇到损坏能自动回滚到上一版
 *
 * 集合（collection）沿用原库表名，方便老用户从云端导出后直接导入：
 *   projects / scripts / storyboards / image_assets / video_assets
 *   generation_tasks / prompt_templates / video_submit_logs
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const COLLECTIONS = [
  'projects',
  'scripts',
  'storyboards',
  'image_assets',
  'video_assets',
  'generation_tasks',
  'prompt_templates',
  'video_submit_logs',
];

const EMPTY = () => ({
  projects: [],
  scripts: [],
  storyboards: [],
  image_assets: [],
  video_assets: [],
  generation_tasks: [],
  prompt_templates: [],
  video_submit_logs: [],
});

let APP_HOME = process.cwd();
let DB_PATH = null;
let SETTINGS_PATH = null;
let MODELS_PATH = null;
let MEM = null;
let SETTINGS = null;
let MODEL_CACHE = null;
let writeQueue = Promise.resolve();

// ── id / 时间 ────────────────────────────────────────────────
let seq = 0;
function uid(prefix = 'id') {
  seq = (seq + 1) % 46656;
  const t = Date.now().toString(36);
  const r = seq.toString(36).padStart(3, '0');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${t}${r}${rand}`;
}
const now = () => new Date().toISOString();

// ── 原子写 ───────────────────────────────────────────────────
function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  } catch { /* 备份失败不影响主流程 */ }
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (e) {
    // 主文件坏了，试上一版备份
    try {
      const bak = fs.readFileSync(`${file}.bak`, 'utf8');
      const parsed = JSON.parse(bak);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* 备份也坏了，用空库 */ }
    return fallback;
  }
}

// ── 初始化 ───────────────────────────────────────────────────
function init(home) {
  APP_HOME = home;
  DB_PATH = path.join(home, 'db.json');
  SETTINGS_PATH = path.join(home, 'settings.json');
  MODELS_PATH = path.join(home, 'models.json');
  fs.mkdirSync(home, { recursive: true });
  MEM = readJson(DB_PATH, null) || EMPTY();
  for (const c of COLLECTIONS) if (!Array.isArray(MEM[c])) MEM[c] = [];
  SETTINGS = readJson(SETTINGS_PATH, null) || {};
  MODEL_CACHE = readJson(MODELS_PATH, null) || { version: 1, updated_at: null, source: 'fallback', models: [] };
  if (!Array.isArray(MODEL_CACHE.models)) MODEL_CACHE.models = [];
  return { db: MEM, settings: SETTINGS, models: MODEL_CACHE };
}

function home() { return APP_HOME; }
function assetsDir() { return path.join(APP_HOME, 'assets'); }
function imagesDir() { return path.join(APP_HOME, 'assets', 'images'); }
function videosDir() { return path.join(APP_HOME, 'assets', 'videos'); }
function audiosDir() { return path.join(APP_HOME, 'assets', 'audios'); }
function exportsDir() { return path.join(APP_HOME, 'exports'); }

/** 串行化写盘，避免并发请求互相覆盖 */
function persist() {
  writeQueue = writeQueue.then(() => {
    writeJsonAtomic(DB_PATH, MEM);
  }).catch(() => {});
  return writeQueue;
}

function persistSettings() {
  writeQueue = writeQueue.then(() => {
    writeJsonAtomic(SETTINGS_PATH, SETTINGS);
  }).catch(() => {});
  return writeQueue;
}

// ── 集合操作 ─────────────────────────────────────────────────
function assertColl(coll) {
  if (!COLLECTIONS.includes(coll)) throw new Error(`未知集合: ${coll}`);
  if (!MEM) throw new Error('store 尚未 init');
}

function list(coll, opts = {}) {
  assertColl(coll);
  let rows = MEM[coll].slice();
  if (typeof opts.filter === 'function') rows = rows.filter(opts.filter);
  if (typeof opts.sort === 'function') rows.sort(opts.sort);
  else rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  if (opts.limit) rows = rows.slice(0, opts.limit);
  return rows;
}

function get(coll, id) {
  assertColl(coll);
  return MEM[coll].find((r) => r.id === id) || null;
}

function insert(coll, row) {
  assertColl(coll);
  const full = Object.assign({}, row);
  if (!full.id) full.id = uid(coll.replace(/s$/, '').slice(0, 8));
  if (!full.created_at) full.created_at = now();
  if (!('updated_at' in full) && coll !== 'image_assets' && coll !== 'video_assets'
      && coll !== 'generation_tasks' && coll !== 'video_submit_logs') {
    full.updated_at = now();
  }
  MEM[coll].unshift(full);
  persist();
  return full;
}

function insertMany(coll, rows) {
  assertColl(coll);
  const out = rows.map((row) => {
    const full = Object.assign({}, row);
    if (!full.id) full.id = uid(coll.replace(/s$/, '').slice(0, 8));
    if (!full.created_at) full.created_at = now();
    return full;
  });
  MEM[coll] = out.concat(MEM[coll]);
  persist();
  return out;
}

function update(coll, id, patch) {
  assertColl(coll);
  const idx = MEM[coll].findIndex((r) => r.id === id);
  if (idx < 0) return null;
  const merged = Object.assign({}, MEM[coll][idx], patch);
  if ('updated_at' in MEM[coll][idx]) merged.updated_at = now();
  MEM[coll][idx] = merged;
  persist();
  return merged;
}

function remove(coll, id) {
  assertColl(coll);
  const before = MEM[coll].length;
  MEM[coll] = MEM[coll].filter((r) => r.id !== id);
  persist();
  return MEM[coll].length < before;
}

function removeWhere(coll, filterFn) {
  assertColl(coll);
  const before = MEM[coll].length;
  MEM[coll] = MEM[coll].filter((r) => !filterFn(r));
  persist();
  return before - MEM[coll].length;
}

function count(coll, filterFn) {
  assertColl(coll);
  return filterFn ? MEM[coll].filter(filterFn).length : MEM[coll].length;
}

// ── 设置 ─────────────────────────────────────────────────────
const SETTING_DEFAULTS = {
  agnes_api_base_url: 'https://apihub.agnes-ai.com/v1',
  agnes_api_key: '',
  default_text_model: 'agnes-2.0-flash',
  default_image_model: 'agnes-image-2.1-flash',
  default_video_model: 'agnes-video-v2.0',
  video_poll_interval: '8',
  video_max_polls: '60',
  default_concurrent_tasks: '3',
  auto_download_video: '0',
  request_timeout_ms: '150000',
  video_submit_interval_ms: '3000',
  image_host_type: '',
  image_host_key: '',
  image_host_endpoint: '',
  auto_upload_image: '1',
  model_cache_ttl_hours: '24',
  auto_refresh_models: '1',
};

function getSettings() {
  const out = {};
  for (const [k, v] of Object.entries(SETTING_DEFAULTS)) out[k] = SETTINGS[k] != null ? SETTINGS[k] : v;
  return out;
}

/** 返回给前端的设置：API Key 永远只给脱敏值 */
function getSettingsMasked() {
  const s = getSettings();
  const key = String(s.agnes_api_key || '');
  const hostKey = String(s.image_host_key || '');
  return Object.assign({}, s, {
    agnes_api_key: key ? '***configured***' : '',
    agnes_api_key_masked: maskKey(key),
    image_host_key: hostKey ? '***configured***' : '',
    image_host_key_masked: maskKey(hostKey),
  });
}

function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 8) return k.slice(0, 2) + '****';
  return `${k.slice(0, 4)}****${k.slice(-4)}`;
}

function setSettings(patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in SETTING_DEFAULTS)) continue;
    // 密钥类字段传空字符串表示「不修改」：否则用户在设置页改别的项、
    // 顺手点了保存，就会把已经填好的 Key 清成空，且没有任何提示。
    if ((k === 'agnes_api_key' || k === 'image_host_key') && String(v) === '') continue;
    SETTINGS[k] = String(v);
  }
  persistSettings();
  return getSettings();
}

function getRawKey() { return String(SETTINGS.agnes_api_key || ''); }

// ── 动态模型目录 ─────────────────────────────────────────────
/**
 * 只把 Agnes 返回的公开模型元数据存本机，不保存请求头/API Key。
 * models.json 是独立文件，升级程序不会覆盖用户已经拉取到的模型清单。
 */
function normalizeModel(item) {
  const raw = typeof item === 'string' ? { id: item } : (item && typeof item === 'object' ? item : {});
  const id = String(raw.id || raw.name || raw.model || '').trim();
  if (!id) return null;
  const caps = raw.capabilities && typeof raw.capabilities === 'object' ? raw.capabilities : {};
  const modalities = Array.isArray(raw.modalities) ? raw.modalities.map(String) : [];
  const haystack = [id, raw.name, raw.owned_by, raw.type, raw.object, ...modalities, ...Object.keys(caps)]
    .filter(Boolean).join(' ').toLowerCase();
  let kind = String(raw.kind || raw.model_type || '').toLowerCase();
  if (!['text', 'image', 'video', 'unknown'].includes(kind)) {
    if (/video|animate|motion|wan|kling|sora/.test(haystack)) kind = 'video';
    else if (/image|vision|dall|flux|sdxl|seedream|画|图/.test(haystack)) kind = 'image';
    else if (/text|chat|completion|gpt|claude|qwen|deepseek|llama|豆包/.test(haystack)) kind = 'text';
    else kind = 'unknown';
  }
  return {
    id,
    name: String(raw.name || id),
    kind,
    owned_by: String(raw.owned_by || raw.provider || ''),
    capabilities: caps,
    modalities,
  };
}

function normalizeModels(payload) {
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data) ? payload.data
      : Array.isArray(payload?.models) ? payload.models
        : Array.isArray(payload?.items) ? payload.items : [];
  const out = [];
  const seen = new Set();
  for (const item of source) {
    const model = normalizeModel(item);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function getModels() {
  return {
    version: MODEL_CACHE?.version || 1,
    updated_at: MODEL_CACHE?.updated_at || null,
    source: MODEL_CACHE?.source || 'fallback',
    error: MODEL_CACHE?.error || '',
    models: Array.isArray(MODEL_CACHE?.models) ? MODEL_CACHE.models.slice() : [],
  };
}

function setModels(payload, meta = {}) {
  const models = normalizeModels(payload);
  MODEL_CACHE = {
    version: 1,
    updated_at: meta.updated_at || now(),
    source: meta.source || 'agnes',
    error: meta.error || '',
    models,
  };
  writeQueue = writeQueue.then(() => writeJsonAtomic(MODELS_PATH, MODEL_CACHE)).catch(() => {});
  return getModels();
}

function setModelCacheError(error) {
  MODEL_CACHE = Object.assign({}, MODEL_CACHE || {}, {
    version: 1,
    error: String(error || '模型拉取失败'),
  });
  writeQueue = writeQueue.then(() => writeJsonAtomic(MODELS_PATH, MODEL_CACHE)).catch(() => {});
  return getModels();
}

function modelsNeedRefresh() {
  const s = getSettings();
  if (s.auto_refresh_models !== '1') return false;
  if (!MODEL_CACHE?.updated_at || !MODEL_CACHE.models?.length) return true;
  const ttl = Math.max(1, Number(s.model_cache_ttl_hours) || 24) * 3600000;
  const updated = new Date(MODEL_CACHE.updated_at).getTime();
  if (!Number.isFinite(updated)) return true;
  return Date.now() - updated > ttl;
}

// ── 全量导入导出 ─────────────────────────────────────────────
function exportAll() {
  return { version: 1, exported_at: now(), collections: MEM };
}

function importAll(payload, mode = 'merge') {
  if (!payload || typeof payload !== 'object') throw new Error('导入数据格式错误');
  const src = payload.collections || payload;
  let added = 0;
  for (const c of COLLECTIONS) {
    if (!Array.isArray(src[c])) continue;
    if (mode === 'replace') {
      added += src[c].length;
      MEM[c] = src[c].slice();
    } else {
      const existing = new Set(MEM[c].map((r) => r.id));
      for (const row of src[c]) {
        if (row && row.id && existing.has(row.id)) continue;
        MEM[c].push(row);
        added++;
      }
    }
  }
  persist();
  return added;
}

/** 单个项目及其全部关联数据，用于「导出资料」 */
function exportProject(projectId) {
  const project = get('projects', projectId);
  if (!project) return null;
  return {
    version: 1,
    exported_at: now(),
    project,
    scripts: list('scripts', { filter: (r) => r.project_id === projectId }),
    storyboards: list('storyboards', {
      filter: (r) => r.project_id === projectId,
      sort: (a, b) => (a.episode_number - b.episode_number) || (a.sort_order - b.sort_order),
    }),
    image_assets: list('image_assets', { filter: (r) => r.project_id === projectId }),
    video_assets: list('video_assets', { filter: (r) => r.project_id === projectId }),
    generation_tasks: list('generation_tasks', { filter: (r) => r.project_id === projectId }),
  };
}

function stats() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString();
  const projects = MEM.projects;
  const inFlight = (v) => ['queued', 'in_progress', 'remote_submitted'].includes(v.status)
    || ['polling', 'remote_submitted'].includes(v.local_status);
  return {
    total_projects: projects.length,
    active_projects: projects.filter((p) => p.status === 'active').length,
    today_images: MEM.image_assets.filter((i) => (i.created_at || '') >= todayStr).length,
    today_videos: MEM.video_assets.filter((v) => (v.created_at || '') >= todayStr).length,
    failed_tasks: MEM.generation_tasks.filter((t) => t.status === 'failed').length
      + MEM.video_assets.filter((v) => v.status === 'failed' || v.local_status === 'submit_failed').length,
    favorited_assets: MEM.image_assets.filter((i) => i.is_favorited).length
      + MEM.video_assets.filter((v) => v.is_favorited).length,
    total_storyboards: MEM.storyboards.length,
    running_videos: MEM.video_assets.filter(inFlight).length,
  };
}

/** 测试用：把内存恢复到干净状态（不写盘，除非调用 persist） */
function _resetForTest() {
  MEM = EMPTY();
  SETTINGS = {};
  MODEL_CACHE = { version: 1, updated_at: null, source: 'fallback', models: [] };
}

module.exports = {
  COLLECTIONS,
  init, home, assetsDir, imagesDir, videosDir, audiosDir, exportsDir,
  uid, now,
  list, get, insert, insertMany, update, remove, removeWhere, count,
  getSettings, getSettingsMasked, setSettings, getRawKey, maskKey, SETTING_DEFAULTS,
  getModels, setModels, setModelCacheError, normalizeModels, normalizeModel, modelsNeedRefresh,
  exportAll, importAll, exportProject, stats, persist,
  _resetForTest,
  get db() { return MEM; },
};
