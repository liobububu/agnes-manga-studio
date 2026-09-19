/**
 * helpers.js — 页面通用片段：页头、项目选择器、批量进度条
 */
import { icon, esc, relTime } from '../consts.js';

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
export function batchBar() {
  return `<div id="batch-bar"></div>`;
}

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
          <span>${esc(title)}：${job.done} / ${job.total}${job.status === 'cancelled' ? '（已取消）' : ''}</span>
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

/** 卡片里的项目统计（分镜/图片/视频数） */
export async function projectStatLine(id) {
  return `<span>${relTime(id)}</span>`;
}

export function selectField(label, id, optionsHtml, extra = '') {
  return `<div class="field"><label>${esc(label)}</label><select class="select" id="${id}" ${extra}>${optionsHtml}</select></div>`;
}

export function inputField(label, id, value = '', placeholder = '', type = 'text', cls = '') {
  return `<div class="field">
    <label>${esc(label)}</label>
    <input class="input ${cls}" id="${id}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" />
  </div>`;
}

export function textareaField(label, id, value = '', placeholder = '', rows = 4, cls = '') {
  return `<div class="field">
    <label>${esc(label)}</label>
    <textarea class="textarea ${cls}" id="${id}" rows="${rows}" placeholder="${esc(placeholder)}">${esc(value)}</textarea>
  </div>`;
}
