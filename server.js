/**
 * Agnes 漫剧工坊 · 本地版 — 本地服务
 * ------------------------------------------------------------------
 * 零依赖 Node.js HTTP 服务，只监听 127.0.0.1。负责：
 *   1. 托管前端页面
 *   2. 代理 Agnes 的文本 / 图片 / 视频接口 —— API Key 只留在本机
 *   3. 项目、剧本、分镜、素材、任务、模板的本地读写
 *   4. 视频异步任务的后台轮询（关掉浏览器也继续）
 *
 * 两种运行形态：
 *   · 源码运行   node server.js      —— 资源目录就在脚本旁边
 *   · 单文件 exe 双击运行            —— 静态资源内嵌，首次启动释放到数据目录
 *
 * 相比云端版：没有用户系统、没有 Supabase、没有 Edge Function，
 * 所有数据躺在本机 data/ 目录里，拔网线也能用（除了调 Agnes 那一步）。
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { createRequire } = require('node:module');

const VERSION = '1.1.3';
/** 改动前端后递增，exe 会在下次启动重新释放页面 */
const ASSETS_VERSION = VERSION;

// ─────────────────────────────────────────────────────────────
// 单文件 exe（Node SEA）支持
// ─────────────────────────────────────────────────────────────
let sea = null;
try { sea = require('node:sea'); } catch { /* 老版本 Node 无此模块 */ }
const IS_SEA = !!(sea && typeof sea.isSea === 'function' && sea.isSea());

/** 运行期可写目录。exe 形态下不能写自己所在目录（可能在 Program Files）。 */
function resolveHome() {
  if (process.env.AGNES_STUDIO_HOME) return path.resolve(process.env.AGNES_STUDIO_HOME);
  const exeDir = path.dirname(process.execPath);
  // 便携模式：exe 旁边放一个名为 portable 的空文件，数据就落在 exe 同级的 data/
  if (fs.existsSync(path.join(exeDir, 'portable'))) return path.join(exeDir, 'data');
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'AgnesStudio');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'AgnesStudio');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'AgnesStudio');
}

const CODE_HOME = __dirname;
const APP_HOME = IS_SEA ? resolveHome() : (process.env.AGNES_STUDIO_HOME
  ? path.resolve(process.env.AGNES_STUDIO_HOME)
  : path.join(CODE_HOME, 'data'));

