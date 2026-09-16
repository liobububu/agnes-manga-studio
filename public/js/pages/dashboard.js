/**
 * dashboard.js — 工作台
 * Hero + 统计 + 快速入口 + 最近项目 + 最近生成
 */
import { icon, esc, relTime, fmtTime } from '../consts.js';
import { api } from '../api.js';
import { empty, spinner, toast } from '../ui.js';
import { head } from './helpers.js';
import { state, navigate } from '../app.js';

export default async function dashboard(container) {
  container.innerHTML = `
    ${head({
      title: '工作台',
      desc: '项目创建 → 脚本生成 → 分镜 → 分镜图 → 图生视频 → 素材入库，一条链路走完',
      actions: `
        <button class="btn btn-primary" id="q-new-project">${icon('plus', 16)}新建项目</button>
        <button class="btn" id="q-refresh">${icon('refresh', 16)}刷新</button>`,
    })}
    <div class="hero">
      <h2>开始你的下一部漫剧</h2>
      <p>所有数据保存在本机，API Key 也只存在本机设置文件里。断网不影响编辑，只有调用 Agnes 生成那一步需要联网。</p>
    </div>
    <div id="stats" class="stat-grid" style="margin-bottom:22px">${spinner('加载统计…')}</div>

    <div class="section-label">快速开始</div>
    <div class="quick" style="margin-bottom:26px">
      ${quickItem('folder', '新建漫剧项目', '设定类型、平台、画风', 'projects', { new: '1' })}
      ${quickItem('script', '生成故事脚本', '构思 / 梗概 / 大纲 / 单集', 'scripts')}
      ${quickItem('film', '生成分镜脚本', '脚本一键转分镜表', 'storyboards')}
      ${quickItem('image', '批量生成分镜图', '按分镜表批量出图', 'images')}
      ${quickItem('video', '图生视频', '分镜图转视频镜头', 'videos')}
      ${quickItem('tasks', '查看镜头任务', '轮询状态与结果', 'tasks')}
    </div>

    <div class="section-label">最近项目</div>
    <div id="recent-projects" class="grid g3" style="margin-bottom:26px">${spinner()}</div>

    <div class="section-label">最近生成</div>
    <div id="recent-assets" class="asset-grid">${spinner()}</div>`;

  container.querySelector('#q-new-project').onclick = () => navigate('projects', { new: '1' });
  container.querySelector('#q-refresh').onclick = () => load();

  function quickItem(ic, title, desc, path, params) {
    return `<button class="quick-item" data-go="${path}" data-params="${esc(JSON.stringify(params || {}))}">
      <div class="ic">${icon(ic, 17)}</div>
      <div>
        <div class="t">${esc(title)}</div>
        <div class="d">${esc(desc)}</div>
      </div>
    </button>`;
  }

  container.querySelectorAll('[data-go]').forEach((b) => {
    b.onclick = () => {
      let p = {};
      try { p = JSON.parse(b.getAttribute('data-params') || '{}'); } catch { p = {}; }
      navigate(b.getAttribute('data-go'), p);
    };
  });

  async function load() {
    const [st, pr, im, vd] = await Promise.all([
      api.stats(), api.projects(), api.images(), api.videos(),
    ]);

    if (st.ok) {
      const s = st.data;
      container.querySelector('#stats').innerHTML = [
        stat('项目总数', s.total_projects, ''),
        stat('进行中', s.active_projects, 'gold'),
        stat('今日生图', s.today_images, ''),
        stat('今日生视频', s.today_videos, ''),
        stat('失败任务', s.failed_tasks, s.failed_tasks ? 'red' : ''),
        stat('收藏素材', s.favorited_assets, ''),
      ].join('');
    }

    if (pr.ok) {
      const list = (pr.data || []).slice(0, 6);
      const el = container.querySelector('#recent-projects');
      if (!list.length) {
        el.innerHTML = `<div class="card" style="grid-column:1/-1">${empty('还没有项目', '点右上角「新建项目」开始第一部漫剧', 'folder')}</div>`;
      } else {
        el.innerHTML = list.map((p) => `
          <div class="proj-card" data-pid="${esc(p.id)}">
            <div class="top">
              <div>
                <div class="nm">${esc(p.name)}</div>
              </div>
              <span class="badge ${p.status === 'active' ? 'gold' : 'gray'}">${p.status === 'active' ? '进行中' : '已归档'}</span>
            </div>
            <div class="ds">${esc(p.description || '暂无简介')}</div>
            <div class="meta">
              <span class="badge gray">${esc(p.project_type || '未分类')}</span>
              <span class="badge gray">${esc(p.target_platform || '')}</span>
              <span class="badge gray">${esc(p.planned_episodes || 0)} 集</span>
            </div>
            <div style="font-size:11px;color:var(--text-4)">更新于 ${relTime(p.updated_at || p.created_at)}</div>
          </div>`).join('');
        el.querySelectorAll('[data-pid]').forEach((c) => {
          c.onclick = () => navigate('storyboards', { project: c.getAttribute('data-pid') });
        });
      }
    }

    const assets = [
      ...(im.ok ? im.data.slice(0, 6).map((i) => ({ kind: 'image', a: i })) : []),
      ...(vd.ok ? vd.data.slice(0, 4).map((v) => ({ kind: 'video', a: v })) : []),
    ];
    const el2 = container.querySelector('#recent-assets');
    if (!assets.length) {
      el2.innerHTML = `<div class="card" style="grid-column:1/-1">${empty('还没有生成内容', '先建项目，再从故事脚本开始', 'sparkles')}</div>`;
    } else {
      el2.innerHTML = assets.map(({ kind, a }) => kind === 'image'
        ? `<div class="asset-card" data-go="assets" data-params='{"tab":"image"}'>
             <img src="${esc(a.url)}" alt="" loading="lazy" onerror="this.style.display='none'" />
             <div class="ovl">
               <div class="top"><span class="badge gray">图片</span></div>
               <div class="btm"><span class="mini-btn">${esc(relTime(a.created_at))}</span></div>
             </div>
           </div>`
        : `<div class="asset-card" data-go="tasks">
             ${a.video_url ? `<video src="${esc(a.video_url)}" muted preload="metadata"></video>` : `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-4);font-size:12px">生成中…</div>`}
             <div class="ovl">
               <div class="top"><span class="badge ${a.status === 'completed' ? 'green' : 'gold'}">${icon('video', 10)}</span></div>
               <div class="btm"><span class="mini-btn">${esc(relTime(a.created_at))}</span></div>
             </div>
           </div>`).join('');
      el2.querySelectorAll('[data-go]').forEach((c) => {
        c.onclick = () => {
          let p = {};
          try { p = JSON.parse(c.getAttribute('data-params') || '{}'); } catch { p = {}; }
          navigate(c.getAttribute('data-go'), p);
        };
      });
    }
  }

  function stat(k, v, cls) {
    return `<div class="stat"><div class="k">${esc(k)}</div><div class="v ${cls}">${esc(v)}</div></div>`;
  }

  await load();
}
