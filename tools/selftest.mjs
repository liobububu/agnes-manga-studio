/**
 * selftest.mjs — 离线自检（不联网、不起服务）
 * 覆盖：数据层 CRUD、设置脱敏、导入导出、状态机、URL 归一化、批量队列、路由分发
 *
 * 用法：node tools/selftest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(path.join(ROOT, 'server.js'));

const store = require('./lib/store.js');
const agnes = require('./lib/agnes.js');
const jobs = require('./lib/jobs.js');
const seed = require('./lib/seed.js');
const createRoutes = require('./lib/routes.js');
const imagehost = require('./lib/imagehost.js');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) { pass++; return true; }
  fail++;
  failures.push(`${name}${extra ? ` — ${extra}` : ''}`);
  return false;
}
function eq(name, actual, expected) {
  return ok(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function group(t) { console.log(`\n── ${t} ──`); }

// ── 0. 干净的数据目录 ────────────────────────────────────────
const HOME = path.join(os.tmpdir(), `agnes-selftest-${process.pid}`);
fs.rmSync(HOME, { recursive: true, force: true });
store.init(HOME);

// ── 1. 数据层 ────────────────────────────────────────────────
group('数据层');
{
  const p = store.insert('projects', { name: '测试剧', project_type: '爽文漫剧' });
  ok('插入项目返回 id', !!p.id, JSON.stringify(p));
  ok('插入项目自动带 created_at', !!p.created_at);
  ok('插入项目自动带 updated_at', !!p.updated_at);

  const got = store.get('projects', p.id);
  eq('按 id 取回', got.name, '测试剧');

  const updated = store.update('projects', p.id, { name: '改名了' });
  eq('更新字段', updated.name, '改名了');
  eq('更新后条数不变', store.count('projects'), 1);

  // 分镜批量插入
  const rows = store.insertMany('storyboards', [
    { project_id: p.id, episode_number: 1, shot_number: 1, sort_order: 0 },
    { project_id: p.id, episode_number: 1, shot_number: 2, sort_order: 1 },
    { project_id: p.id, episode_number: 2, shot_number: 1, sort_order: 0 },
  ]);
  eq('批量插入 3 条', rows.length, 3);
  eq('按集数过滤', store.list('storyboards', { filter: (r) => r.episode_number === 1 }).length, 2);
  eq('按项目+集数过滤', store.list('storyboards', {
    filter: (r) => r.project_id === p.id && r.episode_number === 2,
  }).length, 1);

  ok('删除存在', store.remove('projects', p.id));
  eq('删除后条数归零', store.count('projects'), 0);
  ok('删除不存在返回 false', !store.remove('projects', 'nope'));

  // 未知集合要抛错，不能静默建表
  let threw = false;
  try { store.insert('not_a_table', {}); } catch { threw = true; }
  ok('未知集合抛错', threw);
}

// ── 2. 设置与脱敏 ────────────────────────────────────────────
group('设置与脱敏');
{
  eq('默认 base url', store.getSettings().agnes_api_base_url, 'https://apihub.agnes-ai.com/v1');
  eq('默认文本模型', store.getSettings().default_text_model, 'agnes-2.0-flash');

  store.setSettings({ agnes_api_key: 'sk-abcdefgh12345678' });
  eq('原始 key 可取', store.getRawKey(), 'sk-abcdefgh12345678');
  eq('掩码格式', store.getSettingsMasked().agnes_api_key_masked, 'sk-a****5678');
  eq('对外只给占位', store.getSettingsMasked().agnes_api_key, '***configured***');
  ok('脱敏后不含中间片段', !store.getSettingsMasked().agnes_api_key_masked.includes('cdefgh'));

  // 非法字段不能混进来
  store.setSettings({ evil_field: 'x' });
  ok('非白名单字段被忽略', !('evil_field' in store.getSettings()));

  // 短 key 不崩
  eq('短 key 掩码', store.maskKey('abc'), 'ab****');
  eq('空 key 掩码', store.maskKey(''), '');
}

// ── 3. 导入导出 ──────────────────────────────────────────────
group('导入导出');
{
  const a = store.insert('projects', { name: '导出测试' });
  store.insert('scripts', { project_id: a.id, title: '剧本', content: '内容' });
  const dump = store.exportProject(a.id);
  ok('项目导出含 project', !!dump.project);
  eq('项目导出带剧本', dump.scripts.length, 1);
  ok('导出带时间戳', !!dump.exported_at);

  // 级联删除必须覆盖「所有带 project_id 的集合」。
  // 之前是把集合名写死成一个数组，加了 edit_plans 没同步，
  // 结果删了项目却留下一堆孤儿剪辑方案。
  store.insert('edit_plans', { project_id: a.id, episode_number: 1, clips: [] });
  const dump2 = store.exportProject(a.id);
  ok('项目导出带剪辑方案', Array.isArray(dump2.edit_plans) && dump2.edit_plans.length === 1,
    JSON.stringify(dump2.edit_plans || []).slice(0, 120));
  // 导出的集合范围必须跟着 COLLECTIONS 走，写死的话加表就会漏
  const scoped = store.COLLECTIONS.filter((c) => c !== 'projects' && c !== 'prompt_templates');
  ok('项目导出覆盖所有项目级集合', scoped.every((c) => Array.isArray(dump2[c])),
    scoped.filter((c) => !Array.isArray(dump2[c])).join(','));

  const all = store.exportAll();
  // 别写死数量：加一张新表就该跟着变，写死的话每次加表都要来改断言
  eq('全量导出覆盖所有集合', Object.keys(all.collections).length, store.COLLECTIONS.length);
  ok('每张表都在导出里', store.COLLECTIONS.every((c) => Array.isArray(all.collections[c])),
    store.COLLECTIONS.filter((c) => !Array.isArray(all.collections[c])).join(','));

  // 改 id 后合并导入 → 应新增
  const copy = JSON.parse(JSON.stringify(all.collections));
  copy.projects = copy.projects.map((p) => ({ ...p, id: `${p.id}_copy` }));
  const before = store.count('projects');
  const r1 = store.importAll({ collections: copy }, 'merge');
  ok('合并导入有新增', r1.added > 0);
  ok('合并后条数增加', store.count('projects') > before);
  eq('合法数据没有跳过项', r1.skipped.length, 0);

  const r2 = store.importAll({ collections: { projects: [{ id: 'only-one', name: '替换测试' }] } }, 'replace');
  ok('替换导入返回条数', r2.added >= 1);
  eq('替换后只剩一条', store.count('projects'), 1);

  // 没有 id / 不是对象 / 重复 id 的行不能被塞进库——
  // 所有接口按 id 定位，这种行进去以后改不了也删不掉，会一直卡在那儿
  const r3 = store.importAll({
    collections: {
      projects: [
        { name: '没有 id' },
        'just a string',
        null,
        { id: 'dup', name: '第一次' },
        { id: 'dup', name: '第二次' },
      ],
    },
  }, 'replace');
  eq('不合法的行全部跳过', r3.skipped.length, 4);
  eq('只留下有 id 的那条', store.count('projects'), 1);
  eq('留下的是第一条', store.list('projects')[0].name, '第一次');
  ok('跳过原因可读', r3.skipped.some((s) => /缺少 id/.test(s)) && r3.skipped.some((s) => /重复 id/.test(s)),
    JSON.stringify(r3.skipped));
}

// ── 4. 统计 ──────────────────────────────────────────────────
group('统计');
{
  store._resetForTest();
  const p = store.insert('projects', { name: '统计用', status: 'active' });
  store.insert('projects', { name: '归档', status: 'archived' });
  store.insert('storyboards', { project_id: p.id });
  store.insert('video_assets', { status: 'failed', local_status: 'submit_failed' });
  const s = store.stats();
  eq('项目总数', s.total_projects, 2);
  eq('进行中项目', s.active_projects, 1);
  eq('失败任务计数', s.failed_tasks, 1);
  eq('分镜数', s.total_storyboards, 1);
}

// ── 5. Agnes URL 与状态机 ────────────────────────────────────
group('Agnes 工具');
{
  eq('末尾斜杠归一化', agnes.normalizeBase('https://x.com/v1/'), 'https://x.com/v1');
  eq('补协议', agnes.normalizeBase('x.com/v1'), 'https://x.com/v1');
  eq('withV1 不重复', agnes.withV1('https://x.com/v1'), 'https://x.com/v1/chat/completions'.replace('/chat/completions', ''));
  eq('rootBase 去掉 v1', agnes.rootBase('https://x.com/v1'), 'https://x.com');
  eq('rootBase 无 v1 保持', agnes.rootBase('https://x.com'), 'https://x.com');

  // video_url 提取优先级
  eq('优先 remixed_from_video_id',
    agnes.extractVideoUrl({ remixed_from_video_id: 'A', video_url: 'B' }), 'A');
  eq('其次 video_url', agnes.extractVideoUrl({ video_url: 'B', url: 'C' }), 'B');
  eq('都没有给空串', agnes.extractVideoUrl({}), '');

  // 状态机
  let u = agnes.buildSafeStatusUpdate({ status: 'completed', remixed_from_video_id: 'http://v.mp4' });
  eq('completed 有地址 → completed', u.status, 'completed');
  eq('completed 有地址 → 本地完成', u.local_status, 'completed');
  ok('completed 记完成时间', !!u.completed_at);

  u = agnes.buildSafeStatusUpdate({ status: 'completed' });
  eq('completed 无地址 → 地址待取', u.status, 'video_url_missing');
  eq('completed 无地址 → 解析失败', u.local_status, 'result_parse_failed');

  u = agnes.buildSafeStatusUpdate({ status: 'failed', error: '炸了' });
  eq('failed → failed', u.status, 'failed');
  eq('failed 记错误', u.error_message, '炸了');

  u = agnes.buildSafeStatusUpdate({ status: 'in_progress', progress: 42 });
  eq('in_progress → in_progress', u.status, 'in_progress');
  eq('进度被记录', u.progress, 42);

  u = agnes.buildSafeStatusUpdate({ status: 'queued' });
  eq('queued → queued', u.status, 'queued');

  u = agnes.buildSafeStatusUpdate({ nothing: true });
  eq('未知状态不改 status', u.status, undefined);
  ok('未知状态仍存原始响应', !!u.raw_status_response);

  const models = store.normalizeModels({ data: [
    { id: 'new-text', kind: 'text' },
    { id: 'new-image', kind: 'image' },
    { id: 'new-text', kind: 'text' },
    'new-video',
  ] });
  eq('模型目录去重', models.length, 3);
  eq('模型目录保留 kind', models.find((m) => m.id === 'new-image').kind, 'image');
  eq('字符串模型可识别', models.find((m) => m.id === 'new-video').kind, 'video');

  const cache = store.setModels({ models: [{ id: 'cached', kind: 'text' }] }, { source: 'test' });
  eq('模型缓存写入', cache.models.length, 1);
  eq('模型缓存来源', cache.source, 'test');
  ok('模型缓存不过期判断', !store.modelsNeedRefresh());
  store.setModelCacheError('暂时失败');
  eq('失败只记录错误不清空模型', store.getModels().models.length, 1);
  eq('模型缓存错误可读', store.getModels().error, '暂时失败');
}

// ── 4b. 视频请求体构造（纯函数，不发网络请求） ────────────────
// 2.5 和 2.0 的契约不同，这里逐字段锁住——靠真提交才发现 400 就太晚了。
group('视频请求体');
{
  const b25 = agnes.buildVideoBody({
    prompt: 'p', model: 'agnes-video-2.5', mode_25: 'text', duration_seconds: 8,
    size_25: '1080P', aspect_ratio: '9:16', seed: '7',
  }, 'agnes-video-2.5');
  eq('2.5 带 mode', b25.mode, 'text');
  eq('2.5 时长是字符串', b25.seconds, '8');
  eq('2.5 带 size', b25.size, '1080P');
  eq('2.5 带画幅', b25.aspect_ratio, '9:16');
  eq('2.5 seed 转数字', b25.seed, 7);
  for (const banned of ['num_frames', 'width', 'height', 'frame_rate']) {
    ok(`2.5 不含 ${banned}`, !(banned in b25), JSON.stringify(b25));
  }

  const b20 = agnes.buildVideoBody({
    prompt: 'p', num_frames: 241, width: 1152, height: 768, frame_rate: 24,
    negative_prompt: 'bad',
  }, 'agnes-video-v2.0');
  eq('2.0 带 num_frames', b20.num_frames, 241);
  eq('2.0 带 width', b20.width, 1152);
  eq('2.0 带 negative_prompt', b20.negative_prompt, 'bad');
  ok('2.0 不带 seconds', !('seconds' in b20));
  ok('2.0 不带 mode_25 字段', !('mode' in b20));

  // 图生视频：2.5 用 images[]，2.0 用 image
  const i25 = agnes.buildVideoBody({ prompt: 'p', image: 'https://i/1.png', mode_25: 'reference' }, 'agnes-video-2.5');
  eq('2.5 图片进 images 数组', JSON.stringify(i25.images), JSON.stringify(['https://i/1.png']));
  const i20 = agnes.buildVideoBody({ prompt: 'p', image: 'https://i/1.png' }, 'agnes-video-v2.0');
  eq('2.0 图片仍是 image 字段', i20.image, 'https://i/1.png');

  // 首尾帧：2.5 拆成 first_frame / last_frame
  const kf25 = agnes.buildVideoBody({
    prompt: 'p', mode_25: 'keyframe',
    source_images: [{ url: 'https://a.png' }, { url: 'https://b.png' }, { url: 'https://c.png' }],
  }, 'agnes-video-2.5');
  eq('2.5 首帧', kf25.first_frame, 'https://a.png');
  eq('2.5 尾帧', kf25.last_frame, 'https://b.png');
  eq('2.5 多余的图进 images', JSON.stringify(kf25.images), JSON.stringify(['https://c.png']));

  // 音频：自动把 mode 从 text 提到 reference，否则 Agnes 会拒
  const a25 = agnes.buildVideoBody({ prompt: 'p', mode_25: 'text', audios: ['https://x/1.mp3'] }, 'agnes-video-2.5');
  eq('有音频时 mode 提到 reference', a25.mode, 'reference');
  eq('音频透传', JSON.stringify(a25.audios), JSON.stringify(['https://x/1.mp3']));
  const many = agnes.buildVideoBody({
    prompt: 'p', mode_25: 'reference',
    audios: ['1', '2', '3', '4', '5'],
  }, 'agnes-video-2.5');
  eq('音频最多保留 3 段', many.audios.length, 3);

  // 时长夹取（4~12）
  eq('短时长夹到 4', agnes.buildVideoBody({ prompt: 'p', duration_seconds: 1 }, 'agnes-video-2.5').seconds, '4');
  eq('长时长夹到 12', agnes.buildVideoBody({ prompt: 'p', duration_seconds: 99 }, 'agnes-video-2.5').seconds, '12');

  // 高级参数不能顶掉核心字段
  const ex = agnes.buildVideoBody({
    prompt: 'real', model: 'agnes-video-2.5', extra_params: { prompt: 'hack', model: 'hack', foo: 1 },
  }, 'agnes-video-2.5');
  eq('高级参数不覆盖 prompt', ex.prompt, 'real');
  eq('高级参数不覆盖 model', ex.model, 'agnes-video-2.5');
  eq('高级参数新字段透传', ex.foo, 1);
}

// ── 5b. 图床（本地图片 → 公网地址，图生视频的关键链路） ──────
group('图床');
{
  store._resetForTest();
  eq('未配置时 config 为空', imagehost.config(), null);
  ok('未配置时 isConfigured 为假', !imagehost.isConfigured());

  ok('内置三种图床', Object.keys(imagehost.HOSTS).length === 3, Object.keys(imagehost.HOSTS).join(','));

  // 本地素材地址还原成本机路径
  const p = imagehost.localPathFromAssetUrl('/assets/images/abc.png');
  ok('还原本地图片路径', !!p && String(p).endsWith('abc.png') && String(p).includes('images'), String(p));
  eq('公网地址不还原', imagehost.localPathFromAssetUrl('https://x.com/a.png'), null);
  eq('非素材路径不还原', imagehost.localPathFromAssetUrl('/other/a.png'), null);

  // 不同图床返回格式都要能解析出地址
  eq('解析 imgbb 响应', imagehost.pickUrl({ data: { url: 'https://i.ibb.co/a.png' } }), 'https://i.ibb.co/a.png');
  eq('解析 display_url', imagehost.pickUrl({ data: { display_url: 'https://i.ibb.co/b.png' } }), 'https://i.ibb.co/b.png');
  eq('解析 SM.MS 响应', imagehost.pickUrl({ data: { url: 'https://s2.loli.net/c.png' } }), 'https://s2.loli.net/c.png');
  eq('解析嵌套 image.url', imagehost.pickUrl({ data: { image: { url: 'https://h/d.png' } } }), 'https://h/d.png');
  eq('解析 link 字段', imagehost.pickUrl({ link: 'https://h/e.png' }), 'https://h/e.png');
  eq('没有地址时返回空', imagehost.pickUrl({ success: true }), '');
  eq('非 http 地址不认', imagehost.pickUrl({ data: { url: '/local/a.png' } }), '');

  // 没配图床就上传，必须明确报错，而不是静默失败
  let threw = false;
  try { await imagehost.uploadFile('/no/such/file.png'); } catch { threw = true; }
  ok('未配置图床时上传报错', threw);

  // 配了之后读得到，但不真发请求
  store.setSettings({ image_host_type: 'imgbb', image_host_key: 'k-test' });
  const cfg = imagehost.config();
  ok('配置后可读到', !!cfg);
  eq('图床类型', cfg.type, 'imgbb');
  eq('接口地址', cfg.endpoint, 'https://api.imgbb.com/1/upload');
  ok('配置后 isConfigured 为真', imagehost.isConfigured());

  // 密钥传空表示不修改：避免用户在设置页点保存就把 Key 清掉
  store.setSettings({ image_host_key: '' });
  eq('空密钥不覆盖已保存的值', store.getRawKey(), '');
  eq('图床 Key 保持原值', store.getSettings().image_host_key, 'k-test');

  // 自定义图床必须填接口地址，否则视为没配
  store.setSettings({ image_host_type: 'custom' });
  eq('自定义图床缺地址时视为未配置', imagehost.config(), null);
  store.setSettings({ image_host_endpoint: 'https://my.host/upload' });
  eq('填了地址后可用', imagehost.config().endpoint, 'https://my.host/upload');
}

// ── 6. 批量队列 ──────────────────────────────────────────────
group('批量队列');
{
  const job = jobs.create('images', 5);
  const seen = [];
  const done = await jobs.run(job, [1, 2, 3, 4, 5], async (item, i) => {
    seen.push(item);
    if (item === 3) return { ok: false, error: '故意失败' };
    return { ok: true, id: `x${item}` };
  }, { concurrency: 2, onProgress: () => {} });
  eq('全部执行', done.done, 5);
  eq('成功 4', done.ok, 4);
  eq('失败 1', done.fail, 1);
  eq('状态结束', done.status, 'done');
  eq('每项都跑到', seen.length, 5);

  const j2 = jobs.create('videos', 3);
  j2.cancel = true;
  const r2 = await jobs.run(j2, [1, 2, 3], async () => ({ ok: true }), { concurrency: 1 });
  eq('取消后状态', r2.status, 'cancelled');
  ok('取消后不再继续', r2.done < 3);

  const j3 = jobs.create('images', 1);
  ok('可按 id 取回', jobs.get(j3.id) === j3);
  ok('取消接口', jobs.cancel(j3.id));
  ok('取消不存在的任务返回 false', !jobs.cancel('nope'));
}

// ── 7. 路由分发 ──────────────────────────────────────────────
group('路由分发');
{
  store._resetForTest();
  const fakePoller = {
    init() {}, stop() {}, watch() {}, pollOnce: async () => null,
    events: { emit() {}, add() {}, remove() {} }, log: [], pushLog() {},
  };
  const routes = createRoutes({ store, agnes, poller: fakePoller, jobs, version: 'test' });

  const health = routes.dispatch('GET', '/api/health', {}, {}, {}, null);
  eq('健康检查 ok', health.ok, true);
  eq('健康检查带版本', health.version, 'test');

  const p = routes.dispatch('POST', '/api/projects', { name: '路由测试' }, {}, {}, null);
  ok('路由建项目', !!p.id);

  const one = routes.dispatch('GET', `/api/projects/${p.id}`, {}, {}, {}, null);
  eq('路由取项目', one.name, '路由测试');

  const upd = routes.dispatch('PUT', `/api/projects/${p.id}`, { name: '改了' }, {}, {}, null);
  eq('路由改项目', upd.name, '改了');

  let err = null;
  try { routes.dispatch('POST', '/api/projects', { name: '' }, {}, {}, null); }
  catch (e) { err = e; }
  ok('空名称返回 400', err && err.statusCode === 400, err && err.message);

  err = null;
  try { routes.dispatch('GET', '/api/projects/nope', {}, {}, {}, null); }
  catch (e) { err = e; }
  ok('不存在的资源 404', err && err.statusCode === 404);

  eq('未匹配路由返回 undefined', routes.dispatch('GET', '/api/not-exist', {}, {}, {}, null), undefined);

  // 分镜批量 + 排序
  const sb = routes.dispatch('POST', '/api/storyboards', {
    rows: [{ project_id: p.id, episode_number: 1, shot_number: 1 }, { project_id: p.id, episode_number: 1, shot_number: 2 }],
  }, {}, {}, null);
  eq('路由批量建分镜', sb.inserted, 2);
  const list = routes.dispatch('GET', '/api/storyboards', {}, { project_id: p.id, episode: '1' }, {}, null);
  eq('路由按集过滤', list.length, 2);

  // 模板
  const t = routes.dispatch('POST', '/api/templates', { name: '测试模板', template_type: 'story_concept', content: 'hi {{x}}' }, {}, {}, null);
  ok('路由建模板', !!t.id);
  err = null;
  try { routes.dispatch('POST', '/api/templates', { name: '' }, {}, {}, null); }
  catch (e) { err = e; }
  ok('模板空名称 400', err && err.statusCode === 400);

  // 视频创建：没配 key 时应报 no_api_key（且落一条失败记录）
  store.setSettings({ agnes_api_key: '' });
  const before = store.count('video_assets');
  let vres = null;
  try { vres = await routes.dispatch('POST', '/api/videos', { prompt: 'x' }, {}, {}, null); }
  catch (e) { vres = { ok: false, error: e.message }; }
  ok('无 key 时视频提交被拦下', vres && vres.ok === false, JSON.stringify(vres));
  ok('失败也留下记录可复盘', store.count('video_assets') > before);
}

// ── 8. 内置模板种子 ──────────────────────────────────────────
group('内置模板');
{
  store._resetForTest();
  const n1 = seed.seedTemplates(store);
  ok('首装写入默认模板', n1 > 0, `写入 ${n1} 条`);
  const n2 = seed.seedTemplates(store);
  eq('重复播种不重复写', n2, 0);
  ok('含故事构思模板', store.list('prompt_templates').some((t) => t.template_type === 'story_concept'));
  ok('含脚本优化模板', store.list('prompt_templates').some((t) => t.template_type === 'optimize'));
  ok('模板带变量占位', store.list('prompt_templates').some((t) => /\{\{.+\}\}/.test(t.content)));
}

// ── 9. 文件落盘安全 ──────────────────────────────────────────
group('素材落盘');
{
  const fakePoller = {
    init() {}, stop() {}, watch() {}, pollOnce: async () => null,
    events: { emit() {} }, log: [], pushLog() {},
  };
  const routes = createRoutes({ store, agnes, poller: fakePoller, jobs, version: 'test' });
  const b64 = Buffer.from('fake-image-bytes').toString('base64');
  const saved = routes.saveImageBase64(b64, 'image/png');
  ok('图片写入磁盘', fs.existsSync(saved.file), saved.file);
  ok('落盘路径在 images 目录内', saved.file.startsWith(store.imagesDir()), saved.file);
  ok('返回可访问 URL', saved.url.startsWith('/assets/images/'), saved.url);
  eq('文件内容一致', fs.readFileSync(saved.file, 'utf8'), 'fake-image-bytes');

  // 恶意文件名必须被压成安全名字
  const evil = routes.safeName('../../evil.png', 'png');
  ok('路径穿越被挡', !evil.includes('..'), evil);
  const evil2 = routes.safeName('a/b\\c:*.png', 'png');
  ok('非法字符被替换', !/[\\/:*?"<>|]/.test(path.basename(evil2)), evil2);
  eq('空名字给默认值', path.basename(routes.safeName('', 'png')).startsWith('asset_'), true);

  /**
   * 图片必须只存「文件在哪」，不能把 base64 正文塞进 db.json。
   * 每次写盘都是 JSON.stringify 整个库，一张 2MB 图的 base64 进去，
   * 库就变成几十 MB，之后每次轮询落盘都要重写一遍——表现为「越用越卡」，
   * 而且很难联想到是某张图的问题。这条断言把这种写法挡在门外。
   */
  const bigB64 = Buffer.alloc(256 * 1024, 7).toString('base64');   // 256KB 图
  const big = routes.saveImageBase64(bigB64, 'image/png');
  const rec = store.insert('image_assets', {
    project_id: null, name: '大图', url: big.url, local_file: big.file,
    generation_prompt: 'a big image', mime: 'image/png',
  });
  ok('大图也只存路径不存正文', !JSON.stringify(rec).includes(bigB64.slice(0, 200)),
    'base64 被写进了记录');
  const longest = Object.values(rec).reduce((m, v) => Math.max(m, typeof v === 'string' ? v.length : 0), 0);
  ok('记录里没有超长字段', longest < 2000, `最长字段 ${longest} 字符`);

  // 实测：中等规模库的一次全量落盘要在可接受范围内
  const t0 = Date.now();
  store.persist();
  await new Promise((r) => setTimeout(r, 300));
  ok('一次全量落盘在 1 秒内', Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
}