/** 把内嵌资源释放到可写目录（仅 exe 形态需要） */
function materializeAssets() {
  if (!IS_SEA) return;
  const stampFile = path.join(APP_HOME, '.assets-version');
  let stamp = '';
  try { stamp = fs.readFileSync(stampFile, 'utf8'); } catch { /* 首次运行 */ }
  if (stamp === ASSETS_VERSION) return;

  fs.mkdirSync(APP_HOME, { recursive: true });
  for (const key of sea.getAssetKeys()) {
    if (!key.startsWith('public/') && !key.startsWith('lib/')) continue;
    const dest = path.join(APP_HOME, key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // sea.getAsset() 返回 ArrayBuffer，writeFileSync 只收 Buffer / TypedArray
    fs.writeFileSync(dest, Buffer.from(sea.getAsset(key)));
  }
  fs.writeFileSync(stampFile, ASSETS_VERSION, 'utf8');
}

if (IS_SEA) {
  try {
    materializeAssets();
  } catch (e) {
    console.error('资源释放失败：', e.message);
  }
}

// 资源目录：exe 形态从释放目录读，源码形态从旁边读
const RES_HOME = IS_SEA ? APP_HOME : CODE_HOME;

/**
 * ⚠️ 这里不能用普通的 require('./lib/xxx')：
 *   1. SEA 主脚本里相对 require 会被当成内置模块名解析
 *   2. 需要按真实的磁盘绝对路径造一个 require
 */
const libRequire = createRequire(path.join(RES_HOME, 'server.js'));
const store = libRequire('./lib/store.js');
const agnes = libRequire('./lib/agnes.js');
const poller = libRequire('./lib/poller.js');
const jobs = libRequire('./lib/jobs.js');
const seedLib = libRequire('./lib/seed.js');
const createRoutes = libRequire('./lib/routes.js');

// ─────────────────────────────────────────────────────────────
// 初始化
// ─────────────────────────────────────────────────────────────
fs.mkdirSync(APP_HOME, { recursive: true });
store.init(APP_HOME);
for (const d of [store.imagesDir(), store.videosDir(), store.audiosDir(), store.exportsDir()]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
}
poller.init(store);
seedLib.seedTemplates(store);

const routes = createRoutes({ store, agnes, poller, jobs, version: VERSION });

// 有 Key 且缓存过期时，启动后后台更新模型目录；不阻塞页面启动。
// 没有 Key 时不主动报错，用户到设置页填 Key 后点「刷新模型」即可。
if (store.getRawKey() && store.modelsNeedRefresh()) {
  setTimeout(() => routes.refreshModels().catch(() => {}), 800);
}

// ─────────────────────────────────────────────────────────────
// HTTP 工具
// ─────────────────────────────────────────────────────────────
function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * 写操作必须校验 Origin。
 * 不加这一条，用户浏览任意网页时，那个网页就能静默删掉他的工程文件。
 */
function originOk(req) {
  const o = req.headers.origin;
  if (!o) return true; // curl / 程序自身没有 Origin
  try {
    const h = new URL(String(o)).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
  } catch {
    return false;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** 钉死在 base 目录内，挡路径穿越 */
function safeResolve(base, relPath) {
  const clean = path.normalize(path.join(base, relPath));
  const baseNorm = path.normalize(base);
  if (clean !== baseNorm && !clean.startsWith(baseNorm + path.sep)) return null;
  return clean;
}

function serveStatic(req, res, urlPath) {
  const publicDir = path.join(RES_HOME, 'public');
  let rel = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath);
  if (rel.includes('\0')) return sendText(res, 400, 'bad path');
  let file = safeResolve(publicDir, rel);

  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    // SPA 回退：未知路径一律给 index.html，交给前端路由
    file = path.join(publicDir, 'index.html');
    if (!fs.existsSync(file)) return sendText(res, 404, 'Not Found');
  }

  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const stat = fs.statSync(file);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file).pipe(res);
}

/**
 * 解析 Range 头。抽成纯函数是为了能单测——
 * 边界情况（bytes=-500 后缀区间、start 越界、start>end）靠手点视频条试不出来。
 * @returns {{start:number,end:number}|null|'invalid'}
 *   null = 没有 Range 头或头不合法到可以忽略；'invalid' = 应回 416
 */
function parseRange(header, size) {
  const raw = String(header || '').trim();
  if (!raw) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(raw);
  if (!m) return null;               // 不是 bytes 单位，按整份返回
  const [, a, b] = m;
  if (a === '' && b === '') return null;

  let start;
  let end;
  if (a === '') {                    // bytes=-500 → 最后 500 字节
    start = Math.max(0, size - Number(b));
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Number(b);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid';
  if (start < 0 || start >= size || start > end) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

function serveAsset(req, res, urlPath) {
  // /assets/images/xxx.png  /assets/videos/xxx.mp4  /assets/audios/xxx.mp3
  const parts = urlPath.split('/').filter(Boolean);
  if (parts.length < 3) return sendText(res, 404, 'Not Found');
  const kind = parts[1];
  const name = path.basename(parts.slice(2).join('/'));
  const dir = kind === 'videos' ? store.videosDir()
    : kind === 'images' ? store.imagesDir()
      : kind === 'audios' ? store.audiosDir() : null;
  if (!dir) return sendText(res, 404, 'Not Found');
  const file = safeResolve(dir, name);
  if (!file || !fs.existsSync(file)) return sendText(res, 404, 'Not Found');

  const size = fs.statSync(file).size;
  const ext = path.extname(file).toLowerCase();
  const base = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };

  // 「镜头任务」页的 <video controls> 拖进度条时浏览器会发 Range 请求。
  // 以前这里只声明了 Accept-Ranges 却始终回 200 整个文件，
  // 结果每拖一下都要把几十 MB 的视频重下一遍。
  const range = parseRange(req.headers.range, size);
  if (range === 'invalid') {
    res.writeHead(416, Object.assign({ 'Content-Range': `bytes */${size}` }, base));
    return res.end();
  }
  if (range) {
    res.writeHead(206, Object.assign({
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Content-Length': range.end - range.start + 1,
    }, base));
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file, { start: range.start, end: range.end }).pipe(res);
    return;
  }

  res.writeHead(200, Object.assign({ 'Content-Length': size }, base));
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file).pipe(res);
}

