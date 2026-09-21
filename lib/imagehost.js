/**
 * imagehost.js — 图床上传
 * ------------------------------------------------------------------
 * 图生视频的死结：Agnes 只能抓公网图片，而本地版把图片存在本机。
 * 「填公网 URL」这种让用户自己想办法的做法等于把链路掐断，
 * 所以这里提供一条自动通道：本地图片 → 图床 → 公网 URL → 提交 Agnes。
 *
 * 支持三种图床，都是免费可自助申请的：
 *   imgbb   POST https://api.imgbb.com/1/upload?key=xxx    表单字段 image=base64
 *   smms    POST https://sm.ms/api/v2/upload               表单字段 smfile=文件，Header 带 token
 *   custom  兼容 imgbb 协议的任意自建/第三方图床
 *
 * 图床是可选功能：没配置时程序照常工作，只是本地图片仍不能用于图生视频。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');

const HOSTS = {
  imgbb: {
    label: 'imgbb',
    endpoint: 'https://api.imgbb.com/1/upload',
    keyHint: 'imgbb API Key（免费申请：https://api.imgbb.com/）',
    protocol: 'imgbb',
  },
  smms: {
    label: 'SM.MS',
    endpoint: 'https://sm.ms/api/v2/upload',
    keyHint: 'SM.MS Secret Token（免费申请：https://sm.ms/home/about）',
    protocol: 'smms',
  },
  custom: {
    label: '自定义（imgbb 协议）',
    endpoint: '',
    keyHint: '按 imgbb 协议自建或第三方的图床 Key',
    protocol: 'imgbb',
  },
};

function config() {
  const s = store.getSettings();
  const type = String(s.image_host_type || '').trim();
  const key = String(s.image_host_key || '').trim();
  const endpoint = String(s.image_host_endpoint || '').trim();
  if (!type || !key) return null;
  const preset = HOSTS[type];
  if (!preset) return null;
  const url = type === 'custom' ? endpoint : preset.endpoint;
  if (!url) return null;
  return { type, key, endpoint: url, protocol: preset.protocol, label: preset.label };
}

function isConfigured() { return !!config(); }

/** 把 /assets/images/xxx.png 还原成本机绝对路径；不是本地素材路径则返回 null */
function localPathFromAssetUrl(u) {
  const s = String(u || '');
  const m = /^\/assets\/(images|videos)\/(.+)$/.exec(s);
  if (!m) return null;
  const dir = m[1] === 'videos' ? store.videosDir() : store.imagesDir();
  return path.join(dir, path.basename(m[2]));
}

/**
 * 上传本地文件到图床。
 * @param {string} filePath 本机绝对路径
 * @returns {Promise<{url:string, raw:object}>}
 */
async function uploadFile(filePath) {
  const cfg = config();
  if (!cfg) throw new Error('未配置图床：请到「设置 → 图床」选择图床并填写 Key');
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`图片文件不存在：${filePath || '(空)'}`);
  }
  const buf = fs.readFileSync(filePath);
  const name = path.basename(filePath);
  const ext = path.extname(name).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp'
      : ext === '.gif' ? 'image/gif' : 'image/png';

  let resp;
  if (cfg.protocol === 'smms') {
    const fd = new FormData();
    fd.append('smfile', new Blob([buf], { type: mime }), name);
    resp = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: { Authorization: cfg.key },
      body: fd,
      signal: AbortSignal.timeout(60000),
    });
  } else {
    const body = new URLSearchParams();
    body.set('image', buf.toString('base64'));
    body.set('name', name);
    const sep = cfg.endpoint.includes('?') ? '&' : '?';
    resp = await fetch(`${cfg.endpoint}${sep}key=${encodeURIComponent(cfg.key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(60000),
    });
  }

  const text = await resp.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { _raw: text }; }

  if (!resp.ok) {
    const msg = data?.error?.message || data?.message || data?.error || `图床返回 HTTP ${resp.status}`;
    throw new Error(`图床上传失败：${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }

  const url = pickUrl(data);
  if (!url) throw new Error(`图床返回成功但没解析出图片地址：${text.slice(0, 200)}`);
  return { url, raw: data };
}

/** 不同图床返回字段名不一样，这里按常见名字依次找 */
function pickUrl(data) {
  const d = data?.data;
  const candidates = [
    d?.url, d?.display_url, d?.image?.url, d?.link,
    data?.url, data?.display_url, data?.link,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && /^https?:\/\//i.test(c)) return c;
  }
  return '';
}

/**
 * 把可能是本地地址的图片引用转成 Agnes 能用的公网 URL。
 * 公网地址原样返回；本地地址走图床；没配图床就抛错让调用方决定怎么降级。
 */
async function resolvePublicUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  const local = localPathFromAssetUrl(s);
  if (!local) throw new Error(`无法识别的图片地址：${s}`);
  const r = await uploadFile(local);
  return r.url;
}

/** 连通性自检：用一张 1×1 PNG 试传，成功即说明 Key 有效 */
async function test() {
  const cfg = config();
  if (!cfg) return { ok: false, error: '未配置图床' };
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const tmp = path.join(store.exportsDir(), `_hosttest_${Date.now()}.png`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, png);
  try {
    const r = await uploadFile(tmp);
    return { ok: true, url: r.url, host: cfg.label };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 测试文件清理失败不影响结果 */ }
  }
}

module.exports = {
  HOSTS, config, isConfigured, uploadFile, resolvePublicUrl,
  localPathFromAssetUrl, pickUrl, test,
};
