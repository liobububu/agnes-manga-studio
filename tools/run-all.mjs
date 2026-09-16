/** 串行运行离线自检、接口测试、前端静态检查、真实浏览器验收。 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const tests = ['selftest.mjs', 'apitest.mjs', 'uitest.mjs', 'browser-test.mjs'];
const node = process.execPath;
let failed = 0;
for (const file of tests) {
  console.log(`\n===== ${file} =====`);
  const r = spawnSync(node, [path.join(dir, file)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(`\n===== 总结：${failed ? `${failed} 个测试失败` : '全部测试通过'} =====`);
process.exit(failed ? 1 : 0);
