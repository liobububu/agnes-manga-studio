/**
 * videos.js — 视频生成
 * 四种模式（文生 / 图生 / 多图参考 / 关键帧），提交后交给后端轮询，
 * 页面只负责展示链路诊断 —— 提交超时的锅算 Agnes 的还是本地的，一眼能看出来。
 */
import {
  icon, esc, DURATION_PRESETS, VIDEO_RESOLUTIONS, VIDEO_MODES,
  IMAGE_ROLES, statusBadge, relTime, modelChoices,
} from '../consts.js';
import { api } from '../api.js';
import { modal, toast, empty, spinner, confirm, options, prompt as promptDlg } from '../ui.js';
import { head, projectPicker } from './helpers.js';
import { state, navigate } from '../app.js';

export default async function videos(container, params) {
  let projectId = params.project || (state.projects[0] && state.projects[0].id) || '';
  let mode = 't2v';
  let submitting = false;
  let recent = [];
  let images = [];

  const S = {
    t2v: { prompt: '', neg: 'low quality, blurry, distorted face, flickering, unstable motion', frames: 1, fps: 24, seed: '', res: 0 },
    i2v: {
      image: params.image_url || '',
      prompt: 'Animate the image with subtle natural motion, slight hair movement, slow camera push in, keep character stable',
      neg: 'low quality, blurry, distorted face, flickering, unstable motion',
      frames: 1, fps: 24, seed: '',
    },
    multi: { imgs: [{ url: '', role: '角色参考' }, { url: '', role: '场景参考' }], prompt: '', frames: 1, seed: '' },
    kf: {
      start: '', middle: '', end: '',
      prompt: 'Create a smooth cinematic transition between keyframes, maintaining character identity, consistent lighting, natural motion',
      frames: 1, seed: '',
    },
  };

  container.innerHTML = `
    ${head({
      title: '视频生成',
      desc: 'Agnes Video 2.0 · 异步任务，提交后由本地服务后台轮询，关掉页面也不丢',
      actions: `
        ${projectPicker(state.projects, projectId, { id: 'p-picker', allowEmpty: true, emptyLabel: '未选择项目' })}
        <select class="select select-sm" id="model" style="width:180px"></select>
        <button class="btn" id="reload">${icon('refresh', 16)}</button>`,
    })}
    <div class="grid" style="grid-template-columns:minmax(340px,1fr) minmax(0,1.25fr);gap:20px">
      <div>
        <div class="segmented" id="mode" style="grid-template-columns:repeat(4,1fr);margin-bottom:16px">
          ${VIDEO_MODES.map((m) => `<button data-mode="${m.id}" class="${m.id === mode ? 'on' : ''}">${esc(m.label)}</button>`).join('')}
        </div>
        <div class="card" id="form"></div>
      </div>
      <div>
        <div class="row" style="margin-bottom:12px">
          <div class="card-title" style="margin:0">${icon('tasks', 15)}最近视频任务</div>
          <div class="spacer"></div>
          <button class="btn btn-xs" id="go-tasks">查看全部 ${icon('arrowRight', 11)}</button>
        </div>
        <div id="recent">${spinner()}</div>
      </div>
    </div>`;

  const picker = container.querySelector('#p-picker');
  picker.onchange = () => { projectId = picker.value; loadImages(); loadRecent(); };
  container.querySelector('#reload').onclick = () => { loadImages(); loadRecent(); };
  container.querySelector('#go-tasks').onclick = () => navigate('tasks');

  const mv = modelChoices(state.models, 'video', [state.settings.default_video_model || 'agnes-video-v2.0']);
  container.querySelector('#model').innerHTML = options(mv, 'value', 'label', mv[0]?.value);

  container.querySelectorAll('#mode [data-mode]').forEach((b) => {
    b.onclick = () => {
      mode = b.getAttribute('data-mode');
      container.querySelectorAll('#mode [data-mode]').forEach((x) => x.classList.toggle('on', x === b));
      renderForm();
    };
  });

  function paramsBlock(key, opts = {}) {
    const s = S[key];
    return `
      <div style="padding-top:16px;border-top:1px solid rgba(255,255,255,0.08);margin-top:16px">
        <div class="section-label">视频参数</div>
        ${opts.res !== false ? `
          <div class="field"><label>分辨率</label>
            <select class="select" id="f-res">
              ${VIDEO_RESOLUTIONS.map((r, i) => `<option value="${i}"${i === (s.res || 0) ? ' selected' : ''}>${esc(r.label)}</option>`).join('')}
            </select>
          </div>` : ''}
        <div class="field">
          <label>视频时长</label>
          <div class="chips" id="f-frames">
            ${DURATION_PRESETS.map((p, i) => `<button class="chip ${i === s.frames ? 'on' : ''}" data-i="${i}">${esc(p.label)}</button>`).join('')}
          </div>
          <div class="hint">num_frames = <b>${DURATION_PRESETS[s.frames].frames}</b>（Agnes 要求 8n+1，最大 441）</div>
        </div>
        <div class="field">
          <label>帧率 frame_rate</label>
          <input class="input" id="f-fps" type="number" min="1" max="60" value="${esc(s.fps)}" />
        </div>
        <div class="field">
          <label>Seed（留空随机）</label>
          <input class="input mono" id="f-seed" value="${esc(s.seed)}" placeholder="随机" />
        </div>
      </div>`;
  }

  function bindParams(key) {
    const s = S[key];
    container.querySelectorAll('#f-frames [data-i]').forEach((b) => {
      b.onclick = () => {
        s.frames = Number(b.getAttribute('data-i'));
        container.querySelectorAll('#f-frames [data-i]').forEach((x) => x.classList.toggle('on', x === b));
        container.querySelector('#f-frames').nextElementSibling.innerHTML =
          `num_frames = <b>${DURATION_PRESETS[s.frames].frames}</b>（Agnes 要求 8n+1，最大 441）`;
      };
    });
    const fps = container.querySelector('#f-fps');
    if (fps) fps.oninput = () => { s.fps = Number(fps.value) || 24; };
    const seed = container.querySelector('#f-seed');
    if (seed) seed.oninput = () => { s.seed = seed.value; };
    const res = container.querySelector('#f-res');
    if (res) res.onchange = () => { s.res = Number(res.value); };
  }

  function renderForm() {
    const box = container.querySelector('#form');
    if (mode === 't2v') {
      box.innerHTML = `
        <div class="section-label">输入素材</div>
        <div class="field"><label>视频提示词</label>
          <textarea class="textarea mono" id="f-prompt" rows="6" placeholder="用英文描述画面、运动、镜头…">${esc(S.t2v.prompt)}</textarea></div>
        <div class="field"><label>负面提示词</label>
          <textarea class="textarea mono" id="f-neg" rows="2">${esc(S.t2v.neg)}</textarea></div>
        ${paramsBlock('t2v')}
        <button class="btn btn-primary btn-block" id="submit">${icon('wand', 15)}创建视频任务</button>`;
      box.querySelector('#f-prompt').oninput = (e) => { S.t2v.prompt = e.target.value; };
      box.querySelector('#f-neg').oninput = (e) => { S.t2v.neg = e.target.value; };
      bindParams('t2v');
    } else if (mode === 'i2v') {
      box.innerHTML = `
        <div class="section-label">输入素材</div>
        <div class="field"><label>参考图片（公网可访问 URL）</label>
          <input class="input mono" id="f-image" placeholder="https://…" value="${esc(S.i2v.image)}" />
          ${images.length ? `<select class="select select-sm" id="f-img-pick" style="margin-top:8px">
            <option value="">或从素材库选择…</option>
            ${images.filter((i) => i.remote_url).map((i) => `<option value="${esc(i.remote_url)}">${esc(i.name)}</option>`).join('')}
          </select>` : ''}
          <div class="hint">图生视频需要 Agnes 能抓到的公网图片。本地图片请先上传公网图床。</div>
          <div id="img-preview" style="margin-top:8px"></div>
        </div>
        <div class="section-label">视频描述</div>
        <div class="field"><label>运动描述</label>
          <textarea class="textarea mono" id="f-prompt" rows="5">${esc(S.i2v.prompt)}</textarea></div>
        <div class="field"><label>负面提示词</label>
          <textarea class="textarea mono" id="f-neg" rows="2">${esc(S.i2v.neg)}</textarea></div>
        ${paramsBlock('i2v', { res: false })}
        <button class="btn btn-primary btn-block" id="submit">${icon('image', 15)}图生视频</button>`;
      const img = box.querySelector('#f-image');
      img.oninput = () => { S.i2v.image = img.value; preview(img.value); };
      box.querySelector('#f-prompt').oninput = (e) => { S.i2v.prompt = e.target.value; };
      box.querySelector('#f-neg').oninput = (e) => { S.i2v.neg = e.target.value; };
      const pick = box.querySelector('#f-img-pick');
      if (pick) pick.onchange = () => {
        if (!pick.value) return;
        img.value = pick.value; S.i2v.image = pick.value; preview(pick.value);
      };
      bindParams('i2v');
      preview(S.i2v.image);
    } else if (mode === 'multi') {
      box.innerHTML = `
        <div class="section-label">参考图片（2-8 张）</div>
        <div id="mi-list" class="field"></div>
        ${S.multi.imgs.length < 8 ? `<button class="btn btn-sm btn-block" id="mi-add" style="margin-bottom:14px">${icon('plus', 13)}添加图片</button>` : ''}
        <div class="section-label">视频描述</div>
        <div class="field"><label>视频提示词</label>
          <textarea class="textarea mono" id="f-prompt" rows="4" placeholder="描述多图参考视频的内容…">${esc(S.multi.prompt)}</textarea></div>
        ${paramsBlock('multi', { res: false })}
        <button class="btn btn-primary btn-block" id="submit">${icon('layers', 15)}多图参考生成</button>`;
      renderMi();
      box.querySelector('#f-prompt').oninput = (e) => { S.multi.prompt = e.target.value; };
      const add = box.querySelector('#mi-add');
      if (add) add.onclick = () => { S.multi.imgs.push({ url: '', role: '场景参考' }); renderForm(); };
      bindParams('multi');
    } else {
      box.innerHTML = `
        <div class="section-label">关键帧图片（公网 URL）</div>
        <div class="field"><label>起始关键帧 *</label><input class="input mono" id="kf-start" value="${esc(S.kf.start)}" placeholder="https://…" /></div>
        <div class="field"><label>中间帧（可选）</label><input class="input mono" id="kf-mid" value="${esc(S.kf.middle)}" /></div>
        <div class="field"><label>结束关键帧 *</label><input class="input mono" id="kf-end" value="${esc(S.kf.end)}" /></div>
        <div class="section-label">过渡描述</div>
        <div class="field"><textarea class="textarea mono" id="f-prompt" rows="4">${esc(S.kf.prompt)}</textarea></div>
        ${paramsBlock('kf', { res: false })}
        <button class="btn btn-primary btn-block" id="submit">${icon('wand', 15)}关键帧动画</button>`;
      box.querySelector('#kf-start').oninput = (e) => { S.kf.start = e.target.value; };
      box.querySelector('#kf-mid').oninput = (e) => { S.kf.middle = e.target.value; };
      box.querySelector('#kf-end').oninput = (e) => { S.kf.end = e.target.value; };
      box.querySelector('#f-prompt').oninput = (e) => { S.kf.prompt = e.target.value; };
      bindParams('kf');
    }
    box.querySelector('#submit').onclick = submit;
  }

  function preview(url) {
    const el = container.querySelector('#img-preview');
    if (!el) return;
    el.innerHTML = url ? `<img src="${esc(url)}" style="max-height:110px;max-width:100%;border-radius:10px;border:1px solid var(--border)" onerror="this.style.display='none'" />` : '';
  }

  function renderMi() {
    const el = container.querySelector('#mi-list');
    if (!el) return;
    el.innerHTML = S.multi.imgs.map((im, i) => `
      <div class="row" style="margin-bottom:8px;align-items:flex-start">
        <div style="flex:1;min-width:0">
          <input class="input mono input-sm" data-mi="${i}" value="${esc(im.url)}" placeholder="图片 ${i + 1} URL（公网）" style="height:36px;margin-bottom:6px" />
          <select class="select select-xs" data-mr="${i}">${options(IMAGE_ROLES, 'v', 'v', im.role)}</select>
        </div>
        ${S.multi.imgs.length > 2 ? `<button class="icon-btn danger" data-mdel="${i}" style="background:rgba(255,69,58,0.10);color:var(--err);margin-top:4px">${icon('trash', 13)}</button>` : ''}
      </div>`).join('');
    el.querySelectorAll('[data-mi]').forEach((x) => {
      x.oninput = () => { S.multi.imgs[Number(x.getAttribute('data-mi'))].url = x.value; };
    });
    el.querySelectorAll('[data-mr]').forEach((x) => {
      x.onchange = () => { S.multi.imgs[Number(x.getAttribute('data-mr'))].role = x.value; };
    });
    el.querySelectorAll('[data-mdel]').forEach((x) => {
      x.onclick = () => { S.multi.imgs.splice(Number(x.getAttribute('data-mdel')), 1); renderForm(); };
    });
  }

  // ── 提交 ─────────────────────────────────────────────────
  async function submit() {
    if (submitting) return;
    const model = container.querySelector('#model').value;
    let payload = { project_id: projectId || null, model };

    if (mode === 't2v') {
      if (!S.t2v.prompt.trim()) { toast.err('请输入视频提示词'); return; }
      const r = VIDEO_RESOLUTIONS[S.t2v.res] || VIDEO_RESOLUTIONS[0];
      Object.assign(payload, {
        mode: 'text_to_video', prompt: S.t2v.prompt, negative_prompt: S.t2v.neg,
        width: r.w, height: r.h, num_frames: DURATION_PRESETS[S.t2v.frames].frames,
        frame_rate: S.t2v.fps, seed: S.t2v.seed || undefined,
      });
    } else if (mode === 'i2v') {
      if (!S.i2v.image.trim()) { toast.err('请填写参考图片 URL'); return; }
      if (!/^https?:\/\//.test(S.i2v.image)) { toast.err('参考图必须是 http(s) 开头的公网地址'); return; }
      if (!S.i2v.prompt.trim()) { toast.err('请输入运动描述'); return; }
      Object.assign(payload, {
        mode: 'image_to_video', prompt: S.i2v.prompt, negative_prompt: S.i2v.neg,
        image: S.i2v.image, width: 1152, height: 768,
        num_frames: DURATION_PRESETS[S.i2v.frames].frames, frame_rate: S.i2v.fps, seed: S.i2v.seed || undefined,
      });
    } else if (mode === 'multi') {
      const valid = S.multi.imgs.filter((i) => i.url.trim());
      if (valid.length < 2) { toast.err('多图参考至少需要 2 张图片'); return; }
      if (valid.some((i) => !/^https?:\/\//.test(i.url.trim()))) { toast.err('参考图都必须是公网地址'); return; }
      if (!S.multi.prompt.trim()) { toast.err('请输入视频提示词'); return; }
      Object.assign(payload, {
        mode: 'multi_image', prompt: S.multi.prompt, source_images: valid,
        width: 1152, height: 768, num_frames: DURATION_PRESETS[S.multi.frames].frames,
        frame_rate: 24, seed: S.multi.seed || undefined,
      });
    } else {
      if (!S.kf.start.trim() || !S.kf.end.trim()) { toast.err('起始帧和结束帧都要填'); return; }
      const frames = [{ url: S.kf.start, role: '起始画面' }, { url: S.kf.end, role: '目标画面' }];
      if (S.kf.middle.trim()) frames.splice(1, 0, { url: S.kf.middle, role: '中间帧' });
      Object.assign(payload, {
        mode: 'keyframe', prompt: S.kf.prompt, source_images: frames, mode_flag: 'keyframes',
        width: 1152, height: 768, num_frames: DURATION_PRESETS[S.kf.frames].frames,
        frame_rate: 24, seed: S.kf.seed || undefined,
      });
    }

    submitting = true;
    const btn = container.querySelector('#submit');
    btn.disabled = true;
    btn.innerHTML = `<div class="spinner sm"></div>提交中…（图生视频可能要等 1-2 分钟）`;

    const r = await api.createVideo(payload);
    submitting = false;
    btn.disabled = false;
    btn.innerHTML = icon('wand', 15) + '重新提交';
    btn.onclick = submit;

    if (!r.ok) { toast.err(r.error); showDiag(null, r.error); return; }
    const d = r.data;
    showDiag(d, null);
    loadRecent();
  }

  function showDiag(d, error) {
    const box = container.querySelector('#form');
    const old = box.querySelector('#diag');
    if (old) old.remove();
    const ok = d && d.ok;
    const diag = d?.diagnostics || {};
    const steps = [
      { label: '校验参数', st: error ? 'error' : 'done' },
      { label: '提交到 Agnes', st: error ? 'error' : (d?.timed_out ? 'warn' : 'done') },
      { label: '保存本地任务', st: error ? 'error' : (d?.asset ? 'done' : 'error') },
    ];
    const stepIcon = (st) => st === 'done' ? `<span style="color:var(--ok)">${icon('check', 15)}</span>`
      : st === 'warn' ? `<span style="color:var(--warn)">${icon('alert', 15)}</span>`
        : st === 'error' ? `<span style="color:var(--err)">${icon('x', 15)}</span>`
          : `<div class="spinner sm"></div>`;

    const el = document.createElement('div');
    el.id = 'diag';
    el.style.marginTop = '16px';
    el.innerHTML = `
      <div style="background:rgba(255,255,255,0.035);border:1px solid var(--border);border-radius:14px;padding:14px">
        <div class="row" style="margin-bottom:10px">
          ${ok ? (d.timed_out ? icon('alert', 16) : icon('check', 16)) : icon('x', 16)}
          <span style="font-size:13px;font-weight:600;color:${ok ? (d.timed_out ? 'var(--warn)' : 'var(--ok)') : 'var(--err)'}">
            ${ok ? (d.timed_out ? '请求已发出，但等待超时' : '任务已提交') : '提交失败'}
          </span>
        </div>
        ${steps.map((s) => `<div class="step-row ${s.st}">${stepIcon(s.st)}<span style="font-size:12.5px;color:var(--text-2)">${esc(s.label)}</span></div>`).join('')}
        ${ok && d.asset ? `
          <div style="margin-top:12px;padding:10px;border-radius:10px;background:rgba(52,211,153,0.07);border:1px solid rgba(52,211,153,0.16)">
            <div style="font-size:10.5px;color:var(--text-3)">video_id</div>
            <div style="font-size:11.5px;font-family:var(--mono);color:var(--ok);word-break:break-all">${esc(d.asset.agnes_video_id || '（未拿到，需补录）')}</div>
          </div>` : ''}
        ${error ? `<div class="note red" style="margin-top:12px">${esc(error)}</div>` : ''}
        ${ok && d.timed_out ? `
          <div class="note orange" style="margin-top:12px">
            请求已送到 Agnes，但 ${Math.round((Number(state.settings.request_timeout_ms) || 150000) / 1000)} 秒内没拿到任务 ID。
            图生视频时 Agnes 要先从公网下载参考图，忙起来会超过这个时间。<br><br>
            <b>先别重复提交</b>：等 1-2 分钟去 Agnes 账单看有没有新消费记录。有的话到「镜头任务」点「绑定任务 ID」补录即可追踪。
          </div>` : ''}
        ${diag.final_request_url ? `
          <div style="margin-top:12px">
            <div class="diag-row"><span class="k">请求 URL</span><span class="v" style="color:var(--text-3)">${esc(diag.final_request_url)}</span></div>
            <div class="diag-row"><span class="k">已发出请求</span><span class="v" style="color:${diag.request_sent ? 'var(--ok)' : 'var(--err)'}">${diag.request_sent ? '是' : '否'}</span></div>
            <div class="diag-row"><span class="k">收到响应</span><span class="v" style="color:${diag.response_received ? 'var(--ok)' : 'var(--err)'}">${diag.response_received ? '是' : '否'}</span></div>
            <div class="diag-row"><span class="k">HTTP 状态</span><span class="v" style="color:${(diag.response_status || 0) < 300 ? 'var(--ok)' : 'var(--err)'}">${esc(diag.response_status ?? '—')}</span></div>
            <div class="diag-row"><span class="k">耗时</span><span class="v" style="color:var(--text-3)">${esc(diag.duration_ms ?? '—')} ms</span></div>
          </div>` : ''}
        ${ok ? `<button class="btn btn-sm btn-block" id="to-tasks" style="margin-top:12px">${icon('arrowRight', 13)}前往镜头任务</button>` : ''}
      </div>`;
    box.appendChild(el);
    const t = el.querySelector('#to-tasks');
    if (t) t.onclick = () => navigate('tasks');
  }

  async function loadImages() {
    const r = await api.images(projectId || undefined);
    images = (r.ok && r.data) || [];
  }

  async function loadRecent() {
    const r = await api.videos(projectId || undefined);
    const el = container.querySelector('#recent');
    if (!r.ok) { el.innerHTML = `<div class="note red">${esc(r.error)}</div>`; return; }
    recent = (r.data || []).slice(0, 8);
    if (!recent.length) {
      el.innerHTML = `<div class="card">${empty('还没有视频任务', '选一个模式，填提示词提交', 'video')}</div>`;
      return;
    }
    el.innerHTML = recent.map((v) => `
      <div class="task-row" style="margin-bottom:10px">
        <div class="side">
          ${statusBadge(v.status)}
          <span class="badge gray" style="font-size:10px">${esc(relTime(v.created_at))}</span>
        </div>
        <div class="body">
          <div class="prompt-line">${esc(v.video_prompt)}</div>
          <div class="mono-sm">${esc(v.num_frames)}帧 · ${esc(v.frame_rate)}fps · ${esc(v.model_name)}</div>
        </div>
      </div>`).join('');
  }

  await loadImages();
  renderForm();
  await loadRecent();
}