// ─────────────────────────────────────────────────────────────
// 请求处理
// ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = u.pathname;

  // SSE：视频状态与批量任务进度
  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    poller.events.add(res);
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* ignore */ }
    }, 25000);
    req.on('close', () => {
      clearInterval(ping);
      poller.events.remove(res);
    });
    return;
  }

  // 素材文件
  if (pathname.startsWith('/assets/')) return serveAsset(req, res, pathname);

  // API
  if (pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD' && !originOk(req)) {
      return sendJson(res, 403, { ok: false, error: '跨站请求被拒绝（Origin 校验未通过）' });
    }
    let body = {};
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const raw = await readBody(req, 120 * 1024 * 1024).catch(() => null);
      if (raw === null) return sendJson(res, 413, { ok: false, error: '请求体过大' });
      const text = raw.toString('utf8').trim();
      if (text) {
        try { body = JSON.parse(text); } catch { return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
      }
    }
    const query = Object.fromEntries(u.searchParams.entries());
    try {
      const result = routes.dispatch(req.method, pathname, body, query, req, res);
      if (result === undefined) return sendJson(res, 404, { ok: false, error: `接口不存在: ${req.method} ${pathname}` });
      const out = await result;
      if (out && typeof out === 'object' && typeof out.raw === 'string') return sendText(res, 200, out.raw, res.getHeader('Content-Type') || 'text/plain; charset=utf-8');
      return sendJson(res, 200, out === undefined ? { ok: true } : out);
    } catch (e) {
      const status = e.statusCode || 500;
      return sendJson(res, status, { ok: false, error: e.message || String(e) });
    }
  }

  // 静态资源
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);

  return sendText(res, 405, 'Method Not Allowed');
});

// ─────────────────────────────────────────────────────────────
// 启动
// ─────────────────────────────────────────────────────────────
const START_PORT = Number(process.env.PORT || 5178);
const MAX_TRY = 40;

function listen(port, attempt = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempt < MAX_TRY) {
      listen(port + 1, attempt + 1);
    } else {
      console.error(`\n✗ 启动失败：${e.message}`);
      if (e.code === 'EADDRINUSE') console.error(`  端口 ${port} 起被占用，可用 PORT=xxxx 指定别的端口。`);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    const resumed = poller.resume();
    banner(url, port, resumed);
    if (!process.env.NO_OPEN) openBrowser(url);
  });
}

function banner(url, port, resumed) {
  const line = '─'.repeat(58);
  console.log('');
  console.log(line);
  console.log('  Agnes 漫剧工坊 · 本地版  v' + VERSION);
  console.log(line);
  console.log(`  访问地址    ${url}`);
  console.log(`  数据目录    ${APP_HOME}`);
  console.log(`  素材目录    ${path.join(APP_HOME, 'assets')}`);
  if (resumed) console.log(`  恢复轮询    ${resumed} 个未完成的视频任务`);
  console.log('');
  console.log('  关闭这个窗口即可退出程序。');
  console.log(line);
  console.log('');
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      execFile('open', [url], () => {});
    } else {
      execFile('xdg-open', [url], () => {});
    }
  } catch { /* 打不开就算了，地址已经印在控制台 */ }
}

process.on('SIGINT', () => { console.log('\n正在退出…'); process.exit(0); });

if (require.main === module) listen(START_PORT);

module.exports = { server, listen, APP_HOME, VERSION, parseRange, safeResolve };
