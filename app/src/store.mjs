import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, localStamp, nowIso, readJson, uid, writeJsonAtomic } from './util.mjs';

export const DEFAULT_PROMPT = `请检索并整理过去 24 小时内无畏契约（Valorant）真正发生的新鲜事，优先官方公告、VCT 赛事、战队/选手动态、版本与皮肤消息；不要趋势分析、攻略、科普或旧闻。每条包含：标题、发生了什么（1-2 句）、时间、来源链接（如能确认）。最多 15 条，按关注度排序。全部用 Markdown 输出（# 标题、- 列表），不要用代码块包住整篇。`;

// 提示词一律要求 Markdown 输出：AI Flow 按 Markdown 解析，图表/纯文字会做兜底。
const MARKDOWN_RULE = `输出要求：全部用 Markdown（# 标题、- 列表、必要时 | 表格 |），不要用代码块包住整篇，不要输出寒暄或“以下是总结”。`;

export const SUMMARY_PROFILES = {
  hotspot: {
    id: 'hotspot',
    name: '今日热点汇总',
    docTitle: '今日热点汇总',
    digestTitle: '今日热点汇总',
    digestInstruction:
      '下面是我今天从多个 AI 定时任务收集的热点原文。请去重合并，按领域（时事 / 财经 / 科技 / 游戏 / 体育娱乐 / 其他）整理成一份「今日热点汇总」：每条写标题、发生了什么、为什么值得关注、时间、来源；原文没有的来源和数字不要编；开头先列今天最值得看的 3-5 条。全部用 Markdown 输出。',
    prompt: `你是我的今日热点主编。下面是我从多个 AI 定时任务里取回的热点原文，覆盖今天各个领域，可能有重复、旧闻和互相矛盾的说法。
请输出一份「今日热点汇总」，要求：
1. 汇总今天所有领域的热点：社会/时事、财经/市场、科技/AI、游戏/电竞、体育/娱乐等，不要只写 AI 或某一个游戏。
2. 先按领域分组，每组用 - 条目列出：**标题** — 发生了什么（1-2 句事实）；为什么值得关注（一句）；时间；来源（原文有才写，没写就不要编）。
3. 同一条新闻多个来源重复时合并，保留信息最全的版本；互相冲突时标注「存在不同说法」。
4. 开头用一句话列出「今天最值得看的 3-5 条」，再进入分组正文。
5. 只保留过去 24 小时内、能落到具体事件的内容；跳过纯观点、广告和旧闻。
6. ${MARKDOWN_RULE}
待整理的原文：`
  },
  ai: {
    id: 'ai',
    name: 'AI 早报',
    docTitle: 'AI 早报',
    prompt: `你是我的早报主编。下面是我从多个 AI 收集到的原始回答，里面可能有重复、趋势分析和旧闻。
请只输出一份「AI 早报」，按新闻条目排列，不要写成趋势总结、综述或评论文章：
1. 只保留过去 24 小时内发生的具体新鲜事（最多放宽到 48 小时），优先主流媒体、公司官方和开发者社区都在关注的消息；跳过冷门、纯科普、旧闻和没有事实依据的内容。
2. 每条写成：编号. **标题** — 发生了什么（1-2 句事实）；为什么值得关注（一句）；时间；来源（原文有才写，没写就不要编）。
3. 按关注度排序，8-15 条；重复的合并；互相冲突的标注「存在不同说法」。
4. 开头用一句话列出「昨夜今晨最重要的 3 条」，然后才是条目列表。
5. 不要输出大段趋势分析、行业展望，也不要编造链接、数字或公司动态。
待整理的原始回答：`
  },
  valorant: {
    id: 'valorant',
    name: 'Valorant 资讯晚报',
    docTitle: 'Valorant 资讯晚报',
    digestTitle: 'Valorant 资讯晚报',
    digestInstruction:
      '下面是我今天从多个 AI 定时任务收集的 Valorant 相关资讯原文。请去重合并，整理成一份「Valorant 资讯晚报」：按「官方公告 / 赛事与 VCT / 战队与选手 / 版本与皮肤 / 社区热议」分组，每条写标题、发生了什么、时间、来源；原文没有的来源和比分不要编；未经证实的传闻标「未证实」；开头先列今天最值得看的 3 条。全部用 Markdown 输出。',
    prompt: `你是我的无畏契约（Valorant）资讯编辑。下面是我从多个 AI 收集到的原始回答，可能有重复、传闻和旧闻。
请只输出一份「Valorant 资讯晚报」，按信息条目排列，不要写成趋势分析或长文：
1. 第一行必须是 # 标题，格式为「Valorant 资讯晚报｜YYYY-MM-DD」，日期用当天真实日期。
2. 聚焦过去 24-48 小时：VCT 赛事结果与赛程、官方公告/补丁、版本改动、新皮肤、战队与选手动态、教练/主播言论、社区热议。
3. 按「官方公告 / 赛事与 VCT / 战队与选手 / 版本与皮肤 / 社区热议」分组，每组用 - 条目列出：**标题** — 谁/哪支队伍；发生了什么；时间；来源（原文有才写，没写就不要编）。
4. 优先有明确人物/战队/出处的消息；未证实的传闻标「未证实」；比分、日期、选手 ID 必须与原文一致；可比数据用 | 表格 | 呈现。
5. 不要输出大段趋势判断，不要编造链接、比分或引语；不要写“收到”“以下是报告”这类开场白。
6. ${MARKDOWN_RULE}
待整理的原始回答：`
  },
  custom: {
    id: 'custom',
    name: '自定义',
    docTitle: 'AI 总结',
    prompt: ''
  }
};

