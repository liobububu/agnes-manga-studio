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
const perVideoQuery = new Map();
let videoSeq = 0;
const retryState = new Map();
let lastVideoBody = {};
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
    // 按 video_id 分别记账：第一次查排队，第二次查完成。
    // 批量场景下一个项目会有多条任务同时轮询，共享一个计数器会让
    // 「第二个任务第一次查就返回 completed」，掩盖真实的轮询行为。
    const vid = u.searchParams.get('video_id') || VIDEO_ID;
    const seen = perVideoQuery.get(vid) || 0;
    perVideoQuery.set(vid, seen + 1);
    if (seen === 0) return send(200, { id: vid, status: 'queued', progress: 20 });
    return send(200, { id: vid, status: 'completed', progress: 100, remixed_from_video_id: `${MOCK_BASE}/video.mp4` });
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
      try { lastVideoBody = JSON.parse(body || '{}'); } catch { lastVideoBody = {}; }
      // 提示词里带 RETRY 的，第一次故意返回 429 —— 用来验证客户端真的会退避重试，
      // 而不是「遇到限流就把后面整批扔掉」
      let prompt = '';
      try { prompt = String((JSON.parse(body || '{}').prompt) || ''); } catch { prompt = ''; }
      if (/RETRY/.test(prompt)) {
        const seen = retryState.get(prompt) || 0;
        retryState.set(prompt, seen + 1);
        if (seen === 0) return send(429, { error: { message: 'rate limited' } });
      }
      // 每次创建返回不同的 id —— 批量提交时若复用同一个 id，
      // 就没法验证「是不是真的提交了 N 个任务」
      videoSeq++;
      const id = videoSeq === 1 ? VIDEO_ID : `vid_mock_${String(videoSeq).padStart(3, '0')}`;
      return send(200, { id, video_id: id, task_id: `task_${id}`, status: 'queued' });
    }
    send(404, { error: 'unknown path' });
  });
});

