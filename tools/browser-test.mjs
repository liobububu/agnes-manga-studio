/**
 * browser-test.mjs — 真实浏览器冒烟测试（Chrome/Edge CDP）
 * 不引入 Playwright。验证页面不是白屏、路由能切换、创建项目真的落盘、
 * 以及控制台错误 / unhandledrejection 为零。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 30000 + (process.pid % 10000);
const cdpPort = port + 1;
const stamp = `${process.pid}-${Date.now().toString(36)}`;
const RUN_ID = `${process.pid.toString(36)}${Date.now().toString(36)}`;
const home = path.join(ROOT, 'build', 'ui-home-${RUN_ID}');
fs.mkdirSync(home, { recursive: true });
const profile = path.join(ROOT, 'build', 'ui-profile-${RUN_ID}');
fs.mkdirSync(profile, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
function ok(name, condition, extra = '') {
  if (condition) { pass++; return true; }
  fail++; failures.push(`${name}${extra ? ` — ${extra}` : ''}`);
  return false;
}
function group(s) { console.log(`\n── ${s} ──`); }

function findBrowser() {
  const cands = [
    process.env.NM_BROWSER,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  return cands.find((p) => fs.existsSync(p)) || null;
}

class CDP {
  constructor(url) { this.url = url; this.ws = null; this.next = 1; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 10000);
      this.ws.onopen = () => { clearTimeout(timer); resolve(); };
      this.ws.onerror = (e) => { clearTimeout(timer); reject(new Error(`CDP WebSocket 错误：${e.message || 'unknown'}`)); };
      this.ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
          else p.resolve(msg.result);
        }
      };
    });
    await this.send('Runtime.enable');
    await this.send('Page.enable');
  }
  send(method, params = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const body = String(expr).trim();
    // 纯表达式自动 return；带多条语句的操作由调用方显式写 return。
    const expression = body.includes(';')
      ? `(async function(){${body}})()`
      : `(async function(){return (${body})})()`;
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '页面脚本异常');
    return r.result?.value;
  }
  close() { try { this.ws?.close(); } catch { /* ignore */ } }
}

async function waitFor(fn, label, timeout = 12000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch { /* 页面还没就绪 */ }
    await sleep(150);
  }
  throw new Error(`等待超时：${label}（最后值 ${JSON.stringify(last)}）`);
}

async function getTarget() {
  const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  const list = await r.json();
  return list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl) || null;
}

const server = spawn(NODE, [path.join(ROOT, 'server.js')], {
  env: { ...process.env, PORT: String(port), NO_OPEN: '1', AGNES_STUDIO_HOME: home },
  stdio: 'ignore',
});
let browser = null;
let cdp = null;