export const DEFAULT_SUMMARY_PROFILE = 'valorant';

export function normalizeSummaryProfile(value) {
  return Object.prototype.hasOwnProperty.call(SUMMARY_PROFILES, value) ? value : DEFAULT_SUMMARY_PROFILE;
}

export function normalizeConversationBindings(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const [platformId, value] of Object.entries(input)) {
    if (!platformId || !value || typeof value !== 'object') continue;
    const url = String(value.url || '').trim().slice(0, 2000);
    if (!/^https?:\/\//i.test(url)) continue;
    out[platformId] = {
      url,
      title: String(value.title || '').slice(0, 160),
      updatedAt: value.updatedAt || nowIso()
    };
  }
  return out;
}

export function normalizeSummaryConversation(input) {
  if (!input || typeof input !== 'object') return null;
  const url = String(input.url || '').trim().slice(0, 2000);
  const platformId = String(input.platformId || '').trim();
  if (!/^https?:\/\//i.test(url) || !platformId) return null;
  return {
    url,
    platformId,
    title: String(input.title || '').slice(0, 160),
    updatedAt: input.updatedAt || nowIso()
  };
}

export const DEFAULT_PLATFORMS = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    adapterId: 'chatgpt',
    url: 'https://chatgpt.com/',
    icon: 'openai',
    tone: 'green',
    builtin: true,
    homeNote: '访客模式实测可采集 · 定时任务（Tasks）入口已适配'
  },
  {
    id: 'gemini',
    name: 'Gemini',
    adapterId: 'gemini',
    url: 'https://gemini.google.com/app',
    icon: 'googlegemini',
    tone: 'blue',
    builtin: true,
    homeNote: '访客模式实测可采集 · 读取自己的定时对话需要登录'
  },
  {
    id: 'claude',
    name: 'Claude',
    adapterId: 'claude',
    url: 'https://claude.ai/new',
    icon: 'claude',
    tone: 'orange',
    builtin: true,
    homeNote: '需要登录 · 选择器未实测'
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    adapterId: 'perplexity',
    url: 'https://www.perplexity.ai/',
    icon: 'perplexity',
    tone: 'ink',
    builtin: true,
    homeNote: '需要登录 · 选择器未实测'
  },
  {
    id: 'grok',
    name: 'Grok',
    adapterId: 'grok',
    url: 'https://grok.com/',
    icon: 'grok',
    tone: 'ink',
    builtin: true,
    homeNote: '需要登录 · 选择器未实测'
  },
  {
    id: 'muse',
    name: 'Muse',
    adapterId: 'muse',
    url: 'https://muse.ai/',
    icon: 'muse',
    tone: 'violet',
    builtin: true,
    homeNote: 'Meta 的个人 AI 智能体（muse.ai）· 需要登录 · 选择器未实测'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    adapterId: 'deepseek',
    url: 'https://chat.deepseek.com/',
    icon: 'deepseek',
    tone: 'blue',
    builtin: true,
    enabled: false,
    homeNote: '需要登录 · 选择器未实测'
  },
  {
    id: 'kimi',
    name: 'Kimi',
    adapterId: 'kimi',
    url: 'https://kimi.moonshot.cn/',
    icon: 'kimi',
    tone: 'violet',
    builtin: true,
    enabled: false,
    homeNote: '需要登录 · 选择器未实测'
  },
  {
    id: 'doubao',
    name: '豆包',
    adapterId: 'doubao',
    url: 'https://www.doubao.com/',
    icon: 'doubao',
    tone: 'blue',
    builtin: true,
    enabled: false,
    homeNote: '需要登录 · 选择器未实测'
  },
  {
    id: 'qwen',
    name: '通义千问',
    adapterId: 'qwen',
    url: 'https://www.tongyi.com/',
    icon: 'qwen',
    tone: 'violet',
    builtin: true,
    enabled: false,
    homeNote: '需要登录 · 选择器未实测'
  }
];

