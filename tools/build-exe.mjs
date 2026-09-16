/**
 * build-exe.mjs — Agnes 漫剧工坊 · Windows 单文件 exe
 * ------------------------------------------------------------------
 * Node SEA：把 server.js 作为入口，把 lib/ 与 public/ 内嵌进 blob，
 * 再注入 managed Node 运行时。接收方无需安装 Node，双击即用。
 *
 * 用法：node tools/build-exe.mjs
 * 可选：node tools/build-exe.mjs --out Agnes漫剧工坊.exe
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const DIST = path.join(ROOT, 'dist');
const NODE = process.execPath;
const NODE_DIR = path.dirname(NODE);
const WORKSPACE = path.join(process.env.USERPROFILE || '', '.workbuddy-ai', 'binaries', 'node', 'workspace');
const POSTJECT_ROOT = path.join(WORKSPACE, 'node_modules', 'postject');
const postjectRequire = createRequire(path.join(POSTJECT_ROOT, 'package.json'));

const argv = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const OUT_NAME = valueOf('--out', 'Agnes漫剧工坊.exe');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';

const log = (n, s) => console.log(`\n[${n}] ${s}`);
const size = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, base, out);
    else if (ent.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function findFuse(exePath) {
  const buf = fs.readFileSync(exePath);
  const m = /NODE_SEA_FUSE_[0-9a-f]+/.exec(buf.toString('latin1'));
  assert(m, 'node.exe 中没有 SEA fuse；请换 Node 20+ 官方构建');
  // 关键：不要把后面的 :0 带进去
  return m[0];
}

function run(command, args, label) {
  const r = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', windowsHide: false });
  if (r.error) throw new Error(`${label}：${r.error.message}`);
  if (r.status !== 0) throw new Error(`${label}失败，退出码 ${r.status}`);
}

async function main() {
  assert(process.platform === 'win32', '这个打包脚本只用于 Windows');
  assert(Number(process.versions.node.split('.')[0]) >= 20, `Node 版本过低：${process.versions.node}`);
  assert(fs.existsSync(path.join(ROOT, 'server.js')), '缺少 server.js');
  assert(fs.existsSync(path.join(ROOT, 'public', 'index.html')), '缺少 public/index.html');
  assert(fs.existsSync(POSTJECT_ROOT), `缺少 postject：${POSTJECT_ROOT}`);

  fs.mkdirSync(BUILD, { recursive: true });
  fs.mkdirSync(DIST, { recursive: true });

  // 1. 收集静态资源。数据目录不打进 exe，避免把用户数据污染进发行包。
  log(1, '收集内嵌资源');
  const assets = {};
  for (const rel of walk(path.join(ROOT, 'lib'))) {
    assets[`lib/${rel}`] = path.join(ROOT, 'lib', rel);
  }
  for (const rel of walk(path.join(ROOT, 'public'))) {
    assets[`public/${rel}`] = path.join(ROOT, 'public', rel);
  }
  const assetList = Object.keys(assets);
  const assetBytes = Object.values(assets).reduce((n, file) => n + fs.statSync(file).size, 0);
  console.log(`  ${assetList.length} 个资源，总计 ${size(assetBytes)}`);

  // 2. SEA 配置。主脚本直接用源码 server.js；资源通过 assets 字段注入。
  log(2, '生成 SEA blob');
  const mainPath = path.join(BUILD, 'main.cjs');
  const configPath = path.join(BUILD, 'sea-config.json');
  const blobPath = path.join(BUILD, 'sea-prep.blob');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  // server.js 自己不依赖外部包；lib/public 通过 sea.getAsset() 释放。
  fs.writeFileSync(mainPath, mainSrc, 'utf8');
  fs.writeFileSync(configPath, JSON.stringify({
    main: mainPath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets,
  }, null, 2), 'utf8');
  run(NODE, ['--experimental-sea-config', configPath], 'SEA blob');
  assert(fs.existsSync(blobPath), 'SEA blob 没有生成');
  console.log(`  blob ${size(fs.statSync(blobPath).size)}`);

  // 3. 复制运行时并注入。
  log(3, '注入 Node 运行时');
  const tmpExe = path.join(BUILD, `AgnesStudio-${process.pid}.exe`);
  const outExe = path.join(DIST, OUT_NAME);
  fs.copyFileSync(NODE, tmpExe);
  const fuse = findFuse(tmpExe);
  console.log(`  fuse ${fuse}`);

  const postject = postjectRequire('postject');
  await postject.inject(tmpExe, 'NODE_SEA_BLOB', fs.readFileSync(blobPath), {
    sentinelFuse: fuse,
  });
  fs.copyFileSync(tmpExe, outExe);
  console.log(`  产物 ${outExe}`);
  console.log(`  大小 ${size(fs.statSync(outExe).size)}`);

  // 4. 写一个 portable 标记：双击 exe 后数据落在 exe 同级 data/，
  //    这更符合「拷走就能用」的便携程序直觉。用户删掉 portable 后，
  //    仍可走 %LOCALAPPDATA%/AgnesStudio。
  const portable = path.join(DIST, 'portable');
  if (!fs.existsSync(portable)) fs.writeFileSync(portable, '', 'utf8');

  console.log('\n✓ 打包完成');
  console.log(`  双击：${outExe}`);
  console.log(`  数据：${path.join(DIST, 'data')}`);
}

main().catch((e) => {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
});
