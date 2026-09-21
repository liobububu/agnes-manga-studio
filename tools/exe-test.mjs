/**
 * exe-test.mjs — 打包产物验收
 * ------------------------------------------------------------------
 * 前四层测试跑的都是**源码**，验不到打包本身。而 exe 有自己的失败方式：
 *
 *   · 内嵌资源靠内容哈希判断是否重新释放，一旦没刷新，
 *     用户就一直在跑旧的 lib/*.js —— 现象极迷惑：exe 里 grep 得到新代码，
 *     跑出来却是旧行为（我真踩过一次）。
 *   · 版本号、页面清单、接口路由是否都进了包，也只有跑 exe 才知道。
 *
 * 所以这一层只做一件事：**验证 dist 里的那个 exe 是不是当前代码的产物**。
 * 没有 exe 就跳过（不算失败）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(dir, '..');
const EXE = path.join(ROOT, 'dist', 'Agnes漫剧工坊.exe');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; return true; }
  fail++; failures.push(`${name}${extra ? ` — ${extra}` : ''}`);
  return false;
}
function eq(name, a, b) {
  return ok(name, a === b, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}

if (!fs.existsSync(EXE)) {
  console.log('\n（没有找到 dist/Agnes漫剧工坊.exe，跳过 exe 验收）');
  process.exitCode = 0;
} else {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const HOME = path.join(os.tmpdir(), `agnes-exetest-${process.pid}`);
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });

  const port = await new Promise((r) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
  });
  const BASE = `http://127.0.0.1:${port}`;

  const exe = spawn(EXE, [], {
    env: { ...process.env, PORT: String(port), NO_OPEN: '1', AGNES_STUDIO_HOME: HOME },
    stdio: 'ignore',
  });

  const waitHealth = async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) return await r.json();
      } catch { /* 还没起来 */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  };

  try {
    const health = await waitHealth();
    ok('exe 能启动并响应', !!health, '健康检查超时');
    if (health) {
      // 版本号对不上，说明打包的是旧代码
      eq('exe 版本号与 package.json 一致', health.version, pkg.version);

      // 关键：跑的是不是当前代码。挑几个最近才加的东西当探针。
      const editor = await (await fetch(`${BASE}/js/pages/editor.js`)).text();
      ok('剪辑台页面进了包', editor.length > 1000, `${editor.length} 字节`);
      ok('剪辑台用的是公共集数选项', /episodeOptions/.test(editor), '可能是旧版本');
      ok('剪辑台有字幕导出', /\.srt/.test(editor), '可能是旧版本');

      const consts = await (await fetch(`${BASE}/js/consts.js`)).text();
      ok('consts 已清掉死导出', !/\bexport function fmtBytes/.test(consts), '死代码还在包里');

      // 接口链路：建项目 → 建方案 → 导出 → 字幕
      const proj = await (await fetch(`${BASE}/api/projects`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'exe 验收', status: 'active' }),
      })).json();
      ok('能建项目', !!proj.id, JSON.stringify(proj).slice(0, 120));

      const plan = await (await fetch(`${BASE}/api/edit-plans`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: proj.id, episode_number: 1,
          clips: [{ shot_number: 1, name: '开场', duration: 4, trim_in: 0, trim_out: 4, dialogue: '你好', enabled: true }],
        }),
      })).json();
      ok('能建剪辑方案', !!plan.id, JSON.stringify(plan).slice(0, 120));

      const exp = await (await fetch(`${BASE}/api/edit-plans/${plan.id}/export`)).json();
      eq('导出总时长正确', exp.total_duration, 4);
      eq('字幕条数正确', exp.srt_count, 1);
      ok('SRT 格式正确', /00:00:00,000 --> 00:00:04,000/.test(exp.srt || ''), JSON.stringify(exp.srt));

      // 首页与页面资源
      eq('首页 200', (await fetch(`${BASE}/`)).status, 200);
      for (const p of ['dashboard', 'projects', 'scripts', 'storyboards', 'images', 'videos', 'tasks', 'assets', 'editor', 'settings']) {
        const r = await fetch(`${BASE}/js/pages/${p}.js`);
        if (r.status !== 200) ok(`页面模块 ${p}.js 进了包`, false, `HTTP ${r.status}`);
      }
      ok('全部 10 个页面模块都进了包', true);
    }
  } catch (e) {
    ok('exe 验收过程无异常', false, e.message);
  } finally {
    exe.kill();
    await new Promise((r) => setTimeout(r, 600));
    fs.rmSync(HOME, { recursive: true, force: true });
  }

  console.log(`\n${'═'.repeat(52)}`);
  console.log(`  exe 验收：${pass} 通过 / ${fail} 失败`);
  if (failures.length) {
    console.log('  失败项：');
    failures.forEach((f) => console.log(`   ✗ ${f}`));
  }
  console.log(`${'═'.repeat(52)}\n`);
  process.exitCode = fail ? 1 : 0;
}
