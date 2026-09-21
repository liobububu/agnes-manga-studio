/**
 * uitest.mjs — 前端静态一致性检查
 * ------------------------------------------------------------------
 * 没有 jsdom 也能抓到前端最常见的几类「静默失败」：
 *   · import 了一个不存在的符号 → 运行时 undefined，页面直接白
 *   · icon('x') 名字写错 → 静默退化成 info 图标，看不出来
 *   · api.xxx() 方法拼错 → 一点按钮就报 is not a function
 *   · index.html 引用了不存在的文件 → 404
 *
 * 用法：node tools/uitest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; return true; }
  fail++; failures.push(`${name}${extra ? ` — ${extra}` : ''}`);
  return false;
}
function group(t) { console.log(`\n── ${t} ──`); }

const read = (p) => fs.readFileSync(p, 'utf8');
const listJs = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f));

// ── 1. 入口与资源 ────────────────────────────────────────────
group('入口文件');
{
  const html = read(path.join(PUB, 'index.html'));
  ok('index.html 存在', html.length > 0);
  ok('引了 app.js', html.includes('./js/app.js'));
  ok('引了 app.css', html.includes('./css/app.css'));
  ok('有 view 挂载点', html.includes('id="view"'));
  ok('有 toast 容器', html.includes('id="toasts"'));
  ok('有 modal 容器', html.includes('id="modal-root"'));
  ok('声明 UTF-8', html.includes('charset="UTF-8"'));
  ok('没有登录/注册残留', !/login|register|登录|注册/i.test(html));

  // CSS 里引用的所有文件
  ok('css 文件存在', fs.existsSync(path.join(PUB, 'css', 'app.css')));
}

// ── 2. 模块文件齐全 ──────────────────────────────────────────
group('模块完整性');
{
  const pages = ['dashboard', 'projects', 'scripts', 'storyboards', 'images', 'videos', 'tasks', 'assets', 'settings'];
  for (const p of pages) {
    ok(`页面模块 ${p}.js 存在`, fs.existsSync(path.join(PUB, 'js', 'pages', `${p}.js`)));
  }
  for (const m of ['app.js', 'api.js', 'ui.js', 'consts.js']) {
    ok(`核心模块 ${m} 存在`, fs.existsSync(path.join(PUB, 'js', m)));
  }
  // app.js 里注册的路由必须都有对应文件
  const app = read(path.join(PUB, 'js', 'app.js'));
  for (const p of pages) {
    ok(`app.js 注册了 ${p}`, app.includes(`./pages/${p}.js`));
  }
}

// ── 3. import 符号一致性 ─────────────────────────────────────
group('import 符号');
{
  const files = [...listJs(path.join(PUB, 'js')), ...listJs(path.join(PUB, 'js', 'pages'))];

  /** 收集一个模块的具名导出 */
  function exportsOf(file) {
    const src = read(file);
    const names = new Set();
    // export const X / export function X / export class X / export { a, b }
    for (const m of src.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
      m[1].split(',').forEach((s) => {
        const n = s.trim().split(/\s+as\s+/).pop().trim();
        if (n) names.add(n);
      });
    }
    if (/export\s+default/.test(src)) names.add('default');
    return names;
  }

  for (const file of files) {
    const src = read(file);
    for (const m of src.matchAll(/import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g)) {
      const named = m[2];
      const spec = m[3];
      if (!spec.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), spec);
      if (!fs.existsSync(target)) {
        ok(`${path.basename(file)} 的 import 目标存在`, false, spec);
        continue;
      }
      const avail = exportsOf(target);
      if (named) {
        for (const raw of named.split(',')) {
          const n = raw.trim().split(/\s+as\s+/)[0].trim();
          if (!n) continue;
          ok(`${path.basename(file)} → ${spec} 导出了 ${n}`, avail.has(n), `可用：${[...avail].join(', ')}`);
        }
      }
      // 默认导入
      if (m[1] && !named) ok(`${path.basename(file)} → ${spec} 有默认导出`, avail.has('default'));
    }
  }

  // 页面模块必须默认导出一个函数（helpers.js 是纯工具模块，没有默认导出）
  for (const file of listJs(path.join(PUB, 'js', 'pages'))) {
    if (path.basename(file) === 'helpers.js') continue;
    const src = read(file);
    ok(`${path.basename(file)} 默认导出函数`, /export\s+default\s+(?:async\s+)?function/.test(src));
  }
}

