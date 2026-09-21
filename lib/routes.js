/**
 * routes.js — 全部 /api/* 接口
 * ------------------------------------------------------------------
 * 接口形状基本照抄原版前端调用的数据模型（projects / scripts / storyboards /
 * image_assets / video_assets / generation_tasks / prompt_templates），
 * 这样从云端导出的老数据能直接导入本地版。
 *
 * 相对原版的改动：
 *   · 去掉 user_id，去掉所有 auth 分支
 *   · 生成文本/图片时顺手写 generation_tasks —— 原版这张表从来没被写进去过，
 *     任务页的「文本」「图片」标签页一直是空的
 *   · 图片生成结果落盘到本地 assets/，不再依赖公网 Storage
 *   · 视频创建/查询/下载走本机的 agnes.js，前端拿不到 API Key
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const imagehost = require('./imagehost.js');

module.exports = function createRoutes(ctx) {
  const store = ctx.store;
  const agnes = ctx.agnes;
  const poller = ctx.poller;
  const jobs = ctx.jobs;

  // ── 小工具 ─────────────────────────────────────────────────
  const now = () => new Date().toISOString();

  function attach(id) {
    return `attachment; filename="${encodeURIComponent(id)}"`;
  }

  /** 把请求路径按 /api/xxx/:id 形式的模板匹配出来 */
  function match(pathname, pattern) {
    const a = pathname.split('/').filter(Boolean);
    const b = pattern.split('/').filter(Boolean);
    if (a.length !== b.length) return null;
    const params = {};
    for (let i = 0; i < b.length; i++) {
      if (b[i].startsWith(':')) params[b[i].slice(1)] = decodeURIComponent(a[i]);
      else if (b[i] !== a[i]) return null;
    }
    return params;
  }

  const str = (v, d = '') => (v == null ? d : String(v));
  const num = (v, d = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const bool = (v) => v === true || v === '1' || v === 'true' || v === 1;

  // ── 素材落盘 ───────────────────────────────────────────────
  function safeName(name, ext) {
    let n = path.basename(str(name)).replace(/[\\/:*?"<>|]+/g, '_').trim();
    if (!n || n === '.' || n === '..') n = `asset_${Date.now()}`;
    if (ext && !n.toLowerCase().endsWith('.' + ext.toLowerCase())) n += '.' + ext;
    return n;
  }

  /** 保存 base64 图片，返回 {file, url} */
  function saveImageBase64(b64, mime = 'image/png') {
    const dir = store.imagesDir();
    fs.mkdirSync(dir, { recursive: true });
    const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png';
    const name = safeName(`img_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, ext);
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    return { file, url: `/assets/images/${encodeURIComponent(name)}` };
  }

  /** 把远端图片抓到本地，失败返回 null */
  async function fetchRemoteImage(url) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!resp.ok) return null;
      const buf = Buffer.from(await resp.arrayBuffer());
      const dir = store.imagesDir();
      fs.mkdirSync(dir, { recursive: true });
      const ct = resp.headers.get('content-type') || 'image/png';
      const ext = ct.includes('jpeg') ? 'jpg' : ct.includes('webp') ? 'webp' : 'png';
      const name = safeName(`img_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, ext);
      const file = path.join(dir, name);
      fs.writeFileSync(file, buf);
      return { file, url: `/assets/images/${encodeURIComponent(name)}`, bytes: buf.length };
    } catch {
      return null;
    }
  }

  // ── 路由表 ─────────────────────────────────────────────────
  // 每项：['METHOD', '/api/...', handler(req, res, params, body)]
  const routes = [];
  const on = (method, pattern, handler) => routes.push({ method, pattern, handler });

  // ================= 系统 =================
  on('GET', '/api/health', () => ({
    ok: true,
    version: ctx.version,
    data_home: store.home(),
    time: now(),
  }));

  on('GET', '/api/bootstrap', () => ({
    settings: store.getSettingsMasked(),
    projects: store.list('projects'),
    stats: store.stats(),
    templates: store.list('prompt_templates'),
    models: store.getModels(),
    // 数据文件损坏/从备份恢复时带上说明。静默起一个空库的话，
    // 用户只会觉得「项目怎么全没了」，根本不知道发生了什么。
    load_issues: store.getLoadIssues(),
  }));

  on('GET', '/api/stats', () => store.stats());

  // ================= 设置 / 模型目录 =================
  on('GET', '/api/settings', () => store.getSettingsMasked());

  on('GET', '/api/models', () => store.getModels());

  /** 手动刷新模型目录；失败时保留上一次成功缓存，不让下拉框变空 */
  async function refreshModels() {
    try {
      const result = await agnes.listModels();
      const normalized = store.normalizeModels(result.data);
      if (!normalized.length) {
        const error = 'Agnes 模型接口返回为空或格式无法识别，已保留上次模型目录。';
        store.setModelCacheError(error);
        return { ok: false, error, models: store.getModels(), diagnostics: result.diagnostics };
      }
      const models = store.setModels(result.data, { source: 'agnes' });
      return { ok: true, models, diagnostics: result.diagnostics };
    } catch (e) {
      const models = store.setModelCacheError(e.message);
      return { ok: false, error: e.message, errorType: e.errorType || 'model_fetch_failed', models };
    }
  }

  on('POST', '/api/models/refresh', async () => refreshModels());

  on('PUT', '/api/settings', (req, res, params, body) => {
    const patch = {};
    for (const k of Object.keys(store.SETTING_DEFAULTS)) {
      if (k in body) patch[k] = body[k];
    }
    store.setSettings(patch);
    return { ok: true, settings: store.getSettingsMasked() };
  });

  on('POST', '/api/settings/test', async (req, res, params, body) => {
    const kind = str(body.kind || 'text');
    try {
      const r = await agnes.testConnection(kind);
      return { ok: true, message: r.message };
    } catch (e) {
      return { ok: false, error: e.message, errorType: e.errorType || 'test_failed' };
    }
  });

  // ================= 图床（让本地图片能被 Agnes 用于图生视频） =================
  on('GET', '/api/imagehost', () => {
    const cfg = imagehost.config();
    return {
      configured: !!cfg,
      type: cfg?.type || '',
      label: cfg?.label || '',
      endpoint: cfg?.endpoint || '',
      auto_upload: store.getSettings().auto_upload_image === '1',
      hosts: Object.entries(imagehost.HOSTS).map(([k, v]) => ({ value: k, label: v.label, keyHint: v.keyHint })),
    };
  });

  on('POST', '/api/imagehost/test', async () => {
    try {
      const r = await imagehost.test();
      return r.ok ? { ok: true, message: `图床可用（${r.host}）`, url: r.url } : { ok: false, error: r.error };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /** 把某张素材图片传到图床，成功后写回 remote_url，之后就能用于图生视频 */
  on('POST', '/api/imagehost/upload', async (req, res, params, body) => {
    const id = str(body.image_id);
    const asset = id ? store.get('image_assets', id) : null;
    if (!asset) throw httpError(404, '图片不存在');
    const local = asset.local_file || imagehost.localPathFromAssetUrl(asset.url);
    if (!local || !fs.existsSync(local)) throw httpError(400, '找不到这张图片的本地文件，可能已被删除');
    try {
      const r = await imagehost.uploadFile(local);
      const updated = store.update('image_assets', id, { remote_url: r.url });
      return { ok: true, url: r.url, asset: updated };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ================= 项目 =================
  on('GET', '/api/projects', () => store.list('projects'));

  on('POST', '/api/projects', (req, res, params, body) => {
    const name = str(body.name).trim();
    if (!name) throw httpError(400, '项目名称不能为空');
    return store.insert('projects', {
      name,
      description: str(body.description),
      project_type: str(body.project_type || '自定义'),
      target_platform: str(body.target_platform || '抖音'),
      aspect_ratio: str(body.aspect_ratio || '9:16'),
      art_style: str(body.art_style),
      episode_duration: str(body.episode_duration || '1分钟'),
      planned_episodes: num(body.planned_episodes, 10),
      status: 'active',
    });
  });

  on('GET', '/api/projects/:id', (req, res, params) => {
    const p = store.get('projects', params.id);
    if (!p) throw httpError(404, '项目不存在');
    return p;
  });

  on('PUT', '/api/projects/:id', (req, res, params, body) => {
    const patch = {};
    for (const k of ['name', 'description', 'project_type', 'target_platform', 'aspect_ratio',
      'art_style', 'episode_duration', 'planned_episodes', 'status']) {
      if (k in body) patch[k] = k === 'planned_episodes' ? num(body[k], 1) : str(body[k]);
    }
    const p = store.update('projects', params.id, patch);
    if (!p) throw httpError(404, '项目不存在');
    return p;
  });

  on('DELETE', '/api/projects/:id', (req, res, params, body) => {
    const cascade = bool(body && body.cascade);
    if (!store.get('projects', params.id)) throw httpError(404, '项目不存在');
    store.remove('projects', params.id);
    let removed = 0;
    if (cascade) {
      for (const c of ['scripts', 'storyboards', 'image_assets', 'video_assets', 'generation_tasks']) {
        removed += store.removeWhere(c, (r) => r.project_id === params.id);
      }
    }
    return { ok: true, removed };
  });

  on('POST', '/api/projects/:id/duplicate', (req, res, params) => {
    const p = store.get('projects', params.id);
    if (!p) throw httpError(404, '项目不存在');
    const copy = Object.assign({}, p, {
      id: undefined,
      name: `${p.name} 副本`,
      created_at: undefined,
      updated_at: undefined,
    });
    delete copy.id;
    delete copy.created_at;
    delete copy.updated_at;
    return store.insert('projects', copy);
  });

  on('GET', '/api/projects/:id/export', (req, res, params) => {
    const data = store.exportProject(params.id);
    if (!data) throw httpError(404, '项目不存在');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="project-${params.id}.json"`);
    return { raw: JSON.stringify(data, null, 2) };
  });

  // ================= 剧本 =================
  on('GET', '/api/scripts', (req, res, params, body, query) => {
    const projectId = query.project_id;
    return store.list('scripts', {
      filter: (r) => (projectId ? r.project_id === projectId : true),
      sort: (a, b) => String(b.created_at).localeCompare(String(a.created_at)),
    });
  });

  on('POST', '/api/scripts', (req, res, params, body) => {
    if (!str(body.content).trim()) throw httpError(400, '剧本内容不能为空');
    return store.insert('scripts', {
      project_id: str(body.project_id) || null,
      script_type: str(body.script_type || 'story_concept'),
      title: str(body.title) || `未命名-${now().slice(0, 10)}`,
      content: str(body.content),
      model_name: str(body.model_name),
      generation_prompt: str(body.generation_prompt),
    });
  });

  on('PUT', '/api/scripts/:id', (req, res, params, body) => {
    const patch = {};
    for (const k of ['title', 'content', 'script_type', 'project_id']) if (k in body) patch[k] = str(body[k]);
    const s = store.update('scripts', params.id, patch);
    if (!s) throw httpError(404, '剧本不存在');
    return s;
  });

  on('DELETE', '/api/scripts/:id', (req, res, params) => {
    if (!store.remove('scripts', params.id)) throw httpError(404, '剧本不存在');
    return { ok: true };
  });

  // ================= 分镜 =================
  on('GET', '/api/storyboards', (req, res, params, body, query) => {
    const projectId = query.project_id;
    const ep = query.episode ? Number(query.episode) : undefined;
    return store.list('storyboards', {
      filter: (r) => (projectId ? r.project_id === projectId : true)
        && (ep !== undefined ? Number(r.episode_number) === ep : true),
      sort: (a, b) => (num(a.sort_order, 0) - num(b.sort_order, 0)) || (num(a.shot_number, 0) - num(b.shot_number, 0)),
      limit: 1000,
    });
  });

  function storyboardRow(r, idx) {
    return {
      project_id: str(r.project_id) || null,
      episode_number: num(r.episode_number, 1),
      shot_number: num(r.shot_number, idx + 1),
      shot_type: str(r.shot_type || '中景'),
      scene_description: str(r.scene_description),
      characters: str(r.characters),
      scene: str(r.scene),
      action: str(r.action),
      dialogue: str(r.dialogue),
      narration: str(r.narration),
      sound_effect: str(r.sound_effect),
      duration_seconds: num(r.duration_seconds, 3),
      image_prompt: str(r.image_prompt),
      video_prompt: str(r.video_prompt),
      negative_prompt: str(r.negative_prompt || 'low quality, blurry, distorted face'),
      linked_image_id: r.linked_image_id || null,
      linked_video_id: r.linked_video_id || null,
      status: str(r.status || 'pending'),
      sort_order: num(r.sort_order, idx),
    };
  }

  on('POST', '/api/storyboards', (req, res, params, body) => {
    if (Array.isArray(body.rows)) {
      if (!body.rows.length) throw httpError(400, '没有要创建的分镜');
      const rows = store.insertMany('storyboards', body.rows.map(storyboardRow));
      return { inserted: rows.length, rows };
    }
    return store.insert('storyboards', storyboardRow(body, 0));
  });

  on('PUT', '/api/storyboards/:id', (req, res, params, body) => {
    const patch = {};
    for (const k of ['episode_number', 'shot_number', 'shot_type', 'scene_description', 'characters',
      'scene', 'action', 'dialogue', 'narration', 'sound_effect', 'duration_seconds',
      'image_prompt', 'video_prompt', 'negative_prompt', 'linked_image_id', 'linked_video_id',
      'status', 'sort_order']) {
      if (k in body) {
        patch[k] = ['episode_number', 'shot_number', 'duration_seconds', 'sort_order'].includes(k)
          ? num(body[k], 0) : str(body[k]);
      }
    }
    const s = store.update('storyboards', params.id, patch);
    if (!s) throw httpError(404, '分镜不存在');
    return s;
  });

  on('DELETE', '/api/storyboards/:id', (req, res, params) => {
    if (!store.remove('storyboards', params.id)) throw httpError(404, '分镜不存在');
    return { ok: true };
  });

  on('POST', '/api/storyboards/reorder', (req, res, params, body) => {
    const ids = Array.isArray(body.ids) ? body.ids : [];
    ids.forEach((id, i) => store.update('storyboards', id, { sort_order: i }));
    return { ok: true, count: ids.length };
  });

  on('DELETE', '/api/storyboards', (req, res, params, body, query) => {
    // 清空某项目某集
    const projectId = query.project_id;
    const ep = query.episode ? Number(query.episode) : undefined;
    const n = store.removeWhere('storyboards', (r) => (projectId ? r.project_id === projectId : true)
      && (ep !== undefined ? Number(r.episode_number) === ep : true));
    return { ok: true, removed: n };
  });

  // ================= 图片素材 =================
  on('GET', '/api/images', (req, res, params, body, query) => {
    const projectId = query.project_id;
    return store.list('image_assets', {
      filter: (r) => (projectId ? r.project_id === projectId : true),
      limit: query.limit ? Number(query.limit) : 500,
    });
  });

  on('POST', '/api/images', (req, res, params, body) => {
    return store.insert('image_assets', {
      project_id: str(body.project_id) || null,
      storyboard_id: body.storyboard_id || null,
      name: str(body.name) || `图片_${Date.now()}`,
      url: str(body.url),
      remote_url: str(body.remote_url),
      local_file: str(body.local_file),
      usage_type: str(body.usage_type || 'storyboard'),
      generation_prompt: str(body.generation_prompt),
      model_name: str(body.model_name),
      width: num(body.width, 0),
      height: num(body.height, 0),
      size: str(body.size),
      source_task_id: body.source_task_id || null,
      is_favorited: bool(body.is_favorited),
      notes: str(body.notes),
      tags: Array.isArray(body.tags) ? body.tags : [],
    });
  });

  on('PUT', '/api/images/:id', (req, res, params, body) => {
    const patch = {};
    for (const k of ['name', 'usage_type', 'notes', 'project_id', 'url', 'remote_url']) {
      if (k in body) patch[k] = str(body[k]);
    }
    if ('is_favorited' in body) patch.is_favorited = bool(body.is_favorited);
    if ('tags' in body && Array.isArray(body.tags)) patch.tags = body.tags;
    const a = store.update('image_assets', params.id, patch);
    if (!a) throw httpError(404, '图片不存在');
    return a;
  });

  on('DELETE', '/api/images/:id', (req, res, params) => {
    const a = store.get('image_assets', params.id);
    if (!a) throw httpError(404, '图片不存在');
    // 本地文件跟着删，远端 URL 管不着
    if (a.local_file && fs.existsSync(a.local_file)) {
      try { fs.unlinkSync(a.local_file); } catch { /* 删不掉就算了 */ }
    }
    store.remove('image_assets', params.id);
    return { ok: true };
  });

  // ================= 视频素材 / 任务 =================
  on('GET', '/api/videos', (req, res, params, body, query) => {
    const projectId = query.project_id;
    return store.list('video_assets', {
      filter: (r) => (projectId ? r.project_id === projectId : true),
      limit: query.limit ? Number(query.limit) : 300,
    });
  });

  /**
   * 创建视频任务：校验 → 提交 Agnes → 落库 → 交给轮询器
   * 超时不视为失败（原版血泪）：Agnes 可能已经收下，标记成「提交超时未知」
   * 让用户去账单核对后补录 video_id，而不是傻乎乎重复提交被重复扣费。
   */
  /**
   * 视频资产记录的基础字段。
   * 提交成功和提交失败走的是两条分支，但落库的字段几乎一样——
   * 之前是复制两份，加一个字段（比如 source_audios）就得改两处，
   * 漏掉一处就变成「失败的记录里查不到用了哪段音频」，事后没法复盘。
   * 这里收成一个函数，两条分支只补各自的状态字段。
   */
  function videoAssetRecord(body, ctx, tail) {
    return Object.assign({
      project_id: str(body.project_id) || null,
      storyboard_id: body.storyboard_id || null,
      name: str(body.name) || `视频_${Date.now()}`,
      video_url: '',
      generation_mode: str(body.mode || 'text_to_video'),
      video_prompt: ctx.prompt,
      negative_prompt: str(body.negative_prompt),
      source_image_url: str(ctx.img.image || body.image),
      source_images: ctx.img.source_images || (Array.isArray(body.source_images) ? body.source_images : []),
      source_audios: ctx.audios || [],
      model_name: str(body.model) || store.getSettings().default_video_model,
      seed: body.seed != null ? num(body.seed, 0) : null,
      num_frames: num(body.num_frames, 121),
      frame_rate: num(body.frame_rate, 24),
      width: num(body.width, 1152),
      height: num(body.height, 768),
      progress: 0,
      is_favorited: false,
      notes: '',
      completed_at: null,
    }, tail);
  }

  on('POST', '/api/videos', async (req, res, params, body) => {
    const prompt = str(body.prompt).trim();
    if (!prompt) throw httpError(400, '视频提示词不能为空');

    // Agnes 抓不到 /assets/... 这种本机路径，提交前先把本地素材传成公网地址
    const img = await publicizeImages(body);
    const audios = await publicizeAudios(body);

    // 素材数量超限会被 Agnes 直接 400，界面上只看得到一句看不懂的失败。
    // 前端 UI 已经挡住了（多图最多加 8 张），但接口层面没有限制，这里补上。
    assertMediaLimits(str(body.model) || store.getSettings().default_video_model, img, audios);

    const startedAt = now();
    let result;
    try {
      result = await agnes.createVideo({
        model: str(body.model) || undefined,
        prompt,
        negative_prompt: str(body.negative_prompt),
        width: num(body.width, 1152),
        height: num(body.height, 768),
        num_frames: num(body.num_frames, 121),
        frame_rate: num(body.frame_rate, 24),
        seed: body.seed,
        image: img.image || undefined,
        source_images: img.source_images || undefined,
        mode_flag: body.mode_flag || undefined,
        // Video 2.5 用的字段：模型是 2.5 时 agnes.js 会走另一套请求体
        audios: audios.length ? audios : undefined,
        duration_seconds: body.duration_seconds,
        mode_25: str(body.mode_25) || undefined,
        size_25: str(body.size_25) || undefined,
        aspect_ratio: str(body.aspect_ratio) || undefined,
        extra_params: body.extra_params && typeof body.extra_params === 'object' ? body.extra_params : undefined,
      });
    } catch (e) {
      // 明确失败：也记一条本地记录，方便事后复盘参数
      const asset = store.insert('video_assets', videoAssetRecord(body, { prompt, img, audios }, {
        status: 'failed',
        remote_status: 'not_submitted',
        local_status: 'submit_failed',
        agnes_task_id: '',
        agnes_video_id: '',
        error_message: e.message,
        raw_create_response: e.responseData || null,
        request_log: { error_type: e.errorType, started_at: startedAt, finished_at: now() },
      }));
      return {
        ok: false,
        error: e.message,
        errorType: e.errorType || 'submit_failed',
        diagnostics: e.diagnostics || null,
        asset,
      };
    }

    const timedOut = result.timed_out;
    const videoId = result.video_id;
    const localStatus = timedOut && !videoId ? 'submit_timeout_unknown' : timedOut ? 'remote_submitted' : 'polling';
    const remoteStatus = timedOut && !videoId ? 'unknown' : videoId ? 'queued' : 'not_submitted';
    const legacyStatus = timedOut && !videoId ? 'submit_timeout_unknown' : timedOut ? 'remote_submitted' : 'queued';

    const asset = store.insert('video_assets', videoAssetRecord(body, { prompt, img, audios }, {
      status: legacyStatus,
      remote_status: remoteStatus,
      local_status: localStatus,
      agnes_task_id: result.task_id,
      agnes_video_id: videoId,
      error_message: timedOut ? str(result.message) : '',
      raw_create_response: result.raw,
      request_log: Object.assign({
        started_at: startedAt,
        finished_at: now(),
      }, result.diagnostics || {}),
    }));

    if (videoId) poller.watch(asset.id, true);

    return {
      ok: true,
      asset,
      timed_out: timedOut,
      message: timedOut
        ? (videoId ? '请求超时，但已拿到 video_id，任务继续追踪' : '请求已发出但超时，未拿到 video_id')
        : '任务已提交',
      diagnostics: result.diagnostics || null,
    };
  });

  on('PUT', '/api/videos/:id', (req, res, params, body) => {
    const patch = {};
    for (const k of ['name', 'notes', 'video_url', 'error_message']) if (k in body) patch[k] = str(body[k]);
    if ('is_favorited' in body) patch.is_favorited = bool(body.is_favorited);
    const a = store.update('video_assets', params.id, patch);
    if (!a) throw httpError(404, '视频任务不存在');
    return a;
  });

  on('DELETE', '/api/videos/:id', (req, res, params) => {
    const a = store.get('video_assets', params.id);
    if (!a) throw httpError(404, '视频任务不存在');
    poller.stop(params.id);
    if (a.local_file && fs.existsSync(a.local_file)) {
      try { fs.unlinkSync(a.local_file); } catch { /* ignore */ }
    }
    store.remove('video_assets', params.id);
    return { ok: true };
  });

  on('POST', '/api/videos/:id/refresh', async (req, res, params) => {
    const a = store.get('video_assets', params.id);
    if (!a) throw httpError(404, '视频任务不存在');
    if (!a.agnes_video_id) throw httpError(400, '本地未保存 video_id，无法自动查询。如 Agnes 账单有消费记录，请先「绑定任务 ID」。');
    try {
      const merged = await poller.pollOnce(params.id);
      if (merged && ['queued', 'in_progress'].includes(merged.status)) poller.watch(params.id);
      return { ok: true, asset: merged };
    } catch (e) {
      return { ok: false, error: e.message, errorType: e.errorType || 'query_failed' };
    }
  });

  /** 手动补录 video_id：把「提交超时未知」的任务救回来 */
  on('POST', '/api/videos/:id/bind', (req, res, params, body) => {
    const vid = str(body.video_id).trim();
    if (!vid) throw httpError(400, '请填写 video_id');
    const a = store.get('video_assets', params.id);
    if (!a) throw httpError(404, '视频任务不存在');
    const merged = store.update('video_assets', params.id, {
      agnes_video_id: vid,
      local_status: 'polling',
      remote_status: 'queued',
      status: 'queued',
      error_message: '',
    });
    poller.watch(params.id, true);
    return { ok: true, asset: merged };
  });

  on('POST', '/api/videos/:id/download', async (req, res, params) => {
    const a = store.get('video_assets', params.id);
    if (!a) throw httpError(404, '视频任务不存在');
    if (!a.video_url) throw httpError(400, '还没有视频地址，无法保存');
    const dir = store.videosDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, safeName(`${a.id}`, 'mp4'));
    try {
      const r = await agnes.downloadVideo(a.video_url, file);
      const merged = store.update('video_assets', params.id, { local_file: file });
      poller.events.emit('video', merged);
      return { ok: true, asset: merged, bytes: r.bytes };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  on('POST', '/api/videos/batch-refresh', async (req, res, params, body) => {
    const targets = store.list('video_assets').filter(
      (v) => (v.status === 'completed' || v.status === 'video_url_missing') && !v.video_url && v.agnes_video_id,
    );
    let found = 0;
    for (const v of targets) {
      try {
        const merged = await poller.pollOnce(v.id);
        if (merged && merged.video_url) found++;
      } catch { /* 单条失败继续 */ }
    }
    return { ok: true, total: targets.length, found };
  });

  // ================= 生成任务历史 =================
  on('GET', '/api/tasks', (req, res, params, body, query) => {
    const type = query.task_type;
    return store.list('generation_tasks', {
      filter: (r) => (type ? r.task_type === type : true),
      limit: query.limit ? Number(query.limit) : 300,
    });
  });

  on('POST', '/api/tasks', (req, res, params, body) => {
    return store.insert('generation_tasks', {
      project_id: str(body.project_id) || null,
      storyboard_id: body.storyboard_id || null,
      task_type: str(body.task_type || 'text'),
      model_name: str(body.model_name),
      input_content: body.input_content || {},
      input_images: Array.isArray(body.input_images) ? body.input_images : [],
      output_result: body.output_result || null,
      status: str(body.status || 'completed'),
      error_message: str(body.error_message),
      is_favorited: false,
      notes: str(body.notes),
      seed: body.seed != null ? num(body.seed, 0) : null,
      completed_at: now(),
    });
  });

  on('PUT', '/api/tasks/:id', (req, res, params, body) => {
    const patch = {};
    for (const k of ['notes', 'status']) if (k in body) patch[k] = str(body[k]);
    if ('is_favorited' in body) patch.is_favorited = bool(body.is_favorited);
    const t = store.update('generation_tasks', params.id, patch);
    if (!t) throw httpError(404, '任务不存在');
    return t;
  });

  on('DELETE', '/api/tasks/:id', (req, res, params) => {
    if (!store.remove('generation_tasks', params.id)) throw httpError(404, '任务不存在');
    return { ok: true };
  });

  // ================= 提示词模板 =================
  on('GET', '/api/templates', (req, res, params, body, query) => {
    const type = query.template_type;
    return store.list('prompt_templates', {
      filter: (r) => (type ? r.template_type === type : true),
      sort: (a, b) => String(a.template_type).localeCompare(String(b.template_type))
        || String(a.name).localeCompare(String(b.name)),
    });
  });

  on('POST', '/api/templates', (req, res, params, body) => {
    if (!str(body.name).trim()) throw httpError(400, '模板名称不能为空');
    return store.insert('prompt_templates', {
      name: str(body.name),
      template_type: str(body.template_type || 'story_concept'),
      system: str(body.system),
      content: str(body.content),
      negative_prompt: str(body.negative_prompt),
      is_favorited: bool(body.is_favorited),
      is_builtin: false,
      notes: str(body.notes),
    });
  });

  on('PUT', '/api/templates/:id', (req, res, params, body) => {
    const patch = {};
    for (const k of ['name', 'template_type', 'system', 'content', 'negative_prompt', 'notes']) {
      if (k in body) patch[k] = str(body[k]);
    }
    if ('is_favorited' in body) patch.is_favorited = bool(body.is_favorited);
    const t = store.update('prompt_templates', params.id, patch);
    if (!t) throw httpError(404, '模板不存在');
    return t;
  });

  on('DELETE', '/api/templates/:id', (req, res, params) => {
    if (!store.remove('prompt_templates', params.id)) throw httpError(404, '模板不存在');
    return { ok: true };
  });

  // ================= Agnes 调用 =================
  on('POST', '/api/agnes/text', async (req, res, params, body) => {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) throw httpError(400, 'messages 不能为空');
    const startedAt = now();
    try {
      const r = await agnes.chat(messages, {
        model: str(body.model) || undefined,
        temperature: body.temperature != null ? num(body.temperature, 0.7) : 0.7,
        timeoutMs: num(body.timeout_ms, 120000),
      });
      // 文本生成也留一条任务记录，任务页才有完整历史
      store.insert('generation_tasks', {
        project_id: str(body.project_id) || null,
        storyboard_id: body.storyboard_id || null,
        task_type: 'text',
        model_name: str(body.model) || store.getSettings().default_text_model,
        input_content: { messages },
        input_images: [],
        output_result: { content: r.content },
        status: 'completed',
        error_message: '',
        is_favorited: false,
        notes: str(body.note),
        seed: null,
        completed_at: now(),
      });
      return { ok: true, content: r.content, diagnostics: r.diagnostics, started_at: startedAt };
    } catch (e) {
      store.insert('generation_tasks', {
        project_id: str(body.project_id) || null,
        task_type: 'text',
        model_name: str(body.model) || store.getSettings().default_text_model,
        input_content: { messages },
        input_images: [],
        output_result: null,
        status: 'failed',
        error_message: e.message,
        is_favorited: false,
        notes: '',
        seed: null,
        completed_at: now(),
      });
      return { ok: false, error: e.message, errorType: e.errorType || 'text_failed' };
    }
  });

  on('POST', '/api/agnes/image', async (req, res, params, body) => {
    const prompt = str(body.prompt).trim();
    if (!prompt) throw httpError(400, '图片提示词不能为空');
    const size = str(body.size || '1024x1024');
    const [w, h] = size.split('x').map((n) => Number(n) || 1024);
    const model = str(body.model) || store.getSettings().default_image_model;

    try {
      const r = await agnes.image({
        prompt, model, size,
        image: body.image || undefined,
      });

      let localUrl = '';
      let localFile = '';
      let remoteUrl = r.url || '';

      if (r.b64) {
        const saved = saveImageBase64(r.b64, r.mime);
        localFile = saved.file;
        localUrl = saved.url;
      } else if (r.url) {
        // 远端 URL 会过期，默认抓一份到本地；抓不到就退回用远端地址
        const saved = await fetchRemoteImage(r.url);
        if (saved) { localFile = saved.file; localUrl = saved.url; }
      }

      if (!localUrl && !remoteUrl) throw httpError(502, '图片生成失败：Agnes 未返回图片数据');

      const asset = store.insert('image_assets', {
        project_id: str(body.project_id) || null,
        storyboard_id: body.storyboard_id || null,
        name: str(body.name) || `图片_${Date.now()}`,
        url: localUrl || remoteUrl,
        remote_url: remoteUrl,
        local_file: localFile,
        usage_type: str(body.usage_type || 'storyboard'),
        generation_prompt: prompt,
        model_name: model,
        width: num(body.width, w),
        height: num(body.height, h),
        size,
        source_task_id: null,
        is_favorited: false,
        notes: str(body.notes),
        tags: [],
      });

      if (body.storyboard_id) {
        store.update('storyboards', body.storyboard_id, {
          linked_image_id: asset.id,
          status: 'image_ready',
        });
      }

      store.insert('generation_tasks', {
        project_id: str(body.project_id) || null,
        storyboard_id: body.storyboard_id || null,
        task_type: 'image',
        model_name: model,
        input_content: { prompt, size, image: body.image || null },
        input_images: body.image ? [body.image] : [],
        output_result: { url: asset.url },
        status: 'completed',
        error_message: '',
        is_favorited: false,
        notes: '',
        seed: null,
        completed_at: now(),
      });

      return { ok: true, asset };
    } catch (e) {
      if (e.statusCode) throw e;
      store.insert('generation_tasks', {
        project_id: str(body.project_id) || null,
        task_type: 'image',
        model_name: model,
        input_content: { prompt, size },
        input_images: body.image ? [body.image] : [],
        output_result: null,
        status: 'failed',
        error_message: e.message,
        is_favorited: false,
        notes: '',
        seed: null,
        completed_at: now(),
      });
      return { ok: false, error: e.message, errorType: e.errorType || 'image_failed' };
    }
  });

  // ================= 批量任务 =================
  /**
   * 批量生图：body = { items: [{storyboard_id, prompt, size, usage_type, project_id}], concurrency }
   * 返回 jobId，进度通过 SSE 的 batch 事件推给前端。
   */
  on('POST', '/api/batch/images', (req, res, params, body) => {
    const items = Array.isArray(body.items) ? body.items.filter((i) => str(i.prompt).trim()) : [];
    if (!items.length) throw httpError(400, '没有要生成的图片（提示词为空）');
    const job = jobs.create('images', items.length);

    // 异步跑，接口立刻返回
    (async () => {
      await jobs.run(job, items, async (item) => {
        const r = await fetchInternal('POST', '/api/agnes/image', {
          prompt: item.prompt,
          size: item.size || '1024x1024',
          usage_type: item.usage_type || 'storyboard',
          project_id: item.project_id || null,
          storyboard_id: item.storyboard_id || null,
          model: item.model || undefined,
        });
        if (!r || r.ok === false) return { ok: false, error: r?.error || '生成失败' };
        return { ok: true, id: r.asset?.id };
      }, {
        concurrency: num(body.concurrency, store.getSettings().default_concurrent_tasks),
        onProgress: (j) => poller.events.emit('batch', j),
      });
      jobs.prune();
    })();

    return { ok: true, jobId: job.id, total: job.total };
  });

  on('POST', '/api/batch/videos', (req, res, params, body) => {
    const items = Array.isArray(body.items) ? body.items.filter((i) => str(i.prompt).trim()) : [];
    if (!items.length) throw httpError(400, '没有要生成的视频（提示词为空）');
    const job = jobs.create('videos', items.length);

    (async () => {
      await jobs.run(job, items, async (item) => {
        const r = await fetchInternal('POST', '/api/videos', item);
        if (!r || r.ok === false) return { ok: false, error: r?.error || '提交失败' };
        return { ok: true, id: r.asset?.id };
      }, {
        concurrency: num(body.concurrency, 1), // 视频默认串行提交，避免重复扣费
        intervalMs: num(body.interval_ms, Number(store.getSettings().video_submit_interval_ms) || 0),
        onProgress: (j) => poller.events.emit('batch', j),
      });
      jobs.prune();
    })();

    return { ok: true, jobId: job.id, total: job.total };
  });

  on('GET', '/api/batch/:id', (req, res, params) => {
    const job = jobs.get(params.id);
    if (!job) throw httpError(404, '任务不存在');
    return job;
  });

  on('POST', '/api/batch/:id/cancel', (req, res, params) => {
    if (!jobs.cancel(params.id)) throw httpError(404, '任务不存在');
    return { ok: true };
  });

  on('GET', '/api/batch', () => jobs.list());

  // ================= 导入导出 =================
  on('GET', '/api/export', (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="agnes-studio-backup-${now().slice(0, 10)}.json"`);
    return { raw: JSON.stringify(store.exportAll(), null, 2) };
  });

  on('POST', '/api/import', (req, res, params, body) => {
    const mode = str(body.mode || 'merge');
    if (!['merge', 'replace'].includes(mode)) throw httpError(400, '导入模式只能是 merge 或 replace');
    try {
      const r = store.importAll(body.data || body, mode);
      return {
        ok: true,
        imported: r.added,
        skipped: r.skipped,
        // 有被跳过的行要明确告诉用户：静默丢弃等于数据莫名少了
        warning: r.skipped.length ? `${r.skipped.length} 行数据不合法已跳过` : '',
        stats: store.stats(),
      };
    } catch (e) {
      throw httpError(400, `导入失败：${e.message}`);
    }
  });

  // ================= 日志 =================
  on('GET', '/api/logs', () => poller.log.slice(0, 100));

  /**
   * 把请求里的本地图片地址换成 Agnes 能抓的公网地址。
   * 公网地址原样放过；本地地址走图床；没配图床就明确报错——
   * 不能悄悄把无效参数发给 Agnes，那样用户只会看到一个看不懂的失败。
   */
  async function publicizeImages(body) {
    const out = { image: '', source_images: null };
    if (body.image) out.image = await toPublicImageUrl(body.image);
    if (Array.isArray(body.source_images) && body.source_images.length) {
      const list = [];
      for (const im of body.source_images) {
        const raw = im && typeof im === 'object' ? (im.url || '') : String(im || '');
        const pub = await toPublicImageUrl(raw);
        list.push(im && typeof im === 'object' ? Object.assign({}, im, { url: pub }) : pub);
      }
      out.source_images = list;
    }
    return out;
  }

  /**
   * Video 2.5 的素材上限：图片 8 / 音频 3 / 视频 1 / 合计 12。
   * 这些限制只存在于 2.5 的契约里，2.0 没查到明确约束，所以只对 2.5 生效。
   */
  function assertMediaLimits(model, img, audios) {
    if (!agnes.isVideo25(model)) return;
    const L = agnes.MEDIA_LIMITS_25;
    const imgs = img.source_images && img.source_images.length
      ? img.source_images.length
      : (img.image ? 1 : 0);
    // 参考视频目前只走高级参数通道，界面不发，这里按 0 计
    if (imgs > L.images) throw httpError(400, `参考图片最多 ${L.images} 张（Agnes 2.5 限制），现在有 ${imgs} 张。`);
    if (audios.length > L.audios) throw httpError(400, `参考音频最多 ${L.audios} 段（Agnes 2.5 限制），现在有 ${audios.length} 段。`);
    const total = imgs + audios.length;
    if (total > L.total) {
      throw httpError(400, `素材总数最多 ${L.total} 个（Agnes 2.5 限制），现在是 ${imgs} 张图 + ${audios.length} 段音频 = ${total} 个。`);
    }
  }

  /**
   * 音频参考（Agnes 2.5 的 audios 字段）也要是公网地址。
   * 公网 URL 原样放过；本地路径只有配了「自定义」图床才可能传上去——
   * imgbb / SM.MS 这类图片图床收不了音频，imagehost 里会直接说明原因。
   */
  async function publicizeAudios(body) {
    const raw = Array.isArray(body.audios) ? body.audios : (body.audio ? [body.audio] : []);
    const out = [];
    for (const a of raw) {
      const s = String(a || '').trim();
      if (!s) continue;
      out.push(await toPublicAudioUrl(s));
      if (out.length >= 3) break;   // Agnes 2.5 上限 3 段
    }
    if (raw.filter((a) => String(a || '').trim()).length > 3) {
      throw httpError(400, '音频最多 3 段（Agnes 2.5 限制），只保留前 3 段请删掉多余的。');
    }
    return out;
  }

  async function toPublicAudioUrl(u) {
    const s = String(u || '').trim();
    if (/^https?:\/\//i.test(s)) return s;

    if (!imagehost.isConfigured()) {
      throw httpError(400, '音频只有本机地址，Agnes 抓不到。请填公网音频 URL，或在「设置 → 图床」配置一个支持音频的自定义图床。');
    }
    return imagehost.resolvePublicUrl(s, 'audio');
  }

  async function toPublicImageUrl(u) {
    const s = String(u || '').trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;

    const local = imagehost.localPathFromAssetUrl(s);
    const asset = store.list('image_assets').find((a) => a.url === s || (local && a.local_file === local));

    // 这张素材之前传过就直接用，不重复上传——图床有额度，重复传既慢又浪费
    if (asset && /^https?:\/\//i.test(asset.remote_url || '')) return asset.remote_url;

    if (!imagehost.isConfigured()) {
      throw httpError(400, '这张图只有本机地址，Agnes 抓不到。请到「设置 → 图床」配置一个免费图床，或改用公网图片 URL。');
    }
    if (store.getSettings().auto_upload_image !== '1') {
      throw httpError(400, '已关闭「自动上传本地图片」。请到「素材库」给图片填公网 URL，或在「设置 → 图床」重新开启自动上传。');
    }
    const url = await imagehost.resolvePublicUrl(s);
    if (asset && asset.remote_url !== url) store.update('image_assets', asset.id, { remote_url: url });
    return url;
  }

  // ── 内部调用（避免批量任务里自己 fetch 自己） ──────────────
  async function fetchInternal(method, url, payload) {
    const route = routes.find((r) => r.method === method && r.pattern === url);
    if (!route) throw new Error(`内部路由不存在: ${method} ${url}`);
    return await route.handler({}, null, {}, payload || {}, {});
  }

  function httpError(status, message) {
    const e = new Error(message);
    e.statusCode = status;
    return e;
  }

  /** 匹配并执行；返回 undefined 表示没匹配到 */
  function dispatch(method, pathname, body, query, req, res) {
    for (const r of routes) {
      const params = match(pathname, r.pattern);
      if (!params) continue;
      if (r.method !== method) continue;
      return r.handler(req, res, params, body || {}, query || {});
    }
    return undefined;
  }

  return { dispatch, httpError, saveImageBase64, fetchRemoteImage, safeName, refreshModels };
};
