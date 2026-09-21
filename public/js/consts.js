/**
 * consts.js — 图标、枚举、状态标签、小工具
 * 图标用内联 SVG（Lucide 线性风格），不引外部库 —— 断网也能正常显示。
 */

const P = (d) => `<path d="${d}"/>`;

/** Lucide 风格图标集（24×24，stroke） */
const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  script: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h6"/><path d="M8 13h8"/><path d="M8 17h5"/>',
  film: '<rect x="2" y="2" width="20" height="20" rx="2.18"/><path d="M7 2v20"/><path d="M17 2v20"/><path d="M2 12h20"/><path d="M2 7h5"/><path d="M2 17h5"/><path d="M17 17h5"/><path d="M17 7h5"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  video: '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  tasks: '<path d="M3 6h13"/><path d="M3 12h13"/><path d="M3 18h13"/><path d="m18 9 2 2 4-4"/><path d="m18 15 2 2 4-4"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  star: '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.71a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 10.695a.53.53 0 0 1 .294-.904l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  wand: '<path d="m3 21 9-9"/><path d="M15 4V2"/><path d="M15 16v-2"/><path d="M8 9h2"/><path d="M20 9h2"/><path d="M17.8 11.8 19 13"/><path d="M15 9h0"/><path d="M17.8 6.2 19 5"/><path d="m3 21 3-3"/><path d="M12.2 6.2 11 5"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  save: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>',
  sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/><path d="M5 3v4"/><path d="M3 5h4"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  zap: '<path d="M4 14h7l-2 7 11-11h-7l2-7z"/>',
  layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m6.08 9.5-3.5 1.6a1 1 0 0 0 0 1.81l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9a1 1 0 0 0 0-1.83l-3.5-1.59"/><path d="m6.08 14.5-3.5 1.6a1 1 0 0 0 0 1.81l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9a1 1 0 0 0 0-1.83l-3.5-1.59"/>',
  chevronUp: '<path d="m18 15-6-6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
  play: '<path d="m6 3 14 9-14 9z"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  grip: '<circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  fileText: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h6"/><path d="M8 12h8"/><path d="M8 16h8"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2"/><path d="M9 2v2"/><path d="M15 20v2"/><path d="M9 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  key: '<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
  template: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
};