export const DEFAULT_SUMMARY_PROMPT = `你是我的今日热点主编。下面是我今天从多个 AI 定时任务里取回的热点原文，覆盖各个领域，可能有重复、冲突或未核实的信息。
请直接输出一份「今日热点汇总」，要求：
1. 汇总今天所有领域的热点（社会/时事、财经/市场、科技/AI、游戏/电竞、体育/娱乐等），不要只写 AI；去重合并，冲突时标注「存在不同说法」。
2. 结构：一句话总览；今天最值得看的 3-5 条；按领域分组的条目（每条：**标题** — 事实 + 为什么值得关注 + 来源，原文没有的来源不要编造）；需要继续核实的点。
3. 不添加原文没有的事实或链接；不输出寒暄、解释或“以下是总结”。
4. 保留原文中的日期、数字、链接和专有名词；全部用 Markdown 输出，不要用代码块包住整篇。
待整理的原文：`;

// 1.5 的默认总结指令（只汇总 AI/科技）。迁移时只在用户没改过的情况下替换成新热点版。
const LEGACY_SUMMARY_PROMPT = `你是我的信息主编。下面是我从多个 AI 收集到的原始回答，可能有重复、冲突或未核实的信息。
请直接输出一份最终版中文汇总，要求：
1. 去重合并；优先保留有日期、数字、明确来源的内容；冲突时标注「存在不同说法」。
2. 结构：标题；今日重点（3-5 条）；按主题分组的要点（每条：结论 + 为什么重要 + 来源，原文没有的来源不要编造）；需要继续核实的点；一句话结论。
3. 不添加原文没有的事实或链接；不输出寒暄、解释或“以下是总结”。
4. 保留原文中的日期、数字、链接和专有名词。
待整理的原始回答：`;

export const DEFAULT_SETTINGS = {
  browser: 'edge',
  visible: true,
  minimizeDuringRun: true,
  proxy: '',
  stableMs: 2800,
  maxWaitSec: 300,
  catchUp: true,
  catchUpHours: 12,
  autoCopy: false,
  notify: true,
  debugScreenshots: false,
  // 默认只出「桌面总文档」，不把原文发给任何 AI；需要时再在设置里打开自动总结。
  autoSummarize: false,
  desktopDigest: true,
  // 桌面总文档的标题；现在是 Valorant 资讯晚报。
  digestTitle: 'Valorant 资讯晚报',
  summaryPlatformId: 'chatgpt',
  summaryConversation: null,
  summaryPrompt: DEFAULT_SUMMARY_PROMPT,
  summaryWaitSec: 300,
  outputDir: '',
  waitMinutes: 60,
  pollMinutes: 5,
  // 同时读取几个来源；2 通常能把一次晚报从 10 分钟压到 4-5 分钟。
  concurrency: 2,
  // 同一条对话最多检查几次；到上限就停，不再无限重采。
  maxAttempts: 6,
  // 单个来源最多读多久（秒）：超时就结束这一条，不能一直卡着。
  sourceTimeoutSec: 180,
  // 看门狗：连续多久没有任何进展就强制结束整次采集（分钟）。
  stallMinutes: 15
};

export const WEEKDAY_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