// ── 4. 图标名 ────────────────────────────────────────────────
group('图标名');
{
  const consts = read(path.join(PUB, 'js', 'consts.js'));
  const block = consts.match(/const ICONS = \{([\s\S]*?)\n\};/);
  ok('解析到 ICONS 表', !!block);
  const names = new Set();
  if (block) for (const m of block[1].matchAll(/^\s{2}([A-Za-z][\w]*):/gm)) names.add(m[1]);
  ok('图标数量合理', names.size > 20, `${names.size} 个`);

  const files = [...listJs(path.join(PUB, 'js')), ...listJs(path.join(PUB, 'js', 'pages'))];
  const used = new Set();
  for (const file of files) {
    const src = read(file);
    for (const m of src.matchAll(/icon\(\s*'([A-Za-z][\w]*)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/icon\(\s*([A-Za-z][\w]*)\s*\)/g)) used.add(m[1]);
  }
  ok('页面确实用了图标', used.size > 10, `${used.size} 个`);
  for (const n of used) {
    ok(`图标 ${n} 已定义`, names.has(n));
  }
}

// ── 5. API 方法 ──────────────────────────────────────────────
group('API 方法');
{
  const apiSrc = read(path.join(PUB, 'js', 'api.js'));
  const defined = new Set();
  for (const m of apiSrc.matchAll(/^\s{2}([a-zA-Z][\w]*):/gm)) defined.add(m[1]);
  ok('api 定义了方法', defined.size > 15, `${defined.size} 个`);

  const files = [...listJs(path.join(PUB, 'js', 'pages')), path.join(PUB, 'js', 'app.js')];
  const used = new Set();
  for (const file of files) {
    const src = read(file);
    for (const m of src.matchAll(/\bapi\.([a-zA-Z][\w]*)\s*\(/g)) used.add(m[1]);
  }
  for (const n of used) {
    ok(`api.${n} 已定义`, defined.has(n));
  }
}

// ── 6. 后端接口覆盖 ──────────────────────────────────────────
group('前端调用的后端路由');
{
  const routesSrc = fs.readFileSync(path.join(ROOT, 'lib', 'routes.js'), 'utf8');
  const apiSrc = read(path.join(PUB, 'js', 'api.js'));
  // 前端写的 URL 可能是模板串（`/api/videos/${id}/refresh`），
  // 只取到第一个非字母数字占位符之前的路径前缀来比对后端注册的模式
  const urls = new Set();
  for (const m of apiSrc.matchAll(/['"`](\/api\/[A-Za-z0-9_\-/${}.[\]]*)/g)) {
    let u = m[1];
    u = u.split('?')[0].split('${')[0].replace(/\/$/, '');
    if (u.startsWith('/api/')) urls.add(u);
  }
  ok('解析到前端调用的接口', urls.size > 10, `${urls.size} 个`);
  for (const u of urls) {
    const exists = routesSrc.includes(`'${u}'`) || routesSrc.includes(`'${u}/:id'`);
    ok(`路由 ${u} 已在后端注册`, exists, u);
  }
}

// ── 7. 设计系统落地 ──────────────────────────────────────────
group('设计规范');
{
  const css = read(path.join(PUB, 'css', 'app.css'));
  // PRD 4.2 色板
  ok('主背景 #08090D', css.includes('#08090D'));
  ok('主金色 #D6B56D', css.includes('#D6B56D'));
  ok('亮金色 #F5D58A', css.includes('#F5D58A'));
  ok('成功色 #30D158', css.includes('#30D158'));
  ok('失败色 #FF453A', css.includes('#FF453A'));
  // PRD 4.4 布局
  ok('侧边栏 260px', css.includes('--sidebar-w: 260px'));
  ok('卡片圆角 20px', css.includes('--radius-card: 20px'));
  ok('按钮圆角 14px', css.includes('--radius-btn: 14px'));
  ok('按钮高度 42px', /\.btn\s*\{[^}]*height:\s*42px/.test(css));
  ok('输入框高度 42px', /\.input,\s*\.textarea,\s*\.select\s*\{[^}]*height:\s*42px/.test(css));
  ok('玻璃拟态 backdrop-filter', css.includes('backdrop-filter: blur(20px)'));
  ok('侧边栏模糊 24px', css.includes('backdrop-filter: blur(24px)'));
  ok('弹窗模糊 28px', css.includes('backdrop-filter: blur(28px)'));
  ok('滚动条 hover 变金', css.includes('scrollbar-thumb:hover'));
  // PRD 4.9 禁止项
  ok('无大面积紫色主题', !/#8B5CF6|purple/.test(css));
  // 响应式
  ok('有窄屏适配', css.includes('@media (max-width: 900px)'));
}

// ── 8. 用户系统已清除 ────────────────────────────────────────
group('用户系统残留检查');
{
  const files = [
    ...listJs(path.join(PUB, 'js')),
    ...listJs(path.join(PUB, 'js', 'pages')),
    path.join(PUB, 'index.html'),
    path.join(ROOT, 'server.js'),
    path.join(ROOT, 'lib', 'store.js'),
    path.join(ROOT, 'lib', 'routes.js'),
    path.join(ROOT, 'lib', 'agnes.js'),
    path.join(ROOT, 'lib', 'poller.js'),
  ];
  /**
   * 注释里解释「原版用 Supabase、为什么去掉」是有价值的，不该算残留。
   * 所以只检查真正的代码：先把行注释和块注释剥掉。
   */
  function stripComments(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

  for (const f of files) {
    const src = stripComments(read(f));
    const rel = path.relative(ROOT, f);
    // 「关于」页里写着「去掉 Supabase」的产品说明，那是文案不是依赖，
    // 所以只认真正的 import / 客户端调用
    ok(`${rel} 没有 supabase 依赖`, !/@supabase|from\s*['"]supabase|require\(['"]supabase|supabase\.(from|auth|storage|functions)/i.test(src));
    ok(`${rel} 没有 user_id 字段`, !/\buser_id\b/.test(src));
    ok(`${rel} 没有登录态判断`, !/未登录|登录已过期|auth\.(getUser|signIn|signUp)/.test(src));
  }
  ok('不存在登录页面文件', !fs.existsSync(path.join(PUB, 'js', 'pages', 'login.js')));
  ok('不存在注册页面文件', !fs.existsSync(path.join(PUB, 'js', 'pages', 'register.js')));
}

// ── 9. 前端工具函数（真跑一遍，不只看代码） ────────────────
group('前端工具函数');
{
  const consts = await import(pathToFileURL(path.join(PUB, 'js', 'consts.js')).href);

  // 分镜时长 → Agnes num_frames（8n+1，上限 441）
  ok('5 秒 → 121 帧', consts.framesForDuration(5) === 121, String(consts.framesForDuration(5)));
  ok('10 秒 → 241 帧', consts.framesForDuration(10) === 241, String(consts.framesForDuration(10)));
  ok('3 秒 → 73 帧', consts.framesForDuration(3) === 73, String(consts.framesForDuration(3)));
  ok('超长夹到 441', consts.framesForDuration(100) === 441, String(consts.framesForDuration(100)));
  ok('非法输入回退默认', consts.framesForDuration('abc') === 121, String(consts.framesForDuration('abc')));
  ok('0 秒也合法', consts.framesForDuration(0) === 121, String(consts.framesForDuration(0)));
  for (const s of [1, 2, 3, 5, 8, 10, 15, 18]) {
    const f = consts.framesForDuration(s);
    ok(`${s} 秒满足 8n+1 且 ≤441`, f <= 441 && f >= 9 && (f - 1) % 8 === 0, String(f));
  }

  // 动态模型下拉：新模型要能被选到，且不能串到别的模态
  const dir = {
    models: [
      { id: 'agnes-text-new', kind: 'text' },
      { id: 'agnes-image-new', kind: 'image' },
      { id: 'agnes-video-new', kind: 'video' },
      { id: 'mystery-model', kind: 'unknown' },
    ],
  };
  const text = consts.modelChoices(dir, 'text', ['old-text']);
  const image = consts.modelChoices(dir, 'image', ['old-image']);
  const video = consts.modelChoices(dir, 'video', ['old-video']);
  ok('文本模型含新文本模型', text.some((m) => m.value === 'agnes-text-new'), JSON.stringify(text));
  ok('文本模型不含图片模型', !text.some((m) => m.value === 'agnes-image-new'));
  ok('文本模型保留旧模型回退', text.some((m) => m.value === 'old-text'));
  ok('图片模型含新图片模型', image.some((m) => m.value === 'agnes-image-new'), JSON.stringify(image));
  ok('图片模型不含视频模型', !image.some((m) => m.value === 'agnes-video-new'));
  ok('视频模型含新视频模型', video.some((m) => m.value === 'agnes-video-new'), JSON.stringify(video));
  ok('空目录也能给出回退项', consts.modelChoices({ models: [] }, 'text', ['fallback-1']).length === 1);
  ok('未知类型模型不被丢弃', text.some((m) => m.value === 'mystery-model'), JSON.stringify(text));

  // Video 2.5 判定：模型目录是动态拉的，选中 2.5 时请求体要走另一套。
  // 前后端各有一份判断，两边不一致就会出现「前端按 2.5 显示、后端按 2.0 发参」。
  ok('识别 2.5', consts.isVideo25('agnes-video-2.5') === true);
  ok('识别 v2.5 写法', consts.isVideo25('agnes-video-v2.5') === true);
  ok('识别 25 连写', consts.isVideo25('agnes-video-25') === true);
  ok('2.0 不算 2.5', consts.isVideo25('agnes-video-v2.0') === false);
  ok('空值安全', consts.isVideo25('') === false && consts.isVideo25(undefined) === false);

  ok('时长是字符串', typeof consts.secondsFor25(8) === 'string' && consts.secondsFor25(8) === '8');
  ok('时长夹到下限 4', consts.secondsFor25(1) === '4');
  ok('时长夹到上限 12', consts.secondsFor25(60) === '12');
  ok('非法时长回退 5', consts.secondsFor25('abc') === '5');
  for (const n of [1, 3, 5, 8, 12, 30, 100]) {
    const v = Number(consts.secondsFor25(n));
    ok(`${n} 秒被夹进 4~12`, v >= 4 && v <= 12, String(v));
  }

  ok('2.5 有 size 档位', Array.isArray(consts.VIDEO_SIZES_25) && consts.VIDEO_SIZES_25.length >= 2);
  ok('2.5 size 不含 width/height', !consts.VIDEO_SIZES_25.some((s) => 'width' in s || 'height' in s));
  ok('2.5 有画幅档位', Array.isArray(consts.VIDEO_ASPECTS_25) && consts.VIDEO_ASPECTS_25.some((a) => a.value === '16:9'));
  ok('模式表里含音频生视频', consts.VIDEO_MODES.some((m) => m.id === 'audio'));
}

// ── 前后端对「哪个模型是 2.5」的判断必须一致 ──────────────────
group('2.5 判定前后端一致');
{
  const consts = await import(pathToFileURL(path.join(PUB, 'js', 'consts.js')).href);

  // 后端那份是 CommonJS 内部函数，这里抽出同样的正则做等价性检查：
  // 真要改判定规则，两边得一起改，否则请求体与界面会对不上。
  const agnesSrc = read(path.join(ROOT, 'lib', 'agnes.js'));
  const m = /function isVideo25\(model\)\s*\{[\s\S]*?return\s*(\/.*?\/[a-z]*)\.test/.exec(agnesSrc);
  ok('后端有 isVideo25', !!m, 'lib/agnes.js 里找不到 isVideo25');
  if (m) {
    const backendRe = eval(m[1]); // eslint-disable-line no-eval
    for (const id of ['agnes-video-2.5', 'agnes-video-v2.5', 'agnes-video-25', 'agnes-video-v2.0', 'agnes-video-2.0', '']) {
      const fe = consts.isVideo25(id);
      const be = backendRe.test(String(id || '').toLowerCase());
      ok(`「${id || '(空)'}」两端判定一致`, fe === be, `前端 ${fe} / 后端 ${be}`);
    }
  }
}

// ── SSE 事件：后端 emit 的，前端必须订阅 ────────────────────
// 踩过的坑：后端加了 storyboard 事件并回填了分镜状态，
// 前端压根没 addEventListener，功能等于不存在，而且测试全绿看不出来。
group('SSE 事件两端一致');
{
  const libDir = path.join(ROOT, 'lib');
  const emitted = new Set();
  for (const f of fs.readdirSync(libDir).filter((n) => n.endsWith('.js'))) {
    for (const m of read(path.join(libDir, f)).matchAll(/events\.emit\(\s*'([a-z_]+)'/g)) emitted.add(m[1]);
  }
  ok('后端确实在推事件', emitted.size > 0, [...emitted].join(','));

  const app = read(path.join(PUB, 'js', 'app.js'));
  for (const kind of emitted) {
    ok(`前端订阅了 ${kind}`, app.includes(`addEventListener('${kind}'`), `app.js 里没有 es.addEventListener('${kind}'`);
    ok(`${kind} 在 listeners 表里`, new RegExp(`listeners\\s*=\\s*\\{[\\s\\S]*?${kind}\\s*:`).test(app));
  }
  // 反向：前端订阅了但后端没人推，说明是死代码
  // 只认 es.（SSE 连接）上的监听，别把 window.addEventListener('hashchange') 算进来
  const subscribed = [...app.matchAll(/\bes\.addEventListener\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
  for (const kind of subscribed) {
    ok(`后端确实推 ${kind}`, emitted.has(kind), `前端听了 ${kind}，但 lib/ 里没人 emit`);
  }
}

console.log(`\n${'═'.repeat(52)}`);
console.log(`  前端检查：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log('  失败项：');
  failures.forEach((f) => console.log(`   ✗ ${f}`));
}
console.log(`${'═'.repeat(52)}\n`);
// ⚠️ 不能用 process.exit()：stdout 重定向到文件/管道时是异步的，exit() 会
//    把还没刷出的缓冲丢掉——末尾的汇总标记就没了，上层判失败。
process.exitCode = fail ? 1 : 0;