// ── mock 图床：接收本地图片上传，返回公网地址 ────────────────
let hostUploads = 0;
const hostMock = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    hostUploads++;
    const body = JSON.stringify({
      success: true,
      data: { url: `https://mock.host/img${hostUploads}.png`, display_url: `https://mock.host/img${hostUploads}.png` },
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
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

const hostPort = await listenAsync(hostMock, freePort());
const HOST_BASE = `http://127.0.0.1:${hostPort}`;

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

// ── 9b. 完成后的副作用：不管走自动轮询还是手动刷新都要触发 ────
// 这里的 bug 是真实存在的：回填分镜 / 自动保存原本只写在轮询循环里，
// 用户在「镜头任务」点一下刷新查到完成，分镜状态还停在「有图片」。
group('完成后的副作用');
{
  // 自动下载打开，验证手动刷新也会落盘
  await api('PUT', '/api/settings', { auto_download_video: '1' });

  const sb = await api('POST', '/api/storyboards', {
    rows: [{ project_id: PROJECT_ID, episode_number: 9, shot_number: 1, shot_type: '特写', image_prompt: 'sb side effect', sort_order: 0 }],
  });
  const sbId = sb.data.rows ? sb.data.rows[0].id : (await api('GET', `/api/storyboards?project_id=${PROJECT_ID}&episode=9`)).data[0].id;

  const v = await api('POST', '/api/videos', { prompt: 'side effect test', project_id: PROJECT_ID, storyboard_id: sbId });
  const vid = v.data.asset.id;

  // mock 第 1 次查返回 queued，第 2 次 completed —— 所以刷新两次
  await api('POST', `/api/videos/${vid}/refresh`, {});
  const fresh = await api('POST', `/api/videos/${vid}/refresh`, {});
  eq('手动刷新查到完成', fresh.data.asset.status, 'completed');

  const sbAfter = await api('GET', `/api/storyboards?project_id=${PROJECT_ID}&episode=9`);
  const row = sbAfter.data.find((s) => s.id === sbId);
  eq('手动刷新也回填分镜状态', row.status, 'video_ready');
  eq('分镜关联到视频', row.linked_video_id, vid);

  ok('手动刷新也自动保存视频', !!fresh.data.asset.local_file, JSON.stringify(fresh.data.asset.local_file || ''));

  await api('PUT', '/api/settings', { auto_download_video: '0' });
  await api('DELETE', `/api/videos/${vid}`);
  await api('DELETE', `/api/storyboards/${sbId}`);
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

// ── 11b. 批量视频（用户报过「只能生成一个」，这里重点盯数量） ──
group('批量视频');
{
  const before = (await api('GET', `/api/videos?project_id=${PROJECT_ID}`)).data.length;

  const r = await api('POST', '/api/batch/videos', {
    items: [
      { prompt: 'video one', project_id: PROJECT_ID, mode: 'text_to_video' },
      { prompt: 'video two', project_id: PROJECT_ID, mode: 'text_to_video' },
      { prompt: 'video three', project_id: PROJECT_ID, mode: 'text_to_video' },
    ],
    concurrency: 1,
    interval_ms: 0, // 测试里不等间隔，跑快点；默认间隔另有断言
  });
  eq('批量视频 200', r.status, 200);
  eq('队列收 3 项', r.data.total, 3);

  let job = null;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    const j = await api('GET', `/api/batch/${r.data.jobId}`);
    job = j.data;
    if (job.status !== 'running') break;
  }
  eq('批量视频任务结束', job.status, 'done');
  eq('三项都跑到了', job.done, 3);
  eq('三项都提交成功', job.ok, 3);
  eq('无失败', job.fail, 0);

  const after = (await api('GET', `/api/videos?project_id=${PROJECT_ID}`)).data;
  eq('库里真的多了 3 条视频任务', after.length - before, 3);

  const ids = after.slice(0, 3).map((v) => v.agnes_video_id);
  ok('三个任务拿到不同的 video_id', new Set(ids).size === 3, JSON.stringify(ids));
  ok('每条都记录了提示词', after.slice(0, 3).every((v) => v.video_prompt), '');

  // 带 storyboard_id 时也应逐个提交（分镜批量出视频的真实路径）
  const sbs = await api('GET', `/api/storyboards?project_id=${PROJECT_ID}&episode=1`);
  if (sbs.data.length) {
    const r2 = await api('POST', '/api/batch/videos', {
      items: sbs.data.slice(0, 2).map((s) => ({
        prompt: `shot ${s.shot_number}`,
        project_id: PROJECT_ID,
        storyboard_id: s.id,
        mode: 'text_to_video',
      })),
      concurrency: 1,
      interval_ms: 0,
    });
    let job2 = null;
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      const j = await api('GET', `/api/batch/${r2.data.jobId}`);
      job2 = j.data;
      if (job2.status !== 'running') break;
    }
    eq('分镜批量出视频全部完成', job2.done, 2);
    eq('分镜批量出视频无失败', job2.fail, 0);
  }

  // 限流重试：mock 对带 RETRY 的提示词第一次返回 429
  const rl = await api('POST', '/api/videos', {
    prompt: 'RETRY please',
    project_id: PROJECT_ID,
    mode: 'text_to_video',
  });
  eq('限流后重试成功 200', rl.status, 200);
  eq('限流后重试成功', rl.data.ok, true);
  ok('重试后拿到 video_id', !!rl.data.asset?.agnes_video_id, String(rl.data.asset?.agnes_video_id));

  // 提交间隔：设成 1.2 秒，提交 2 个，任务总耗时应明显大于 1.2 秒
  await api('PUT', '/api/settings', { video_submit_interval_ms: '1200' });
  const ri = await api('POST', '/api/batch/videos', {
    items: [
      { prompt: 'interval one', project_id: PROJECT_ID },
      { prompt: 'interval two', project_id: PROJECT_ID },
    ],
    concurrency: 1,
  });
  let job3 = null;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    const j = await api('GET', `/api/batch/${ri.data.jobId}`);
    job3 = j.data;
    if (job3.status !== 'running') break;
  }
  const spent = new Date(job3.finished_at) - new Date(job3.started_at);
  eq('间隔批量也全部完成', job3.done, 2);
  ok('提交间隔生效', spent >= 1200, `耗时 ${spent}ms`);
  await api('PUT', '/api/settings', { video_submit_interval_ms: '3000' });

  // 视频跑完后要回填分镜状态，否则用户在分镜表上完全看不到进度
  await sleep(3500);
  const sbs2 = await api('GET', `/api/storyboards?project_id=${PROJECT_ID}&episode=1`);
  const linked = sbs2.data.filter((s) => s.status === 'video_ready' || s.linked_video_id);
  ok('视频完成后回填分镜状态', linked.length >= 1, `状态：${sbs2.data.map((s) => s.status).join(',')}`);
}