export function nextOccurrence(schedule, from = new Date()) {
  const type = schedule?.type || 'manual';
  if (type === 'manual') return null;
  if (type === 'interval') {
    const hours = Math.min(168, Math.max(1, Number(schedule.everyHours) || 6));
    return new Date(from.getTime() + hours * 3_600_000).toISOString();
  }

  const [rawHour, rawMinute] = String(schedule.time || '09:00').split(':').map(Number);
  const hour = Number.isFinite(rawHour) ? Math.min(23, Math.max(0, rawHour)) : 9;
  const minute = Number.isFinite(rawMinute) ? Math.min(59, Math.max(0, rawMinute)) : 0;
  const target = new Date(from);
  target.setSeconds(0, 0);

  if (type === 'weekly') {
    const weekday = ((Number(schedule.weekday ?? 1) % 7) + 7) % 7;
    target.setHours(hour, minute, 0, 0);
    let diff = (weekday - target.getDay() + 7) % 7;
    if (diff === 0 && target.getTime() <= from.getTime()) diff = 7;
    target.setDate(target.getDate() + diff);
    return target.toISOString();
  }

  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= from.getTime()) target.setDate(target.getDate() + 1);
  return target.toISOString();
}

export function scheduleLabel(schedule) {
  if (!schedule || schedule.type === 'manual') return '仅手动运行';
  if (schedule.type === 'interval') return `每 ${schedule.everyHours || 6} 小时`;
  if (schedule.type === 'weekly') return `每${WEEKDAY_NAMES[Number(schedule.weekday ?? 1) % 7]} ${schedule.time || '09:00'}`;
  return `每天 ${schedule.time || '09:00'}`;
}

export function normalizeMode(mode) {
  return mode === 'scheduled' ? 'scheduled' : 'prompt';
}

export function normalizeSources(input) {
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, 12)
    .map((item) => {
      const url = String(item?.url || '').trim();
      return {
        platformId: String(item?.platformId || ''),
        url: /^https?:\/\//i.test(url) ? url.slice(0, 500) : '',
        keyword: String(item?.keyword || '').trim().slice(0, 60),
        firstRun: item?.firstRun === 'all' ? 'all' : 'latest'
      };
    })
    .filter((item) => item.platformId && (item.url || item.keyword));
}

export function normalizeWait(input, current) {
  const base = current || { minutes: 60, pollMinutes: 5 };
  const source = input && typeof input === 'object' ? input : {};
  const minutes = Number.isFinite(Number(source.minutes)) ? Number(source.minutes) : base.minutes ?? 60;
  const pollMinutes = Number.isFinite(Number(source.pollMinutes)) ? Number(source.pollMinutes) : base.pollMinutes ?? 5;
  return {
    minutes: Math.min(720, Math.max(0, minutes)),
    pollMinutes: Math.min(120, Math.max(0.05, pollMinutes))
  };
}

