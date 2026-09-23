/**
 * helpers.js — 页面通用片段：页头、项目选择器、批量进度条
 */
import { icon, esc } from '../consts.js';

export function head(o) {
  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">${esc(o.title)}</h1>
        ${o.desc ? `<p class="page-desc">${esc(o.desc)}</p>` : ''}
      </div>
      <div class="page-actions">${o.actions || ''}</div>
    </div>`;
}

/** 项目下拉选择框，带「全部/无」选项 */
export function projectPicker(projects, selected, opts = {}) {
  const id = opts.id || 'project-picker';
  const cls = opts.small ? 'select select-sm' : 'select';
  return `
    <select class="${cls}" id="${id}" style="min-width:150px">
      ${opts.allowEmpty ? `<option value="">${esc(opts.emptyLabel || '未选择项目')}</option>` : ''}
      ${opts.allOption ? `<option value="__all__"${selected === '__all__' ? ' selected' : ''}>全部项目</option>` : ''}
      ${projects.map((p) => `<option value="${esc(p.id)}"${p.id === selected ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
    </select>`;
}

/** 批量任务进度（SSE 驱动） */
export function renderBatchBar(el, job, onCancel) {
  if (!el) return;
  if (!job) { el.innerHTML = ''; return; }
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  const title = job.type === 'images' ? '批量生成图片' : '批量提交视频';
  // 失败原因要给人看：只报「3 个失败」等于没说，用户没法判断该重试还是该改参数
  const errors = job.fail
    ? [...new Set((job.items || []).filter((i) => !i.ok).map((i) => i.error || '未知错误'))].slice(0, 3)
    : [];
  el.innerHTML = `
    <div class="note ${job.fail ? 'orange' : 'gold'}" style="display:flex;align-items:center;gap:14px">
      ${job.status === 'running' ? '<div class="spinner sm"></div>' : icon(job.fail ? 'alert' : 'check', 16)}
      <div style="flex:1;min-width:0">
        <div style="display:flex;justify-content:space-between;margin-bottom:6px;gap:10px;flex-wrap:wrap">
          <span>${esc(title)}：${job.done} / ${job.total}${job.status === 'cancelled' ? '（已取消）' : job.status === 'interrupted' ? '（上次运行中断，可继续补缺失项）' : ''}</span>
          <span style="color:var(--ok)">成功 ${job.ok}</span>
          ${job.fail ? `<span style="color:var(--err)">失败 ${job.fail}</span>` : ''}
        </div>
        <div class="progress" style="max-width:none"><i style="width:${pct}%"></i></div>
        ${errors.length ? `<div style="margin-top:8px;font-size:11.5px;color:#FCA5A5;line-height:1.6">${errors.map((e) => esc(e)).join('<br>')}</div>` : ''}
      </div>
      ${job.status === 'running' && onCancel
        ? `<button class="btn btn-xs" id="batch-cancel">取消</button>`
        : ''}
    </div>`;
  const btn = el.querySelector('#batch-cancel');
  if (btn) btn.onclick = () => onCancel(job.id);
}

/**
 * 集数下拉的 option 列表。分镜页和剪辑台都要用，
 * 写两份就会出现「一边改了另一边没改」（比如集数上限不一致）。
 */
export function episodeOptions(selected, max = 30) {
  const cur = Number(selected) || 1;
  return Array.from({ length: max }, (_, i) => i + 1)
    .map((n) => `<option value="${n}"${n === cur ? ' selected' : ''}>第 ${n} 集</option>`)
    .join('');
}
