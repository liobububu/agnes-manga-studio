/**
 * projects.js — 项目管理
 * 列表 + 新建/编辑弹窗 + 复制/删除 + 导出资料
 */
import { icon, esc, fmtTime, relTime, PROJECT_TYPES, PLATFORMS, ASPECTS } from '../consts.js';
import { api } from '../api.js';
import { modal, confirm, toast, empty, spinner, options } from '../ui.js';
import { head } from './helpers.js';
import { navigate, softRefresh } from '../app.js';

export default async function projects(container, params) {
  container.innerHTML = `
    ${head({
      title: '项目管理',
      desc: '每一部漫剧一个项目，类型、平台、画风在这里定',
      actions: `
        <button class="btn btn-primary" id="new-project">${icon('plus', 16)}新建项目</button>
        <button class="btn" id="refresh">${icon('refresh', 16)}刷新</button>`,
    })}
    <div id="list">${spinner('加载项目…')}</div>`;

  container.querySelector('#new-project').onclick = () => openForm(null);
  container.querySelector('#refresh').onclick = () => load();

  async function load() {
    const r = await api.projects();
    const el = container.querySelector('#list');
    if (!r.ok) { el.innerHTML = `<div class="note red">${esc(r.error)}</div>`; return; }
    const list = r.data || [];
    if (!list.length) {
      el.innerHTML = `<div class="card">${empty('还没有项目', '点「新建项目」创建第一部漫剧，填好类型和平台后面生成会更贴题', 'folder')}</div>`;
      return;
    }
    // 顺带统计每个项目的素材数
    const [sbs, imgs, vids] = await Promise.all([api.storyboards(), api.images(), api.videos()]);
    const countBy = (arr, key) => {
      const m = {};
      (arr || []).forEach((x) => { if (x.project_id) m[x.project_id] = (m[x.project_id] || 0) + 1; });
      return m;
    };
    const sbC = countBy(sbs.ok ? sbs.data : [], 'project_id');
    const imC = countBy(imgs.ok ? imgs.data : [], 'project_id');
    const vdC = countBy(vids.ok ? vids.data : [], 'project_id');

    el.innerHTML = `<div class="grid g3">${list.map((p) => `
      <div class="proj-card" data-id="${esc(p.id)}">
        <div class="top">
          <div style="min-width:0">
            <div class="nm">${esc(p.name)}</div>
            <div style="font-size:11px;color:var(--text-4);margin-top:3px">${esc(fmtTime(p.created_at))}</div>
          </div>
          <span class="badge ${p.status === 'active' ? 'gold' : 'gray'}">${p.status === 'active' ? '进行中' : '已归档'}</span>
        </div>
        <div class="ds">${esc(p.description || '暂无简介')}</div>
        <div class="meta">
          <span class="badge gray">${esc(p.project_type || '未分类')}</span>
          <span class="badge gray">${esc(p.target_platform || '')}</span>
          <span class="badge gray">${esc(p.aspect_ratio || '')}</span>
          ${p.art_style ? `<span class="badge gray">${esc(p.art_style)}</span>` : ''}
        </div>
        <div class="stats">
          <div class="s"><span class="n">${sbC[p.id] || 0}</span><span class="l">分镜</span></div>
          <div class="s"><span class="n">${imC[p.id] || 0}</span><span class="l">图片</span></div>
          <div class="s"><span class="n">${vdC[p.id] || 0}</span><span class="l">视频</span></div>
          <div class="s"><span class="n">${esc(p.planned_episodes || 0)}</span><span class="l">预计集数</span></div>
        </div>
        <div class="row" style="gap:6px;flex-wrap:wrap">
          <button class="btn btn-xs" data-act="open">${icon('arrowRight', 12)}进入分镜</button>
          <button class="btn btn-xs" data-act="edit">${icon('edit', 12)}编辑</button>
          <button class="btn btn-xs" data-act="dup">${icon('copy', 12)}复制</button>
          <button class="btn btn-xs" data-act="export">${icon('download', 12)}导出资料</button>
          <button class="btn btn-xs btn-danger" data-act="del">${icon('trash', 12)}删除</button>
        </div>
      </div>`).join('')}</div>`;

    el.querySelectorAll('[data-id]').forEach((card) => {
      const id = card.getAttribute('data-id');
      card.querySelectorAll('[data-act]').forEach((b) => {
        b.onclick = async (e) => {
          e.stopPropagation();
          const act = b.getAttribute('data-act');
          if (act === 'open') navigate('storyboards', { project: id });
          else if (act === 'edit') openForm(list.find((x) => x.id === id));
          else if (act === 'dup') {
            const r2 = await api.duplicateProject(id);
            if (r2.ok) { toast.ok('已复制项目'); load(); softRefresh(); }
            else toast.err(r2.error);
          } else if (act === 'export') {
            window.open(`/api/projects/${id}/export`, '_blank');
          } else if (act === 'del') {
            const ok = await confirm({
              title: '删除项目',
              text: `确定删除「${esc(list.find((x) => x.id === id)?.name || '')}」吗？<br><br>
                     <span style="color:var(--text-3)">勾选「连带删除素材」会一并删掉这个项目下的剧本、分镜、图片和视频记录（本地图片文件也会删）。</span>
                     <div style="margin-top:12px"><label class="row" style="gap:8px;font-size:12.5px;color:var(--text-2)">
                       <input type="checkbox" id="cascade" /> 连带删除该项目下的全部数据
                     </label></div>`,
              danger: true,
              okText: '删除',
            });
            if (!ok) return;
            const cascade = document.getElementById('cascade')?.checked;
            const r3 = await api.deleteProject(id, !!cascade);
            if (r3.ok) { toast.ok(`已删除${cascade ? `（连带 ${r3.data.removed} 条数据）` : ''}`); load(); softRefresh(); }
            else toast.err(r3.error);
          }
        };
      });
      card.onclick = (e) => {
        if (e.target.closest('[data-act]')) return;
        navigate('storyboards', { project: id });
      };
    });
  }

  function openForm(project) {
    const isEdit = !!project;
    const p = project || {
      name: '', description: '', project_type: '爽文漫剧', target_platform: '抖音',
      aspect_ratio: '9:16 竖屏', art_style: '', episode_duration: '1分钟', planned_episodes: 10, status: 'active',
    };
    modal({
      title: isEdit ? '编辑项目' : '新建项目',
      body: `
        <div class="field"><label>项目名称 *</label><input class="input" id="f-name" value="${esc(p.name)}" placeholder="例：都市逆袭之神级选择" /></div>
        <div class="field"><label>简介</label><textarea class="textarea" id="f-desc" rows="3" placeholder="一句话说清这部漫剧讲什么">${esc(p.description)}</textarea></div>
        <div class="grid g2" style="gap:0 14px">
          <div class="field"><label>类型</label><select class="select" id="f-type">${options(PROJECT_TYPES, 'v', 'v', p.project_type)}</select></div>
          <div class="field"><label>目标平台</label><select class="select" id="f-plat">${options(PLATFORMS, 'v', 'v', p.target_platform)}</select></div>
          <div class="field"><label>视频比例</label><select class="select" id="f-ratio">${options(ASPECTS, 'v', 'v', p.aspect_ratio)}</select></div>
          <div class="field"><label>画风</label><input class="input" id="f-style" value="${esc(p.art_style)}" placeholder="例：日漫厚涂、国漫写实" /></div>
          <div class="field"><label>单集时长</label><input class="input" id="f-dur" value="${esc(p.episode_duration)}" placeholder="1分钟" /></div>
          <div class="field"><label>预计集数</label><input class="input" id="f-eps" type="number" min="1" value="${esc(p.planned_episodes)}" /></div>
        </div>
        <div class="field"><label>状态</label>
          <select class="select" id="f-status">
            <option value="active"${p.status === 'active' ? ' selected' : ''}>进行中</option>
            <option value="archived"${p.status === 'archived' ? ' selected' : ''}>已归档</option>
          </select>
        </div>`,
      footer: `
        <button class="btn" data-no>取消</button>
        <button class="btn btn-primary" data-yes>${isEdit ? '保存' : '创建'}</button>`,
      onMount(root, close) {
        root.querySelector('[data-no]').onclick = close;
        root.querySelector('#f-name').focus();
        root.querySelector('[data-yes]').onclick = async () => {
          const payload = {
            name: root.querySelector('#f-name').value.trim(),
            description: root.querySelector('#f-desc').value.trim(),
            project_type: root.querySelector('#f-type').value,
            target_platform: root.querySelector('#f-plat').value,
            aspect_ratio: root.querySelector('#f-ratio').value,
            art_style: root.querySelector('#f-style').value.trim(),
            episode_duration: root.querySelector('#f-dur').value.trim(),
            planned_episodes: Number(root.querySelector('#f-eps').value) || 1,
            status: root.querySelector('#f-status').value,
          };
          if (!payload.name) { toast.err('项目名称不能为空'); return; }
          const r = isEdit ? await api.updateProject(p.id, payload) : await api.createProject(payload);
          if (r.ok) { toast.ok(isEdit ? '已保存' : '项目已创建'); close(); load(); softRefresh(); }
          else toast.err(r.error);
        };
      },
    });
  }

  await load();
  // 支持从工作台带 ?new=1 直接弹出新建框
  if (params && params.new === '1') {
    setTimeout(() => openForm(null), 120);
    history.replaceState(null, '', '#/projects');
  }
}