// ── 10. 数据文件损坏的恢复 ───────────────────────────────────
// 本地应用的命门：db.json 坏了会怎样。最坏的情况不是报错，
// 是「静默起一个空库」，用户打开一看项目全没了却不知道为什么。
group('数据损坏恢复');
{
  const D = path.join(HOME, '..', `agnes-corrupt-${process.pid}`);
  const wipe = () => fs.rmSync(D, { recursive: true, force: true });
  const write = (n, s) => { fs.mkdirSync(D, { recursive: true }); fs.writeFileSync(path.join(D, n), s); };

  // 1) 主文件坏 + 备份好 → 从备份恢复，且坏文件另存（不能让它变成新的 .bak）
  wipe();
  write('db.json', '{ 这不是合法 JSON');
  write('db.json.bak', JSON.stringify({ projects: [{ id: 'p1', name: '备份里的项目' }] }));
  store.init(D);
  eq('从备份恢复了数据', store.count('projects'), 1);
  eq('恢复的是备份内容', store.list('projects')[0].name, '备份里的项目');
  const issues1 = store.getLoadIssues();
  ok('记录了恢复过程', issues1.some((i) => /备份恢复/.test(i.msg)), JSON.stringify(issues1));
  ok('坏文件被另存', fs.readdirSync(D).some((f) => f.startsWith('db.json.corrupt-')), fs.readdirSync(D).join(','));

  // 关键：坏文件已被挪走，下次写盘不会把好的备份覆盖掉
  store.persist();
  await new Promise((r) => setTimeout(r, 120));
  const bakAfter = JSON.parse(fs.readFileSync(path.join(D, 'db.json.bak'), 'utf8'));
  ok('好备份没被坏文件顶掉', Array.isArray(bakAfter.projects) && bakAfter.projects.length === 1,
    JSON.stringify(bakAfter).slice(0, 120));

  // 2) 主文件坏 + 备份也坏 → 空库，但必须留下 error 级提示
  wipe();
  write('db.json', 'garbage');
  write('db.json.bak', 'also garbage');
  store.init(D);
  eq('两边都坏时按空库启动', store.count('projects'), 0);
  const issues2 = store.getLoadIssues();
  ok('空库启动有 error 级提示', issues2.some((i) => i.level === 'error' && /空库/.test(i.msg)),
    JSON.stringify(issues2));

  // 3) 文件正常时不该有任何提示
  wipe();
  write('db.json', JSON.stringify({ projects: [{ id: 'ok1', name: '正常项目' }] }));
  store.init(D);
  eq('正常文件照常加载', store.count('projects'), 1);
  eq('正常时无加载问题', store.getLoadIssues().length, 0);

  wipe();
  store.init(HOME);   // 收尾前把 store 指回原目录
}

// ── 收尾 ─────────────────────────────────────────────────────
fs.rmSync(HOME, { recursive: true, force: true });

console.log(`\n${'═'.repeat(52)}`);
console.log(`  自检结果：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log('  失败项：');
  failures.forEach((f) => console.log(`   ✗ ${f}`));
}
console.log(`${'═'.repeat(52)}\n`);
// ⚠️ 不能用 process.exit()：stdout 重定向到文件/管道时是异步的，exit() 会
//    把还没刷出的缓冲丢掉——末尾的汇总标记就没了，上层判失败。
process.exitCode = fail ? 1 : 0;
