/**
 * api.js — 后端接口封装
 * 统一把 HTTP 错误、业务 ok:false 都收敛成 {ok, data, error}，页面里不用层层 try。
 */

async function req(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    return { ok: false, error: `无法连接到本地服务：${e.message}` };
  }
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    return { ok: false, error: data?.error || `请求失败（HTTP ${res.status}）`, status: res.status };
  }
  if (data && data.ok === false) {
    return { ok: false, error: data.error || '操作失败', errorType: data.errorType, data };
  }
  return { ok: true, data };
}

export const api = {
  health: () => req('GET', '/api/health'),
  bootstrap: () => req('GET', '/api/bootstrap'),
  stats: () => req('GET', '/api/stats'),

  settings: () => req('GET', '/api/settings'),
  imageHost: () => req('GET', '/api/imagehost'),
  testImageHost: () => req('POST', '/api/imagehost/test', {}),
  uploadImageHost: (imageId) => req('POST', '/api/imagehost/upload', { image_id: imageId }),
  refreshModels: () => req('POST', '/api/models/refresh', {}),
  saveSettings: (patch) => req('PUT', '/api/settings', patch),
  testSettings: (kind) => req('POST', '/api/settings/test', { kind }),

  projects: () => req('GET', '/api/projects'),
  createProject: (p) => req('POST', '/api/projects', p),
  updateProject: (id, p) => req('PUT', `/api/projects/${id}`, p),
  deleteProject: (id, cascade) => req('DELETE', `/api/projects/${id}`, { cascade }),
  duplicateProject: (id) => req('POST', `/api/projects/${id}/duplicate`, {}),

  scripts: (projectId) => req('GET', `/api/scripts${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`),
  createScript: (s) => req('POST', '/api/scripts', s),
  deleteScript: (id) => req('DELETE', `/api/scripts/${id}`),

  storyboards: (projectId, episode) => {
    const q = [];
    if (projectId) q.push(`project_id=${encodeURIComponent(projectId)}`);
    if (episode != null) q.push(`episode=${episode}`);
    return req('GET', `/api/storyboards${q.length ? `?${q.join('&')}` : ''}`);
  },
  createStoryboard: (s) => req('POST', '/api/storyboards', s),
  createStoryboards: (rows) => req('POST', '/api/storyboards', { rows }),
  updateStoryboard: (id, s) => req('PUT', `/api/storyboards/${id}`, s),
  deleteStoryboard: (id) => req('DELETE', `/api/storyboards/${id}`),
  reorderStoryboards: (ids) => req('POST', '/api/storyboards/reorder', { ids }),
  clearStoryboards: (projectId, episode) => req('DELETE', `/api/storyboards?project_id=${encodeURIComponent(projectId)}&episode=${episode}`),

  assetEntities: (projectId) => req('GET', `/api/asset-entities${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`),
  createAssetEntity: (a) => req('POST', '/api/asset-entities', a),
  updateAssetEntity: (id, a) => req('PUT', `/api/asset-entities/${id}`, a),
  deleteAssetEntity: (id) => req('DELETE', `/api/asset-entities/${id}`),

  images: (projectId) => req('GET', `/api/images${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`),
  updateImage: (id, a) => req('PUT', `/api/images/${id}`, a),
  deleteImage: (id) => req('DELETE', `/api/images/${id}`),
  genImage: (p) => req('POST', '/api/agnes/image', p),

  videos: (projectId) => req('GET', `/api/videos${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`),
  updateVideo: (id, v) => req('PUT', `/api/videos/${id}`, v),
  deleteVideo: (id) => req('DELETE', `/api/videos/${id}`),
  createVideo: (v) => req('POST', '/api/videos', v),
  refreshVideo: (id) => req('POST', `/api/videos/${id}/refresh`, {}),
  bindVideo: (id, videoId) => req('POST', `/api/videos/${id}/bind`, { video_id: videoId }),
  downloadVideo: (id) => req('POST', `/api/videos/${id}/download`, {}),
  batchRefreshVideos: () => req('POST', '/api/videos/batch-refresh', {}),

  tasks: (type) => req('GET', `/api/tasks${type ? `?task_type=${type}` : ''}`),
  updateTask: (id, t) => req('PUT', `/api/tasks/${id}`, t),
  deleteTask: (id) => req('DELETE', `/api/tasks/${id}`),

  templates: (type) => req('GET', `/api/templates${type ? `?template_type=${type}` : ''}`),
  createTemplate: (t) => req('POST', '/api/templates', t),
  updateTemplate: (id, t) => req('PUT', `/api/templates/${id}`, t),
  deleteTemplate: (id) => req('DELETE', `/api/templates/${id}`),

  audioAssets: (projectId) => req('GET', '/api/audio-assets' + (projectId ? '?project_id=' + encodeURIComponent(projectId) : '')),
  createAudioAsset: (a) => req('POST', '/api/audio-assets', a),
  generateTts: (a) => req('POST', '/api/tts/generate', a),

  editPlans: (projectId, episode) => req('GET', `/api/edit-plans?project_id=${encodeURIComponent(projectId || '')}${episode ? `&episode=${episode}` : ''}`),
  assembleEditPlan: (projectId, episode) => req('GET', `/api/edit-plans/assemble?project_id=${encodeURIComponent(projectId)}&episode=${episode}`),
  createEditPlan: (p) => req('POST', '/api/edit-plans', p),
  updateEditPlan: (id, p) => req('PUT', `/api/edit-plans/${id}`, p),
  deleteEditPlan: (id) => req('DELETE', `/api/edit-plans/${id}`),
  exportEditPlan: (id, srtMode) => req('GET', `/api/edit-plans/${id}/export${srtMode ? `?srt=${srtMode}` : ''}`),

  genText: (p) => req('POST', '/api/agnes/text', p),

  batchImages: (p) => req('POST', '/api/batch/images', p),
  batchVideos: (p) => req('POST', '/api/batch/videos', p),
  cancelBatch: (id) => req('POST', `/api/batch/${id}/cancel`, {}),
  batches: () => req('GET', '/api/batch'),

  importData: (data, mode) => req('POST', '/api/import', { data, mode }),
};
