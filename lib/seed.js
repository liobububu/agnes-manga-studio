/**
 * seed.js — 首次运行的默认数据
 * ------------------------------------------------------------------
 * 只做一件事：给「提示词模板」铺一批能直接用的底子。
 * 原版模板表建了但界面没做，本地版把它补上了 —— 模板集中管理后，
 * 改提示词不用再翻代码。
 *
 * 模板里的 {{变量}} 由前端按 template_type 渲染成输入框。
 */
'use strict';

const DEFAULT_TEMPLATES = [
  {
    key: 'story_concept',
    name: '故事构思 · 爽文漫剧',
    template_type: 'story_concept',
    system: '你是专业的AI短视频漫剧编剧，擅长创作适合抖音、快手等平台的爽点密集型漫剧。请用中文回答，并按要求的 JSON 字段返回。',
    content: [
      '请根据以下信息生成漫剧故事构思，用JSON格式返回，字段：',
      'one_liner(一句话故事)、selling_points(故事卖点数组)、protagonist_goal(主角目标)、',
      'core_conflict(核心冲突)、antagonist(反派阻碍)、satisfaction_points(爽点设计数组)、hook(结尾钩子)。',
      '',
      '题材: {{题材}}',
      '主角身份: {{主角身份}}',
      '金手指: {{金手指}}',
      '核心冲突: {{核心冲突}}',
      '爽点方向: {{爽点方向}}',
      '目标平台: {{目标平台}}',
      '单集时长: {{单集时长}}',
      '风格要求: {{风格要求}}',
    ].join('\n'),
    negative_prompt: '',
    notes: '生成一句话故事、卖点、爽点设计与结尾钩子',
  },
  {
    key: 'plot_summary',
    name: '剧情梗概',
    template_type: 'plot_summary',
    system: '你是专业的AI短视频漫剧编剧。请用中文回答，并按要求的 JSON 字段返回。',
    content: [
      '请根据故事想法生成剧情梗概，用JSON格式返回，字段：',
      'summary_short(300字梗概)、summary_long(800字梗概)、season_direction(分季方向)、',
      'conflict_lines(主要冲突线数组)、foreshadowing(暗线伏笔)、emotional_arc(情绪递进)。',
      '',
      '故事想法: {{故事想法}}',
    ].join('\n'),
    negative_prompt: '',
    notes: '300 字 / 800 字双版本梗概 + 暗线伏笔',
  },
  {
    key: 'episode_outline',
    name: '分集大纲',
    template_type: 'episode_outline',
    system: '你是专业的AI短视频漫剧编剧。请用中文回答，返回 JSON 数组。',
    content: [
      '请根据剧情梗概生成分集大纲，用JSON数组格式返回，每集包含：',
      'episode(集数)、title(标题)、core_conflict(核心冲突)、plot(剧情简述)、satisfaction(爽点)、hook(结尾钩子)。',
      '',
      '剧情梗概: {{剧情梗概}}',
      '目标集数: {{目标集数}}集',
      '单集时长: {{单集时长}}',
      '每集留钩子: {{每集留钩子}}',
    ].join('\n'),
    negative_prompt: '',
    notes: '按集数拆出冲突、爽点、钩子',
  },
  {
    key: 'episode_script',
    name: '单集脚本',
    template_type: 'episode_script',
    system: '你是专业的AI短视频漫剧编剧。请用中文回答，返回 JSON 数组。',
    content: [
      '请根据集大纲生成单集完整脚本，用JSON数组格式返回，每个镜头包含：',
      'shot_number(编号)、shot_type(景别)、scene_description(画面描述)、action(人物动作)、',
      'dialogue(台词)、narration(旁白)、sound_effect(音效)、duration_seconds(时长秒)、emotion_goal(情绪目标)。',
      '',
      '本集大纲: {{本集大纲}}',
    ].join('\n'),
    negative_prompt: '',
    notes: '镜头级脚本，含景别、台词、音效、情绪目标',
  },
  {
    key: 'storyboard_script',
    name: '分镜脚本',
    template_type: 'storyboard_script',
    system: '你是专业的AI漫剧分镜导演。请用JSON数组格式返回分镜表，每个镜头必须包含所有字段，英文图片/视频提示词要专业、详细。',
    content: [
      '请将以下脚本转换为分镜脚本，用JSON数组格式返回，每个镜头包含：',
      'shot_number(编号)、shot_type(景别)、scene_description(画面描述)、characters(出场人物)、',
      'action(人物动作)、dialogue(台词)、narration(旁白)、sound_effect(音效)、duration_seconds(时长)、',
      'image_prompt(英文图片生成提示词，风格统一、细节丰富)、video_prompt(英文视频生成提示词，描述运动和镜头)。',
      '',
      '脚本内容: {{脚本内容}}',
    ].join('\n'),
    negative_prompt: '',
    notes: '一次产出图片提示词与视频提示词',
  },
  {
    key: 'image_prompt',
    name: '分镜图片提示词',
    template_type: 'image_prompt',
    system: '你是专业的AI漫剧分镜图提示词工程师，请生成适合图像生成的英文提示词，风格统一，细节丰富。只输出提示词本身，不要解释。',
    content: '为以下分镜生成英文图片提示词：景别:{{景别}}，画面:{{画面描述}}，人物:{{人物}}，动作:{{动作}}，画风:{{画风}}',
    negative_prompt: 'low quality, blurry, distorted face, extra fingers, watermark, text',
    notes: '批量补图片提示词时用',
  },
  {
    key: 'video_prompt',
    name: '图生视频运动描述',
    template_type: 'video_prompt',
    system: '你是专业的AI视频提示词工程师。请用英文输出，只描述画面运动与镜头运动，不要重复静态外观。',
    content: '为以下分镜生成英文视频运动提示词：画面:{{画面描述}}，动作:{{动作}}，情绪:{{情绪目标}}，镜头运动:{{镜头运动}}',
    negative_prompt: 'low quality, blurry, distorted face, flickering, unstable motion',
    notes: '批量补视频提示词时用',
  },
  {
    key: 'optimize_opening',
    name: '强化开头 3 秒',
    template_type: 'optimize',
    system: '你是专业的AI短视频漫剧编剧。请保持原有结构与篇幅，只做针对性增强。',
    content: '请优化脚本，大幅强化开头3秒的吸引力，要让观众立刻停下来：\n\n{{脚本内容}}',
    negative_prompt: '',
    notes: '脚本优化 · 开头钩子',
  },
  {
    key: 'optimize_conflict',
    name: '强化冲突',
    template_type: 'optimize',
    system: '你是专业的AI短视频漫剧编剧。请保持原有结构与篇幅，只做针对性增强。',
    content: '请优化脚本，强化核心冲突的戏剧张力：\n\n{{脚本内容}}',
    negative_prompt: '',
    notes: '脚本优化 · 冲突',
  },
  {
    key: 'optimize_satisfaction',
    name: '强化爽点',
    template_type: 'optimize',
    system: '你是专业的AI短视频漫剧编剧。请保持原有结构与篇幅，只做针对性增强。',
    content: '请优化脚本，强化爽点密度和爽感：\n\n{{脚本内容}}',
    negative_prompt: '',
    notes: '脚本优化 · 爽点',
  },
  {
    key: 'optimize_reversal',
    name: '强化反转',
    template_type: 'optimize',
    system: '你是专业的AI短视频漫剧编剧。请保持原有结构与篇幅，只做针对性增强。',
    content: '请优化脚本，添加更强烈的反转：\n\n{{脚本内容}}',
    negative_prompt: '',
    notes: '脚本优化 · 反转',
  },
  {
    key: 'optimize_hook',
    name: '强化评论钩子',
    template_type: 'optimize',
    system: '你是专业的AI短视频漫剧编剧。请保持原有结构与篇幅，只做针对性增强。',
    content: '请优化脚本，强化评论互动钩子，引发观众讨论：\n\n{{脚本内容}}',
    negative_prompt: '',
    notes: '脚本优化 · 互动',
  },
  {
    key: 'optimize_shorten',
    name: '缩短脚本',
    template_type: 'optimize',
    system: '你是专业的AI短视频漫剧编剧。',
    content: '请精简脚本，删除冗余，保留核心冲突和爽点：\n\n{{脚本内容}}',
    negative_prompt: '',
    notes: '脚本优化 · 精简',
  },
  {
    key: 'optimize_cinematic',
    name: '增加镜头感',
    template_type: 'optimize',
    system: '你是专业的AI短视频漫剧编剧。',
    content: '请优化脚本，增加镜头感和画面感描述：\n\n{{脚本内容}}',
    negative_prompt: '',
    notes: '脚本优化 · 镜头感',
  },
];

/** 首装时写入；已存在同 key 的模板不重复写 */
function seedTemplates(store) {
  if (!store) return 0;
  const existing = new Set(store.list('prompt_templates').map((t) => t.key).filter(Boolean));
  let n = 0;
  for (const t of DEFAULT_TEMPLATES) {
    if (existing.has(t.key)) continue;
    store.insert('prompt_templates', Object.assign({
      is_favorited: false,
      is_builtin: true,
    }, t));
    n++;
  }
  return n;
}

module.exports = { DEFAULT_TEMPLATES, seedTemplates };