function freshState() {
  const createdAt = nowIso();
  const scheduledExample = {
    id: uid('task'),
    name: '每日定时回答汇总',
    mode: 'scheduled',
    prompt: '（定时采集模式不使用提示词）',
    platformIds: [],
    sources: [],
    wait: { minutes: 60, pollMinutes: 5 },
    schedule: { type: 'daily', time: '09:00', weekday: 1, everyHours: 6 },
    enabled: false,
    isExample: true,
    createdAt,
    lastRunAt: null,
    nextRunAt: null
  };
  const exampleTask = {
    id: uid('task'),
    name: '每日 AI 资讯汇总',
    mode: 'prompt',
    prompt: DEFAULT_PROMPT,
    platformIds: ['chatgpt', 'gemini'],
    sources: [],
    wait: { minutes: 60, pollMinutes: 5 },
    schedule: { type: 'daily', time: '09:00', weekday: 1, everyHours: 6 },
    enabled: false,
    isExample: true,
    createdAt,
    lastRunAt: null,
    nextRunAt: null
  };
  return {
    version: 2,
    settingsVersion: 3,
    createdAt,
    settings: { ...DEFAULT_SETTINGS },
    platforms: DEFAULT_PLATFORMS.map((platform) => ({
      ...platform,
      enabled: platform.enabled !== false,
      login: 'unknown',
      lastCheckAt: null,
      loginError: null,
      createdAt
    })),
    tasks: [scheduledExample, exampleTask],
    runs: [],
    watermarks: {},
    latestRunId: null
  };
}

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'state.json');
    this.runsDir = path.join(dataDir, 'runs');
    ensureDir(this.runsDir);
    this.state = this.migrate(readJson(this.file));
    this.save();
  }

  migrate(raw) {
    if (!raw || !raw.version || !Array.isArray(raw.platforms)) {
      return freshState();
    }
    const state = {
      ...freshState(),
      ...raw,
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
      platforms: Array.isArray(raw.platforms) ? raw.platforms : [],
      tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
      runs: Array.isArray(raw.runs) ? raw.runs : []
    };

    for (const seed of DEFAULT_PLATFORMS) {
      const existing = state.platforms.find((platform) => platform.id === seed.id);
      if (!existing) {
        state.platforms.push({
          ...seed,
          enabled: seed.enabled !== false,
          login: 'unknown',
          lastCheckAt: null,
          loginError: null,
          createdAt: nowIso()
        });
      } else if (existing.builtin) {
        // 内置平台由应用维护：同步官方地址与图标（例如 Muse 从 meta.ai 纠正为 muse.ai）
        existing.adapterId = seed.adapterId;
        existing.url = seed.url;
        existing.icon = seed.icon;
        existing.tone = seed.tone;
        existing.homeNote = seed.homeNote;
      }
    }

    state.platforms = state.platforms.map((platform) => ({
      enabled: true,
      login: 'unknown',
      lastCheckAt: null,
      loginError: null,
      ...platform
    }));

    state.tasks = state.tasks.map((task) => ({
      mode: 'prompt',
      sources: [],
      wait: { minutes: 60, pollMinutes: 5 },
      schedule: { type: 'daily', time: '09:00', weekday: 1, everyHours: 6 },
      enabled: false,
      isExample: false,
      summaryProfile: DEFAULT_SUMMARY_PROFILE,
      conversations: {},
      summaryConversation: null,
      ...task,
      summaryProfile: normalizeSummaryProfile(task.summaryProfile),
      conversations: normalizeConversationBindings(task.conversations),
      summaryConversation: normalizeSummaryConversation(task.summaryConversation)
    }));

    state.watermarks = raw.watermarks && typeof raw.watermarks === 'object' ? raw.watermarks : {};

    state.settings.summaryConversation = normalizeSummaryConversation(raw.settings?.summaryConversation);
    state.settings.maxAttempts = Math.min(20, Math.max(1, Number(state.settings.maxAttempts) || 6));
    state.settings.concurrency = Math.min(4, Math.max(1, Number(state.settings.concurrency) || 2));
    state.settings.sourceTimeoutSec = Math.min(900, Math.max(60, Number(state.settings.sourceTimeoutSec) || 180));
    state.settings.stallMinutes = Math.min(120, Math.max(5, Number(state.settings.stallMinutes) || 15));

    // 1.6 升级：默认改成「先出桌面总文档、不自动发给 AI」。只在旧数据上迁一次，之后用户改了就不再覆盖。
    if (Number(raw.settingsVersion || 0) < 2) {
      state.settings.autoSummarize = false;
      state.settings.desktopDigest = true;
      state.settings.summaryConversation = null;
      state.settingsVersion = 2;
      // 旧任务的总结格式是「AI 早报」，1.6 起默认按全领域热点汇总，避免只汇总 AI。
      for (const task of state.tasks) {
        if (task.summaryProfile === 'ai') task.summaryProfile = 'hotspot';
      }
      if (String(state.settings.summaryPrompt || '').trim() === LEGACY_SUMMARY_PROMPT.trim()) {
        state.settings.summaryPrompt = DEFAULT_SUMMARY_PROMPT;
      }
    }

    // 1.10 升级：产品重心从「全球热点」转到「Valorant 资讯晚报」。
    // 已有任务里按热点汇总的，统一改成 Valorant 晚报，避免生成全世界日报。
    if (Number(raw.settingsVersion || 0) < 3) {
      state.settings.digestTitle = state.settings.digestTitle || 'Valorant 资讯晚报';
      for (const task of state.tasks) {
        if (task.summaryProfile === 'hotspot' || task.summaryProfile === 'ai') task.summaryProfile = 'valorant';
      }
      state.settingsVersion = 3;
    }

    return state;
  }

  getWatermark(key) {
    return (this.state.watermarks || {})[key] || null;
  }

  setWatermark(key, value) {
    this.state.watermarks = this.state.watermarks || {};
    this.state.watermarks[key] = { ...value, updatedAt: nowIso() };
    this.save();
    return this.state.watermarks[key];
  }

  resetWatermarks(prefix = '') {
    if (!prefix) {
      this.state.watermarks = {};
      this.save();
      return 0;
    }
    const kept = {};
    for (const [key, value] of Object.entries(this.state.watermarks || {})) {
      if (!key.startsWith(prefix)) kept[key] = value;
    }
    this.state.watermarks = kept;
    this.save();
    return Object.keys(kept).length;
  }

  watermarkSummary() {
    return Object.entries(this.state.watermarks || {})
      .map(([key, value]) => ({
        key,
        platformId: key.split('::')[0],
        label: value.label || '',
        count: value.count || 0,
        lastTime: value.lastTime || null,
        updatedAt: value.updatedAt || null
      }))
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  }

  save() {
    writeJsonAtomic(this.file, this.state);
  }

  findPlatform(id) {
    return this.state.platforms.find((platform) => platform.id === id) || null;
  }

  findTask(id) {
    return this.state.tasks.find((task) => task.id === id) || null;
  }

  createTask(input) {
    const now = new Date();
    const task = {
      id: uid('task'),
      name: String(input.name || '未命名汇总').slice(0, 60),
      mode: normalizeMode(input.mode),
      prompt: String(input.prompt || DEFAULT_PROMPT).slice(0, 20_000),
      platformIds: Array.isArray(input.platformIds) ? input.platformIds : [],
      sources: normalizeSources(input.sources),
      wait: normalizeWait(input.wait),
      summaryProfile: normalizeSummaryProfile(input.summaryProfile),
      conversations: normalizeConversationBindings(input.conversations),
      summaryConversation: normalizeSummaryConversation(input.summaryConversation),
      schedule: input.schedule || { type: 'manual', time: '09:00', weekday: 1, everyHours: 6 },
      enabled: Boolean(input.enabled),
      isExample: false,
      createdAt: now.toISOString(),
      lastRunAt: null,
      nextRunAt: null
    };
    task.nextRunAt = task.enabled ? nextOccurrence(task.schedule, now) : null;
    this.state.tasks.unshift(task);
    this.save();
    return task;
  }

  updateTask(id, patch) {
    const task = this.findTask(id);
    if (!task) return null;
    if (typeof patch.name === 'string') task.name = patch.name.slice(0, 60);
    if (typeof patch.mode === 'string') task.mode = normalizeMode(patch.mode);
    if (typeof patch.prompt === 'string') task.prompt = patch.prompt.slice(0, 20_000);
    if (typeof patch.summaryProfile === 'string') task.summaryProfile = normalizeSummaryProfile(patch.summaryProfile);
    if (patch.conversations && typeof patch.conversations === 'object') task.conversations = normalizeConversationBindings(patch.conversations);
    if (patch.summaryConversation !== undefined) task.summaryConversation = normalizeSummaryConversation(patch.summaryConversation);
    if (Array.isArray(patch.platformIds)) task.platformIds = patch.platformIds;
    if (Array.isArray(patch.sources)) task.sources = normalizeSources(patch.sources);
    if (patch.wait && typeof patch.wait === 'object') task.wait = normalizeWait(patch.wait, task.wait);
    if (patch.schedule && typeof patch.schedule === 'object') {
      task.schedule = {
        type: ['manual', 'daily', 'weekly', 'interval'].includes(patch.schedule.type) ? patch.schedule.type : task.schedule.type,
        time: /^\d{1,2}:\d{2}$/.test(patch.schedule.time || '') ? patch.schedule.time : task.schedule.time,
        weekday: Number.isFinite(Number(patch.schedule.weekday)) ? Number(patch.schedule.weekday) : task.schedule.weekday,
        everyHours: Math.min(168, Math.max(1, Number(patch.schedule.everyHours) || task.schedule.everyHours || 6))
      };
    }
    if (typeof patch.enabled === 'boolean' && patch.enabled !== task.enabled) {
      task.enabled = patch.enabled;
      task.nextRunAt = patch.enabled ? nextOccurrence(task.schedule, new Date()) : null;
    } else if (patch.schedule && task.enabled) {
      task.nextRunAt = nextOccurrence(task.schedule, new Date());
    }
    if (patch.isExample === false) task.isExample = false;
    this.save();
    return task;
  }

  deleteTask(id) {
    const index = this.state.tasks.findIndex((task) => task.id === id);
    if (index === -1) return false;
    this.state.tasks.splice(index, 1);
    this.save();
    return true;
  }

  runMeta(run) {
    const finished = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
    const started = new Date(run.startedAt).getTime();
    return {
      id: run.id,
      taskId: run.taskId,
      taskName: run.taskName,
      trigger: run.trigger,
      status: run.status,
      phase: run.phase,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt || null,
      durationMs: Math.max(0, finished - started),
      progress: run.progress,
      bundlePath: run.bundlePath || null,
      rawBundlePath: run.rawBundlePath || run.bundlePath || null,
      summaryPath: run.summaryPath || null,
      finalPath: run.finalPath || null,
      outputPath: run.outputPath || null,
      rawOutputPath: run.rawOutputPath || null,
      digestPath: run.digestPath || null,
      summary: run.summary ? {
        status: run.summary.status,
        platformId: run.summary.platformId || null,
        name: run.summary.name || null,
        profileId: run.summary.profileId || null,
        profileName: run.summary.profileName || null,
        chars: run.summary.chars || 0,
        error: run.summary.error || null,
        warning: run.summary.warning || null
      } : null,
      error: run.error || null,
      results: (run.results || []).map((result) => ({
        platformId: result.platformId,
        name: result.name,
        icon: result.icon,
        status: result.status,
        durationMs: result.durationMs || 0,
        chars: result.chars || 0,
        error: result.error || null,
        url: result.url || null,
        screenshot: result.screenshot || null
      }))
    };
  }

  /** 程序异常退出后，上次残留的 running 记录不可能再继续跑；启动时统一标成“中断”。 */
  settleInterruptedRuns(reason = '程序在这次采集结束前退出了（可能是浏览器被关闭或程序崩溃）。这次采集已中断，可以重新运行。') {
    let changed = 0;
    for (const run of this.state.runs) {
      if (run.status !== 'running') continue;
      run.status = 'failed';
      run.error = reason;
      run.finishedAt = run.finishedAt || nowIso();
      run.phase = '已中断';
      changed += 1;
    }
    if (changed) this.save();
    return changed;
  }

  upsertRunMeta(run) {
    const meta = this.runMeta(run);
    const index = this.state.runs.findIndex((item) => item.id === run.id);
    if (index === -1) this.state.runs.unshift(meta);
    else this.state.runs[index] = meta;
    this.state.runs = this.state.runs.slice(0, 80);
    if (run.status !== 'running') this.state.latestRunId = run.id;
    this.save();
    return meta;
  }

  getRunMeta(id) {
    return this.state.runs.find((run) => run.id === id) || null;
  }

  deleteRun(id) {
    if (!/^[a-zA-Z0-9_-]+$/.test(String(id))) return false;
    const index = this.state.runs.findIndex((run) => run.id === id);
    if (index === -1) return false;
    const meta = this.state.runs[index];
    this.state.runs.splice(index, 1);
    if (this.state.latestRunId === id) {
      const next = this.state.runs.find((run) => run.status !== 'running');
      this.state.latestRunId = next ? next.id : null;
    }
    const targets = [this.runJsonPath(id)];
    for (const candidate of [meta?.bundlePath, meta?.rawBundlePath, meta?.summaryPath, meta?.finalPath]) {
      if (candidate && candidate.startsWith(this.runsDir)) targets.push(candidate);
    }
    const artifacts = path.join(this.runsDir, id);
    for (const target of targets) {
      try {
        if (fs.existsSync(target) && fs.statSync(target).isFile()) fs.unlinkSync(target);
      } catch {
        // 忽略单个文件删除失败
      }
    }
    try {
      if (fs.existsSync(artifacts) && fs.statSync(artifacts).isDirectory()) {
        fs.rmSync(artifacts, { recursive: true, force: true });
      }
    } catch {
      // 忽略目录删除失败
    }
    this.save();
    return true;
  }

  runJsonPath(id) {
    return path.join(this.runsDir, `${id}.json`);
  }

  loadRun(id) {
    if (!/^[a-zA-Z0-9_-]+$/.test(String(id))) return null;
    const full = readJson(this.runJsonPath(id));
    if (full) return full;
    return this.getRunMeta(id);
  }

  bundlePathFor(run) {
    if (run.bundlePath) return run.bundlePath;
    return path.join(this.runsDir, `${run.id}.md`);
  }

  rawPathFor(run) {
    if (run.rawBundlePath && fs.existsSync(run.rawBundlePath)) return run.rawBundlePath;
    return this.bundlePathFor(run);
  }

  finalPathFor(run) {
    if (run.summaryPath && fs.existsSync(run.summaryPath)) return run.summaryPath;
    if (run.finalPath && fs.existsSync(run.finalPath)) return run.finalPath;
    return this.bundlePathFor(run);
  }

  // 桌面总文档：每次运行后把今天所有来源合并成一份 .md 直接放桌面，方便手动交给 AI。
  desktopDir() {
    const home = os.homedir();
    const candidates = [
      process.env.OneDrive ? path.join(process.env.OneDrive, 'Desktop') : '',
      path.join(home, 'Desktop'),
      path.join(home, 'OneDrive', 'Desktop'),
      path.join(home, '桌面')
    ].filter(Boolean);
    return candidates.find((dir) => fs.existsSync(dir)) || path.join(home, 'Desktop');
  }

  // 桌面总文档：始终是同一个文件（今日汇总.md），每次运行把今天所有来源合并进去，方便手动交给 AI。
  dailyDigestPath() {
    return path.join(this.desktopDir(), '今日汇总.md');
  }

  // 输出目录里按日期留档，避免覆盖历史；桌面只保留最新一份。
  dailyDigestArchivePath(date = new Date()) {
    const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return path.join(this.outputDir(), `今日汇总_${stamp}.md`);
  }

  outputDir() {
    const configured = String(this.state.settings.outputDir || '').trim();
    if (configured) {
      try {
        return path.resolve(configured);
      } catch {
        // 落回默认目录
      }
    }
    const documents = path.join(os.homedir(), 'Documents');
    if (fs.existsSync(documents)) return path.join(documents, 'AI Flow');
    return this.runsDir;
  }

  paths() {
    return {
      dataDir: this.dataDir,
      runsDir: this.runsDir,
      outputDir: this.outputDir(),
      desktopDir: this.desktopDir(),
      digestPath: this.dailyDigestPath(),
      logFile: path.join(this.dataDir, 'ai-flow.log')
    };
  }

  latestBundle() {
    const latest = this.state.runs.find((run) => run.status !== 'running' && (run.finalPath || run.bundlePath));
    if (!latest) return null;
    const file = this.finalPathFor(latest);
    try {
      return { run: latest, text: fs.readFileSync(file, 'utf8'), file };
    } catch {
      return null;
    }
  }

  outputStamp(taskName) {
    return `${localStamp()}_${taskName || '汇总'}`.replace(/[\\/:*?"<>|]/g, '_');
  }

  stats() {
    const cutoff = Date.now() - 7 * 24 * 3_600_000;
    const runs = this.state.runs.filter((run) => {
      const time = new Date(run.finishedAt || run.startedAt).getTime();
      return run.status !== 'running' && time >= cutoff;
    });
    const finished = runs.filter((run) => ['done', 'partial', 'failed', 'empty'].includes(run.status));
    let attempts = 0;
    let successes = 0;
    for (const run of runs) {
      for (const result of run.results || []) {
        if (['ok', 'partial', 'login', 'timeout', 'error', 'no-answer'].includes(result.status)) {
          attempts += 1;
          if (['ok', 'partial'].includes(result.status)) successes += 1;
        }
      }
    }
    const dayBuckets = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let offset = 6; offset >= 0; offset -= 1) {
      const start = new Date(today);
      start.setDate(start.getDate() - offset);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      const label = `${start.getMonth() + 1}/${start.getDate()}`;
      const count = finished.filter((run) => {
        const time = new Date(run.finishedAt || run.startedAt).getTime();
        return time >= start.getTime() && time < end.getTime();
      }).length;
      dayBuckets.push({ label, count });
    }
    return {
      completedRuns: finished.filter((run) => ['done', 'partial', 'empty'].includes(run.status)).length,
      totalRuns: finished.length,
      totalDurationMs: finished.reduce((sum, run) => sum + (run.durationMs || 0), 0),
      attempts,
      successes,
      successRate: attempts ? Math.round((successes / attempts) * 100) : null,
      days: dayBuckets
    };
  }

  publicState(extra = {}) {
    return {
      version: 2,
      serverNow: nowIso(),
      settings: this.state.settings,
      platforms: this.state.platforms.filter((platform) => !platform.hidden),
      hiddenPlatforms: this.state.platforms.filter((platform) => platform.hidden && platform.builtin).length,
      tasks: this.state.tasks,
      runs: this.state.runs.slice(0, 50),
      latestRunId: this.state.latestRunId,
      watermarks: this.watermarkSummary(),
      stats: this.stats(),
      ...extra
    };
  }
}
