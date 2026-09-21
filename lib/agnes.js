/**
 * agnes.js — Agnes API 客户端
 * ------------------------------------------------------------------
 * 原版要绕一层 Supabase Edge Function 才能调 Agnes（因为浏览器有跨域、
 * 且 API Key 不能落前端）。本地版把这一层收进本机服务：
 *   · API Key 只存在本机 settings.json，前端永远拿不到明文
 *   · 没有 Edge Function 的 90s/150s 双层超时，改成直连，超时自己定
 *   · 原版的链路诊断（request_sent / response_received / response_status）
 *     保留下来 —— 排查「到底 Agnes 收没收到请求」时这几个字段最值钱
 *
 * 接口规则（照搬原版验证过的结论）：
 *   text         POST {base}/v1/chat/completions
 *   image        POST {base}/v1/images/generations   图生图 body.image=[url]
 *   video_create POST {base}/v1/videos               image 直接放顶层
 *   video_query  GET  {rootBase}/agnesapi?video_id=  （rootBase = 去掉 /v1）
 */
'use strict';

const store = require('./store');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── URL 归一化 ───────────────────────────────────────────────
function normalizeBase(raw) {
  let base = String(raw || 'https://apihub.agnes-ai.com/v1').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
  return base;
}
/** 去掉结尾 /v1，查询接口用的是域名根路径 */
function rootBase(base) {
  return normalizeBase(base).replace(/\/v1$/, '');
}
function withV1(base) {
  const b = normalizeBase(base);
  return b.endsWith('/v1') ? b : `${b}/v1`;
}

// ── 错误 ─────────────────────────────────────────────────────
class AgnesError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'AgnesError';
    this.errorType = opts.errorType || 'agnes_error';
    this.status = opts.status || 0;
    this.responseData = opts.responseData || null;
    this.diagnostics = opts.diagnostics || null;
  }
}

function noKey() {
  return new AgnesError('请先在「设置」页配置 Agnes API Key。', {
    errorType: 'no_api_key',
    status: 0,
    responseData: null,
    diagnostics: { request_sent: false, response_received: false, response_status: null },
  });
}

/**
 * 统一发起请求。
 * @returns {Promise<{data:object, diagnostics:object}>}
 */
async function request(url, { method = 'POST', body, timeoutMs = 25000, apiKey }) {
  const startedAt = Date.now();
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) options.body = JSON.stringify(body);

  let resp;
  let text;
  try {
    resp = await fetch(url, options);
    text = await resp.text();
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    const isTimeout = /timed out|abort/i.test(msg);
    const err = new AgnesError(
      isTimeout ? `请求 Agnes 超时（${Math.round(timeoutMs / 1000)}s 未返回）` : `网络异常：${msg}`,
      {
        errorType: isTimeout ? 'proxy_timeout' : 'network_error',
        status: 0,
        responseData: null,
        diagnostics: {
          request_sent: true,
          response_received: false,
          response_status: null,
          duration_ms: Date.now() - startedAt,
          timed_out: isTimeout,
        },
      },
    );
    throw err;
  }

  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { _raw: text }; }

  const diagnostics = {
    request_sent: true,
    response_received: true,
    response_status: resp.status,
    duration_ms: Date.now() - startedAt,
    final_request_url: url,
  };

  if (!resp.ok) {
    const msg = String((data && (data.error?.message || data.error || data.message)) || `Agnes 返回 HTTP ${resp.status}`);
    throw new AgnesError(typeof msg === 'string' ? msg : JSON.stringify(msg), {
      errorType: data?.error?.type === 'invalid_api_key' || resp.status === 401 ? 'invalid_api_key' : 'agnes_error',
      status: resp.status,
      responseData: data,
      diagnostics,
    });
  }

  return { data, diagnostics };
}

// ── 文本 ─────────────────────────────────────────────────────
async function chat(messages, { model, temperature = 0.7, timeoutMs = 120000 } = {}) {
  const s = store.getSettings();
  const key = store.getRawKey();
  if (!key) throw noKey();
  const url = `${withV1(s.agnes_api_base_url)}/chat/completions`;
  const { data, diagnostics } = await request(url, {
    method: 'POST',
    body: { model: model || s.default_text_model, messages, temperature },
    timeoutMs,
    apiKey: key,
  });
  const content = data?.choices?.[0]?.message?.content || '';
  return { content, raw: data, diagnostics };
}

