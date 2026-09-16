/**
 * apitest.mjs — 接口端到端测试
 * ------------------------------------------------------------------
 * 自己起一个 mock Agnes 服务（假文本 / 假图片 / 假视频任务），
 * 让被测服务把 base url 指过去，就能在不联网、不花钱的前提下
 * 把「生成 → 落盘 → 轮询 → 完成 → 下载」整条链路跑一遍。
 *
 * 用法：node tools/apitest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; return true; }
  fail++; failures.push(`${name}${extra ? ` — ${extra}` : ''}`);
  return false;
}
function eq(name, a, b) { return ok(name, a === b, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); }
function group(t) { console.log(`\n── ${t} ──`); }

const HOME = path.join(os.tmpdir(), `agnes-apitest-${process.pid}`);
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ── mock Agnes ───────────────────────────────────────────────
let queryCount = 0;
const VIDEO_ID = 'vid_mock_001';
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const send = (code, obj) => {
    const s = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
    res.end(s);
  };
  if (req.method === 'GET' && u.pathname === '/agnesapi') {
    queryCount++;
    if (queryCount <= 1) return send(200, { id: VIDEO_ID, status: 'queued', progress: 20 });
    return send(200, { id: VIDEO_ID, status: 'completed', progress: 100, remixed_from_video_id: `${MOCK_BASE}/video.mp4` });
  }
  if (req.method === 'GET' && u.pathname === '/video.mp4') {
    const buf = Buffer.from('MOCKMP4DATA');
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': buf.length });
    return res.end(buf);
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (u.pathname === '/v1/chat/completions') {
      return send(200, { choices: [{ message: { role: 'assistant', content: '```json\n[{"shot_number":1,"shot_type":"特写","image_prompt":"a hero face"}]\n```' } }] });
    }
    if (u.pathname === '/v1/images/generations') {
      return send(200, { data: [{ b64_json: PNG_1PX }] });
    }
    if (req.method === 'GET' && u.pathname === '/v1/models') {
      return send(200, {
        object: 'list',
        data: [
          { id: 'agnes-text-new', name: 'agnes-text-new', kind: 'text', owned_by: 'agnes' },
          { id: 'agnes-image-new', name: 'agnes-image-new', kind: 'image', owned_by: 'agnes' },
          { id: 'agnes-video-new', name: 'agnes-video-new', kind: 'video', owned_by: 'agnes' },
        ],
      });
    }
    if (u.pathname === '/v1/videos') {
      return send(200, { id: VIDEO_ID, video_id: VIDEO_ID, task_id: 'task_mock', status: 'queued' });
    }
    send(404, { error: 'unknown path' });
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => 21000 + Math.floor(Math.random() * 8000);

async function listenAsync(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(port));
  });
}

let MOCK_BASE = '';
let BASE = '';
let srv = null;

async function waitHealth(base, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  return false;
}

async function api(method, url, body, headers = {}) {
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  Object.assign(opts.headers, headers);
  const res = await fetch(`${BASE}${url}`, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data, text };
}

// ── 启动 ─────────────────────────────────────────────────────
const mockPort = await listenAsync(mock, freePort());
MOCK_BASE = `http://127.0.0.1:${mockPort}`;

const srvPort = freePort() + 1;
srv = spawn(NODE, [path.join(ROOT, 'server.js')], {
  env: { ...process.env, PORT: String(srvPort), NO_OPEN: '1', AGNES_STUDIO_HOME: HOME },
  stdio: 'ignore',
});
BASE = `http://127.0.0.1:${srvPort}`;

if (!await waitHealth(BASE)) {
  console.error('✗ 服务没起来');
  srv.kill(); mock.close();
  process.exit(1);
}
console.log(`\nmock Agnes: ${MOCK_BASE}\n被测服务:   ${BASE}\n数据目录:   ${HOME}`);

// ── 1. 基础 ──────────────────────────────────────────────────
group('基础接口');
{
  const r = await api('GET', '/api/health');
  eq('health 200', r.status, 200);
  eq('health ok', r.data.ok, true);
  ok('health 带数据目录', !!r.data.data_home);

  const b = await api('GET', '/api/bootstrap');
  eq('bootstrap 200', b.status, 200);
  ok('bootstrap 含 settings', !!b.data.settings);
  ok('bootstrap 含 projects', Array.isArray(b.data.projects));
  ok('bootstrap 含 stats', !!b.data.stats);
  ok('bootstrap 含模板', Array.isArray(b.data.templates) && b.data.templates.length > 0);
}

// ── 2. 设置 ──────────────────────────────────────────────────
group('设置');
{
  const r = await api('PUT', '/api/settings', {
    agnes_api_base_url: `${MOCK_BASE}/v1`,
    agnes_api_key: 'sk-mock-key-1234567890',
    video_poll_interval: '1',
    video_max_polls: '20',
    auto_download_video: '1',
  });
  eq('保存设置 200', r.status, 200);
  const g = await api('GET', '/api/settings');
  eq('Key 脱敏返回', g.data.agnes_api_key, '***configured***');
  ok('掩码形如 sk-a****7890', /\*+/.test(g.data.agnes_api_key_masked), g.data.agnes_api_key_masked);
  eq('base url 已更新', g.data.agnes_api_base_url, `${MOCK_BASE}/v1`);
  eq('轮询间隔已更新', g.data.video_poll_interval, '1');

  const t = await api('POST', '/api/settings/test', { kind: 'text' });
  ok('连通性测试返回结构', typeof t.data.ok === 'boolean', JSON.stringify(t.data));
  eq('mock 连通', t.data.ok, true);

  const mr = await api('POST', '/api/models/refresh', {});
  eq('模型拉取 200', mr.status, 200);
  eq('模型拉取成功', mr.data.ok, true);
  eq('拉到 3 个模型', mr.data.models.models.length, 3);
  ok('模型目录记录更新时间', !!mr.data.models.updated_at);
  eq('模型来源是 Agnes', mr.data.models.source, 'agnes');
  const ml = await api('GET', '/api/models');
  eq('模型目录可读取', ml.data.models.length, 3);
  eq('模型目录保留新文本模型', ml.data.models.find((m) => m.id === 'agnes-text-new').kind, 'text');
}

// ── 3. 项目 ──────────────────────────────────────────────────
let PROJECT_ID = '';
group('项目');
{
  const r = await api('POST', '/api/projects', { name: '接口测试剧', project_type: '都市逆袭', planned_episodes: 6 });
  eq('建项目 200', r.status, 200);
  PROJECT_ID = r.data.id;
  ok('拿到项目 id', !!PROJECT_ID);
  eq('默认平台', r.data.target_platform, '抖音');

  const l = await api('GET', '/api/projects');
  eq('项目列表有 1 条', l.data.length, 1);

  const u = await api('PUT', `/api/projects/${PROJECT_ID}`, { name: '改过名了', status: 'archived' });
  eq('改名', u.data.name, '改过名了');
  eq('改状态', u.data.status, 'archived');

  const d = await api('POST', `/api/projects/${PROJECT_ID}/duplicate`, {});
  ok('复制出副本', d.data.name.includes('副本'), d.data.name);
  eq('复制后 2 条', (await api('GET', '/api/projects')).data.length, 2);

  const bad = await api('POST', '/api/projects', { name: '' });
  eq('空名称 400', bad.status, 400);
  ok('空名称带错误说明', !!bad.data.error);
}

// ── 4. 文本生成 ──────────────────────────────────────────────
group('文本生成');
{
  const r = await api('POST', '/api/agnes/text', {
    messages: [{ role: 'user', content: '生成分镜' }],
    project_id: PROJECT_ID,
  });
  eq('文本生成 200', r.status, 200);
  eq('文本生成 ok', r.data.ok, true);
  ok('返回内容非空', String(r.data.content).length > 0);
  ok('内容含 JSON', r.data.content.includes('shot_number'));

  // 文本生成要写任务历史（原版这张表一直空着）
  const t = await api('GET', '/api/tasks?task_type=text');
  eq('文本任务入库', t.data.length, 1);
  eq('任务类型正确', t.data[0].task_type, 'text');
}

// ── 5. 剧本 ──────────────────────────────────────────────────
let SCRIPT_ID = '';
group('剧本');
{
  const r = await api('POST', '/api/scripts', {
    project_id: PROJECT_ID, script_type: 'story_concept', title: '测试剧本', content: '正文',
  });
  eq('建剧本 200', r.status, 200);
  SCRIPT_ID = r.data.id;
  const l = await api('GET', `/api/scripts?project_id=${PROJECT_ID}`);
  eq('项目下 1 条剧本', l.data.length, 1);

  const u = await api('PUT', `/api/scripts/${SCRIPT_ID}`, { title: '改标题' });
  eq('改剧本标题', u.data.title, '改标题');

  const bad = await api('POST', '/api/scripts', { content: '' });
  eq('空内容 400', bad.status, 400);
}

// ── 6. 分镜 ──────────────────────────────────────────────────
group('分镜');
{
  const r = await api('POST', '/api/storyboards', {
    rows: [
      { project_id: PROJECT_ID, episode_number: 1, shot_number: 1, shot_type: '特写', image_prompt: 'a hero', sort_order: 0 },
      { project_id: PROJECT_ID, episode_number: 1, shot_number: 2, shot_type: '全景', image_prompt: 'a city', sort_order: 1 },
      { project_id: PROJECT_ID, episode_number: 2, shot_number: 1, shot_type: '中景', sort_order: 0 },
    ],
  });
  eq('批量建分镜 200', r.status, 200);
  eq('插入 3 条', r.data.inserted, 3);

  const l1 = await api('GET', `/api/storyboards?project_id=${PROJECT_ID}&episode=1`);
  eq('第 1 集 2 条', l1.data.length, 2);
  const l2 = await api('GET', `/api/storyboards?project_id=${PROJECT_ID}&episode=2`);
  eq('第 2 集 1 条', l2.data.length, 1);

  // 排序：把两条顺序颠倒
  const ids = l1.data.map((s) => s.id).reverse();
  await api('POST', '/api/storyboards/reorder', { ids });
  const after = await api('GET', `/api/storyboards?project_id=${PROJECT_ID}&episode=1`);
  eq('排序生效', after.data[0].id, ids[0]);

  const one = l1.data[0];
  const u = await api('PUT', `/api/storyboards/${one.id}`, { shot_type: '仰拍', duration_seconds: 5 });
  eq('改景别', u.data.shot_type, '仰拍');
  eq('改时长', u.data.duration_seconds, 5);

  const del = await api('DELETE', `/api/storyboards?project_id=${PROJECT_ID}&episode=2`);
  eq('清空第 2 集', del.data.removed, 1);
}

// ── 7. 图片生成（含落盘） ────────────────────────────────────
let IMG_ID = '';
group('图片生成');
{
  const r = await api('POST', '/api/agnes/image', {
    prompt: 'a hero face', size: '1024x1024', project_id: PROJECT_ID, usage_type: 'storyboard',
  });
  eq('图片生成 200', r.status, 200);
  eq('图片生成 ok', r.data.ok, true);
  IMG_ID = r.data.asset.id;
  ok('返回本地 URL', r.data.asset.url.startsWith('/assets/images/'), r.data.asset.url);
  ok('记录了落盘路径', !!r.data.asset.local_file);

  // 静态访问这张图
  const img = await fetch(`${BASE}${r.data.asset.url}`);
  eq('图片可访问', img.status, 200);
  ok('图片有内容', (await img.arrayBuffer()).byteLength > 0);

  const t = await api('GET', '/api/tasks?task_type=image');
  eq('图片任务入库', t.data.length, 1);

  const fav = await api('PUT', `/api/images/${IMG_ID}`, { is_favorited: true });
  eq('收藏图片', fav.data.is_favorited, true);
  const st = await api('GET', '/api/stats');
  eq('统计里算到收藏', st.data.favorited_assets, 1);
}

// ── 8. 视频任务（提交 → 轮询 → 完成 → 保存） ────────────────
let VID_ID = '';
group('视频任务');
{
  const r = await api('POST', '/api/videos', {
    prompt: 'hero turns and smiles',
    project_id: PROJECT_ID,
    mode: 'text_to_video',
    num_frames: 121,
    frame_rate: 24,
    width: 1152,
    height: 768,
  });
  eq('提交视频 200', r.status, 200);
  eq('提交成功', r.data.ok, true);
  VID_ID = r.data.asset.id;
  eq('拿到 video_id', r.data.asset.agnes_video_id, VIDEO_ID);
  eq('初始状态 queued', r.data.asset.status, 'queued');
  eq('本地状态轮询中', r.data.asset.local_status, 'polling');

  // 等轮询跑完（mock 第 2 次查询返回 completed，interval 设的 1s）
  let asset = null;
  for (let i = 0; i < 30; i++) {
    await sleep(700);
    const v = await api('GET', `/api/videos?project_id=${PROJECT_ID}`);
    asset = v.data[0];
    if (asset.status === 'completed') break;
  }
  eq('轮询后变 completed', asset.status, 'completed');
  ok('拿到视频地址', !!asset.video_url, asset.video_url);
  eq('本地状态完成', asset.local_status, 'completed');
  ok('记录了完成时间', !!asset.completed_at);
  ok('存了原始状态响应', !!asset.raw_status_response);

  // 开了自动保存，应该已经落盘
  ok('视频已自动保存到本机', !!asset.local_file, String(asset.local_file));
  if (asset.local_file) {
    ok('本地视频文件存在', fs.existsSync(asset.local_file), asset.local_file);
    const name = path.basename(asset.local_file);
    const resp = await fetch(`${BASE}/assets/videos/${name}`);
    eq('视频可静态访问', resp.status, 200);
  }
}

// ── 9. 手动刷新与补录 ────────────────────────────────────────
group('刷新与补录');
{
  const r = await api('POST', `/api/videos/${VID_ID}/refresh`, {});
  eq('手动刷新 200', r.status, 200);
  eq('刷新成功', r.data.ok, true);

  // 造一条无 video_id 的任务，测补录
  const r2 = await api('POST', '/api/videos', { prompt: 'no id test', project_id: PROJECT_ID });
  const id2 = r2.data.asset.id;
  await api('PUT', `/api/videos/${id2}`, { name: '待补录' });
  const bind = await api('POST', `/api/videos/${id2}/bind`, { video_id: 'vid_manual_9' });
  eq('补录成功', bind.data.ok, true);
  eq('补录后写入 video_id', bind.data.asset.agnes_video_id, 'vid_manual_9');
  eq('补录后进入轮询', bind.data.asset.local_status, 'polling');

  const nb = await api('POST', `/api/videos/${id2}/bind`, { video_id: '' });
  eq('空 video_id 400', nb.status, 400);

  const br = await api('POST', '/api/videos/batch-refresh', {});
  eq('批量刷新 200', br.status, 200);
  ok('批量刷新返回统计', typeof br.data.total === 'number');

  await api('DELETE', `/api/videos/${id2}`);
}

// ── 10. 模板 ─────────────────────────────────────────────────
group('提示词模板');
{
  const l = await api('GET', '/api/templates');
  ok('内置模板已注入', l.data.length > 5, `${l.data.length} 条`);

  const r = await api('POST', '/api/templates', {
    name: '自定义模板', template_type: 'story_concept', content: '写个 {{题材}} 故事', system: '你是编剧',
  });
  eq('建模板 200', r.status, 200);
  const u = await api('PUT', `/api/templates/${r.data.id}`, { name: '改了名' });
  eq('改模板', u.data.name, '改了名');

  const f = await api('GET', '/api/templates?template_type=optimize');
  ok('按类型过滤', f.data.every((t) => t.template_type === 'optimize'));

  await api('DELETE', `/api/templates/${r.data.id}`);
  eq('删模板后查不到', (await api('GET', `/api/templates`)).data.find((t) => t.id === r.data.id), undefined);
}

// ── 11. 批量队列 ─────────────────────────────────────────────
group('批量队列');
{
  const r = await api('POST', '/api/batch/images', {
    items: [
      { prompt: 'img one', project_id: PROJECT_ID, size: '1024x1024' },
      { prompt: 'img two', project_id: PROJECT_ID, size: '1024x1024' },
    ],
    concurrency: 2,
  });
  eq('批量生图 200', r.status, 200);
  eq('队列收 2 项', r.data.total, 2);

  let job = null;
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    const j = await api('GET', `/api/batch/${r.data.jobId}`);
    job = j.data;
    if (job.status !== 'running') break;
  }
  eq('批量任务结束', job.status, 'done');
  eq('全部成功', job.ok, 2);
  eq('无失败', job.fail, 0);

  const before = (await api('GET', `/api/images?project_id=${PROJECT_ID}`)).data.length;
  ok('批量生成的图片已入库', before >= 3, `${before} 张`);

  const emptyBatch = await api('POST', '/api/batch/images', { items: [] });
  eq('空队列 400', emptyBatch.status, 400);
}

// ── 12. 导入导出 ─────────────────────────────────────────────
group('导入导出');
{
  const ex = await api('GET', '/api/export');
  eq('导出 200', ex.status, 200);
  ok('导出内容是 JSON', typeof ex.data === 'object' && !!ex.data.collections);
  ok('导出含项目', ex.data.collections.projects.length >= 1);

  const im = await api('POST', '/api/import', { data: ex.data, mode: 'merge' });
  eq('导入 200', im.status, 200);
  ok('导入返回结果', typeof im.data.imported === 'number');

  const bad = await api('POST', '/api/import', { data: null, mode: 'xxx' });
  eq('非法模式 400', bad.status, 400);

  const pe = await fetch(`${BASE}/api/projects/${PROJECT_ID}/export`);
  eq('单项目导出 200', pe.status, 200);
  const peData = await pe.json();
  ok('单项目导出含分镜', Array.isArray(peData.storyboards));
  ok('单项目导出含图片', Array.isArray(peData.image_assets));
}

// ── 13. 安全 ─────────────────────────────────────────────────
group('安全');
{
  // CSRF：跨站 Origin 的写操作要被拒
  const bad = await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example.com' },
    body: JSON.stringify({ name: '来自恶意站点' }),
  });
  eq('跨站 POST 被拒 403', bad.status, 403);

  const good = await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1' },
    body: JSON.stringify({ name: '合法来源' }),
  });
  ok('同源 POST 放行', good.status === 200, String(good.status));

  // 路径穿越
  const trav = await fetch(`${BASE}/assets/images/..%2f..%2fserver.js`);
  eq('路径穿越 404', trav.status, 404);
  const trav2 = await fetch(`${BASE}/assets/images/%2e%2e%2f%2e%2e%2fpackage.json`);
  eq('编码穿越 404', trav2.status, 404);

  // Key 不能从任何接口泄露
  const s = await api('GET', '/api/settings');
  ok('设置接口不含明文 Key', !JSON.stringify(s.data).includes('sk-mock-key-1234567890'));
}

// ── 14. 静态资源 ─────────────────────────────────────────────
group('静态资源');
{
  const idx = await fetch(`${BASE}/`);
  eq('首页 200', idx.status, 200);
  ok('首页是 HTML', (await idx.text()).includes('<title>'));

  for (const f of ['/css/app.css', '/js/app.js', '/js/consts.js', '/js/api.js', '/js/ui.js']) {
    const r = await fetch(`${BASE}${f}`);
    eq(`静态资源 ${f}`, r.status, 200);
  }
  for (const p of ['dashboard', 'projects', 'scripts', 'storyboards', 'images', 'videos', 'tasks', 'assets', 'settings']) {
    const r = await fetch(`${BASE}/js/pages/${p}.js`);
    eq(`页面模块 ${p}.js`, r.status, 200);
  }
  const spa = await fetch(`${BASE}/some/unknown/route`);
  eq('未知路由回退首页', spa.status, 200);
}

// ── 15. SSE ──────────────────────────────────────────────────
group('SSE');
{
  // SSE 是长连接，不能 r.text()（会一直等到流结束），要按流读第一块
  const okConn = await new Promise((resolve) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    (async () => {
      try {
        const res = await fetch(`${BASE}/api/events`, { signal: ctrl.signal });
        const reader = res.body.getReader();
        const { value } = await reader.read();
        const text = Buffer.from(value).toString('utf8');
        clearTimeout(timer);
        ctrl.abort();
        resolve(text.includes('connected'));
      } catch { clearTimeout(timer); resolve(false); }
    })();
  });
  ok('SSE 能连上并收到 handshake', okConn);
}

// ── 16. 清理 ─────────────────────────────────────────────────
group('级联删除');
{
  const r = await fetch(`${BASE}/api/projects/${PROJECT_ID}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cascade: true }),
  });
  const d = await r.json();
  eq('删除项目 200', r.status, 200);
  ok('级联删掉了关联数据', d.removed >= 4, `删了 ${d.removed} 条`);
  const left = await api('GET', `/api/storyboards?project_id=${PROJECT_ID}`);
  eq('分镜已清空', left.data.length, 0);
}

// ── 收尾 ─────────────────────────────────────────────────────
srv.kill();
mock.close();
await sleep(400);
fs.rmSync(HOME, { recursive: true, force: true });

console.log(`\n${'═'.repeat(52)}`);
console.log(`  接口测试：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log('  失败项：');
  failures.forEach((f) => console.log(`   ✗ ${f}`));
}
console.log(`${'═'.repeat(52)}\n`);
process.exit(fail ? 1 : 0);