try {
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { return false; }
  }, '本地服务');

  const bin = findBrowser();
  if (!bin) {
    console.log('未找到 Chrome/Edge，跳过真实浏览器测试（不算失败）。');
    process.exitCode = 0;
  } else {
    console.log(`浏览器：${bin}`);
    browser = spawn(bin, [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu', '--mute-audio',
      '--window-size=1440,900', `http://127.0.0.1:${port}/#/dashboard`,
    ], { stdio: 'ignore' });

    const target = await waitFor(getTarget, '浏览器页面');
    cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.connect();

    const errors = [];
    await cdp.eval(`
      window.__uiErrors = [];
      window.__uiRejects = [];
      window.addEventListener('error', e => window.__uiErrors.push(String(e.message || e.error || 'window error')));
      window.addEventListener('unhandledrejection', e => window.__uiRejects.push(String((e.reason && e.reason.message) || e.reason || 'unhandled rejection')));
      return true;
    `);

    group('工作台');
    await waitFor(() => cdp.eval(`document.readyState === 'complete' && !!document.querySelector('.page-title')`), '工作台渲染');
    ok('工作台标题存在', await cdp.eval(`document.querySelector('.page-title')?.textContent === '工作台'`));
    ok('侧边栏存在', await cdp.eval(`!!document.querySelector('.sidebar') && document.querySelector('.sidebar').getBoundingClientRect().height > 0`));
    ok('快速入口存在', await cdp.eval(`document.querySelectorAll('.quick-item').length === 6`));
    ok('工作台非白屏', await cdp.eval(`document.body.innerText.includes('开始你的下一部漫剧')`));
    ok('未配置时显示设置引导', await cdp.eval(`document.body.innerText.includes('还没有配置 Agnes API Key')`));

    group('页面切换');
    const pages = [
      ['projects', '项目管理'], ['scripts', '故事脚本'], ['storyboards', '分镜制作'],
      ['images', '图片生成'], ['videos', '视频生成'], ['tasks', '镜头任务'],
      ['assets', '素材库'], ['editor', '剪辑台'], ['settings', '设置'],
    ];
    for (const [id, title] of pages) {
      await cdp.eval(`location.hash = '#/${id}'`);
      await waitFor(() => cdp.eval(`document.querySelector('.page-title')?.textContent === ${JSON.stringify(title)}`), title);
      ok(`${title} 标题存在`, await cdp.eval(`document.querySelector('.page-title')?.textContent === ${JSON.stringify(title)}`));
      ok(`${title} 内容可见`, await cdp.eval(`document.querySelector('.page')?.getBoundingClientRect().height > 50`));
    }

    group('创建项目');
    await cdp.eval(`location.hash = '#/projects?new=1'`);
    await waitFor(() => cdp.eval(`!!document.querySelector('.modal')`), '新建项目弹窗');
    ok('新建项目弹窗打开', await cdp.eval(`!!document.querySelector('.modal')`));
    await cdp.eval(`document.querySelector('#f-name').value = '浏览器验收剧'; document.querySelector('#f-name').dispatchEvent(new Event('input', {bubbles:true})); return true;`);
    await cdp.eval(`document.querySelector('[data-yes]')?.click(); return true;`);
    await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/api/projects`);
      const d = await r.json();
      return d.some((p) => p.name === '浏览器验收剧');
    }, '项目落盘');
    ok('创建项目后接口可读回', true);
    ok('创建后弹窗关闭', await cdp.eval(`!document.querySelector('.modal')`));

    group('设置页');
    await cdp.eval(`location.hash = '#/settings'`);
    await waitFor(() => cdp.eval(`document.querySelector('.page-title')?.textContent === '设置'`), '设置页');
    await waitFor(() => cdp.eval(`!!document.querySelector('#refresh-models-api')`), '设置首页模型拉取按钮');
    ok('设置首页直接显示模型拉取按钮', await cdp.eval(`!!document.querySelector('#refresh-models-api')`));
    await cdp.eval(`document.querySelector('[data-sec="task"]')?.click(); return true;`);
    await waitFor(() => cdp.eval(`!!document.querySelector('#save-task')`), '任务设置');
    ok('任务设置面板可打开', await cdp.eval(`!!document.querySelector('#t-interval') && !!document.querySelector('#save-task')`));
    await cdp.eval(`document.querySelector('[data-sec="model"]')?.click(); return true;`);
    await waitFor(() => cdp.eval(`!!document.querySelector('#refresh-models')`), '模型设置');
    ok('动态模型面板可打开', await cdp.eval(`!!document.querySelector('#refresh-models') && !!document.querySelector('#m-ttl')`));
    ok('模型默认项可选', await cdp.eval(`document.querySelector('#m-text')?.options.length > 0 && document.querySelector('#m-image')?.options.length > 0 && document.querySelector('#m-video')?.options.length > 0`));

    group('视频生成页：音频生视频模式');
    await cdp.eval(`location.hash = '#/videos'`);
    await waitFor(() => cdp.eval(`document.querySelector('.page-title')?.textContent === '视频生成'`), '视频页');
    ok('五个生成模式都在', await cdp.eval(`document.querySelectorAll('#mode [data-mode]').length === 5`),
      String(await cdp.eval(`document.querySelectorAll('#mode [data-mode]').length`)));
    ok('有音频生视频入口', await cdp.eval(`!!document.querySelector('#mode [data-mode="audio"]')`));

    // 切到音频模式：页面要能画出音频输入，而不是白屏或抛错
    await cdp.eval(`document.querySelector('#mode [data-mode="audio"]')?.click(); return true;`);
    await waitFor(() => cdp.eval(`!!document.querySelector('#au-list')`), '音频模式表单');
    ok('音频模式画出音频输入', await cdp.eval(`!!document.querySelector('[data-au]')`));
    ok('音频模式有提交按钮', await cdp.eval(`!!document.querySelector('#submit')`));

    // 模型下拉换成 2.5 时，参数区要从 num_frames 切到 seconds。
    // mock 模型目录里没有 2.5，这里直接往下拉插一项——否则这段永远走不到，
    // 「验过」就成了空话。
    await cdp.eval(`(() => {
      const sel = document.querySelector('#model');
      if (!Array.from(sel.options).some((o) => /2[._-]?5/.test(o.value))) {
        const o = document.createElement('option');
        o.value = 'agnes-video-2.5'; o.textContent = 'agnes-video-2.5';
        sel.appendChild(o);
      }
      sel.value = 'agnes-video-2.5';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor(() => cdp.eval(`!!document.querySelector('#f-sec25')`), '2.5 参数区');
    ok('2.5 显示 seconds 档位', await cdp.eval(`!!document.querySelector('#f-sec25')`));
    ok('2.5 不再显示 num_frames', await cdp.eval(`!document.querySelector('#f-frames')`));
    ok('2.5 不再显示帧率', await cdp.eval(`!document.querySelector('#f-fps')`));
    ok('2.5 显示 size 档位', await cdp.eval(`!!document.querySelector('#f-size25')`));
    ok('2.5 显示画幅档位', await cdp.eval(`!!document.querySelector('#f-ar25')`));
    // 音频模式在 2.5 下要保留音频输入，不能被参数区重绘冲掉
    ok('2.5 下音频输入仍在', await cdp.eval(`!!document.querySelector('[data-au]')`));

    group('剪辑台');
    await cdp.eval(`location.hash = '#/editor'`);
    await waitFor(() => cdp.eval(`document.querySelector('.page-title')?.textContent === '剪辑台'`), '剪辑台');
    ok('剪辑台标题存在', await cdp.eval(`document.querySelector('.page-title')?.textContent === '剪辑台'`));
    ok('有按分镜汇总按钮', await cdp.eval(`!!document.querySelector('#assemble')`));
    ok('有保存与导出按钮', await cdp.eval(`!!document.querySelector('#save') && !!document.querySelector('#export')`));

    // 未选项目时应给出引导而不是白屏
    await cdp.eval(`(() => { document.querySelector('#assemble')?.click(); return true; })()`);
    await new Promise((r) => setTimeout(r, 400));
    ok('点汇总不抛错', ((await cdp.eval(`(window.__uiErrors||[]).length`)) === 0));

    // 先造数据：验收项目里本来没有片段，不造的话这条断言永远量不到东西。
    // 用接口直接建方案（不需要 API Key），再回页面看它是否被画出来。
    const projRes = await fetch(`http://127.0.0.1:${port}/api/projects`);
    const projList = await projRes.json();
    const proj = projList.find((p) => p.name === '浏览器验收剧') || projList[0];
    const planRes = await fetch(`http://127.0.0.1:${port}/api/edit-plans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: proj.id, episode_number: 1, name: '验收方案',
        clips: [
          { shot_number: 1, name: '镜头一', duration: 4, trim_in: 0, trim_out: 4, enabled: true },
          { shot_number: 2, name: '镜头二', duration: 6, trim_in: 1, trim_out: 5, enabled: true },
        ],
        transitions: [{ after_clip_index: 0, type: 'crossfade', duration: 0.5 }],
      }),
    });
    const planJson = await planRes.json();
    ok('接口建剪辑方案成功', planRes.status === 200 && !!planJson.id, JSON.stringify(planJson).slice(0, 160));

    await cdp.eval(`(() => {
      const sel = document.querySelector('#p-picker');
      const target = ${JSON.stringify(proj.id)};
      const opt = Array.from(sel.options).find((o) => o.value === target) || Array.from(sel.options).find((o) => o.value && o.value !== '__all__');
      if (!opt) return false;
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor(() => cdp.eval(`document.querySelectorAll('[data-tr]').length > 0`), '片段行出现');
    const clipCount = await cdp.eval(`document.querySelectorAll('[data-tr]').length`);
    ok('画出片段行（含转场下拉）', clipCount === 2, `片段 ${clipCount} 行`);
    ok('显示总时长', /总时长/.test(await cdp.eval(`document.querySelector('#timeline')?.textContent || ''`)));
    ok('转场选中了交叉淡化', await cdp.eval(`document.querySelector('[data-tr="0"]')?.value === 'crossfade'`));

    group('每个模式点提交都不崩');
    // 关键帧模式的 mode id 是 'keyframe' 而状态键是 'kf'，
    // 直接用 mode 取状态会拿到 undefined → 提交时 TypeError。
    // 这里逐个模式真点一次提交按钮，把这类崩溃锁住。
    // ⚠️ 光设 .value 不会触发 oninput，状态根本没更新 ——
    //    那样跑的是「校验失败提前 return」，压根走不到真正会崩的代码。
    //    必须补发 input 事件。未处理的 Promise 拒绝落在 __uiRejects，两边都要看。
    // cdp.eval 遇到含分号的表达式会整体包进 IIFE，所以这里必须自己写 return，
    // 否则拿到的永远是 undefined。
    const setVal = (sel, v) => `return (() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return false;
      el.value = ${JSON.stringify(v)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`;

    for (const [m, fills] of [
      ['t2v', [['#f-prompt', 'a cat']]],
      ['i2v', [['#f-image', 'https://x/1.png'], ['#f-prompt', 'move']]],
      ['keyframe', [['#kf-start', 'https://x/a.png'], ['#kf-end', 'https://x/b.png']]],
      ['audio', [['[data-au]', 'https://x/1.mp3']]],
    ]) {
      await cdp.eval(`location.hash = '#/videos'`);
      await waitFor(() => cdp.eval(`!!document.querySelector('#mode [data-mode="${m}"]')`), `模式 ${m}`);
      await cdp.eval(`(() => { document.querySelector('#mode [data-mode="${m}"]').click(); return true; })()`);
      await waitFor(() => cdp.eval(`!!document.querySelector('#submit')`), `${m} 提交按钮`);
      for (const [sel, val] of fills) {
        ok(`${m} 能填 ${sel}`, await cdp.eval(setVal(sel, val)));
      }
      await cdp.eval(`(() => { document.querySelector('#submit').click(); return true; })()`);
      await new Promise((r) => setTimeout(r, 600));
      const got = await cdp.eval(`({errors: window.__uiErrors || [], rejects: window.__uiRejects || []})`);
      const all = [...got.errors, ...got.rejects].filter((e) => !/Agnes API Key|未配置|请先在/.test(e));
      ok(`${m} 模式提交不抛 TypeError`, !all.some((e) => /TypeError|undefined/.test(e)), JSON.stringify(all));
    }

    const collected = await cdp.eval(`({errors:window.__uiErrors || [], rejects:window.__uiRejects || []})`);
    ok('无 window error', collected?.errors?.length === 0, JSON.stringify(collected?.errors || []));
    ok('无未处理 Promise 拒绝', collected?.rejects?.length === 0, JSON.stringify(collected?.rejects || []));
    cdp.close();
  }
} catch (e) {
  fail++;
  failures.push(`浏览器测试异常：${e.message}`);
  console.error(`浏览器测试异常：${e.stack || e.message}`);
} finally {
  if (cdp) cdp.close();
  if (browser?.pid) {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' });
    } else browser.kill('SIGTERM');
  }
  if (server?.pid) {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    } else server.kill('SIGTERM');
  }
}

console.log(`\n__RESULT__ pass=${pass} fail=${fail}`);
if (failures.length) failures.forEach((x) => console.log(`  ✗ ${x}`));
// 全绿才回收现场；有失败则留下排查（用独立目录名是为了不读到上一轮的密钥）
if (!fail) {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* 清不掉不影响结果 */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 清不掉不影响结果 */ }
}
process.exitCode = fail ? 1 : 0;
