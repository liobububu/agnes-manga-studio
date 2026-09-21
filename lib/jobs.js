/**
 * jobs.js — 批量生成队列
 * ------------------------------------------------------------------
 * 原版批量只能靠用户在界面上一个个点，图片一多就变成体力活。
 * 这里做成一个带并发上限的小队列：
 *   · 进度实时写进内存，前端通过 SSE 拿
 *   · 单项失败不影响其余项，最后汇总成功/失败数
 *   · 支持中途取消（改 cancel 标记，跑完当前项就停）
 */
'use strict';

const jobs = new Map();

function create(type, total) {
  const id = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const job = {
    id, type, total, done: 0, ok: 0, fail: 0,
    concurrency: null,   // run() 里填入，让「并发到底用了多少」可被观测/断言
    status: 'running', cancel: false,
    started_at: new Date().toISOString(),
    finished_at: null,
    items: [],
  };
  jobs.set(id, job);
  return job;
}

function get(id) { return jobs.get(id) || null; }
function list() { return Array.from(jobs.values()).slice(0, 50); }

/**
 * 跑队列。
 * @param job 由 create() 得到
 * @param items 任意数组
 * @param worker (item, index) => Promise<{ok:boolean, id?:string, error?:string}>
 * @param opts {concurrency, onProgress}
 */
async function run(job, items, worker, opts = {}) {
  const concurrency = Math.max(1, Math.min(Number(opts.concurrency) || 3, 8));
  job.concurrency = concurrency;
  const onProgress = opts.onProgress || (() => {});
  // 提交间隔：对着 Agnes 这种按次计费的上游，连着发容易被限流/判重。
  // 视频批量默认带一点间隔，图片批量不需要。
  const intervalMs = Math.max(0, Number(opts.intervalMs) || 0);
  let cursor = 0;

  async function loop() {
    while (cursor < items.length) {
      if (job.cancel) break;
      const idx = cursor++;
      const item = items[idx];
      try {
        const r = await worker(item, idx);
        if (r && r.ok === false) {
          job.fail++;
          job.items.push({ index: idx, ok: false, error: r.error || '失败' });
        } else {
          job.ok++;
          job.items.push({ index: idx, ok: true, id: r?.id || null });
        }
      } catch (e) {
        job.fail++;
        job.items.push({ index: idx, ok: false, error: e.message || String(e) });
      }
      job.done++;
      onProgress(job);
      if (intervalMs > 0 && cursor < items.length && !job.cancel) {
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) workers.push(loop());
  await Promise.all(workers);

  job.status = job.cancel ? 'cancelled' : 'done';
  job.finished_at = new Date().toISOString();
  onProgress(job);
  return job;
}

function cancel(id) {
  const job = jobs.get(id);
  if (!job) return false;
  job.cancel = true;
  return true;
}

/** 只保留最近 50 条，避免长时间运行后内存里堆一堆历史 */
function prune() {
  const all = Array.from(jobs.values());
  if (all.length <= 50) return;
  all.slice(0, all.length - 50)
    .filter((j) => j.status !== 'running')
    .forEach((j) => jobs.delete(j.id));
}

module.exports = { create, get, list, run, cancel, prune };
