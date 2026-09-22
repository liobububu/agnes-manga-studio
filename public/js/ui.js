/**
 * ui.js — toast / 弹窗 / 确认框 / DOM 助手
 * 所有页面共用，避免每个页面各写一套。
 */
import { icon, esc } from './consts.js';

// ── Toast ───────────────────────────────────────────────────
const TOAST_ICON = { ok: 'check', err: 'alert', warn: 'alert', info: 'info' };

export function toast(message, kind = 'info', ms = 3800) {
  const wrap = document.getElementById('toasts');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = `toast ${kind === 'error' ? 'err' : kind === 'success' ? 'ok' : kind === 'warn' ? 'warn' : ''}`;
  const ic = TOAST_ICON[kind === 'error' ? 'err' : kind === 'success' ? 'ok' : kind === 'warn' ? 'warn' : 'info'];
  el.innerHTML = `${icon(ic, 16)}${icon ? '' : ''}<div style="flex:1;min-width:0">${esc(message)}</div>`;
  // 图标需要一点上边距对齐首行文字
  el.firstElementChild && (el.firstElementChild.style.marginTop = '1px');
  wrap.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  }, ms);
}
toast.ok = (m, ms) => toast(m, 'success', ms);
toast.err = (m, ms) => toast(m, 'error', ms || 6000);
toast.warn = (m, ms) => toast(m, 'warn', ms || 5200);
toast.info = (m, ms) => toast(m, 'info', ms);

// ── 弹窗 ────────────────────────────────────────────────────
/**
 * 打开一个通用弹窗。
 * @param {object} o {title, body(HTML或Node), footer(HTML), wide, onMount(root, close)}
 */
export function modal(o) {
  const root = document.getElementById('modal-root');
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal ${o.fullscreen ? 'fullscreen' : o.wide ? 'wide' : ''}">
      <div class="modal-head">
        <h3>${esc(o.title || '')}</h3>
        <button class="icon-btn" data-close style="background:transparent;color:var(--text-3)">${icon('x', 16)}</button>
      </div>
      <div class="modal-body">${typeof o.body === 'string' ? o.body : ''}</div>
      ${o.footer ? `<div class="modal-foot">${o.footer}</div>` : ''}
    </div>`;
  const close = () => mask.remove();
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('[data-close]')) close();
  });
  const bodyEl = mask.querySelector('.modal-body');
  if (o.body && typeof o.body !== 'string') bodyEl.appendChild(o.body);
  root.appendChild(mask);
  if (o.onMount) o.onMount(mask, close);
  return { close, root: mask };
}

export function attachAssetMentions(input, getAssets) {
  if (!input) return () => {};
  const menu = document.createElement('div'); menu.className = 'mention-menu'; menu.hidden = true; document.body.appendChild(menu);
  let matches = [], active = 0;
  const close = () => { menu.hidden = true; matches = []; active = 0; };
  const token = () => { const pos = input.selectionStart ?? input.value.length; const m = input.value.slice(0, pos).match(/(?:^|[\s，。；;、:：])@([^\s@，。；;、:：]*)$/); return m ? { query:m[1].toLowerCase(), start:pos-m[1].length-1, end:pos } : null; };
  const insert = (a) => { const t=token(); if(!t)return; input.setRangeText(`@${a.name}`,t.start,t.end,'end'); input.dispatchEvent(new Event('input',{bubbles:true})); close(); input.focus(); };
  const render = () => { const t=token(); if(!t){close();return;} const all=(getAssets&&getAssets())||[]; matches=all.filter(a=>a&&a.name&&(!t.query||a.name.toLowerCase().includes(t.query))).slice(0,8); if(!matches.length){close();return;} active=Math.min(active,matches.length-1); menu.innerHTML=matches.map((a,i)=>`<button type="button" class="mention-item ${i===active?'on':''}" data-i="${i}"><b>@${esc(a.name)}</b><span>${esc(a.meta||'素材')}</span></button>`).join(''); const r=input.getBoundingClientRect(); menu.style.left=`${Math.max(8,Math.min(r.left,window.innerWidth-330))}px`; menu.style.top=`${Math.min(r.bottom+6,window.innerHeight-260)}px`; menu.hidden=false; menu.querySelectorAll('[data-i]').forEach(b=>b.onmousedown=e=>{e.preventDefault();insert(matches[Number(b.dataset.i)]);}); };
  input.addEventListener('input',render); input.addEventListener('click',render);
  input.addEventListener('keydown',e=>{ if(menu.hidden)return; if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();active=(active+(e.key==='ArrowDown'?1:-1)+matches.length)%matches.length;render();} else if(e.key==='Enter'&&matches[active]){e.preventDefault();insert(matches[active]);} else if(e.key==='Escape')close(); });
  input.addEventListener('blur',()=>setTimeout(close,120)); return close;
}

/** 确认框，返回 Promise<boolean> */
export function confirm(o) {
  const text = typeof o === 'string' ? o : o.text;
  const opts = typeof o === 'string' ? {} : o;
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title: opts.title || '确认操作',
      body: `<div style="font-size:13.5px;line-height:1.7;color:var(--text-2)">${text}</div>`,
      footer: `
        <button class="btn" data-no>${esc(opts.cancelText || '取消')}</button>
        <button class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'}" data-yes>${esc(opts.okText || '确定')}</button>`,
      onMount(root, close) {
        root.querySelector('[data-yes]').onclick = () => { done = true; close(); resolve(true); };
        root.querySelector('[data-no]').onclick = () => { close(); resolve(false); };
        root.querySelector('[data-yes]').focus();
      },
    });
    // 点遮罩关闭时也要 resolve(false)
    const obs = new MutationObserver(() => {
      if (!document.body.contains(m.root) && !done) { obs.disconnect(); resolve(false); }
    });
    obs.observe(document.getElementById('modal-root'), { childList: true });
  });
}

