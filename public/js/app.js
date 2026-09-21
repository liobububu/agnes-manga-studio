/**
 * app.js — 应用外壳：侧边栏、路由、全局状态、SSE
 */
import { icon, esc } from './consts.js';
import { api } from './api.js';
import { toast } from './ui.js';

import dashboard from './pages/dashboard.js';
import projects from './pages/projects.js';
import scripts from './pages/scripts.js';
import storyboards from './pages/storyboards.js';
import images from './pages/images.js';
import videos from './pages/videos.js';
import tasks from './pages/tasks.js';
import assets from './pages/assets.js';
import settings from './pages/settings.js';
import editor from './pages/editor.js';

const NAV = [
  { id: 'dashboard', label: '工作台', icon: 'dashboard', page: dashboard },
  { id: 'projects', label: '项目管理', icon: 'folder', page: projects },
  { id: 'scripts', label: '故事脚本', icon: 'script', page: scripts },
  { id: 'storyboards', label: '分镜制作', icon: 'film', page: storyboards },
  { id: 'images', label: '图片生成', icon: 'image', page: images },
  { id: 'videos', label: '视频生成', icon: 'video', page: videos },
  { id: 'tasks', label: '镜头任务', icon: 'tasks', page: tasks },
  { id: 'assets', label: '素材库', icon: 'grid', page: assets },
  { id: 'editor', label: '剪辑台', icon: 'grip', page: editor },
  { id: 'settings', label: '设置', icon: 'settings', page: settings },
];

export const state = {
  settings: {},
  projects: [],
  stats: {},
  templates: [],
  models: { models: [], updated_at: null, source: 'fallback', error: '' },
  imageHost: { configured: false, hosts: [] },
  home: '',
  version: '',
  current: 'dashboard',
};

let cleanup = null;

// ── 路由 ────────────────────────────────────────────────────
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const params = Object.fromEntries(new URLSearchParams(qs || '').entries());
  return { id: path || 'dashboard', params };
}

export function navigate(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  location.hash = `#/${path}${qs ? `?${qs}` : ''}`;
}

async function render() {
  const { id, params } = parseHash();
  const nav = NAV.find((n) => n.id === id) || NAV[0];
  state.current = nav.id;

  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }

  const view = document.getElementById('view');
  view.innerHTML = '';
  const page = document.createElement('div');
  page.className = 'page';
  view.appendChild(page);

  renderSidebar();

  try {
    const c = await nav.page(page, params);
    if (typeof c === 'function') cleanup = c;
  } catch (e) {
    page.innerHTML = `<div class="note red">页面加载失败：${esc(e.message)}</div>`;
  }
  window.scrollTo({ top: 0 });
}

function renderSidebar() {
  const el = document.getElementById('sidebar');
  const running = state.stats.running_videos || 0;
  el.innerHTML = `
    <div class="brand">
      <div class="brand-mark">${icon('sparkles', 19)}</div>
      <div>
        <div class="brand-name">Agnes 漫剧工坊</div>
        <div class="brand-sub">本地版 · 数据不出本机</div>
      </div>
    </div>
    <nav class="nav">
      ${NAV.map((n) => `
        <button class="nav-item ${n.id === state.current ? 'active' : ''}" data-nav="${n.id}" title="${esc(n.label)}">
          ${icon(n.icon, 17)}
          <span class="lbl">${esc(n.label)}</span>
          ${n.id === 'tasks' && running ? `<span class="badge">${running}</span>` : ''}
        </button>`).join('')}
    </nav>
    <div class="sidebar-footer">
      <div class="ver">v${esc(state.version || '1.0.0')}</div>
      <div class="path" title="${esc(state.home || '')}">${esc(state.home || '')}</div>
    </div>`;

  el.querySelectorAll('[data-nav]').forEach((b) => {
    b.onclick = () => navigate(b.getAttribute('data-nav'));
  });
}

// ── 全局数据 ────────────────────────────────────────────────
export async function refreshState() {
  const r = await api.bootstrap();
  if (r.ok) {
    state.settings = r.data.settings || {};
    state.projects = r.data.projects || [];
    state.stats = r.data.stats || {};
    state.templates = r.data.templates || [];
    state.models = r.data.models || state.models;
    state.loadIssues = Array.isArray(r.data.load_issues) ? r.data.load_issues : [];
    // 图床状态决定「本地图片能不能用于图生视频」，各页面都要看
    const ih = await api.imageHost();
    if (ih.ok) state.imageHost = ih.data;
    renderSidebar();
    showLoadIssues();
  }
}

/**
 * 数据文件损坏时明确告诉用户。
 * 不提示的话，程序只是「安静地变成空库」，用户会以为是项目被删了。
 * 只在启动时提示一次，之后不再打扰。
 */
let loadIssuesShown = false;
function showLoadIssues() {
  if (loadIssuesShown) return;
  const issues = state.loadIssues || [];
  if (!issues.length) return;
  loadIssuesShown = true;

  const worst = issues.some((i) => i.level === 'error') ? 'error' : 'warn';
  const lines = issues.map((i) => `· ${i.msg}`).join('\n');
  const msg = issues.length === 1
    ? lines.replace(/^· /, '')
    : `启动时有 ${issues.length} 个数据加载问题：\n${lines}`;
  if (worst === 'error') toast.err(msg, 15000);
  else toast.warn(msg, 12000);
}

/** 给页面用：改了项目/设置之后刷新侧边栏与统计 */
export async function softRefresh() {
  await refreshState();
}

// ── SSE：视频状态与批量任务进度 ─────────────────────────────
// 后端会推 4 类事件：video / batch / storyboard / log
// 少注册一个，对应的实时更新就成了死代码——加事件时两边要一起改
const listeners = { video: [], batch: [], storyboard: [], log: [] };
export function onEvent(kind, fn) {
  if (!listeners[kind]) listeners[kind] = [];
  listeners[kind].push(fn);
  return () => { listeners[kind] = (listeners[kind] || []).filter((f) => f !== fn); };
}

function fire(kind, raw) {
  let d = null;
  try { d = JSON.parse(raw); } catch { return; }
  (listeners[kind] || []).forEach((f) => { try { f(d); } catch { /* ignore */ } });
  return d;
}

function connectSSE() {
  try {
    const es = new EventSource('/api/events');
    es.addEventListener('video', (e) => {
      fire('video', e.data);
      if (state.current === 'dashboard') refreshState();
    });
    es.addEventListener('batch', (e) => { fire('batch', e.data); });
    // 视频完成后分镜被回填成「视频就绪」，分镜页要跟着变，否则用户得手动刷新
    es.addEventListener('storyboard', (e) => { fire('storyboard', e.data); });
    es.addEventListener('log', (e) => { fire('log', e.data); });
    es.onerror = () => { /* 断线由浏览器自动重连 */ };
  } catch { /* SSE 不可用时静默降级为手动刷新 */ }
}

// ── 启动 ────────────────────────────────────────────────────
async function boot() {
  const h = await api.health();
  if (h.ok) {
    state.home = h.data.data_home || '';
    state.version = h.data.version || '';
  }
  await refreshState();
  window.addEventListener('hashchange', render);
  await render();
  connectSSE();

  if (!state.settings.agnes_api_key) {
    setTimeout(() => {
      toast.warn('还没有配置 Agnes API Key，去「设置」填一个就能开始生成了。', 8000);
    }, 700);
  }
}

boot();
