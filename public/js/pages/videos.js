/**
 * videos.js — 视频生成
 * 四种模式（文生 / 图生 / 多图参考 / 关键帧），提交后交给后端轮询，
 * 页面只负责展示链路诊断 —— 提交超时的锅算 Agnes 的还是本地的，一眼能看出来。
 */
import {
  icon, esc, DURATION_PRESETS, VIDEO_RESOLUTIONS, VIDEO_MODES,
  SECONDS_PRESETS, isVideo25, secondsFor25,
  VIDEO_SIZES_25, VIDEO_ASPECTS_25,
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
    // 音频生视频（Agnes 2.5 的 audios 参考）：提示词里用 <Audio 1> 指代第 1 段
    audio: {
      audios: [''],
      prompt: 'A person lip-syncs to <Audio 1>, close-up, natural facial motion, cinematic lighting',
      seconds: 5, seed: '',
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
        <div class="segmented" id="mode" style="grid-template-columns:repeat(${VIDEO_MODES.length},1fr);margin-bottom:16px">
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

  // 换模型要重画表单：2.0 和 2.5 的参数区不是同一套
  container.querySelector('#model').onchange = () => renderForm();

  /**
   * 参数区随模型族切换：2.5 认 seconds / size / aspect_ratio，
   * 而且 width / height / fps / num_frames 传了直接 400 —— 继续显示这些输入
   * 等于让用户填一组注定被拒的参数。
   */
  function paramsBlock(key, opts = {}) {
    const s = S[key];
    const v25 = isVideo25(container.querySelector('#model')?.value);
    // 音频模式没有 frames（它用 seconds），直接取会 DURATION_PRESETS[undefined] 抛错
    const fi = s.frames || 1;

    if (v25) {
      const sec = s.seconds || 5;
      return `
      <div style="padding-top:16px;border-top:1px solid rgba(255,255,255,0.08);margin-top:16px">
        <div class="section-label">视频参数（Video 2.5）</div>
        <div class="field"><label>分辨率 size</label>
          <select class="select" id="f-size25">
            ${VIDEO_SIZES_25.map((r) => `<option value="${r.value}"${r.value === (s.size25 || '720P') ? ' selected' : ''}>${esc(r.label)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>画幅比例</label>
          <select class="select" id="f-ar25">
            ${VIDEO_ASPECTS_25.map((r) => `<option value="${r.value}"${r.value === (s.ar25 || '16:9') ? ' selected' : ''}>${esc(r.label)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>时长 seconds</label>
          <div class="chips" id="f-sec25">
            ${SECONDS_PRESETS.map((p) => `<button class="chip ${p.seconds === sec ? 'on' : ''}" data-sec="${p.seconds}">${esc(p.label)}</button>`).join('')}
          </div>
          <div class="hint">2.5 的时长是秒数，取值 <b>4~12</b>（不是 num_frames）</div>
        </div>
        <div class="field">
          <label>Seed（留空随机）</label>
          <input class="input mono" id="f-seed" value="${esc(s.seed || '')}" placeholder="随机" />
        </div>
        <div class="field">
          <label>高级参数（JSON，可选）</label>
          <textarea class="textarea mono" id="f-extra" rows="2" placeholder='{"字段名": "值"}'>${esc(s.extra || '')}</textarea>
          <div class="hint">2.5 不支持 width / height / fps / num_frames，传了会被拒，所以这里不提供。</div>
        </div>
      </div>`;
    }

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
            ${DURATION_PRESETS.map((p, i) => `<button class="chip ${i === fi ? 'on' : ''}" data-i="${i}">${esc(p.label)}</button>`).join('')}
          </div>
          <div class="hint">num_frames = <b>${DURATION_PRESETS[fi].frames}</b>（Agnes 要求 8n+1，最大 441）</div>
        </div>
        <div class="field">
          <label>帧率 frame_rate</label>
          <input class="input" id="f-fps" type="number" min="1" max="60" value="${esc(s.fps)}" />
        </div>
        <div class="field">
          <label>Seed（留空随机）</label>
          <input class="input mono" id="f-seed" value="${esc(s.seed)}" placeholder="随机" />
        </div>
        <div class="field">
          <label>高级参数（JSON，可选）</label>
          <textarea class="textarea mono" id="f-extra" rows="2" placeholder='{"字段名": "值"}'>${esc(s.extra || '')}</textarea>
          <div class="hint">
            Agnes 若新增了能力（例如音频驱动、新的控制字段），直接在这里传参就能用上，不用等程序更新。
            已填的提示词、模型、尺寸等常规参数不会被这里覆盖。
            目前 Agnes 官方公开的是文生视频、图生视频、多图参考、关键帧和音频参考这几种。
          </div>
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
    // Video 2.5 的控件（与上面互斥，靠 id 区分）
    container.querySelectorAll('#f-sec25 [data-sec]').forEach((b) => {
      b.onclick = () => {
        s.seconds = Number(b.getAttribute('data-sec'));
        container.querySelectorAll('#f-sec25 [data-sec]').forEach((x) => x.classList.toggle('on', x === b));
      };
    });
    const size25 = container.querySelector('#f-size25');
    if (size25) size25.onchange = () => { s.size25 = size25.value; };
    const ar25 = container.querySelector('#f-ar25');
    if (ar25) ar25.onchange = () => { s.ar25 = ar25.value; };
    const extra = container.querySelector('#f-extra');
    if (extra) extra.oninput = () => { s.extra = extra.value; };
  }

  /** 解析高级参数；不是合法 JSON 就拦下来，别把坏参数发给 Agnes */
  function readExtraParams(key) {
    const raw = String(S[key].extra || '').trim();
    if (!raw) return undefined;
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch {
      toast.err('高级参数不是合法 JSON，请检查后重试');
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      toast.err('高级参数必须是一个 JSON 对象');
      return null;
    }
    return parsed;
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
          ${(() => {
            // 配了图床：本机图片也能选，提交时后端自动上传成公网地址
            const usable = (state.imageHost && state.imageHost.configured)
              ? images
              : images.filter((i) => i.remote_url);
            if (usable.length) {
              return `<select class="select select-sm" id="f-img-pick" style="margin-top:8px">
                <option value="">或从素材库选择…</option>
                ${usable.map((i) => `<option value="${esc(i.remote_url || i.url)}">${esc(i.name)}</option>`).join('')}
              </select>`;
            }
            // 一张都选不了时，别丢一个空下拉——用户会以为是功能坏了
            return images.length
              ? `<div class="hint" style="margin-top:8px;color:var(--warn)">
                   素材库里的图片都只有本机地址，Agnes 抓不到。
                   到「设置 → 图床」配一个免费图床后即可直接选用，或在「素材库」手动填公网 URL。
                 </div>`
              : '';
          })()}
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
    } else if (mode === 'keyframe') {
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
    } else if (mode === 'audio') {
      box.innerHTML = `
        <div class="section-label">参考音频（公网 URL，最多 3 段）</div>
        <div id="au-list"></div>
        ${S.audio.audios.length < 3 ? `<button class="btn btn-sm btn-block" id="au-add" style="margin-bottom:14px">${icon('plus', 13)}添加音频</button>` : ''}
        <div class="section-label">画面描述</div>
        <div class="field"><textarea class="textarea mono" id="f-prompt" rows="4">${esc(S.audio.prompt)}</textarea>
          <div class="hint">用 <b>&lt;Audio 1&gt;</b> 指代第 1 段音频、&lt;Audio 2&gt; 指代第 2 段；画面会跟着音频的节奏走。</div>
        </div>
        ${paramsBlock('audio', { res: false })}
        <div class="note" style="margin-top:12px">
          音频总时长 2~12 秒、单段小于 15 MB。Agnes 要能直接抓到这个 URL，
          本机路径不行——需要公网直链。
        </div>
        <button class="btn btn-primary btn-block" id="submit">${icon('wand', 15)}音频生视频</button>`;
      box.querySelector('#f-prompt').oninput = (e) => { S.audio.prompt = e.target.value; };
      const add = box.querySelector('#au-add');
      if (add) add.onclick = () => { S.audio.audios.push(''); renderForm(); };
      bindParams('audio');
      renderAu();
    }
    box.querySelector('#submit').onclick = submit;
  }

  function preview(url) {
    const el = container.querySelector('#img-preview');
    if (!el) return;
    el.innerHTML = url ? `<img src="${esc(url)}" style="max-height:110px;max-width:100%;border-radius:10px;border:1px solid var(--border)" onerror="this.style.display='none'" />` : '';
  }

  function renderAu() {
    const el = container.querySelector('#au-list');
    if (!el) return;
    el.innerHTML = S.audio.audios.map((a, i) => `
      <div class="row" style="margin-bottom:8px">
        <input class="input mono input-sm" data-au="${i}" value="${esc(a)}" placeholder="音频 ${i + 1} URL（公网直链）" style="height:36px" />
        ${S.audio.audios.length > 1 ? `<button class="icon-btn danger" data-udel="${i}" style="background:rgba(255,69,58,0.10);color:var(--err)">${icon('trash', 13)}</button>` : ''}
      </div>`).join('');
    el.querySelectorAll('[data-au]').forEach((x) => {
      x.oninput = () => { S.audio.audios[Number(x.getAttribute('data-au'))] = x.value; };
    });
    el.querySelectorAll('[data-udel]').forEach((x) => {
      x.onclick = () => { S.audio.audios.splice(Number(x.getAttribute('data-udel')), 1); renderForm(); };
    });
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
    } else if (mode === 'keyframe') {
      if (!S.kf.start.trim() || !S.kf.end.trim()) { toast.err('起始帧和结束帧都要填'); return; }
      const frames = [{ url: S.kf.start, role: '起始画面' }, { url: S.kf.end, role: '目标画面' }];
      if (S.kf.middle.trim()) frames.splice(1, 0, { url: S.kf.middle, role: '中间帧' });
      Object.assign(payload, {
        mode: 'keyframe', prompt: S.kf.prompt, source_images: frames, mode_flag: 'keyframes',
        width: 1152, height: 768, num_frames: DURATION_PRESETS[S.kf.frames].frames,
        frame_rate: 24, seed: S.kf.seed || undefined,
      });
    } else {
      // 音频生视频：Agnes 2.5 的 audios 参考
      const valid = S.audio.audios.map((a) => a.trim()).filter(Boolean);
      if (!valid.length) { toast.err('请至少填一段音频 URL'); return; }
      const bad = valid.find((a) => !/^https?:\/\//.test(a));
      if (bad) { toast.err('音频必须是 http(s) 开头的公网直链，Agnes 抓不到本机文件'); return; }
      if (valid.length > 3) { toast.err('音频最多 3 段'); return; }
      if (!S.audio.prompt.trim()) { toast.err('请输入画面描述'); return; }
      if (!isVideo25(model)) {
        toast.err('音频生视频是 Agnes Video 2.5 的能力，请在上方模型下拉里选一个 2.5 模型');
        return;
      }
      Object.assign(payload, {
        mode: 'audio_reference', prompt: S.audio.prompt, audios: valid,
        mode_25: 'reference', duration_seconds: S.audio.seconds || 5,
        seed: S.audio.seed || undefined,
      });
    }

    // Video 2.5 的参数：这一套字段和服务端 agnes.js 的分流逻辑对应
    if (isVideo25(model) && mode !== 'audio') {
      const key = mode === 'keyframe' ? 'kf' : mode;   // 界面 mode id 与状态键不完全同名
      const s = S[key];
      payload.mode_25 = mode === 't2v' ? 'text' : mode === 'keyframe' ? 'keyframe' : 'reference';
      payload.duration_seconds = s.seconds
        || Math.round((DURATION_PRESETS[s.frames || 1].frames - 1) / 24) || 5;
      payload.duration_seconds = Number(secondsFor25(payload.duration_seconds));
      payload.size_25 = s.size25 || '720P';
      payload.aspect_ratio = s.ar25 || '16:9';
    }

    // 高级参数：解析失败就不提交，别把坏参数发给 Agnes
    const extra = readExtraParams(mode);
    if (extra === null) return;
    if (extra) payload.extra_params = extra;

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