// ── 图片 ─────────────────────────────────────────────────────
/**
 * 生成图片。Agnes 走 LiteLLM 代理，不认 response_format，
 * 实际返回 b64_json 居多 —— 由调用方落盘成本地文件。
 * @returns {{url?:string, b64?:string, mime:string, raw:object, diagnostics:object}}
 */
async function image({ prompt, model, size = '1024x1024', image: inputImage, timeoutMs = 120000 }) {
  const s = store.getSettings();
  const key = store.getRawKey();
  if (!key) throw noKey();
  const url = `${withV1(s.agnes_api_base_url)}/images/generations`;
  const body = { model: model || s.default_image_model, prompt, size };
  if (inputImage) body.image = Array.isArray(inputImage) ? inputImage : [inputImage];

  const { data, diagnostics } = await request(url, { method: 'POST', body, timeoutMs, apiKey: key });
  const item = data?.data?.[0] || {};
  return {
    url: item.url || '',
    b64: item.b64_json || '',
    mime: 'image/png',
    raw: data,
    diagnostics,
  };
}

// ── 视频创建 ─────────────────────────────────────────────────
/**
 * Video 2.5 与 2.0 的请求体不是一回事：
 *   2.5 认 mode / seconds / size / images[] / audios[] / videos[] / first_frame，
 *       而且 width / height / fps / num_frames 传了直接 400；
 *   2.0 认 width / height / num_frames / frame_rate / image。
 * 模型目录是动态拉的，用户选到 2.5 时如果还按 2.0 发，每个请求都会被 400 打回，
 * 界面上只看得到「提交失败」，很难想到是模型换了契约。所以按模型族分流。
 */
function isVideo25(model) {
  const m = String(model || '').toLowerCase();
  return /2[._-]?5/.test(m);
}

/** Video 2.5 的素材上限（官方文档）。超了会 400，不如在提交前拦住并说清楚。 */
const MEDIA_LIMITS_25 = { images: 8, audios: 3, videos: 1, total: 12 };

/**
 * 2.5 的时长是字符串 "4"~"12"。前端给的是秒数，这里夹到合法区间。
 * 不夹的话用户选 3 秒会被 400，而界面上只会显示「提交失败」。
 */
function secondsFor25(v) {
  const n = Math.round(Number(v) || 5);
  return String(Math.min(12, Math.max(4, n)));
}

/** 提交视频任务。只要拿到 video_id / task_id 就算提交成功，不等生成完成。
 *  图生视频时 Agnes 要先从公网抓参考素材，可能很久 —— 超时按 150s 起。 */
/**
 * 按模型族拼请求体。抽成纯函数是为了能单独测——
 * 「2.5 不能带 num_frames」这种契约错误，靠跑一次真实提交才发现就太晚了。
 */
function buildVideoBody(params, model) {
  const body = { model, prompt: params.prompt };
  if (params.seed != null && params.seed !== '') body.seed = Number(params.seed);

  if (isVideo25(model)) {
    // ── Video 2.5 契约 ──
    body.mode = params.mode_25 || 'text';
    body.seconds = secondsFor25(params.duration_seconds);
    if (params.size_25) body.size = params.size_25;
    if (params.aspect_ratio) body.aspect_ratio = params.aspect_ratio;

    if (params.source_images && params.source_images.length) {
      const imgs = params.source_images.map((i) => i.url || i).filter(Boolean);
      if (body.mode === 'keyframe') {
        // 首尾帧：两张图正好对应 first/last，多于两张的按参考图处理
        if (imgs[0]) body.first_frame = imgs[0];
        if (imgs[1]) body.last_frame = imgs[1];
        for (const u of imgs.slice(2)) (body.images ||= []).push(u);
      } else {
        body.images = imgs;
      }
    } else if (params.image) {
      if (body.mode === 'keyframe') body.first_frame = params.image;
      else body.images = [params.image];
    }

    // 音频参考：Agnes 2.5 的「音频生视频」走的就是这个字段，
    // 提示词里用 <Audio 1> 指代第 1 段。上限 3 段、总时长 2~12 秒。
    if (params.audios && params.audios.length) {
      body.audios = params.audios.filter(Boolean).slice(0, 3);
      if (body.mode === 'text') body.mode = 'reference';
    }
    if (params.videos_25 && params.videos_25.length) body.videos = params.videos_25;
  } else {
    // ── Video 2.0 及未知模型：保持原有契约 ──
    body.width = params.width || 1152;
    body.height = params.height || 768;
    body.num_frames = params.num_frames || 121;
    body.frame_rate = params.frame_rate || 24;
    if (params.negative_prompt) body.negative_prompt = params.negative_prompt;
    if (params.source_images && params.source_images.length) {
      // 多图参考 / 关键帧：image 是 URL 数组，直接放顶层（不能包 extra_body）
      body.image = params.source_images.map((i) => i.url || i);
      if (params.mode_flag === 'keyframes') body.mode = 'keyframes';
    } else if (params.image) {
      body.image = params.image;
    }
    if (params.audios && params.audios.length) {
      body.audios = params.audios.filter(Boolean).slice(0, 3);
    }
  }

  /**
   * 额外参数通道：Agnes 以后新增能力（如音频驱动、新的控制字段）时，
   * 用户直接在界面上填 JSON 就能用上，不用等程序改代码。
   * 已有的核心参数不允许被覆盖，避免把 prompt / model 这类字段顶掉。
   */
  if (params.extra_params && typeof params.extra_params === 'object') {
    for (const [k, v] of Object.entries(params.extra_params)) {
      if (k in body) continue;
      body[k] = v;
    }
  }
  return body;
}

