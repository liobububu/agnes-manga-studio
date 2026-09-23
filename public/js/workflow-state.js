/** 漫剧主生产链统一状态计算器：项目首页、分镜页、剪辑台必须共用这里的阶段定义。 */
export const WORKFLOW_STAGE_NAMES = ['脚本', '分镜', '图片', '视频', '配音', '剪辑'];

export function plannedEpisodes(projectId, scripts = [], storyboards = []) {
  const planned = new Set();
  const projectScripts = scripts.filter((s) => s.project_id === projectId);
  projectScripts.filter((s) => s.script_type === 'episode_outline').forEach((s) => {
    try {
      const text = String(s.content || '');
      const m = text.match(/\[[\s\S]*\]/);
      const arr = JSON.parse(m ? m[0] : text);
      if (Array.isArray(arr)) arr.forEach((x, i) => planned.add(Number(x?.episode ?? x?.episode_number ?? i + 1)));
    } catch {}
  });
  projectScripts.filter((s) => s.episode_number != null).forEach((s) => planned.add(Number(s.episode_number)));
  storyboards.filter((s) => s.project_id === projectId).forEach((s) => planned.add(Number(s.episode_number) || 1));
  return [...planned].filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
}

export function shotWorkflowState(shot, { images = [], videos = [], audios = [] } = {}) {
  const image = shot?.linked_image_id ? images.find((a) => a.id === shot.linked_image_id) : null;
  const video = shot?.linked_video_id ? videos.find((a) => a.id === shot.linked_video_id) : null;
  const audioKeys = new Set(audios.filter((a) => a.status === 'completed' && a.media_readable === true).map((a) => `${a.storyboard_id}:${a.audio_type}`));
  const needsImage = Boolean(String(shot?.image_prompt || '').trim());
  const needsVideo = Boolean(String(shot?.video_prompt || '').trim());
  const needsDialogue = Boolean(String(shot?.dialogue || '').trim());
  const needsNarration = Boolean(String(shot?.narration || '').trim());
  const imageReady = Boolean(shot?.linked_image_id && image?.media_readable === true);
  const videoReady = Boolean(shot?.linked_video_id && video?.media_readable === true);
  const dialogueReady = !needsDialogue || audioKeys.has(`${shot?.id}:dialogue`);
  const narrationReady = !needsNarration || audioKeys.has(`${shot?.id}:narration`);
  return {
    shot,
    needsImage, needsVideo, needsDialogue, needsNarration,
    imageReady, videoReady, dialogueReady, narrationReady,
    audioReady: dialogueReady && narrationReady,
    missingImage: needsImage && !imageReady,
    missingVideo: needsVideo && !videoReady,
    missingDialogue: needsDialogue && !dialogueReady,
    missingNarration: needsNarration && !narrationReady,
    complete: (!needsImage || imageReady) && (!needsVideo || videoReady) && dialogueReady && narrationReady,
  };
}

export function episodeWorkflowState({ projectId, episode, scripts = [], storyboards = [], images = [], videos = [], audios = [], plans = [] }) {
  const ep = Number(episode) || 1;
  const projectScripts = scripts.filter((s) => s.project_id === projectId);
  const shots = storyboards.filter((s) => s.project_id === projectId && (Number(s.episode_number) || 1) === ep);
  const script = projectScripts.find((s) => s.script_type === 'episode_script' && Number(s.episode_number) === ep) || null;
  const media = { images: images.filter((a) => a.project_id === projectId), videos: videos.filter((a) => a.project_id === projectId), audios: audios.filter((a) => a.project_id === projectId) };
  const shotStates = shots.map((s) => shotWorkflowState(s, media));
  const hasScript = Boolean(script);
  const hasStoryboard = shots.length > 0;
  const imagesDone = hasStoryboard && shotStates.every((s) => s.imageReady);
  const videosDone = hasStoryboard && shotStates.every((s) => s.videoReady);
  const audioDone = hasStoryboard && shotStates.every((s) => s.audioReady);
  const hasPlan = plans.some((p) => p.project_id === projectId && (Number(p.episode_number) || 1) === ep);
  const stages = [hasScript, hasStoryboard, imagesDone, videosDone, audioDone, hasPlan];
  const done = stages.filter(Boolean).length;
  let next;
  if (!hasScript) next = { page: 'scripts', label: '单集脚本', params: { project: projectId, tab: 'episode_script', episode: String(ep) } };
  else if (!hasStoryboard) next = { page: 'storyboards', label: '分镜', params: { project: projectId, episode: String(ep), source_script: script.id } };
  else if (!imagesDone) next = { page: 'storyboards', label: '补齐分镜图', params: { project: projectId, episode: String(ep) } };
  else if (!videosDone) next = { page: 'storyboards', label: '补齐视频', params: { project: projectId, episode: String(ep) } };
  else if (!audioDone) next = { page: 'storyboards', label: '补齐配音', params: { project: projectId, episode: String(ep) } };
  else next = { page: 'editor', label: hasPlan ? '继续剪辑' : '剪辑', params: { project: projectId, episode: String(ep) } };
  return { episode: ep, script, shots, shotStates, hasScript, hasStoryboard, imagesDone, videosDone, audioDone, hasPlan, stages, done, percent: Math.round(done / stages.length * 100), next };
}

export function projectWorkflowState(data) {
  const episodes = plannedEpisodes(data.projectId, data.scripts, data.storyboards);
  const states = episodes.map((episode) => episodeWorkflowState({ ...data, episode }));
  const current = states.find((s) => !s.stages.every(Boolean)) || states.at(-1) || episodeWorkflowState({ ...data, episode: 1 });
  return { episodes, states, current };
}

export function nextEpisodeWorkflowState(data, currentEpisode) {
  const episodes = plannedEpisodes(data.projectId, data.scripts, data.storyboards);
  const next = episodes.find((ep) => ep > Number(currentEpisode));
  return next == null ? null : episodeWorkflowState({ ...data, episode: next });
}