/** 生成图标 SVG */
export function icon(name, size = 18, cls = '') {
  const d = ICONS[name] || ICONS.info;
  return `<svg class="${cls}" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
}

// ── 枚举 ────────────────────────────────────────────────────
export const PROJECT_TYPES = ['爽文漫剧', '悬疑漫剧', '都市逆袭', '末世生存', '奇幻冒险', '科幻脑洞', '情绪故事', '短篇条漫动态化', '自定义'];
export const PLATFORMS = ['抖音', '快手', '视频号', '小红书', 'B站', 'YouTube Shorts', 'TikTok', '横版视频', '自定义'];
export const ASPECTS = ['9:16 竖屏', '16:9 横屏', '1:1 方形', '3:4 竖版', '4:3 横版'];
export const SHOT_TYPES = ['远景', '全景', '中景', '近景', '特写', '极特写', '俯拍', '仰拍'];
export const IMAGE_SIZES = [
  { label: '横版 1024×768', value: '1024x768', w: 1024, h: 768 },
  { label: '竖版 768×1024', value: '768x1024', w: 768, h: 1024 },
  { label: '方形 1024×1024', value: '1024x1024', w: 1024, h: 1024 },
  { label: '宽屏 1280×720', value: '1280x720', w: 1280, h: 720 },
  { label: '竖屏 720×1280', value: '720x1280', w: 720, h: 1280 },
];
export const VIDEO_RESOLUTIONS = [
  { label: '1152×768 横版', w: 1152, h: 768 },
  { label: '768×1152 竖版', w: 768, h: 1152 },
  { label: '1024×1024 方形', w: 1024, h: 1024 },
];
export const DURATION_PRESETS = [
  { label: '约 3 秒', frames: 81 },
  { label: '约 5 秒', frames: 121 },
  { label: '约 10 秒', frames: 241 },
  { label: '约 18 秒', frames: 441 },
];
export const IMAGE_USAGES = [
  { value: 'storyboard', label: '分镜图' },
  { value: 'character', label: '角色图' },
  { value: 'scene', label: '场景图' },
  { value: 'prop', label: '道具图' },
  { value: 'style_test', label: '风格测试' },
  { value: 'reference', label: '参考图' },
];
export const IMAGE_ROLES = ['角色参考', '场景参考', '风格参考', '起始画面', '目标画面', '道具参考'];
export const VIDEO_MODES = [
  { id: 't2v', label: '文生视频', mode: 'text_to_video' },
  { id: 'i2v', label: '图生视频', mode: 'image_to_video' },
  { id: 'multi', label: '多图参考', mode: 'multi_image' },
  { id: 'keyframe', label: '关键帧动画', mode: 'keyframe' },
  { id: 'audio', label: '音频生视频', mode: 'audio_reference' },
];

/**
 * Agnes Video 2.5 的请求契约和 2.0 不一样：
 * 2.5 认 mode / seconds / size / images[] / audios[]，
 * 而且 width / height / fps / num_frames 传了直接 400。
 * 模型目录是动态拉的，选中 2.5 时界面和请求体都要跟着换，
 * 所以判断逻辑放这里，前后端共用同一套规则。
 */
export function isVideo25(model) {
  return /2[._-]?5/.test(String(model || '').toLowerCase());
}

/** 2.5 的时长参数是字符串 "4"~"12" 秒，超出会被 400 */
export function secondsFor25(v) {
  const n = Math.round(Number(v) || 5);
  return String(Math.min(12, Math.max(4, n)));
}

/** 2.5 用 size 档位而不是 width/height（传 width/height 会 400） */
export const VIDEO_SIZES_25 = [
  { value: '720P', label: '720P' },
  { value: '1080P', label: '1080P' },
  { value: '1K', label: '1K' },
  { value: '2K', label: '2K' },
];

/** 2.5 用 aspect_ratio 表达画幅 */
export const VIDEO_ASPECTS_25 = [
  { value: '16:9', label: '16:9 横屏' },
  { value: '9:16', label: '9:16 竖屏' },
  { value: '1:1', label: '1:1 方形' },
  { value: '4:3', label: '4:3' },
  { value: '3:4', label: '3:4' },
];

/** 2.5 时长档位：与 DURATION_PRESETS 的帧数无关，是真正的秒数 */
export const SECONDS_PRESETS = [
  { label: '4 秒', seconds: 4 },
  { label: '5 秒', seconds: 5 },
  { label: '8 秒', seconds: 8 },
  { label: '10 秒', seconds: 10 },
  { label: '12 秒', seconds: 12 },
];
export const SCRIPT_TYPES = [
  { value: 'story_concept', label: '故事构思' },
  { value: 'plot_summary', label: '剧情梗概' },
  { value: 'episode_outline', label: '分集大纲' },
  { value: 'episode_script', label: '单集脚本' },
  { value: 'storyboard_script', label: '分镜脚本' },
];
/**
 * 把服务端模型目录转换成下拉项。
 * Agnes 新模型可能还没被正确标注 kind，所以 unknown 也允许作为候选；
 * 只排除明显属于其它模态的名字，避免新模型被误藏起来。
 */
export function modelChoices(directory, kind, fallbacks = []) {
  const all = Array.isArray(directory?.models) ? directory.models : [];
  const textLike = (m) => !/image|vision|video|animate|motion|wan|kling|sora/i.test(String(m.id));
  const imageLike = (m) => /image|vision|dall|flux|sdxl|seedream|画|图/i.test(String(m.id));
  const videoLike = (m) => /video|animate|motion|wan|kling|sora/i.test(String(m.id));
  const predicate = kind === 'text' ? textLike : kind === 'image' ? imageLike : videoLike;
  let ids = all.filter((m) => m.kind === kind || m.kind === 'unknown').filter(predicate).map((m) => m.id);
  if (!ids.length) ids = all.filter(predicate).map((m) => m.id);
  ids = [...new Set([...fallbacks, ...ids].filter(Boolean))];
  return ids.map((id) => ({ value: id, label: id }));
}

export const TEMPLATE_TYPES = [
  { value: 'story_concept', label: '故事生成' },
  { value: 'plot_summary', label: '剧情梗概' },
  { value: 'episode_outline', label: '分集大纲' },
  { value: 'episode_script', label: '单集脚本' },
  { value: 'storyboard_script', label: '分镜脚本' },
  { value: 'image_prompt', label: '图片提示词' },
  { value: 'video_prompt', label: '视频提示词' },
  { value: 'optimize', label: '脚本优化' },
];

// ── 状态标签与样式 ──────────────────────────────────────────
export const VIDEO_STATUS = {
  queued: { label: '排队中', cls: 'blue' },
  in_progress: { label: '生成中', cls: 'gold' },
  completed: { label: '已完成', cls: 'green' },
  failed: { label: '远端失败', cls: 'red' },
  remote_submitted: { label: '已提交', cls: 'blue' },
  poll_timeout: { label: '查询超时', cls: 'orange' },
  video_url_missing: { label: '地址待取', cls: 'yellow' },
  sync_failed: { label: '同步异常', cls: 'orange' },
  submit_timeout_unknown: { label: '提交超时未知', cls: 'orange' },
};
export const REMOTE_STATUS = {
  not_submitted: '未提交',
  unknown: '状态未知',
  queued: '排队中',
  in_progress: '生成中',
  completed: '已完成',
  failed: '远端失败',
};
export const LOCAL_STATUS = {
  draft: '草稿',
  validating: '校验参数',
  submitting: '提交中',
  submit_timeout_unknown: '提交超时未知',
  remote_submitted: '已提交',
  saving: '保存中',
  polling: '轮询中',
  poll_timeout: '查询超时',
  video_url_missing: '地址待取',
  result_parse_failed: '结果解析失败',
  completed: '已完成',
  submit_failed: '提交失败',
  sync_failed: '同步异常',
  local_error: '本地异常',
};
export const STORYBOARD_STATUS = {
  pending: { label: '待处理', cls: 'gray' },
  image_ready: { label: '有图片', cls: 'blue' },
  video_ready: { label: '有视频', cls: 'gold' },
  done: { label: '完成', cls: 'green' },
};

export function statusBadge(status) {
  const s = VIDEO_STATUS[status] || { label: status || '未知', cls: 'gray' };
  return `<span class="badge ${s.cls}">${esc(s.label)}</span>`;
}

// ── 小工具 ──────────────────────────────────────────────────
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function relTime(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '—';
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return fmtDate(iso);
}

/**
 * 把分镜的「时长（秒）」换算成 Agnes 的 num_frames。
 * Agnes 要求 8n+1、最大 441，所以先按 24fps 算出帧数再套到最近的 8n+1。
 * 批量出视频时用它，镜头长的才不会被一律砍成 5 秒。
 */
export function framesForDuration(seconds, fps = 24) {
  const sec = Number(seconds) || 5;
  const frames = Math.round((sec * fps) / 8) * 8 + 1;
  return Math.max(9, Math.min(441, frames));
}


/** 从模型输出里抠出 JSON（数组或对象），容忍 ```json 包裹和前后废话 */
export function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const arrStart = s.indexOf('[');
  const objStart = s.indexOf('{');
  let start = -1;
  if (arrStart >= 0 && objStart >= 0) start = Math.min(arrStart, objStart);
  else start = arrStart >= 0 ? arrStart : objStart;
  if (start < 0) return null;
  const openCh = s[start];
  const closeCh = openCh === '[' ? ']' : '}';
  // 括号配对扫描，跳过字符串里的括号
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

export function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  // 非安全上下文（比如 http 访问）的兜底
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy') ? resolve() : reject(new Error('复制失败'));
    } catch (e) { reject(e); }
    document.body.removeChild(ta);
  });
}