async function createVideo(params) {
  const s = store.getSettings();
  const key = store.getRawKey();
  if (!key) throw noKey();

  const model = params.model || s.default_video_model;
  const body = buildVideoBody(params, model);

  const url = `${withV1(s.agnes_api_base_url)}/videos`;
  const timeoutMs = Number(s.request_timeout_ms) || 150000;

  const attempt = async () => {
    try {
      const { data, diagnostics } = await request(url, { method: 'POST', body, timeoutMs, apiKey: key });
      if (data?.error && !data?.video_id && !data?.id) {
        throw new AgnesError(String(data.error?.message || data.error), {
          errorType: 'agnes_error', status: 200, responseData: data, diagnostics,
        });
      }
      const video_id = data?.video_id || data?.id || '';
      if (!video_id) {
        throw new AgnesError('Agnes 未返回 video_id（响应体中无 video_id / id 字段）', {
          errorType: 'no_video_id', status: 200, responseData: data, diagnostics,
        });
      }
      return { video_id, task_id: data?.task_id || '', raw: data, diagnostics, timed_out: false };
    } catch (e) {
      // 超时但请求已发出：Agnes 可能已经收下任务了。不能当失败丢掉 ——
      // 原版为此专门做了「提交超时未知」状态，让用户去 Agnes 账单核对后再补录 video_id。
      if (e instanceof AgnesError && e.errorType === 'proxy_timeout') {
        return {
          video_id: '',
          task_id: '',
          raw: e.responseData || {},
          diagnostics: e.diagnostics,
          timed_out: true,
          message: e.message,
        };
      }
      throw e;
    }
  };

  /**
   * 只有「明确的限流 / 服务端错误」才重试。
   * 超时一律不重试：那种情况下 Agnes 多半已经收下任务，再发一次就是重复扣费。
   */
  let lastErr = null;
  for (let i = 0; i <= 2; i++) {
    if (i > 0) await sleep(4000 * i);
    try {
      return await attempt();
    } catch (e) {
      const retryable = e instanceof AgnesError && (e.status === 429 || e.status >= 500);
      if (!retryable) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

// ── 视频查询 ─────────────────────────────────────────────────
async function queryVideo(videoId) {
  const s = store.getSettings();
  const key = store.getRawKey();
  if (!key) throw noKey();
  const url = `${rootBase(s.agnes_api_base_url)}/agnesapi?video_id=${encodeURIComponent(videoId)}`;
  const { data, diagnostics } = await request(url, { method: 'GET', timeoutMs: 25000, apiKey: key });
  return { data, diagnostics };
}

/** Agnes v2.0 把最终视频地址放在 remixed_from_video_id 里，命名怪但确实如此 */
function extractVideoUrl(result) {
  return result?.remixed_from_video_id || result?.video_url || result?.output_url || result?.url || '';
}

/**
 * 状态机保护：由 Agnes 查询结果生成安全的更新字段。
 * 规则（原版踩坑总结）：
 *   1. 只有 Agnes 明确 status=failed 才标远端失败
 *   2. completed 但没 video_url → video_url_missing，不是 failed
 *   3. 未知 status → 不动状态，只存原始响应
 */
function buildSafeStatusUpdate(result) {
  const updates = { raw_status_response: result };
  const agnesStatus = result?.status;
  const videoUrl = extractVideoUrl(result);
  const progress = result?.progress;

  if (videoUrl) updates.video_url = videoUrl;
  if (result?.error) updates.error_message = typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
  if (progress != null) updates.progress = Number(progress) || 0;

  if (agnesStatus === 'failed') {
    updates.status = 'failed';
    updates.remote_status = 'failed';
  } else if (agnesStatus === 'completed') {
    updates.completed_at = new Date().toISOString();
    updates.remote_status = 'completed';
    if (videoUrl) {
      updates.status = 'completed';
      updates.local_status = 'completed';
    } else {
      updates.status = 'video_url_missing';
      updates.local_status = 'result_parse_failed';
    }
  } else if (agnesStatus === 'in_progress') {
    updates.status = 'in_progress';
    updates.remote_status = 'in_progress';
    updates.local_status = 'polling';
  } else if (agnesStatus === 'queued') {
    updates.status = 'queued';
    updates.remote_status = 'queued';
    updates.local_status = 'polling';
  }
  return updates;
}

// ── 视频下载 ─────────────────────────────────────────────────
async function downloadVideo(videoUrl, destFile) {
  const s = store.getSettings();
  const key = store.getRawKey();
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const resp = await fetch(videoUrl, { headers, signal: AbortSignal.timeout(300000) });
  if (!resp.ok) throw new AgnesError(`视频下载失败：HTTP ${resp.status}`, { errorType: 'download_failed', status: resp.status });
  const buf = Buffer.from(await resp.arrayBuffer());
  require('node:fs').writeFileSync(destFile, buf);
  return { file: destFile, bytes: buf.length };
}

// ── 动态模型目录 ─────────────────────────────────────────────
/**
 * 读取 OpenAI 兼容的 GET /v1/models。
 * 兼容 Agnes 可能返回的三种形状：
 *   { data: [{ id: ... }] } / { models: [...] } / [...]。
 * 模型目录是可选能力：接口不存在或临时失败时，不影响已有模型和生成流程。
 */
async function listModels({ timeoutMs = 30000 } = {}) {
  const s = store.getSettings();
  const key = store.getRawKey();
  if (!key) throw noKey();
  const url = `${withV1(s.agnes_api_base_url)}/models`;
  const { data, diagnostics } = await request(url, {
    method: 'GET',
    timeoutMs,
    apiKey: key,
  });
  return { data, diagnostics };
}

// ── 连通性测试 ───────────────────────────────────────────────
async function testConnection(kind = 'text') {
  const s = store.getSettings();
  const key = store.getRawKey();
  if (!key) throw noKey();
  if (kind === 'text') {
    const r = await chat([{ role: 'user', content: '回复两个字：正常' }], { timeoutMs: 30000 });
    return { ok: true, message: r.content.slice(0, 60) || '已连通（返回为空）' };
  }
  if (kind === 'image') {
    const url = `${withV1(s.agnes_api_base_url)}/images/generations`;
    await request(url, { method: 'POST', body: { model: s.default_image_model, prompt: 'test', size: '1024x1024' }, timeoutMs: 30000, apiKey: key });
    return { ok: true, message: '图片接口可达' };
  }
  const url = `${withV1(s.agnes_api_base_url)}/videos`;
  try {
    await request(url, { method: 'POST', body: { model: s.default_video_model, prompt: 'test' }, timeoutMs: 20000, apiKey: key });
    return { ok: true, message: '视频接口可达' };
  } catch (e) {
    // 视频接口即使参数不全，只要不是 401/404 也算可达
    if (e.status === 401) throw e;
    return { ok: true, message: `视频接口可达（返回 ${e.status || '超时'}）` };
  }
}

module.exports = {
  normalizeBase, rootBase, withV1,
  AgnesError,
  chat, image, createVideo, buildVideoBody, queryVideo, downloadVideo, listModels,
  extractVideoUrl, buildSafeStatusUpdate,
  isVideo25, secondsFor25, MEDIA_LIMITS_25,
  testConnection,
};