// ── 11c. 图床：本地图片 → 公网地址 → 图生视频 ────────────────
group('图床与图生视频');
{
  await api('PUT', '/api/settings', {
    image_host_type: 'custom',
    image_host_endpoint: `${HOST_BASE}/upload`,
    image_host_key: 'test-key',
    auto_upload_image: '1',
  });
  const ih = await api('GET', '/api/imagehost');
  eq('图床状态可读', ih.status, 200);
  ok('图床已配置', ih.data.configured, JSON.stringify(ih.data));

  const ht = await api('POST', '/api/imagehost/test', {});
  eq('图床测试通过', ht.data.ok, true);
  ok('测试确实上传了一张', hostUploads > 0, String(hostUploads));

  // 生成一张本地图片（本地版默认落盘，只有本机地址）
  const ir = await api('POST', '/api/agnes/image', {
    prompt: 'host test image', project_id: PROJECT_ID, size: '1024x1024',
  });
  eq('本地图片生成成功', ir.data.ok, true);
  const localUrl = ir.data.asset.url;
  ok('图片只有本机地址', localUrl.startsWith('/assets/'), localUrl);

  // 用本地地址提交图生视频：应自动上传后提交
  const before = hostUploads;
  const vr = await api('POST', '/api/videos', {
    prompt: 'i2v from local image',
    project_id: PROJECT_ID,
    mode: 'image_to_video',
    image: localUrl,
  });
  eq('图生视频提交成功', vr.data.ok, true);
  ok('本地图片被上传到图床', hostUploads > before, `上传次数 ${hostUploads}`);
  ok('提交给 Agnes 的是公网地址', /^https?:\/\//i.test(vr.data.asset.source_image_url), vr.data.asset.source_image_url);

  // 同一张图第二次提交，应复用已保存的公网地址，不再重复上传
  const mid = hostUploads;
  const vr2 = await api('POST', '/api/videos', {
    prompt: 'i2v again',
    project_id: PROJECT_ID,
    mode: 'image_to_video',
    image: localUrl,
  });
  eq('第二次也成功', vr2.data.ok, true);
  eq('不重复上传同一张图', hostUploads, mid);

  // 已传过的图即使没配图床也能提交（公网地址已存下来），这是对的
  await api('PUT', '/api/settings', { image_host_type: '', image_host_key: '' });
  const reused = await api('POST', '/api/videos', {
    prompt: 'reuse saved url', project_id: PROJECT_ID, mode: 'image_to_video', image: localUrl,
  });
  eq('已存公网地址的图无需图床也能提交', reused.data.ok, true);

  // 关闭自动上传后，本地图必须明确拒绝，不能偷偷违背用户设置
  await api('PUT', '/api/settings', { image_host_type: 'custom', image_host_endpoint: `${HOST_BASE}/upload`, image_host_key: 'test-key', auto_upload_image: '0' });
  const ir0 = await api('POST', '/api/agnes/image', {
    prompt: 'auto upload off', project_id: PROJECT_ID, size: '1024x1024',
  });
  const off = await api('POST', '/api/videos', {
    prompt: 'auto upload off', project_id: PROJECT_ID, mode: 'image_to_video', image: ir0.data.asset.url,
  });
  eq('关闭自动上传时拒绝本地图', off.status, 400);
  ok('关闭自动上传错误说明清楚', /自动上传/.test(off.data.error || ''), off.data.error);

  // 没配图床 + 一张还没传过的本地图：必须明确报错，不能把无效参数发给 Agnes
  await api('PUT', '/api/settings', { image_host_type: '', image_host_key: '', auto_upload_image: '1' });
  const ir2 = await api('POST', '/api/agnes/image', {
    prompt: 'never uploaded', project_id: PROJECT_ID, size: '1024x1024',
  });
  const bad = await api('POST', '/api/videos', {
    prompt: 'no host', project_id: PROJECT_ID, mode: 'image_to_video', image: ir2.data.asset.url,
  });
  eq('未配图床时拒绝提交', bad.status, 400);
  ok('错误说明指向图床配置', /图床/.test(bad.data.error || ''), bad.data.error);
}

// ── 11d. 高级参数通道（Agnes 以后新增能力时不用改代码） ───────
group('高级参数通道');
{
  const r = await api('POST', '/api/videos', {
    prompt: 'real prompt',
    project_id: PROJECT_ID,
    mode: 'text_to_video',
    extra_params: { audio_url: 'https://a/b.mp3', custom_field: 7, prompt: '想覆盖主提示词' },
  });
  eq('带额外参数提交成功', r.data.ok, true);
  eq('额外字段透传给 Agnes', lastVideoBody.audio_url, 'https://a/b.mp3');
  eq('自定义字段透传', lastVideoBody.custom_field, 7);
  eq('核心参数不被额外参数覆盖', lastVideoBody.prompt, 'real prompt');
}

// ── 11e. Video 2.5 换了契约：不能按 2.0 发参数 ────────────────
// 2.5 文档明确写了 width / height / fps / num_frames 传了直接 400。
// 模型目录是动态拉的，用户选到 2.5 时如果还发老参数，每个请求都会被拒。
group('Video 2.5 请求体分流');
{
  const r = await api('POST', '/api/videos', {
    prompt: 'v25 test', project_id: PROJECT_ID,
    model: 'agnes-video-2.5', mode: 'text_to_video',
    num_frames: 241, width: 1152, height: 768, frame_rate: 24,
    duration_seconds: 8, mode_25: 'text', size_25: '1080P', aspect_ratio: '16:9',
  });
  eq('2.5 提交成功', r.data.ok, true);
  ok('2.5 不再发 num_frames', !('num_frames' in lastVideoBody), JSON.stringify(lastVideoBody));
  ok('2.5 不再发 width/height', !('width' in lastVideoBody) && !('height' in lastVideoBody));
  ok('2.5 不再发 frame_rate', !('frame_rate' in lastVideoBody));
  eq('2.5 带 mode', lastVideoBody.mode, 'text');
  eq('2.5 时长是字符串秒数', lastVideoBody.seconds, '8');
  eq('2.5 带 size', lastVideoBody.size, '1080P');
  eq('2.5 带画幅', lastVideoBody.aspect_ratio, '16:9');

  // 时长夹到 4~12：不夹的话选 3 秒会被 400
  const r3 = await api('POST', '/api/videos', {
    prompt: 'v25 clamp', project_id: PROJECT_ID, model: 'agnes-video-2.5', duration_seconds: 3,
  });
  eq('2.5 短时长被夹到 4', lastVideoBody.seconds, '4');
  const r30 = await api('POST', '/api/videos', {
    prompt: 'v25 clamp hi', project_id: PROJECT_ID, model: 'agnes-video-2.5', duration_seconds: 30,
  });
  eq('2.5 超长被夹到 12', lastVideoBody.seconds, '12');

  // 老模型必须保持原样，不能因为加了分流就被改坏
  const old = await api('POST', '/api/videos', {
    prompt: 'v20 keep', project_id: PROJECT_ID, model: 'agnes-video-v2.0',
    num_frames: 241, width: 1152, height: 768, frame_rate: 24,
  });
  eq('2.0 提交成功', old.data.ok, true);
  eq('2.0 仍发 num_frames', lastVideoBody.num_frames, 241);
  eq('2.0 仍发 width', lastVideoBody.width, 1152);
  eq('2.0 仍发 frame_rate', lastVideoBody.frame_rate, 24);
  ok('2.0 不带 mode_25 字段', !('seconds' in lastVideoBody));
}

// ── 11f. 音频生视频（Agnes 2.5 的 audios 参考） ───────────────
group('音频生视频');
{
  const r = await api('POST', '/api/videos', {
    prompt: 'lip sync <Audio 1>', project_id: PROJECT_ID,
    model: 'agnes-video-2.5', mode: 'audio_reference',
    audios: ['https://cdn.example.com/voice1.mp3', 'https://cdn.example.com/voice2.mp3'],
    duration_seconds: 6, mode_25: 'reference',
  });
  eq('音频提交成功', r.data.ok, true);
  eq('audios 透传给 Agnes', JSON.stringify(lastVideoBody.audios), JSON.stringify(['https://cdn.example.com/voice1.mp3', 'https://cdn.example.com/voice2.mp3']));
  eq('音频模式是 reference', lastVideoBody.mode, 'reference');

  for (const v of ['https://cdn.example.com/voice1.mp3', 'https://cdn.example.com/voice2.mp3']) {
    ok('音频公网地址未被动手脚', lastVideoBody.audios.includes(v));
  }

  // 超过 3 段要拦住，不能悄悄丢掉用户填的内容
  const many = await api('POST', '/api/videos', {
    prompt: 'too many audios', project_id: PROJECT_ID, model: 'agnes-video-2.5',
    audios: ['https://a/1.mp3', 'https://a/2.mp3', 'https://a/3.mp3', 'https://a/4.mp3'],
  });
  eq('超过 3 段音频被拒', many.status, 400);
  ok('提示说明上限', /3/.test(many.data.error || ''), many.data.error);

  // 本机路径 Agnes 抓不到，没配图床时必须明确报错
  const local = await api('POST', '/api/videos', {
    prompt: 'local audio', project_id: PROJECT_ID, model: 'agnes-video-2.5',
    audios: ['/assets/audios/voice.mp3'],
  });
  eq('本机音频未配图床时 400', local.status, 400);
  ok('错误说明指向公网 URL 或图床', /公网|图床/.test(local.data.error || ''), local.data.error);

  // 音频存在资产记录里，事后能复盘用了哪几段
  const all = await api('GET', '/api/videos');
  const saved = all.data.find((v) => v.id === r.data.asset.id);
  ok('资产记录了音频来源', Array.isArray(saved?.source_audios) && saved.source_audios.length === 2,
    JSON.stringify(saved?.source_audios));
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

// ── 17. 素材 Range 请求 ──────────────────────────────────────
// 「镜头任务」页用 <video controls> 预览本地视频，拖进度条时浏览器会发
// Range 请求。以前服务端声明了 Accept-Ranges 却始终回 200 整个文件，
// 每拖一下都要把几十 MB 重下一遍。
group('素材 Range 请求');
{
  const dir = path.join(HOME, 'assets', 'videos');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'range.mp4'), Buffer.alloc(1000, 7));

  const full = await fetch(`${BASE}/assets/videos/range.mp4`);
  eq('整份请求 200', full.status, 200);
  eq('声明支持 Range', full.headers.get('accept-ranges'), 'bytes');
  eq('无 Range 时回全量', (Buffer.from(await full.arrayBuffer())).length, 1000);

  const r1 = await fetch(`${BASE}/assets/videos/range.mp4`, { headers: { Range: 'bytes=100-199' } });
  eq('区间请求 206', r1.status, 206);
  eq('Content-Range 正确', r1.headers.get('content-range'), 'bytes 100-199/1000');
  eq('区间只回 100 字节', (Buffer.from(await r1.arrayBuffer())).length, 100);

  const r2 = await fetch(`${BASE}/assets/videos/range.mp4`, { headers: { Range: 'bytes=900-' } });
  eq('开放区间 206', r2.status, 206);
  eq('开放区间回剩余部分', (Buffer.from(await r2.arrayBuffer())).length, 100);

  const r3 = await fetch(`${BASE}/assets/videos/range.mp4`, { headers: { Range: 'bytes=-50' } });
  eq('后缀区间 206', r3.status, 206);
  eq('后缀区间回 50 字节', (Buffer.from(await r3.arrayBuffer())).length, 50);

  const bad = await fetch(`${BASE}/assets/videos/range.mp4`, { headers: { Range: 'bytes=5000-6000' } });
  eq('越界区间 416', bad.status, 416);

  // 之前 serveAsset 只认 images / videos，audios 会 404
  const adir = path.join(HOME, 'assets', 'audios');
  fs.mkdirSync(adir, { recursive: true });
  fs.writeFileSync(path.join(adir, 'a.mp3'), Buffer.from('MP3DATA'));
  const au = await fetch(`${BASE}/assets/audios/a.mp3`);
  eq('audios 素材可访问', au.status, 200);
}

// ── 收尾 ─────────────────────────────────────────────────────
srv.kill();
mock.close();
hostMock.close();
await sleep(400);
fs.rmSync(HOME, { recursive: true, force: true });

console.log(`\n${'═'.repeat(52)}`);
console.log(`  接口测试：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log('  失败项：');
  failures.forEach((f) => console.log(`   ✗ ${f}`));
}
console.log(`${'═'.repeat(52)}\n`);
// ⚠️ 不能用 process.exit()：stdout 重定向到文件/管道时是异步的，exit() 会
//    把还没刷出的缓冲丢掉——末尾的汇总标记就没了，上层判失败。
process.exitCode = fail ? 1 : 0;