/** 输入弹窗，返回 Promise<string|null> */
export function prompt(o) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title: o.title || '请输入',
      body: `
        <div class="field">
          <label>${esc(o.label || '')}</label>
          <input class="input ${o.mono ? 'mono' : ''}" id="prompt-input" value="${esc(o.value || '')}" placeholder="${esc(o.placeholder || '')}" />
        </div>
        ${o.hint ? `<div class="hint">${o.hint}</div>` : ''}`,
      footer: `
        <button class="btn" data-no>取消</button>
        <button class="btn btn-primary" data-yes>确定</button>`,
      onMount(root, close) {
        const input = root.querySelector('#prompt-input');
        input.focus();
        input.select();
        const submit = () => { done = true; close(); resolve(input.value.trim()); };
        root.querySelector('[data-yes]').onclick = submit;
        root.querySelector('[data-no]').onclick = () => { close(); resolve(null); };
        input.onkeydown = (e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') { close(); resolve(null); }
        };
      },
    });
    const obs = new MutationObserver(() => {
      if (!document.body.contains(m.root) && !done) { obs.disconnect(); resolve(null); }
    });
    obs.observe(document.getElementById('modal-root'), { childList: true });
  });
}

// ── DOM 助手 ────────────────────────────────────────────────
/** 设置 innerHTML 后批量挂事件：on(root, '.sel', 'click', fn) */
export function on(root, selector, type, fn, opts) {
  root.querySelectorAll(selector).forEach((el) => el.addEventListener(type, fn, opts));
}

export function empty(title, desc, iconName = 'inbox') {
  return `<div class="empty">${icon(iconName, 38)}<div class="t">${esc(title)}</div><div class="d">${esc(desc || '')}</div></div>`;
}

export function spinner(text) {
  return `<div class="loading-wrap"><div class="spinner"></div><span>${esc(text || '加载中…')}</span></div>`;
}

/** 生成 <option> 列表 */
export function options(items, valueKey = 'value', labelKey = 'label', current) {
  return items.map((it) => {
    const v = typeof it === 'object' ? it[valueKey] : it;
    const l = typeof it === 'object' ? it[labelKey] : it;
    return `<option value="${esc(v)}"${String(v) === String(current) ? ' selected' : ''}>${esc(l)}</option>`;
  }).join('');
}
