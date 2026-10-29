'use strict';

const DEFAULT_PROMPT = `请检索并整理过去 24 小时内无畏契约（Valorant）真正发生的新鲜事，优先官方公告、VCT 赛事、战队/选手动态、版本与皮肤消息；不要趋势分析、攻略、科普或旧闻。每条包含：标题、发生了什么（1-2 句）、时间、来源链接（如能确认）。最多 15 条，按关注度排序。全部用 Markdown 输出（# 标题、- 列表），不要用代码块包住整篇。`;

const VALORANT_PROMPT = `请检索并整理过去 24-48 小时内无畏契约（Valorant）的资讯：VCT 赛事结果与赛程、官方公告/补丁、版本改动、新皮肤、战队与选手动态、教练/主播言论、社区热议。优先有明确人物/战队/来源、讨论度高的消息；区分已证实与未证实传闻，跳过冷门和旧闻。每条包含：标题、谁/哪支队伍、发生了什么、时间、来源链接（如能确认）。最多 15 条。全部用 Markdown 输出。`;

const HOTSPOT_PROMPT = `请检索并汇总今天（过去 24 小时）各领域的热点：时事/社会、财经/市场、科技/AI、游戏/电竞、体育/娱乐。每条包含：领域、标题、发生了什么（1-2 句事实）、时间、来源链接（如能确认）；不要只写 AI，也不要趋势分析、科普或旧闻。同类事件合并，最多 20 条。全部用 Markdown 输出（# 标题、- 列表），不要用代码块包住整篇。`;

const TASK_TEMPLATES = {
  valorant: { name: 'Valorant 资讯晚报', summaryProfile: 'valorant', prompt: VALORANT_PROMPT },
  hotspot: { name: '今日热点汇总', summaryProfile: 'hotspot', prompt: HOTSPOT_PROMPT },
  ai: { name: 'AI 早报', summaryProfile: 'ai', prompt: DEFAULT_PROMPT }
};

const SUMMARY_PROFILE_OPTIONS = [
  ['valorant', 'Valorant 资讯晚报（官方 / 赛事 / 战队 / 版本）'],
  ['hotspot', '今日热点汇总（全领域，按领域分组）'],
  ['ai', 'AI 早报（昨夜今晨新闻条目）'],
  ['custom', '自定义（使用设置里的总结指令）']
];

const SUMMARY_INSTRUCTION = `下面是我从多个 AI 分别获取的同一问题的回答汇总。请帮我：
1. 去掉重复、过时和互相矛盾的信息；
2. 按主题重新整合，保留关键数据、结论和来源链接；
3. 不要添加原文没有的事实；
4. 输出一份简洁的中文日报，开头给 3 条最重要的结论。

---
`;

const SCHEDULED_SUMMARY_INSTRUCTION = `下面是我从几个 AI 的定时任务里取回的回答原文，每段都标了平台和来源对话。请帮我：
1. 合并重复和高度相似的内容，保留各自独有的信息；
2. 按主题整合，保留关键数据、结论和来源链接；
3. 不要补充原文没有的事实；
4. 输出一份简洁的中文汇总，开头给 3 条最重要的结论。

---
`;

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const LOGIN_LABELS = {
  logged_in: ['s-logged_in', '已登录'],
  logged_out: ['s-logged_out', '未登录'],
  guest: ['s-guest', '可用（未登录）'],
  blocked: ['s-blocked', '需人机验证'],
  error: ['s-error', '检查失败'],
  checking: ['s-checking', '检测中'],
  unknown: ['s-unknown', '待检测']
};
const RUN_LABELS = { running: '运行中', done: '已完成', partial: '部分完成', empty: '未采集到新内容', failed: '失败' };
const RESULT_LABELS = {
  pending: '等待中',
  running: '采集中',
  waiting: '等待回答',
  ok: '成功',
  partial: '部分完成',
  'no-new': '没有新回答',
  'no-answer': '回答未生成',
  login: '需要登录',
  timeout: '超时',
  error: '失败',
  skipped: '已跳过'
};
const VIEW_META = {
  home: ['欢迎回来', '让多个 AI 为你收集信息', '定时获取 · 自动汇总 · 一键复制'],
  tasks: ['任务中心', '定时任务', '打开定时对话取回回答，不用再问一遍'],
  platforms: ['平台与登录', 'AI 平台', '独立浏览器会话，不保存密码'],
  history: ['历史记录', '每一次采集', '原文完整保留，随时复制或下载'],
  settings: ['设置', '运行设置', '浏览器、等待策略与本地数据']
};
const ICON_FILES = new Set(['openai', 'googlegemini', 'claude', 'perplexity', 'grok', 'muse']);

const state = {
  data: null,
  view: 'home',
  runFilter: 'all',
  runQuery: '',
  openRunId: null,
  runDetail: null,
  runFinalLoaded: false,
  settingsDirty: false,
  popoverHandler: null,
  toastTimer: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function safeHref(url) {
  return /^https?:\/\//i.test(String(url || '')) ? esc(url) : '#';
}

function icon(name, extra = '') {
  return `<svg class="icon ${extra}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (sameDay) return `今天 ${time}`;
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${time}`;
}

function fmtFullTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '0 秒';
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
  if (ms < 3_600_000) {
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);
    return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
  }
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  return minutes ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
}

function fmtBigDuration(ms) {
  if (!ms) return '0';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function scheduleLabel(schedule) {
  if (!schedule || schedule.type === 'manual') return '仅手动运行';
  if (schedule.type === 'interval') return `每 ${schedule.everyHours || 6} 小时`;
  if (schedule.type === 'weekly') {
    return `每${WEEKDAYS[Number(schedule.weekday ?? 1) % 7]} ${schedule.time || '09:00'}`;
  }
  return `每天 ${schedule.time || '09:00'}`;
}

function nextRunText(iso) {
  if (!iso) return '未排程';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '未排程';
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`;
  if (date.toDateString() === tomorrow.toDateString()) return `明天 ${time}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

function taskPlatforms(task) {
  const ids = task.mode === 'scheduled'
    ? (task.sources || []).map((source) => source.platformId)
    : (task.platformIds || []);
  return [...new Set(ids)].map((id) => platformById(id)).filter(Boolean);
}

function sourceLabel(source) {
  if (source.keyword) return `「${source.keyword}」`;
  const url = String(source.url || '');
  try {
    const parsed = new URL(url);
    const tail = parsed.pathname.replace(/^\/|\/$/g, '').split('/').filter(Boolean).slice(-1)[0] || parsed.hostname;
    return tail.slice(0, 26);
  } catch {
    return url.replace(/^https?:\/\//, '').slice(0, 26) || '未填写';
  }
}

function sourceSummary(task) {
  const sources = task.sources || [];
  if (!sources.length) return '还没有添加定时对话来源';
  const shown = sources.slice(0, 3).map(sourceLabel).join('、');
  return `读取 ${sources.length} 条定时对话：${shown}${sources.length > 3 ? ' 等' : ''}`;
}

function waitSummary(task) {
  const minutes = Number(task?.wait?.minutes ?? state.data?.settings?.waitMinutes ?? 60);
  if (!(minutes > 0)) return '不等回答，读到什么就汇总';
  const poll = Number(task?.wait?.pollMinutes ?? state.data?.settings?.pollMinutes ?? 5);
  return `没生成回答时最多等 ${Math.round(minutes)} 分钟，每 ${Math.max(1, Math.round(poll))} 分钟查一次`;
}

function conversationSummary(task) {
  const ids = task.platformIds || [];
  if (!ids.length) return '未选择平台';
  const bound = ids.filter((id) => task.conversations?.[id]?.url).length;
  return bound ? `复用 ${bound}/${ids.length} 个对话` : '首次运行新建对话';
}

function modeBadge(task) {
  return `<span class="badge ${task.mode === 'scheduled' ? 'mode-scheduled' : 'mode-prompt'}">${task.mode === 'scheduled' ? '定时回答' : '提示词'}</span>`;
}

function logoInner(platform) {
  if (platform && ICON_FILES.has(platform.icon)) {
    return `<img src="/assets/${platform.icon}.svg" alt="">`;
  }
  const letter = String(platform?.name || '?').trim().slice(0, 1).toUpperCase();
  return `<span class="custom-logo">${esc(letter)}</span>`;
}

function platformLogo(platform, className = 'platform-logo') {
  return `<span class="${className}">${logoInner(platform)}</span>`;
}

function miniLogo(platform, status = '') {
  return `<span class="mini-logo ${status}" title="${esc(platform?.name || '')}">${logoInner(platform)}<span class="mini-state"></span></span>`;
}

function platformById(id) {
  return state.data?.platforms.find((platform) => platform.id === id) || null;
}

function loginInfo(platform) {
  if (!platform) return { cls: 'unknown', text: '待检测' };
  if (platform.enabled === false) {
    return platform.login === 'logged_in'
      ? { cls: 's-logged_in', text: '已登录 · 已停用' }
      : { cls: 'unknown', text: '已停用' };
  }
  const [cls, text] = LOGIN_LABELS[platform.login] || LOGIN_LABELS.unknown;
  return { cls, text };
}

function chip(status, text) {
  return `<span class="chip ${esc(status)}">${esc(text || RESULT_LABELS[status] || RUN_LABELS[status] || status)}</span>`;
}

function runGoodCount(run) {
  return (run.results || []).filter((result) => ['ok', 'partial'].includes(result.status)).length;
}

function toast(message, type = 'info', options = {}) {
  const root = document.getElementById('toast-root');
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  const iconName = type === 'error' ? 'x' : type === 'success' ? 'check' : 'spark';
  node.innerHTML = `${icon(iconName)}<span></span>${options.action ? '<button class="toast-action"></button>' : ''}`;
  node.querySelector('span').textContent = message;
  if (options.action) {
    const button = node.querySelector('.toast-action');
    button.textContent = options.action.label;
    button.addEventListener('click', () => {
      node.remove();
      options.action.onClick();
    });
  }
  root.appendChild(node);
  const duration = options.duration || (options.action ? 6500 : 3800);
  setTimeout(() => node.remove(), duration);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) {
    const error = new Error(data?.error?.message || `请求失败（${response.status}）`);
    error.code = data?.error?.code || 'ERROR';
    throw error;
  }
  return data;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function closePopover() {
  const root = document.getElementById('menu-root');
  if (root) root.innerHTML = '';
  if (state.popoverHandler) {
    document.removeEventListener('click', state.popoverHandler);
    state.popoverHandler = null;
  }
}

function openPopover(anchor, html) {
  closePopover();
  const root = document.getElementById('menu-root');
  root.innerHTML = `<div class="popover-menu">${html}</div>`;
  const menu = root.firstElementChild;
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth || 160;
  const height = menu.offsetHeight || 120;
  let left = Math.min(window.innerWidth - width - 12, Math.max(12, rect.right - width));
  let top = rect.bottom + 7;
  if (top + height > window.innerHeight - 12) top = Math.max(12, rect.top - height - 7);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  setTimeout(() => {
    const handler = (event) => {
      if (!menu.contains(event.target)) closePopover();
    };
    document.addEventListener('click', handler);
    state.popoverHandler = handler;
  }, 0);
}

function openModal(html) {
  closePopover();
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-backdrop">${html}</div>`;
  const backdrop = root.firstElementChild;
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) closeModal();
  });
  return root;
}

function closeModal() {
  const root = document.getElementById('modal-root');
  if (root) root.innerHTML = '';
  state.openRunId = null;
  state.runDetail = null;
  state.runFinalLoaded = false;
}

function runStatusChip(status) {
  return `<span class="chip ${status}">${esc(RUN_LABELS[status] || status)}</span>`;
}

function platformStatusChip(platform) {
  const info = loginInfo(platform);
  return `<span class="platform-status"><span class="status-dot"></span>${esc(info.text)}</span>`;
}

function render() {
  if (!state.data) return;
  const desktop = Boolean(state.data.desktop);
  document.body.classList.toggle('shell', desktop);
  if (desktop) initWindowChrome();
  renderNav();
  renderTopbar();
  renderView();
}

function renderNav() {
  $$('.nav-item').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === state.view);
  });
}

function renderTopbar() {
  const meta = VIEW_META[state.view] || VIEW_META.home;
  $('#eyebrow').textContent = meta[0];
  $('#headline').textContent = meta[1];
  $('#subline').textContent = meta[2];
  const latest = state.data?.runs?.find((run) => run.status !== 'running');
  const seen = localStorage.getItem('aiFlowSeenRun');
  const dot = $('#bell-dot');
  if (latest && latest.id !== seen) dot.hidden = false;
  else dot.hidden = true;
}

function renderView() {
  if (!state.data) return;
  if (state.view === 'settings' && state.settingsDirty) return;
  closePopover();
  const view = document.getElementById('view');
  let html = '';
  if (state.view === 'home') html = renderHome();
  else if (state.view === 'tasks') html = renderTasks();
  else if (state.view === 'platforms') html = renderPlatforms();
  else if (state.view === 'history') html = renderHistory();
  else if (state.view === 'settings') html = renderSettings();
  view.innerHTML = html;
  if (state.view === 'settings') bindSettings();
  view.classList.remove('view');
  void view.offsetWidth;
  view.classList.add('view');
}

function needsLoginSetup() {
  const platforms = (state.data?.platforms || []).filter((platform) => platform.enabled);
  if (!platforms.length) return false;
  if (!platforms.some((platform) => platform.login === 'logged_in')) return true;
  const main = platforms.filter((platform) => ['chatgpt', 'gemini'].includes(platform.id));
  return main.length > 0 && !main.some((platform) => platform.login === 'logged_in');
}

function renderHome() {
  const hasRuns = (state.data.runs || []).some((run) => run.status !== 'running');
  const needsSetup = !hasRuns && needsLoginSetup();
  return `
    ${needsSetup ? setupStrip() : ''}
    ${platformStrip()}
    <div class="home-grid">
      <div class="home-col">
        ${currentCard()}
        ${recentPanel()}
      </div>
      <div class="home-col">
        ${schedulePanel()}
        ${statsPanel()}
      </div>
    </div>`;
}

function setupStrip() {
  const kind = state.data.settings.browser === 'chrome' ? 'Chrome' : 'Edge';
  return `<div class="setup-strip">
    <div class="setup-icon">${icon('shield')}</div>
    <div class="setup-copy">
      <b>第一次使用：登录一次，然后抓链接</b>
      <span>① 在 AI Flow 独立的 ${kind} 窗口里登录你的 AI 账号（你设置的定时对话只有登录后才看得到）；② 新建任务时选「读取定时回答」，打开那条定时对话后点「抓取当前链接」；③ 点运行，回答会自动汇总成一份 Markdown。访客模式只适合「发送提示词」，读不到账号里的定时对话。</span>
    </div>
    <div class="setup-actions">
      <button class="btn" data-action="login-guide">打开登录</button>
      <button class="btn dark" data-action="new-task">创建任务</button>
    </div>
  </div>`;
}

function platformStrip() {
  const platforms = state.data.platforms;
  const cards = platforms.map((platform) => {
    const info = loginInfo(platform);
    return `<div class="platform-card ${info.cls} ${platform.enabled === false ? 'is-disabled' : ''}" data-action="open-platforms" title="管理 ${esc(platform.name)}">
      <button class="kebab" data-action="platform-menu" data-id="${esc(platform.id)}" aria-label="${esc(platform.name)} 菜单">${icon('more')}</button>
      ${platformLogo(platform)}
      <div class="platform-name">${esc(platform.name)}</div>
      <div class="platform-status"><span class="status-dot"></span>${esc(info.text)}</div>
    </div>`;
  }).join('');
  return `<div class="platform-grid">${cards}
    <button class="add-platform" data-action="add-platform">
      <span class="plus-circle">${icon('plus')}</span>
      <span>添加平台</span>
    </button>
  </div>`;
}

function currentCard() {
  const data = state.data;
  const active = data.currentRun;
  const dateLabel = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date());

  if (active) {
    const total = active.progress?.total || active.results.length || 1;
    const done = active.progress?.done || 0;
    const percent = Math.round((done / total) * 100);
    const results = active.results || [];
    const minis = results.slice(0, 7).map((result) => {
      const platform = platformById(result.platformId) || { name: result.name, icon: result.icon };
      return miniLogo(platform, result.status);
    }).join('');
    const more = results.length > 7 ? `<span class="mini-more">+${results.length - 7}</span>` : '';
    const waiting = results.filter((result) => result.status === 'waiting').length;
    return `<div class="current-card">
      <div class="current-inner">
        <div class="ring" style="--p:${percent}">
          <div class="ring-center"><strong>${done}/${total}</strong><span>PROGRESS</span></div>
        </div>
        <div class="current-main">
          <div class="current-headline">
            <h2 class="current-title">${esc(active.taskName)}</h2>
            <span class="pill running"><span class="dot"></span>运行中</span>
            ${waiting ? `<span class="pill waiting"><span class="dot"></span>等待 ${waiting} 个定时回答</span>` : ''}
          </div>
          <p class="current-sub">${esc(active.phase || '正在采集')} · 已完成 ${done}/${total} 个来源</p>
          <div class="progress-track"><div class="progress-bar" style="width:${percent}%"></div></div>
          <div class="current-footer">
            <div class="platform-mini-row">${minis}${more}</div>
            <div class="current-actions">
              <button class="btn soft" data-action="stop-waiting" data-id="${esc(active.taskId)}">强制结束</button>
              <button class="btn soft" data-action="open-run" data-id="${esc(active.id)}">查看进度</button>
            </div>
          </div>
        </div>
      </div>
      <div class="current-date">${esc(dateLabel)}</div>
    </div>`;
  }

  const tasks = data.tasks || [];
  const runnable = (task) => (task.mode === 'scheduled' ? (task.sources || []).length > 0 : (task.platformIds || []).length > 0);
  const nextTask = tasks
    .filter((task) => task.enabled && task.nextRunAt)
    .sort((a, b) => new Date(a.nextRunAt) - new Date(b.nextRunAt))[0]
    || tasks.find(runnable)
    || tasks[0];

  if (!nextTask) {
    return `<div class="current-card">
      <div class="current-inner">
        <div class="ring" style="--p:0"><div class="ring-center"><strong>0</strong><span>TASKS</span></div></div>
        <div class="current-main">
          <div class="current-headline"><h2 class="current-title">还没有任务</h2></div>
          <p class="current-sub">先在 AI 里设好定时任务，再在这里登记那条对话；到点自动取回回答并汇总成一份文档。</p>
          <div class="current-footer">
            <div class="platform-mini-row">${state.data.platforms.slice(0, 6).map((p) => miniLogo(p)).join('')}</div>
            <div class="current-actions"><button class="btn dark" data-action="new-task">创建第一个任务</button></div>
          </div>
        </div>
      </div>
      <div class="current-date">${esc(dateLabel)}</div>
    </div>`;
  }

  const platforms = taskPlatforms(nextTask);
  const miniLogos = platforms.map((p) => miniLogo(p)).join('');
  const enabledText = nextTask.enabled ? `下次 ${nextRunText(nextTask.nextRunAt)}` : '定时未启用';
  const targetText = nextTask.mode === 'scheduled' ? sourceSummary(nextTask) : `${platforms.length} 个 AI 平台`;
  const ringLabel = nextTask.enabled && nextTask.nextRunAt
    ? `${pad2(new Date(nextTask.nextRunAt).getHours())}:${pad2(new Date(nextTask.nextRunAt).getMinutes())}`
    : '待';
  const lastRun = data.runs.find((run) => run.taskId === nextTask.id && run.status !== 'running');
  const latestButton = data.latestRunId
    ? `<button class="btn" data-action="open-run" data-id="${esc(data.latestRunId)}">最新汇总</button>`
    : '';
  return `<div class="current-card">
    <div class="current-inner">
      <div class="ring" style="--p:${nextTask.enabled ? 8 : 0}">
        <div class="ring-center"><strong>${esc(ringLabel)}</strong><span>${nextTask.enabled ? 'NEXT' : 'PAUSED'}</span></div>
      </div>
      <div class="current-main">
        <div class="current-headline">
          <h2 class="current-title">${esc(nextTask.name)}</h2>
          <span class="pill">${esc(scheduleLabel(nextTask.schedule))}</span>
          <span class="pill">${nextTask.mode === 'scheduled' ? '读取定时回答' : '发送提示词'}</span>
        </div>
        <p class="current-sub">${esc(enabledText)} · ${esc(targetText)} · ${esc(waitSummary(nextTask))}${lastRun ? ` · 上次 ${fmtDateTime(lastRun.finishedAt)}` : ''}</p>
        <div class="current-footer">
          <div class="platform-mini-row">${miniLogos || '<span class="mini-more">还没有选择平台</span>'}</div>
          <div class="current-actions">
            ${latestButton}
            <button class="btn dark" data-action="run-task" data-id="${esc(nextTask.id)}">${icon('play')}立即运行</button>
          </div>
        </div>
      </div>
    </div>
    <div class="current-date">${esc(dateLabel)}</div>
  </div>`;
}

function schedulePanel() {
  const tasks = state.data.tasks || [];
  const rows = tasks.slice(0, 4).map((task) => `
    <div class="schedule-item">
      <span class="schedule-icon">${icon('doc')}</span>
      <div class="schedule-copy">
        <button class="schedule-name" data-action="edit-task" data-id="${esc(task.id)}">${esc(task.name)}</button>
        <div class="schedule-meta">${esc(scheduleLabel(task.schedule))}${task.enabled && task.nextRunAt ? ` · 下次 ${esc(nextRunText(task.nextRunAt))}` : ' · 未启用'}</div>
      </div>
      <div class="schedule-actions">
        <button class="switch ${task.enabled ? 'on' : ''}" role="switch" aria-checked="${task.enabled}" data-toggle-task="${esc(task.id)}" aria-label="启用 ${esc(task.name)}"></button>
        <button class="kebab" style="position:static;width:24px;height:24px;opacity:.55" data-action="task-menu" data-id="${esc(task.id)}" aria-label="任务菜单">${icon('more')}</button>
      </div>
    </div>`).join('');

  return `<section class="panel">
    <div class="panel-head">
      <h2 class="panel-title">定时任务</h2>
      <button class="panel-link" data-action="new-task">${icon('plus')}新建</button>
    </div>
    <div class="schedule-list">
      ${rows || `<div class="empty" style="padding:24px 8px 14px">
        <div class="empty-title">还没有定时任务</div>
        <div class="empty-text">创建一个每天固定时间运行的任务。</div>
        <button class="btn" data-action="new-task">新建任务</button>
      </div>`}
    </div>
  </section>`;
}

function recentPanel() {
  const runs = (state.data.runs || []).filter((run) => run.status !== 'running').slice(0, 4);
  const rows = runs.map((run) => `
    <div class="recent-row" data-action="open-run" data-id="${esc(run.id)}">
      <span class="recent-icon">${icon('doc')}</span>
      <div class="recent-copy">
        <div class="recent-name">${esc(run.taskName)}</div>
        <div class="recent-time">${esc(fmtDateTime(run.finishedAt || run.startedAt))}${run.trigger === 'schedule' ? ' · 定时' : ' · 手动'}</div>
      </div>
      ${chip(run.status, RUN_LABELS[run.status])}
    </div>`).join('');
  return `<section class="panel">
    <div class="panel-head">
      <h2 class="panel-title">最近记录</h2>
      <button class="panel-link" data-action="go-history">查看全部 ${icon('arrow')}</button>
    </div>
    <div class="recent-list">
      ${rows || `<div class="empty" style="padding:26px 8px 18px">
        <div class="empty-icon">${icon('history')}</div>
        <div class="empty-title">还没有汇总记录</div>
        <div class="empty-text">任务运行完成后，每个 AI 的回答和合并后的文本会完整保存在这里。</div>
      </div>`}
    </div>
  </section>`;
}

function sparkline(days) {
  const width = 100;
  const height = 40;
  const counts = days.map((day) => day.count);
  const max = Math.max(1, ...counts);
  if (!counts.some((count) => count > 0)) {
    return `<svg class="spark-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <line class="spark-grid" x1="2" y1="${height - 8}" x2="98" y2="${height - 8}"/>
    </svg><span class="spark-empty-text">近 7 天还没有运行</span>`;
  }
  const step = (width - 8) / Math.max(1, counts.length - 1);
  const points = counts.map((count, index) => [4 + index * step, height - 7 - (count / max) * (height - 16)]);
  let path = `M${points[0][0]},${points[0][1]}`;
  for (let index = 1; index < points.length; index += 1) {
    const [x0, y0] = points[index - 1];
    const [x1, y1] = points[index];
    const middle = (x0 + x1) / 2;
    path += ` C${middle},${y0} ${middle},${y1} ${x1},${y1}`;
  }
  const last = points[points.length - 1];
  return `<svg class="spark-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
    <defs>
      <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#7d9aff" stop-opacity=".26"/>
        <stop offset="1" stop-color="#7d9aff" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <line class="spark-grid" x1="2" y1="${height - 7}" x2="98" y2="${height - 7}"/>
    <path d="${path} L${last[0]},${height - 4} L${points[0][0]},${height - 4} Z" fill="url(#sparkFill)" stroke="none"/>
    <path d="${path}" fill="none" stroke="#7d9aff" stroke-width="1.6" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="1.9" fill="#5f82ff"/>
  </svg>`;
}

function statsPanel() {
  const stats = state.data.stats || { completedRuns: 0, totalDurationMs: 0, successRate: null, days: [] };
  return `<section class="panel">
    <div class="panel-head">
      <h2 class="panel-title">运行统计</h2>
      <span class="pill">近 7 天</span>
    </div>
    <div class="stats-grid">
      <div class="stat-tile">
        <div class="stat-icon">${icon('doc')}</div>
        <div class="stat-value">${stats.completedRuns || 0}</div>
        <div class="stat-label">完成任务</div>
      </div>
      <div class="stat-tile">
        <div class="stat-icon">${icon('clock')}</div>
        <div class="stat-value">${stats.totalDurationMs ? esc(fmtBigDuration(stats.totalDurationMs)) : '0'}</div>
        <div class="stat-label">累计运行</div>
      </div>
      <div class="stat-tile">
        <div class="stat-icon">${icon('chart')}</div>
        <div class="stat-value">${stats.successRate === null ? '—' : `${stats.successRate}<small>%</small>`}</div>
        <div class="stat-label">采集成功率</div>
      </div>
    </div>
    <div class="spark-wrap">${sparkline(stats.days || [])}</div>
    <div class="spark-labels">${(stats.days || []).map((day) => `<span>${esc(day.label)}</span>`).join('')}</div>
  </section>`;
}

function renderTasks() {
  const tasks = state.data.tasks || [];
  const list = tasks.map((task) => {
    const platforms = taskPlatforms(task);
    const pills = platforms.map((p) => `<span class="platform-pill">${logoInner(p)}${esc(p.name)}</span>`).join('');
    const lastRun = state.data.runs.find((run) => run.taskId === task.id && run.status !== 'running');
    return `<article class="task-card">
      <div class="task-top">
        <div class="task-main">
          <div class="task-title-row">
            <h3 class="task-title">${esc(task.name)}</h3>
            ${modeBadge(task)}
            ${task.isExample ? '<span class="badge example">模板</span>' : ''}
            ${task.enabled ? '<span class="badge">已启用</span>' : '<span class="badge">未启用</span>'}
          </div>
          <p class="task-prompt">${esc(task.mode === 'scheduled' ? sourceSummary(task) : task.prompt)}</p>
          <div class="platform-pills">${pills || '<span class="platform-pill">未选择平台</span>'}</div>
          <div class="task-meta-row">
            <span>${icon('clock')}${esc(scheduleLabel(task.schedule))}</span>
            <span>${icon('refresh')}${task.enabled ? `下次 ${esc(nextRunText(task.nextRunAt))}` : '未启用定时'}</span>
            ${task.mode === 'scheduled' ? `<span>${icon('spark')}${esc(waitSummary(task))}</span>` : `<span>${icon('link')}${esc(conversationSummary(task))}</span>`}
            ${lastRun ? `<span>${icon('history')}上次 ${esc(fmtDateTime(lastRun.finishedAt))}</span>` : ''}
          </div>
        </div>
        <div class="task-actions">
          <button class="switch ${task.enabled ? 'on' : ''}" role="switch" aria-checked="${task.enabled}" data-toggle-task="${esc(task.id)}" aria-label="启用 ${esc(task.name)}"></button>
          <button class="btn soft" data-action="run-task" data-id="${esc(task.id)}">${icon('play')}运行</button>
          <button class="btn" data-action="edit-task" data-id="${esc(task.id)}">编辑</button>
          <button class="kebab" style="position:static;width:30px;height:30px" data-action="task-menu" data-id="${esc(task.id)}" aria-label="更多">${icon('more')}</button>
        </div>
      </div>
    </article>`;
  }).join('');

  return `<div class="page-toolbar">
    <div><h2>所有任务</h2><p>默认按「读取定时回答」运行：按设定时间打开每条定时对话，复制定时生成的回答并汇总。</p></div>
    <div class="toolbar-actions"><button class="btn dark" data-action="new-task">${icon('plus')}新建任务</button></div>
  </div>
  <div class="task-list">
    ${list || `<section class="panel"><div class="empty">
      <div class="empty-icon">${icon('tasks')}</div>
      <div class="empty-title">还没有任务</div>
      <div class="empty-text">创建一个任务，让 AI Flow 每天定时打开各平台的定时对话，把已经生成的回答汇总到一份文档。</div>
      <button class="btn dark" data-action="new-task">创建任务</button>
    </div></section>`}
  </div>`;
}

function renderPlatforms() {
  const data = state.data;
  const browser = data.browser;
  const installedCount = browser.installed ? Object.values(browser.installed).filter(Boolean).length : 0;
  const cards = data.platforms.map((platform) => {
    const info = loginInfo(platform);
    const lastCheck = platform.lastCheckAt ? `上次检查 ${fmtDateTime(platform.lastCheckAt)}` : '尚未检查登录状态';
    const note = platform.loginError || platform.homeNote || '';
    const canOpen = platform.login !== 'checking';
    return `<div class="platform-card large ${info.cls} ${platform.enabled === false ? 'is-disabled' : ''}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between">
        ${platformLogo(platform)}
        <button class="switch ${platform.enabled ? 'on' : ''}" role="switch" aria-checked="${platform.enabled}" data-toggle-platform="${esc(platform.id)}" aria-label="启用 ${esc(platform.name)}"></button>
      </div>
      <div class="platform-name">${esc(platform.name)}</div>
      <div class="platform-status"><span class="status-dot"></span>${esc(info.text)}</div>
      <div class="platform-note" title="${esc(note)}">${esc(note)}</div>
      <div class="platform-actions">
        <button class="btn sm" data-action="check-platform" data-id="${esc(platform.id)}" ${platform.login === 'checking' ? 'disabled' : ''}>${platform.login === 'checking' ? '检查中…' : '检查登录'}</button>
        <button class="btn sm soft" data-action="open-platform" data-id="${esc(platform.id)}" ${canOpen ? '' : 'disabled'}>${platform.login === 'logged_in' ? '打开页面' : '打开登录'}</button>
        <button class="btn sm ghost" data-action="delete-platform" data-id="${esc(platform.id)}">${platform.builtin ? '移除' : '删除'}</button>
      </div>
      <div class="platform-note">${esc(lastCheck)}</div>
    </div>`;
  }).join('');

  return `<div class="browser-panel">
    <span class="browser-icon">${icon('browser')}</span>
    <div class="browser-info">
      <b>自动化浏览器 · ${esc(browser.label || '未检测到')}${browser.running ? ' · 运行中' : ''}</b>
      <span>AI Flow 使用独立的 ${esc(browser.label || '浏览器')} 配置。在这里登录一次，之后自动复用；不会关闭或修改你日常使用的浏览器。登录后这个页面会自动更新状态。</span>
      <span>${installedCount ? `检测到 ${installedCount} 个可用浏览器` : '没有检测到 Edge 或 Chrome'}${browser.executable ? ` · ${esc(browser.executable)}` : ''}</span>
    </div>
    <div class="browser-actions">
      <button class="btn" data-action="close-browser" ${browser.running ? '' : 'disabled'}>关闭自动化浏览器</button>
      <button class="btn" data-action="check-all">检查全部</button>
      <button class="btn dark" data-action="login-guide">打开登录</button>
    </div>
  </div>
  <div class="page-toolbar">
    <div><h2>平台</h2><p>AI Flow 只读取你已登录网页中的回答，不接入 API，也不上传内容。</p></div>
    <div class="toolbar-actions">
      ${data.hiddenPlatforms ? `<button class="btn" data-action="restore-platforms">${icon('refresh')}恢复默认平台</button>` : ''}
      <button class="btn" data-action="add-platform">${icon('plus')}添加平台</button>
    </div>
  </div>
  <div class="platform-grid large">
    ${cards}
    <button class="add-platform large" data-action="add-platform">
      <span class="plus-circle">${icon('plus')}</span>
      <span>添加自定义平台</span>
    </button>
  </div>
  <p class="form-hint" style="margin-top:14px">网站改版可能导致页面识别失效。遇到失败时，可以点「打开页面」手动查看，并在运行记录里查看失败原因和诊断截图。</p>`;
}

function renderHistory() {
  const query = (state.runQuery || '').trim().toLowerCase();
  const runs = (state.data.runs || []).filter((run) => {
    if (state.runFilter === 'done') return ['done', 'partial'].includes(run.status);
    if (state.runFilter === 'failed') return ['failed', 'empty'].includes(run.status);
    return true;
  }).filter((run) => !query || String(run.taskName || '').toLowerCase().includes(query));
  const rows = runs.map((run) => {
    const good = runGoodCount(run);
    const total = run.results?.length || 0;
    return `<tr data-action="open-run" data-id="${esc(run.id)}">
      <td><div class="run-name"><span class="recent-icon">${icon('doc')}</span><span>${esc(run.taskName)}</span>${run.mode === 'scheduled' ? '<span class="mode-tag">定时回答</span>' : ''}</div></td>
      <td>${esc(fmtFullTime(run.finishedAt || run.startedAt))}</td>
      <td class="muted">${run.trigger === 'schedule' ? '定时' : '手动'}</td>
      <td>${good}/${total}</td>
      <td>${chip(run.status, RUN_LABELS[run.status])}</td>
      <td class="right">
        <button class="btn sm" data-action="open-run" data-id="${esc(run.id)}">查看</button>
        <button class="btn sm danger" data-action="delete-run" data-id="${esc(run.id)}" aria-label="删除这条记录">${icon('trash')}</button>
      </td>
    </tr>`;
  }).join('');
  return `<div class="page-toolbar">
    <div><h2>历史记录</h2><p>每次运行都会保存合并后的 Markdown 文档和每条定时对话的原文。</p></div>
    <div class="toolbar-actions">
      <input class="text-input search-input" id="run-search" placeholder="搜索任务名" value="${esc(state.runQuery || '')}">
      <div class="filters">
        <button class="filter-chip ${state.runFilter === 'all' ? 'active' : ''}" data-action="filter-runs" data-filter="all">全部</button>
        <button class="filter-chip ${state.runFilter === 'done' ? 'active' : ''}" data-action="filter-runs" data-filter="done">有回答</button>
        <button class="filter-chip ${state.runFilter === 'failed' ? 'active' : ''}" data-action="filter-runs" data-filter="failed">没采到</button>
      </div>
    </div>
  </div>
  <section class="panel" style="padding:16px 18px">
    ${rows ? `<div class="table-wrap"><table class="run-table">
      <thead><tr><th>任务</th><th>时间</th><th>来源</th><th>采集</th><th>状态</th><th class="right">操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>` : `<div class="empty">
      <div class="empty-icon">${icon('history')}</div>
      <div class="empty-title">${state.runFilter === 'all' && !query ? '还没有运行记录' : '没有符合条件的记录'}</div>
      <div class="empty-text">运行一次任务后，这里会保留完整原文，方便随时复制。</div>
      <button class="btn" data-action="new-task">新建任务</button>
    </div>`}
  </section>`;
}

function flagButton(name, on, label = '', disabled = false) {
  return `<button type="button" class="switch ${on ? 'on' : ''}" role="switch" aria-checked="${Boolean(on)}" data-flag="${esc(name)}" aria-label="${esc(label)}" ${disabled ? 'disabled' : ''}></button>`;
}

function toggleRow(title, description, name, on, disabled = false) {
  return `<div class="toggle-row">
    <div class="toggle-copy"><b>${esc(title)}</b><span>${esc(description)}</span></div>
    ${flagButton(name, on, title, disabled)}
  </div>`;
}

function renderSettings() {
  const data = state.data;
  const settings = data.settings;
  const browser = data.browser;
  const installed = browser.installed || {};
  return `<form id="settings-form">
    <div class="settings-grid">
      <section class="settings-card">
        <div class="settings-head">
          <span class="settings-icon">${icon('browser')}</span>
          <div><h3>登录与浏览器</h3><p>在 AI Flow 的独立浏览器里登录一次；不保存账号密码。</p></div>
        </div>
        <div class="field">
          <label>自动化浏览器</label>
          <select class="select-input" name="browser">
            <option value="edge" ${settings.browser === 'edge' ? 'selected' : ''} ${installed.edge ? '' : 'disabled'}>Microsoft Edge${installed.edge ? '（已安装）' : '（未安装）'}</option>
            <option value="chrome" ${settings.browser === 'chrome' ? 'selected' : ''} ${installed.chrome ? '' : 'disabled'}>Google Chrome${installed.chrome ? '（已安装）' : '（未安装）'}</option>
          </select>
          <div class="hint">AI Flow 会为这个浏览器创建独立配置；切换浏览器后需要重新登录一次。</div>
        </div>
        <div class="profile-line">
          ${icon('shield')}
          <span>新版 Edge / Chrome 会加密登录 Cookie，无法复制日常浏览器的登录态。登录状态只保存在本机。</span>
        </div>
        <div class="settings-actions" style="justify-content:flex-start;margin-top:10px">
          <button type="button" class="btn" data-action="login-guide">打开登录</button>
          <button type="button" class="btn" data-action="check-all">检查登录状态</button>
        </div>
        ${toggleRow('在后台最小化运行', '运行任务时把自动化浏览器最小化，减少打扰。', 'minimizeDuringRun', settings.minimizeDuringRun)}
        ${toggleRow('显示浏览器窗口', '关闭后使用无头模式。部分网站的人机验证可能因此失败。', 'visible', settings.visible)}
      </section>

      <section class="settings-card">
        <div class="settings-head">
          <span class="settings-icon">${icon('clock')}</span>
          <div><h3>定时回答与等待</h3><p>回答还没生成时，AI Flow 会按间隔检查这条定时对话；到次数上限就停，不会再无限重采。</p></div>
        </div>
        <div class="two-fields">
          <div class="field">
            <label>默认最多等待（分钟）</label>
            <input type="number" name="waitMinutes" min="0" max="720" step="5" value="${esc(settings.waitMinutes ?? 60)}">
            <div class="hint">0 表示不等。新建任务的默认值，可在任务里单独改。</div>
          </div>
          <div class="field">
            <label>检查间隔（分钟）</label>
            <input type="number" name="pollMinutes" min="1" max="120" value="${esc(settings.pollMinutes ?? 5)}">
            <div class="hint">等待期间每隔这么久重新读一次对话。</div>
          </div>
        </div>
        <div class="two-fields">
          <div class="field">
            <label>每个来源最多检查（次）</label>
            <input type="number" name="maxAttempts" min="1" max="20" value="${esc(settings.maxAttempts || 6)}">
            <div class="hint">没有新回答时最多重试几次；到上限标记「超时」并结束，不会无限循环。</div>
          </div>
          <div class="field">
            <label>同时读取（个来源）</label>
            <input type="number" name="concurrency" min="1" max="4" value="${esc(settings.concurrency || 2)}">
            <div class="hint">并发读取缩短总时长；默认 2，遇到限流可改回 1。</div>
          </div>
        </div>
        <div class="two-fields">
          <div class="field">
            <label>单个来源最长读取（秒）</label>
            <input type="number" name="sourceTimeoutSec" min="60" max="900" step="30" value="${esc(settings.sourceTimeoutSec || 180)}">
            <div class="hint">超过这个时间就结束这一条并标记超时，不会一直卡在「采集中」。</div>
          </div>
          <div class="field">
            <label>无响应强制结束（分钟）</label>
            <input type="number" name="stallMinutes" min="5" max="120" step="5" value="${esc(settings.stallMinutes || 15)}">
            <div class="hint">连续这么久没有任何进展就强制收尾，避免界面永远停在采集。</div>
          </div>
        </div>
        <div class="two-fields">
          <div class="field">
            <label>回答稳定判定（秒）</label>
            <input type="number" name="stable" min="1.2" max="15" step="0.2" value="${(settings.stableMs / 1000).toFixed(1)}">
            <div class="hint">仅「发送提示词」模式使用：文本停止变化才算生成完。</div>
          </div>
          <div class="field">
            <label>单平台最长等待（秒）</label>
            <input type="number" name="maxWait" min="60" max="900" step="10" value="${settings.maxWaitSec}">
            <div class="hint">超时后保留已生成内容，并标记为部分完成。</div>
          </div>
        </div>
        <div class="two-fields">
          <div class="field">
            <label>代理地址（可选）</label>
            <input type="text" name="proxy" value="${esc(settings.proxy || '')}" placeholder="http://127.0.0.1:7897">
            <div class="hint">留空则跟随系统设置。</div>
          </div>
          <div class="field"></div>
        </div>
        <div class="two-fields">
          <div class="field">
            <label>补跑窗口（小时）</label>
            <input type="number" name="catchUpHours" min="1" max="72" value="${settings.catchUpHours}">
            <div class="hint">打开工作台时，错过不久的任务会自动补跑。</div>
          </div>
          <div class="field"></div>
        </div>
        ${toggleRow('允许错过后补跑', '应用当时未运行时，打开后补跑错过的任务。', 'catchUp', settings.catchUp)}
      </section>

      <section class="settings-card">
        <div class="settings-head">
          <span class="settings-icon">${icon('spark')}</span>
          <div><h3>AI 总结（可选）</h3><p>默认不发给任何 AI：运行完只在桌面生成合并好的「今日汇总」总文档，你自己复制给 AI。打开开关后才会把这份文档交给 ChatGPT 整理。</p></div>
        </div>
        ${toggleRow('采集完成后自动让 AI 总结（默认关闭）', '关闭时只保存原文和桌面总文档；打开后把合并全文发给下面选的 AI。', 'autoSummarize', settings.autoSummarize)}
        <div class="two-fields">
          <div class="field">
            <label>总结用的 AI</label>
            <select class="select-input" name="summaryPlatformId">
              ${(data.platforms || []).map((platform) => `<option value="${esc(platform.id)}" ${platform.id === (settings.summaryPlatformId || 'chatgpt') ? 'selected' : ''}>${esc(platform.name)}${platform.enabled === false ? '（已停用）' : ''}${platform.login === 'logged_in' ? ' · 已登录' : ''}</option>`).join('')}
            </select>
            <div class="hint">建议固定用 ChatGPT；所有任务的总结都会复用同一个「汇总数据」对话。</div>
          </div>
          <div class="field">
            <label>总结最长等待（秒）</label>
            <input type="number" name="summaryWait" min="60" max="900" step="10" value="${esc(settings.summaryWaitSec || 300)}">
            <div class="hint">超时后保留已生成的内容；原始回答不会丢。</div>
          </div>
        </div>
        <div class="field">
          <label>共用总结对话</label>
          ${settings.summaryConversation
            ? `<div class="form-hint" style="margin-bottom:6px">所有任务都发到这条对话：<a href="${safeHref(settings.summaryConversation.url)}" target="_blank" rel="noreferrer">${esc(settings.summaryConversation.title || settings.summaryConversation.url)}</a></div>
               <button type="button" class="btn sm ghost" data-action="clear-summary-conversation">清除，下次重新新建</button>`
            : '<div class="form-hint">还没有记录；开启自动总结后，第一次总结会自动新建一条并固定下来，之后所有任务都发到这条对话。</div>'}
        </div>
        <div class="field">
          <label>总结指令</label>
          <textarea class="text-input" name="summaryPrompt" rows="6">${esc(settings.summaryPrompt || '')}</textarea>
          <div class="hint">仅任务里选「自定义」格式时使用；「今日热点汇总」用内置的全领域模板。</div>
        </div>
        <div class="note-card"><b>开启后会发送给 AI 网页。</b>发送的是桌面上的合并总文档（不是每个平台的原文）；原始合集仍单独保存为「…_原始.md」。</div>
      </section>

      <section class="settings-card">
        <div class="settings-head">
          <span class="settings-icon">${icon('copy')}</span>
          <div><h3>输出与提醒</h3><p>每次运行都会在桌面更新一份总文档，文档目录里另存一份原文合集。</p></div>
        </div>
        <div class="field">
          <label>桌面总文档</label>
          <div class="input-with-button">
            <input type="text" value="${esc((data.paths && data.paths.digestPath) || '')}" readonly>
            <button type="button" class="btn" data-action="open-desktop">${icon('folder')}打开桌面</button>
          </div>
          <div class="hint">文件名固定为「今日汇总.md」，每次运行合并更新；带日期的历史留档在「文档 \\ AI Flow」。复制给任意 AI 即可手动汇总。</div>
        </div>
        <div class="field">
          <label>总文档标题</label>
          <input type="text" name="digestTitle" value="${esc(settings.digestTitle || 'Valorant 资讯晚报')}" placeholder="Valorant 资讯晚报">
          <div class="hint">显示在文档第一行，例如「Valorant 资讯晚报 · 2026-10-26」。</div>
        </div>
        ${toggleRow('自动在桌面生成今日汇总', '关闭后只在输出目录里保存 .md，不再写桌面。', 'desktopDigest', settings.desktopDigest !== false)}
        <div class="field">
          <label>汇总保存目录</label>
          <div class="input-with-button">
            <input type="text" name="outputDir" value="${esc((data.paths && data.paths.outputDir) || settings.outputDir || '')}" placeholder="例如 D:\\AI Flow 汇总">
            <button type="button" class="btn" data-action="open-output-folder">${icon('folder')}打开</button>
          </div>
          <div class="hint">留空则使用「文档 \\ AI Flow」。每次运行的完整汇总都会另存一份到这里。</div>
        </div>
        ${toggleRow('生成后自动复制全文', '定时运行结束后把汇总全文写入剪贴板。', 'autoCopy', settings.autoCopy)}
        ${toggleRow('完成后显示 Windows 通知', '定时任务完成后在桌面右下角提醒。', 'notify', settings.notify)}
        <div class="note-card" style="margin-top:12px">
          <b>桌面总文档不经过 AI。</b>它把今天所有任务的来源合并成一份 Markdown；需要 AI 整理时再打开上面的自动总结，或直接复制给 ChatGPT。
        </div>
      </section>

      <section class="settings-card">
        <div class="settings-head">
          <span class="settings-icon">${icon('link')}</span>
          <div><h3>已记录来源</h3><p>每条定时对话读到第几回答了，清掉记录后会重新完整采集一次。</p></div>
        </div>
        <div class="watermark-list">
          ${(data.watermarks || []).map((item) => {
            const platform = platformById(item.platformId);
            return `<div class="watermark-row">
              <span class="mini-logo">${logoInner(platform || { name: item.platformId })}<span class="mini-state"></span></span>
              <div class="watermark-copy">
                <div class="watermark-label">${esc(item.label || item.key)}</div>
                <div class="watermark-meta">已读 ${item.count} 条回答${item.updatedAt ? ` · ${esc(fmtDateTime(item.updatedAt))}` : ''}</div>
              </div>
              <button type="button" class="btn sm" data-action="reset-watermark" data-key="${esc(item.key)}">清除</button>
            </div>`;
          }).join('') || '<div class="watermark-empty">还没有记录。运行过一次「读取定时回答」后，这里会列出每条对话的进度。</div>'}
        </div>
        ${(data.watermarks || []).length
          ? '<div class="settings-actions" style="justify-content:flex-start;margin-top:10px"><button type="button" class="btn danger" data-action="reset-watermark" data-key="">清除全部记录</button></div>'
          : ''}
      </section>

      <section class="settings-card danger-zone">
        <div class="settings-head">
          <span class="settings-icon">${icon('folder')}</span>
          <div><h3>本地数据</h3><p>登录状态、运行记录和汇总都保存在本机。</p></div>
        </div>
        <div class="field">
          <label>数据目录</label>
          <input type="text" value="${esc(data.dataDir || '')}" readonly>
        </div>
        <div class="settings-actions" style="justify-content:flex-start;flex-wrap:wrap">
          <button type="button" class="btn" data-action="open-data-folder">${icon('folder')}打开数据目录</button>
          <button type="button" class="btn" data-action="close-browser" ${browser.running ? '' : 'disabled'}>关闭自动化浏览器</button>
          <button type="button" class="btn danger" data-action="shutdown">退出 AI Flow</button>
        </div>
        <div class="about-line">AI Flow ${esc(data.appVersion || '')} · 本地服务 ${esc(String(data.port || ''))} · 不接入大模型 API，不上传数据。</div>
      </section>
    </div>
    <div class="settings-actions">
      <span class="text-muted" id="settings-dirty" hidden style="font-size:11px">有未保存的修改</span>
      <button class="btn dark" type="submit">保存设置</button>
    </div>
  </form>`;
}

function bindSettings() {
  const form = document.getElementById('settings-form');
  if (!form) return;
  state.settingsDirty = false;
  const markDirty = () => {
    state.settingsDirty = true;
    const badge = document.getElementById('settings-dirty');
    if (badge) badge.hidden = false;
  };
  form.addEventListener('input', markDirty);
  form.addEventListener('change', markDirty);
  form.addEventListener('click', (event) => {
    const flag = event.target.closest('[data-flag]');
    if (!flag) return;
    flag.classList.toggle('on');
    flag.setAttribute('aria-checked', String(flag.classList.contains('on')));
    markDirty();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const flags = {};
      form.querySelectorAll('[data-flag]').forEach((button) => {
        flags[button.dataset.flag] = button.classList.contains('on');
      });
      const body = {
        browser: form.elements.browser.value,
        stableMs: Number(form.elements.stable.value) * 1000,
        maxWaitSec: Number(form.elements.maxWait.value),
        maxAttempts: Number(form.elements.maxAttempts?.value || 6),
        concurrency: Number(form.elements.concurrency?.value || 2),
        sourceTimeoutSec: Number(form.elements.sourceTimeoutSec?.value || 180),
        stallMinutes: Number(form.elements.stallMinutes?.value || 15),
        catchUpHours: Number(form.elements.catchUpHours.value),
        waitMinutes: Number(form.elements.waitMinutes.value),
        pollMinutes: Number(form.elements.pollMinutes.value),
        outputDir: form.elements.outputDir.value.trim(),
        digestTitle: String(form.elements.digestTitle?.value || '').trim(),
        proxy: form.elements.proxy.value,
        summaryPlatformId: form.elements.summaryPlatformId?.value || 'chatgpt',
        summaryPrompt: form.elements.summaryPrompt?.value ?? '',
        summaryWaitSec: Number(form.elements.summaryWait?.value || 300),
        ...flags
      };
      await api('/api/settings', { method: 'POST', body });
      state.settingsDirty = false;
      const response = await api('/api/state');
      state.data = response.state;
      render();
      toast('设置已保存', 'success');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      submit.disabled = false;
    }
  });
}

function sourceRowHtml(platforms, source = {}, index = 0) {
  const selectedId = source.platformId || platforms[0]?.id || '';
  return `<div class="source-row" data-source-row>
    <div class="source-row-head">
      <span class="source-index">${index + 1}</span>
      <select class="select-input source-platform" data-source-platform>
        ${platforms.map((platform) => `<option value="${esc(platform.id)}" ${platform.id === selectedId ? 'selected' : ''}>${esc(platform.name)}${platform.enabled === false ? '（已停用）' : ''}</option>`).join('')}
      </select>
      <button type="button" class="btn tiny" data-open-platform>打开平台</button>
      <button type="button" class="btn tiny" data-grab-url>抓取当前链接</button>
      <button type="button" class="btn tiny danger" data-remove-source aria-label="删除这个来源">${icon('trash')}</button>
    </div>
    <label class="source-field">
      <span>定时对话链接</span>
      <input class="text-input" data-source-url value="${esc(source.url || '')}" placeholder="https://… 打开那条定时对话后复制地址；Grok 填 https://grok.com/automations">
    </label>
    <label class="source-field">
      <span>或标题关键词</span>
      <input class="text-input" data-source-keyword value="${esc(source.keyword || '')}" placeholder="例如：每日 AI 资讯 / 全球趋势雷达 19:00">
    </label>
    <label class="check-row source-first">
      <input type="checkbox" data-source-all ${source.firstRun === 'all' ? 'checked' : ''}>
      <span>第一次运行时把这条对话里的回答全部取回（默认只取最新一条）</span>
    </label>
  </div>`;
}

function conversationUrlLooksValid(platform, url) {
  try {
    const target = new URL(url);
    const home = new URL(platform?.url || '');
    if (target.origin !== home.origin) return false;
    if (target.pathname === home.pathname && target.search === home.search) return false;
    if (/^\/(new|app)?\/?$/i.test(target.pathname)) return false;
    if (/\/(login|signin|auth|captcha|challenge)(\/|$)/i.test(target.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

function openTaskModal(taskId = null) {
  const data = state.data;
  const task = taskId ? data.tasks.find((item) => item.id === taskId) : null;
  const isEdit = Boolean(task);
  const platforms = data.platforms;
  const mode = task?.mode || 'scheduled';
  const preselected = task
    ? new Set(task.platformIds || [])
    : new Set(platforms.filter((platform) => platform.enabled && ['chatgpt', 'gemini'].includes(platform.id)).map((platform) => platform.id));
  if (!preselected.size) {
    platforms.filter((platform) => platform.enabled).slice(0, 2).forEach((platform) => preselected.add(platform.id));
  }
  const schedule = task?.schedule || { type: 'daily', time: '09:00', weekday: 1, everyHours: 6 };
  const enabled = task ? task.enabled : schedule.type !== 'manual';
  const settings = data.settings || {};
  const waitMinutes = Number(task?.wait?.minutes ?? settings.waitMinutes ?? 60);
  const pollMinutes = Number(task?.wait?.pollMinutes ?? settings.pollMinutes ?? 5);
  const sources = (task?.sources || []).length
    ? task.sources
    : [{ platformId: platforms.find((platform) => platform.enabled)?.id || platforms[0]?.id, url: '', keyword: '', firstRun: 'latest' }];
  const summaryProfile = task?.summaryProfile || 'valorant';
  const conversationDrafts = Object.fromEntries(
    Object.entries(task?.conversations || {}).map(([platformId, value]) => [platformId, value?.url || ''])
  );
  let summaryConversation = task?.summaryConversation || null;
  let summaryConversationCleared = false;

  const chips = platforms.map((platform) => `
    <button type="button" class="pick-chip ${preselected.has(platform.id) ? 'selected' : ''}" data-pick="${esc(platform.id)}">
      ${logoInner(platform)}
      <span>${esc(platform.name)}</span>
      <span class="pick-dot ${esc(platform.login || 'unknown')}"></span>
    </button>`).join('');

  const scheduleButtons = [
    ['daily', '每天'],
    ['weekly', '每周'],
    ['interval', '按间隔'],
    ['manual', '仅手动']
  ].map(([value, label]) => `<button type="button" class="${schedule.type === value ? 'active' : ''}" data-sched="${value}">${label}</button>`).join('');

  openModal(`<div class="modal modal-wide">
    <div class="modal-head">
      <div class="modal-head-copy">
        <h2 class="modal-title">${isEdit ? '编辑任务' : '新建采集任务'}</h2>
        <p class="modal-sub" id="task-modal-sub">不用重新提问：直接打开你设置好的定时对话，把它已经生成的回答取回来汇总。</p>
      </div>
      <button class="modal-close" data-action="close-modal" aria-label="关闭">${icon('x')}</button>
    </div>
    <div class="modal-body">
      <form id="task-form">
        <div class="form-grid">
          <div class="span-2">
            <label class="form-label">采集方式</label>
            <div class="segmented" id="task-mode">
              <button type="button" class="${mode === 'scheduled' ? 'active' : ''}" data-mode="scheduled">读取定时回答</button>
              <button type="button" class="${mode === 'prompt' ? 'active' : ''}" data-mode="prompt">发送提示词</button>
            </div>
            <div class="form-hint" data-mode-hint="scheduled">工具只读取那条定时对话里已经出现的回答，不会替你发新问题。Grok 自动化任务请填 <code>https://grok.com/automations</code>，关键词填任务标题（例如「全球趋势雷达 19:00」）。</div>
            <div class="form-hint" data-mode-hint="prompt" hidden>同一个提示词依次发送给选中的 AI，并继续发到各自已绑定的同一条对话；第一次运行会自动新建并记住。</div>
          </div>
          ${isEdit ? '' : `<div class="span-2">
            <label class="form-label">快速模板</label>
            <select class="select-input" id="task-template">
              <option value="">自定义任务</option>
              <option value="valorant">Valorant 资讯晚报：官方 / 赛事 / 战队 / 版本（推荐）</option>
              <option value="hotspot">今日热点汇总：时事 / 财经 / 科技 / 游戏 / 体育（全领域）</option>
              <option value="ai">AI 早报：昨夜今晨新闻</option>
            </select>
            <div class="form-hint">选模板会切到「发送提示词」并填好采集问题；日报只负责采集，AI 总结默认关闭，结果先合并成桌面总文档。</div>
          </div>`}
          <div class="span-2">
            <label class="form-label">任务名称<span class="req">*</span></label>
            <input class="text-input" name="name" maxlength="60" value="${esc(task?.name || '每日定时回答汇总')}" placeholder="例如：每日 AI 资讯汇总">
          </div>
          <div class="span-2" data-mode-panel="scheduled">
            <label class="form-label">定时对话来源<span class="req">*</span></label>
            <div id="task-sources">${sources.map((source, index) => sourceRowHtml(platforms, source, index)).join('')}</div>
            <button type="button" class="btn soft" id="add-source">${icon('plus')}添加一个定时对话</button>
            <div class="form-hint">对话识别：优先使用「抓取当前链接」得到的链接；没有链接时按标题关键词在平台侧边栏里找，并记住已读到第几条，只采集之后的新回答。</div>
          </div>
          <div class="span-2" data-mode-panel="scheduled">
            <label class="form-label">回答还没生成时</label>
            <div class="schedule-fields">
              <div class="field">
                <label>最多等待（分钟）</label>
                <input type="number" class="text-input" name="waitMinutes" min="0" max="720" step="5" value="${esc(waitMinutes)}">
              </div>
              <div class="field">
                <label>每隔（分钟）检查一次</label>
                <input type="number" class="text-input" name="pollMinutes" min="1" max="120" value="${esc(pollMinutes)}">
              </div>
            </div>
            <div class="form-hint">填 0 表示不等：读到什么就汇总什么。等待过程中可以随时点「结束等待」。</div>
          </div>
          <div class="span-2" data-mode-panel="prompt">
            <label class="form-label">提示词<span class="req">*</span></label>
            <textarea class="textarea-input" name="prompt" placeholder="发送给每个 AI 的同一段提示词">${esc(task?.prompt || DEFAULT_PROMPT)}</textarea>
            <div class="form-hint">支持自动替换：{date} 今天日期、{weekday} 星期、{time} 当前时间。</div>
          </div>
          <div class="span-2" data-mode-panel="prompt">
            <label class="form-label">发送到哪些平台<span class="req">*</span></label>
            <div class="platform-picker" id="task-platforms">${chips || '<span class="form-hint">还没有可选平台。</span>'}</div>
            <div class="form-hint">ChatGPT / Gemini 未登录时通常也能以访客模式采集；登录后更稳定。某个平台失败不会中断其他平台。</div>
          </div>
          <div class="span-2" data-mode-panel="prompt">
            <label class="form-label">对话复用</label>
            <div class="form-hint">第一次运行会在每个平台新建一个对话并记住；之后把提示词继续发到同一个对话，不再每天新开。要绑定已有对话：打开平台 → 进入那条对话 → 点「抓取当前链接」。</div>
            <div id="task-conversations" class="conversation-list"></div>
          </div>
          <div class="span-2">
            <label class="form-label">总结格式</label>
            <select class="select-input" name="summaryProfile">
              ${SUMMARY_PROFILE_OPTIONS.map(([value, label]) => `<option value="${value}" ${summaryProfile === value ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
            <div class="form-hint">默认不自动总结：任务只采集，结果合并到「桌面 · 今日汇总.md」。到「设置 · AI 总结」打开开关后，才用这里的格式（默认「今日热点汇总」）交给 ChatGPT 整理。</div>
            ${summaryConversation
              ? `<div class="form-hint" id="summary-conversation-note">复用总结对话：<a href="${safeHref(summaryConversation.url)}" target="_blank" rel="noreferrer">${esc(summaryConversation.title || summaryConversation.url)}</a> <button type="button" class="btn tiny ghost" data-clear-summary-conversation>清除</button></div>`
              : '<div class="form-hint" id="summary-conversation-note">第一次总结会自动新建一个对话并记住，后续复用，不再每天新建。</div>'}
          </div>
          <div class="span-2">
            <label class="form-label">运行时间</label>
            <div class="segmented" id="sched-type">${scheduleButtons}</div>
            <div class="schedule-fields">
              <div class="field" data-sched-field="daily,weekly">
                <label>时间</label>
                <input type="time" class="text-input" name="time" value="${esc(schedule.time || '09:00')}">
              </div>
              <div class="field" data-sched-field="weekly">
                <label>星期</label>
                <select class="select-input" name="weekday">
                  ${WEEKDAYS.map((name, index) => `<option value="${index}" ${Number(schedule.weekday ?? 1) === index ? 'selected' : ''}>${name}</option>`).join('')}
                </select>
              </div>
              <div class="field" data-sched-field="interval">
                <label>每隔（小时）</label>
                <input type="number" class="text-input" name="everyHours" min="1" max="168" value="${esc(schedule.everyHours || 6)}">
              </div>
            </div>
            <div class="check-row" id="task-enabled-row">
              <input type="checkbox" id="task-enabled" ${enabled ? 'checked' : ''}>
              <label for="task-enabled">保存后启用定时运行</label>
            </div>
          </div>
        </div>
        <div class="sync-err" id="task-error" hidden></div>
      </form>
    </div>
    <div class="modal-foot">
      <button class="btn" data-action="close-modal">取消</button>
      <button class="btn dark" id="task-submit">${isEdit ? '保存修改' : '创建任务'}</button>
    </div>
  </div>`);

  const form = document.getElementById('task-form');
  const typeRoot = document.getElementById('sched-type');
  const modeRoot = document.getElementById('task-mode');
  const sourcesRoot = document.getElementById('task-sources');
  const readRows = () => $$('[data-source-row]', sourcesRoot);

  const renumberSources = () => {
    readRows().forEach((row, index) => {
      row.querySelector('.source-index').textContent = String(index + 1);
    });
  };
  const addSourceRow = () => {
    sourcesRoot.insertAdjacentHTML('beforeend', sourceRowHtml(platforms, { platformId: platforms[0]?.id }, readRows().length));
    renumberSources();
  };
  const updateModePanels = () => {
    const active = modeRoot.querySelector('button.active')?.dataset.mode || 'scheduled';
    $$('[data-mode-panel]', form).forEach((panel) => {
      panel.hidden = panel.dataset.modePanel !== active;
    });
    $$('[data-mode-hint]', form).forEach((hint) => {
      hint.hidden = hint.dataset.modeHint !== active;
    });
    const sub = document.getElementById('task-modal-sub');
    if (sub) {
      sub.textContent = active === 'prompt'
        ? '同一条提示词继续发到各平台已绑定的对话；第一次运行会自动新建并记住，不再每天堆叠新聊天。'
        : '不用重新提问：直接打开你设置好的定时对话，把它已经生成的回答取回来汇总。';
    }
  };

  const conversationRoot = document.getElementById('task-conversations');
  const platformById = (id) => platforms.find((platform) => platform.id === id);
  const selectedPlatformIds = () => $$('.pick-chip.selected', form).map((item) => item.dataset.pick);
  const conversationRowHtml = (platform) => {
    const url = conversationDrafts[platform.id] || '';
    return `<div class="conversation-row" data-conversation-row="${esc(platform.id)}">
      <div class="conversation-head">
        <span class="conversation-name">${logoInner(platform)}<span>${esc(platform.name)}</span></span>
        <span class="conversation-state">${url ? '每天继续发到这条对话' : '首次运行自动新建并记住'}</span>
        <button type="button" class="btn tiny" data-grab-conversation="${esc(platform.id)}">抓取当前链接</button>
        <button type="button" class="btn tiny ghost" data-clear-conversation="${esc(platform.id)}" ${url ? '' : 'disabled'}>清除</button>
      </div>
      <input class="text-input" data-conversation-url="${esc(platform.id)}" value="${esc(url)}" placeholder="留空：第一次运行自动新建对话并记住链接">
    </div>`;
  };
  const renderConversations = () => {
    if (!conversationRoot) return;
    const selected = selectedPlatformIds().map(platformById).filter(Boolean);
    conversationRoot.innerHTML = selected.length
      ? selected.map(conversationRowHtml).join('')
      : '<div class="form-hint">先选择平台，再决定对话怎么复用。</div>';
  };
  const summaryNote = document.getElementById('summary-conversation-note');
  const summaryPlatform = () =>
    platformById(summaryConversation?.platformId) ||
    platformById(settings.summaryPlatformId) ||
    platforms.find((platform) => platform.enabled !== false) ||
    platforms[0] ||
    null;
  const renderSummaryNote = () => {
    if (!summaryNote) return;
    if (summaryConversation) {
      const platform = platformById(summaryConversation.platformId);
      summaryNote.innerHTML = `复用总结对话${platform ? `（${esc(platform.name)}）` : ''}：<a href="${safeHref(summaryConversation.url)}" target="_blank" rel="noreferrer">${esc(summaryConversation.title || summaryConversation.url)}</a>
        <button type="button" class="btn tiny" data-grab-summary-conversation>更换</button>
        <button type="button" class="btn tiny ghost" data-clear-summary-conversation>清除</button>`;
    } else {
      summaryNote.innerHTML = `${summaryConversationCleared ? '已清除，下次总结会新建一个对话。' : '第一次总结会自动新建一个对话并记住，后续复用，不再每天新建。'}
        <button type="button" class="btn tiny" data-grab-summary-conversation>绑定已有总结对话</button>`;
    }
  };

  const updateFields = () => {
    const type = typeRoot.querySelector('button.active')?.dataset.sched || 'daily';
    $$('[data-sched-field]', form).forEach((element) => {
      element.hidden = !element.dataset.schedField.split(',').includes(type);
    });
    const enabledRow = document.getElementById('task-enabled-row');
    if (enabledRow) enabledRow.hidden = type === 'manual';
  };
  updateFields();
  updateModePanels();
  renderConversations();
  renderSummaryNote();

  typeRoot.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-sched]');
    if (!button) return;
    $$('button', typeRoot).forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    updateFields();
  });
  modeRoot.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-mode]');
    if (!button) return;
    $$('button', modeRoot).forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    updateModePanels();
  });
  const templateSelect = document.getElementById('task-template');
  if (templateSelect) {
    templateSelect.addEventListener('change', () => {
      const template = TASK_TEMPLATES[templateSelect.value];
      if (!template) return;
      form.elements.name.value = template.name;
      form.elements.prompt.value = template.prompt;
      form.elements.summaryProfile.value = template.summaryProfile;
      const promptButton = modeRoot.querySelector('[data-mode="prompt"]');
      if (promptButton) {
        $$('button', modeRoot).forEach((item) => item.classList.remove('active'));
        promptButton.classList.add('active');
        updateModePanels();
      }
    });
  }
  document.getElementById('add-source').addEventListener('click', addSourceRow);

  async function runRowAction(button, busyLabel, work) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = busyLabel;
    try {
      await work();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  sourcesRoot.addEventListener('click', async (event) => {
    const row = event.target.closest('[data-source-row]');
    if (!row) return;
    if (event.target.closest('[data-remove-source]')) {
      row.remove();
      if (!readRows().length) addSourceRow();
      renumberSources();
      return;
    }
    const platformId = row.querySelector('[data-source-platform]').value;
    const openButton = event.target.closest('[data-open-platform]');
    if (openButton) {
      await runRowAction(openButton, '打开中…', async () => {
        await api(`/api/platforms/${platformId}/open`, { method: 'POST' });
        toast(`已打开 ${platformId}，请在自动化浏览器里点开那条定时对话`, 'info', { duration: 6000 });
      });
      return;
    }
    const grabButton = event.target.closest('[data-grab-url]');
    if (grabButton) {
      await runRowAction(grabButton, '抓取中…', async () => {
        const info = await api(`/api/platforms/${platformId}/current-url`);
        row.querySelector('[data-source-url]').value = info.url;
        toast('已抓取当前对话链接', 'success');
      });
    }
  });

  if (conversationRoot) {
    conversationRoot.addEventListener('input', (event) => {
      const input = event.target.closest('[data-conversation-url]');
      if (!input) return;
      const platformId = input.dataset.conversationUrl;
      conversationDrafts[platformId] = input.value;
      const row = input.closest('[data-conversation-row]');
      const stateLabel = row?.querySelector('.conversation-state');
      if (stateLabel) stateLabel.textContent = input.value.trim() ? '每天继续发到这条对话' : '首次运行自动新建并记住';
      const clearButton = row?.querySelector('[data-clear-conversation]');
      if (clearButton) clearButton.disabled = !input.value.trim();
    });
    conversationRoot.addEventListener('click', async (event) => {
      const clearButton = event.target.closest('[data-clear-conversation]');
      if (clearButton) {
        conversationDrafts[clearButton.dataset.clearConversation] = '';
        renderConversations();
        return;
      }
      const grabButton = event.target.closest('[data-grab-conversation]');
      if (!grabButton) return;
      const platformId = grabButton.dataset.grabConversation;
      const platform = platformById(platformId);
      await runRowAction(grabButton, '抓取中…', async () => {
        const info = await api(`/api/platforms/${platformId}/current-url`);
        if (!conversationUrlLooksValid(platform, info.url)) {
          throw new Error('当前还在平台首页或登录页。先在自动化浏览器里点开目标对话，再回来抓取。');
        }
        conversationDrafts[platformId] = info.url;
        renderConversations();
        toast(`已绑定 ${platform?.name || platformId} 的对话，之后继续发到这里`, 'success');
      });
    });
  }
  form.addEventListener('click', async (event) => {
    const clearButton = event.target.closest('[data-clear-summary-conversation]');
    if (clearButton) {
      summaryConversation = null;
      summaryConversationCleared = true;
      renderSummaryNote();
      return;
    }
    const grabButton = event.target.closest('[data-grab-summary-conversation]');
    if (!grabButton) return;
    const platform = summaryPlatform();
    if (!platform) {
      toast('还没有可用的总结平台。', 'error');
      return;
    }
    await runRowAction(grabButton, '抓取中…', async () => {
      const info = await api(`/api/platforms/${platform.id}/current-url`);
      if (!conversationUrlLooksValid(platform, info.url)) {
        throw new Error('当前还在平台首页或登录页。先打开已有的总结对话，再回来抓取。');
      }
      summaryConversation = {
        url: info.url,
        platformId: platform.id,
        title: info.title || '',
        updatedAt: new Date().toISOString()
      };
      summaryConversationCleared = false;
      renderSummaryNote();
      toast('已绑定总结对话，之后每天在同一对话里总结', 'success');
    });
  });

  $$('.pick-chip', form).forEach((chipButton) => {
    chipButton.addEventListener('click', () => {
      chipButton.classList.toggle('selected');
      renderConversations();
    });
  });
  const submit = document.getElementById('task-submit');
  submit.addEventListener('click', () => form.requestSubmit());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorBox = document.getElementById('task-error');
    errorBox.hidden = true;
    const activeMode = modeRoot.querySelector('button.active')?.dataset.mode || 'scheduled';
    const name = form.elements.name.value.trim();
    const prompt = activeMode === 'prompt' ? form.elements.prompt.value.trim() : '';
    const platformIds = $$('.pick-chip.selected', form).map((item) => item.dataset.pick);
    const sources = readRows().map((row) => ({
      platformId: row.querySelector('[data-source-platform]').value,
      url: row.querySelector('[data-source-url]').value.trim(),
      keyword: row.querySelector('[data-source-keyword]').value.trim(),
      firstRun: row.querySelector('[data-source-all]').checked ? 'all' : 'latest'
    })).filter((source) => source.url || source.keyword);
    const type = typeRoot.querySelector('button.active')?.dataset.sched || 'daily';
    if (!name) return showFormError(errorBox, '请填写任务名称。');
    if (activeMode === 'prompt' && !prompt) return showFormError(errorBox, '请填写提示词。');
    if (activeMode === 'prompt' && !platformIds.length) return showFormError(errorBox, '请至少选择一个平台。');
    if (activeMode === 'scheduled' && !sources.length) {
      return showFormError(errorBox, '每个定时来源需要填写对话链接或标题关键词（推荐先点「抓取当前链接」）。');
    }
    const conversations = {};
    Object.entries(conversationDrafts).forEach(([platformId, value]) => {
      const url = String(value || '').trim();
      if (!url) return;
      const previous = task?.conversations?.[platformId];
      conversations[platformId] = previous?.url === url
        ? previous
        : { url, title: '', updatedAt: new Date().toISOString() };
    });
    for (const [platformId, binding] of Object.entries(conversations)) {
      const platform = platformById(platformId);
      if (platform && !conversationUrlLooksValid(platform, binding.url)) {
        return showFormError(errorBox, `「${platform.name}」填的链接不是具体对话。请打开那条对话后点「抓取当前链接」；或者清空，让第一次运行自动新建。`);
      }
    }
    const body = {
      name,
      mode: activeMode,
      prompt,
      platformIds,
      sources,
      conversations,
      summaryConversation: summaryConversation ? { ...summaryConversation } : null,
      summaryProfile: form.elements.summaryProfile?.value || 'ai',
      wait: {
        minutes: Number(form.elements.waitMinutes.value || 0),
        pollMinutes: Number(form.elements.pollMinutes.value || 5)
      },
      schedule: {
        type,
        time: form.elements.time.value || '09:00',
        weekday: Number(form.elements.weekday.value || 1),
        everyHours: Number(form.elements.everyHours.value || 6)
      },
      enabled: type === 'manual' ? false : form.querySelector('#task-enabled').checked
    };
    submit.disabled = true;
    try {
      let resultTask;
      if (isEdit) {
        const response = await api(`/api/tasks/${task.id}`, { method: 'PATCH', body });
        resultTask = response.task;
        closeModal();
        toast('任务已更新', 'success');
      } else {
        const response = await api('/api/tasks', { method: 'POST', body });
        resultTask = response.task;
        closeModal();
        toast('任务已创建', 'success', {
          action: { label: '立即运行', onClick: () => runTask(resultTask.id) }
        });
      }
    } catch (error) {
      showFormError(errorBox, error.message);
    } finally {
      submit.disabled = false;
    }
  });
}

function showFormError(box, message) {
  if (!box) return;
  box.textContent = message;
  box.hidden = false;
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function openPlatformModal() {
  openModal(`<div class="modal">
    <div class="modal-head">
      <div class="modal-head-copy">
        <h2 class="modal-title">添加自定义平台</h2>
        <p class="modal-sub">任何有网页聊天界面的 AI 都可以尝试接入；页面结构不同，可能需要自定义选择器。</p>
      </div>
      <button class="modal-close" data-action="close-modal" aria-label="关闭">${icon('x')}</button>
    </div>
    <div class="modal-body">
      <form id="platform-form">
        <div class="form-grid">
          <div class="field">
            <label>平台名称</label>
            <input class="text-input" name="pname" placeholder="例如：Kimi" maxlength="40">
          </div>
          <div class="field">
            <label>网页地址</label>
            <input class="text-input" name="purl" placeholder="https://">
          </div>
          <div class="span-2">
            <details>
              <summary style="font-size:11.5px;color:#6d7a91;cursor:pointer;padding:4px 0">高级：自定义页面选择器（可选）</summary>
              <div class="form-grid" style="margin-top:10px">
                <div class="field">
                  <label>输入框 CSS 选择器</label>
                  <input class="text-input" name="composer" placeholder="textarea, [contenteditable=true]">
                </div>
                <div class="field">
                  <label>发送按钮 CSS 选择器</label>
                  <input class="text-input" name="send" placeholder="button[aria-label*=Send]">
                </div>
                <div class="field">
                  <label>停止按钮 CSS 选择器</label>
                  <input class="text-input" name="stop" placeholder="button[aria-label*=Stop]">
                </div>
                <div class="field">
                  <label>回答区域 CSS 选择器</label>
                  <input class="text-input" name="answer" placeholder=".message.assistant, .prose">
                </div>
              </div>
              <div class="form-hint">不填则使用通用识别；如果网站改版，可以在这里修正。</div>
            </details>
          </div>
        </div>
        <div class="sync-err" id="platform-error" hidden></div>
      </form>
    </div>
    <div class="modal-foot">
      <button class="btn" data-action="close-modal">取消</button>
      <button class="btn dark" id="platform-submit">添加平台</button>
    </div>
  </div>`);
  const form = document.getElementById('platform-form');
  const submit = document.getElementById('platform-submit');
  submit.addEventListener('click', () => form.requestSubmit());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorBox = document.getElementById('platform-error');
    errorBox.hidden = true;
    const name = form.pname.value.trim();
    const url = form.purl.value.trim();
    if (!name) return showFormError(errorBox, '请填写平台名称。');
    if (!/^https?:\/\//i.test(url)) return showFormError(errorBox, '网址需要以 http:// 或 https:// 开头。');
    submit.disabled = true;
    try {
      await api('/api/platforms', {
        method: 'POST',
        body: {
          name,
          url,
          customSelectors: {
            composer: form.composer.value.trim(),
            send: form.send.value.trim(),
            stop: form.stop.value.trim(),
            answer: form.answer.value.trim()
          }
        }
      });
      closeModal();
      toast('平台已添加，可以打开登录后检查状态', 'success');
    } catch (error) {
      showFormError(errorBox, error.message);
    } finally {
      submit.disabled = false;
    }
  });
}

function openLoginGuide() {
  const data = state.data;
  const kind = data.settings.browser === 'chrome' ? 'Chrome' : 'Edge';
  const platforms = data.platforms.filter((platform) => platform.enabled);
  const rows = platforms.map((platform) => {
    const info = loginInfo(platform);
    const logged = platform.login === 'logged_in';
    return `<div class="schedule-item">
      <span class="mini-logo">${logoInner(platform)}<span class="mini-state"></span></span>
      <div class="schedule-copy">
        <div class="schedule-name" style="cursor:default">${esc(platform.name)}</div>
        <div class="schedule-meta">${esc(info.text)}${platform.lastCheckAt ? ` · ${esc(fmtDateTime(platform.lastCheckAt))}` : ''}</div>
      </div>
      <button class="btn sm ${logged ? '' : 'dark'}" data-action="open-platform" data-id="${esc(platform.id)}">${logged ? '打开页面' : '打开登录'}</button>
    </div>`;
  }).join('');

  openModal(`<div class="modal" style="width:min(610px,94vw)">
    <div class="modal-head">
      <div class="modal-head-copy">
        <h2 class="modal-title">可选登录：登录一次，之后自动运行</h2>
        <p class="modal-sub">不登录也可以先用访客模式采集；登录后能使用账号额度并保存对话历史。</p>
      </div>
      <button class="modal-close" data-action="close-modal" aria-label="关闭">${icon('x')}</button>
    </div>
    <div class="modal-body">
      <div class="note-card">
        新版 Edge / Chrome 会对登录 Cookie 做系统级加密，复制到另一个配置会直接失效，所以 AI Flow 使用独立的 ${kind} 配置。你日常使用的 ${kind} 不会被关闭或修改；这里登录一次后，定时采集会一直复用。
      </div>
      <div class="sync-steps">
        <div class="sync-step"><span class="step-no">1</span><span>点下方「打开登录」，AI Flow 会启动独立的 ${kind} 窗口并打开对应网站。</span></div>
        <div class="sync-step"><span class="step-no">2</span><span>在这个窗口里正常登录（可以使用 Google 账号）。不用关闭窗口，AI Flow 会自动识别。</span></div>
        <div class="sync-step"><span class="step-no">3</span><span>状态会自动更新为「已登录」；想立刻刷新也可以点「检查全部」。以后不需要再登录。</span></div>
      </div>
      <div class="schedule-list">${rows || '<div class="empty-title">没有启用的平台</div>'}</div>
      <p class="form-hint">登录状态只保存在应用数据目录，不会上传。若网站登录过期，重新打开对应平台登录一次即可。</p>
    </div>
    <div class="modal-foot">
      <button class="btn" data-action="close-modal">稍后再说</button>
      <button class="btn dark" data-action="guide-check">检查全部</button>
    </div>
  </div>`);
}

function openRunModal(runId) {
  if (!runId) return;
  state.openRunId = runId;
  state.runDetail = null;
  state.runFinalLoaded = false;
  openModal(`<div class="modal wide">
    <div class="modal-head">
      <div class="modal-head-copy">
        <h2 class="modal-title" id="run-title">汇总</h2>
        <p class="modal-sub" id="run-sub">正在加载…</p>
      </div>
      <button class="modal-close" data-action="close-modal" aria-label="关闭">${icon('x')}</button>
    </div>
    <div class="modal-body" id="run-body"><div class="empty"><div class="empty-text">正在加载…</div></div></div>
    <div class="modal-foot" id="run-foot"></div>
  </div>`);
  const current = state.data.currentRun;
  if (current && current.id === runId) {
    renderLiveRun(current);
    return;
  }
  loadRunDetail(runId);
}

async function loadRunDetail(runId) {
  try {
    const response = await api(`/api/runs/${runId}`);
    if (state.openRunId !== runId) return;
    state.runDetail = response;
    state.runFinalLoaded = response.run?.status !== 'running';
    renderRunDetail(response);
  } catch (error) {
    if (state.openRunId !== runId) return;
    const body = document.getElementById('run-body');
    if (body) body.innerHTML = `<div class="answer-error">${esc(error.message)}</div>`;
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return String(url || '');
  }
}

function scheduledHint(result) {
  if (result.status === 'no-new') {
    return '<div class="answer-hint">这条对话已经读过，而且还没有新回答。想重新采集一次，到「设置 · 已记录来源」里清掉它的进度。</div>';
  }
  if (result.status === 'no-answer') {
    return '<div class="answer-hint">平台的定时任务可能还没执行，或回答还在生成。可以在平台里确认这条定时的执行时间，或把任务的等待时间调长。</div>';
  }
  return '';
}

function runSummaryHtml(run) {
  const scheduled = run.mode === 'scheduled';
  return `<div class="run-summary-grid">${(run.results || []).map((result) => {
    const platform = platformById(result.platformId) || { name: result.name, icon: result.icon };
    const meta = ['ok', 'partial'].includes(result.status)
      ? scheduled
        ? `新增 ${result.newCount || 0} 条 · 对话内共 ${result.totalCount || 0} 条`
        : `${result.chars || 0} 字 · ${Math.round((result.durationMs || 0) / 100) / 10}s`
      : result.status === 'waiting'
        ? `已检查 ${result.attempts || 1} 次 · 已等 ${fmtDuration(result.waitedMs || 0)}${result.nextRetryInSec ? ` · ${Math.round(result.nextRetryInSec)} 秒后自动重试` : ''}`
        : esc(RESULT_LABELS[result.status] || result.status);
    return `<div class="run-summary-item">
      <span class="mini-logo ${esc(result.status)}">${logoInner(platform)}<span class="mini-state"></span></span>
      <div class="run-summary-copy">
        <div class="run-summary-name">${esc(result.name)}</div>
        <div class="run-summary-meta">${meta}</div>
      </div>
      ${chip(result.status, RESULT_LABELS[result.status])}
    </div>`;
  }).join('')}</div>`;
}

function renderRunDetail({ run, bundle, bundleName, rawBundle, rawBundleName }) {
  const title = document.getElementById('run-title');
  const sub = document.getElementById('run-sub');
  const body = document.getElementById('run-body');
  const foot = document.getElementById('run-foot');
  if (!body) return;
  const good = runGoodCount(run);
  const scheduled = run.mode === 'scheduled';
  const summary = run.summary || null;
  const summaryOk = summary?.status === 'ok' && String(summary.text || '').trim();
  const summaryError = summary?.status === 'error';
  const summaryName = summary?.name || summary?.platformId || 'AI';
  const summaryProfileName = summary?.profileName || 'AI 总结';
  title.textContent = run.taskName || '汇总';
  sub.textContent = `${fmtFullTime(run.finishedAt || run.startedAt)} · ${run.trigger === 'schedule' ? '定时运行' : '手动运行'} · ${good}/${(run.results || []).length} 个${scheduled ? '定时对话' : '平台'}有回答${summaryOk ? ` · ${summaryProfileName} 已整理` : ''}`;
  const canRerun = Boolean(run.taskId) && ['failed', 'empty', 'partial'].includes(run.status) && !state.data.currentRun;
  foot.innerHTML = `
    ${canRerun ? `<button class="btn" data-action="rerun-task" data-id="${esc(run.taskId)}">${icon('refresh')}重新运行</button>` : ''}
    <a class="btn" href="/api/runs/${encodeURIComponent(run.id)}/bundle" style="text-decoration:none">${icon('download')}${summaryOk ? '下载最终汇总' : '下载 .md'}</a>
    ${summaryOk ? `<a class="btn" href="/api/runs/${encodeURIComponent(run.id)}/raw" style="text-decoration:none">${icon('download')}下载原始回答</a>` : ''}
    ${run.digestPath ? `<a class="btn" href="/api/runs/${encodeURIComponent(run.id)}/digest" style="text-decoration:none">${icon('doc')}今日汇总</a>` : ''}
    <button class="btn" data-action="open-folder" data-id="${esc(run.id)}">${icon('folder')}打开文件夹</button>
    ${summaryOk
      ? `<button class="btn dark" data-action="copy-summary" data-id="${esc(run.id)}">${icon('copy')}复制总结</button>`
      : `<button class="btn" data-action="copy-run" data-id="${esc(run.id)}">${icon('copy')}复制全文</button>
         <button class="btn dark" data-action="copy-with-instruction" data-id="${esc(run.id)}">${icon('spark')}复制并附总结指令</button>`}`;

  const sections = (run.results || []).map((result, index) => {
    const platform = platformById(result.platformId) || { name: result.name, icon: result.icon };
    const goodResult = ['ok', 'partial'].includes(result.status);
    const softResult = ['no-new', 'no-answer'].includes(result.status);
    const metaHtml = goodResult
      ? scheduled
        ? `本次新增 ${result.newCount || 0} 条 · 对话内共 ${result.totalCount || 0} 条${result.lastAnswerTime ? ` · 最新回答 ${fmtDateTime(result.lastAnswerTime)}` : ''}`
        : `${result.chars || 0} 字 · ${fmtDuration(result.durationMs)}`
      : result.status === 'waiting'
        ? `已检查 ${result.attempts || 1} 次 · 已等待 ${fmtDuration(result.waitedMs || 0)}${result.nextRetryInSec ? ` · ${Math.round(result.nextRetryInSec)} 秒后自动重试` : ''}`
        : result.status === 'no-new'
          ? `对话内共 ${result.totalCount || 0} 条回答`
          : '';
    const sourceLine = scheduled && (result.sourceKeyword || result.sourceUrl || result.url)
      ? `<div class="run-section-source">${icon('link')}${esc(result.sourceKeyword || hostOf(result.sourceUrl || result.url || ''))}</div>`
      : '';
    const errorHtml = !goodResult
      ? `<div class="answer-error"><b>${esc(RESULT_LABELS[result.status] || '未采集')}</b>${esc(result.error || '没有拿到回答。')}
          ${softResult ? scheduledHint(result) : ''}
          ${result.platformId ? `<div style="margin-top:8px"><button class="btn sm" data-action="open-platform" data-id="${esc(result.platformId)}">打开这个平台</button></div>` : ''}
        </div>`
      : result.status === 'partial'
        ? `<div class="answer-note">${esc(result.error || '回答可能没有生成完整。')}</div>`
        : '';
    return `<section class="run-section">
      <div class="run-section-head">
        ${platformLogo(platform)}
        <span class="run-section-title">${esc(result.name)}</span>
        ${chip(result.status, RESULT_LABELS[result.status])}
        <span class="run-section-meta">${metaHtml}</span>
      </div>
      ${sourceLine}
      ${errorHtml}
      ${goodResult ? `<div class="answer-block">
        <div class="answer-toolbar">
          <span class="hint">原文 · 保留链接与列表</span>
          <button class="btn sm" data-action="copy-answer" data-index="${index}">${icon('copy')}复制这段</button>
        </div>
        <pre class="answer-text" id="answer-${index}"></pre>
      </div>` : ''}
      ${result.url && goodResult ? `<div style="margin-top:6px"><a class="form-hint" href="${safeHref(result.url)}" target="_blank" rel="noreferrer">打开这次对话</a></div>` : ''}
    </section>`;
  }).join('');

  const summaryBlock = summaryOk
    ? `<section class="ai-summary">
        <div class="ai-summary-head">
          <div class="ai-summary-title">${icon('spark')}<b>${esc(summaryProfileName)} · ${esc(summaryName)}</b><span class="ai-summary-meta">${summary.chars || 0} 字 · ${fmtDuration(summary.durationMs || 0)}${summary.warning ? ' · 部分完成' : ''}</span></div>
          <button class="btn sm" data-action="copy-summary" data-id="${esc(run.id)}">${icon('copy')}复制总结</button>
        </div>
        <pre class="answer-text summary-text" id="run-summary-text"></pre>
        ${summary.warning ? `<div class="answer-note">${esc(summary.warning)}</div>` : ''}
        ${summary.url ? `<div class="form-hint" style="margin-top:6px">总结对话：<a href="${safeHref(summary.url)}" target="_blank" rel="noreferrer">打开这条对话</a></div>` : ''}
        ${rawBundleName ? `<div class="form-hint" style="margin-top:6px">原始回答：<a href="/api/runs/${encodeURIComponent(run.id)}/raw">${esc(rawBundleName)}</a></div>` : ''}
      </section>`
    : summaryError
      ? `<div class="answer-error" style="margin-bottom:16px"><b>AI 总结失败</b>${esc(summary.error || '没有拿到总结内容。')}<div class="form-hint" style="margin-top:6px">原始回答已经保存，不会丢；修好登录/额度后可以点「重新运行」。</div></div>`
      : '';

  const digestBlock = run.digestPath
    ? `<section class="dataset-card">
        <div class="dataset-head">
          ${icon('doc')}
          <b>桌面总文档</b>
          <span class="hint">今天所有来源已合并，未经任何 AI 处理</span>
        </div>
        <div class="dataset-links">
          <a class="btn sm" href="/api/runs/${encodeURIComponent(run.id)}/digest">${icon('download')}下载 .md</a>
          <button class="btn sm" data-action="open-desktop">${icon('folder')}打开桌面</button>
        </div>
        <div class="form-hint">${esc(run.digestPath)}</div>
      </section>`
    : '';

  const datasetBlock = run.datasetDir
    ? `<section class="dataset-card">
        <div class="dataset-head">
          ${icon('chart')}
          <b>回答数据</b>
          <span class="hint">${run.datasetRecords || 0} 条记录 · ${run.datasetCharts || 0} 张图表 · 表格与 AI 数据集</span>
        </div>
        <div class="dataset-links">
          <a class="btn sm" href="/api/runs/${encodeURIComponent(run.id)}/dataset/${encodeURIComponent('回答集.xlsx')}">${icon('download')}Excel 表格</a>
          <a class="btn sm" href="/api/runs/${encodeURIComponent(run.id)}/dataset/${encodeURIComponent('回答集.csv')}">${icon('download')}CSV</a>
          <a class="btn sm" href="/api/runs/${encodeURIComponent(run.id)}/dataset/${encodeURIComponent('回答集.jsonl')}">${icon('download')}AI 数据集</a>
          <button class="btn sm" data-action="open-dataset-folder" data-id="${esc(run.id)}">${icon('folder')}数据文件夹</button>
        </div>
        <div class="form-hint">JSONL 一行一条回答，含表格与图表；同目录上级的「最新数据」始终保留最近一次。</div>
      </section>`
    : '';

  const rawBlock = `<details class="raw-details" ${summaryOk || summaryError ? '' : 'open'}>
    <summary>原始回答（${(run.results || []).length} 个平台）${rawBundleName ? ` · ${esc(rawBundleName)}` : ''}</summary>
    <div class="raw-inner">${sections}
      ${run.prompt ? `<details style="margin-top:8px"><summary style="font-size:11px;color:#8c97ab;cursor:pointer">查看本次提示词</summary><pre class="answer-text" id="run-prompt" style="margin-top:8px;max-height:240px;background:#f8faff;border:1px solid #eef2f9;border-radius:12px"></pre></details>` : ''}
    </div>
  </details>`;

  const failureNote = run.status === 'failed' && !run.error
    ? `<div class="answer-error" style="margin-bottom:16px"><b>本次没有采集到任何回答</b>请检查登录状态，或打开对应平台手动查看。</div>`
    : '';
  const incomplete = bundle ? '' : `<div class="answer-note" style="margin-bottom:16px">文件还没有生成；以下是各平台的原文。</div>`;

  body.innerHTML = `${runSummaryHtml(run)}
    ${incomplete}${failureNote}
    ${run.error ? `<div class="answer-error" style="margin-bottom:16px"><b>任务错误</b>${esc(run.error)}</div>` : ''}
    ${summaryBlock}
    ${digestBlock}
    ${datasetBlock}
    ${rawBlock}`;

  const summaryElement = document.getElementById('run-summary-text');
  if (summaryElement && summaryOk) summaryElement.textContent = summary.text || '';
  (run.results || []).forEach((result, index) => {
    if (['ok', 'partial'].includes(result.status)) {
      const element = document.getElementById(`answer-${index}`);
      if (element) element.textContent = result.text || '';
    }
  });
  const promptElement = document.getElementById('run-prompt');
  if (promptElement) promptElement.textContent = run.prompt || '';
}

function renderLiveRun(run) {
  const title = document.getElementById('run-title');
  const sub = document.getElementById('run-sub');
  const body = document.getElementById('run-body');
  const foot = document.getElementById('run-foot');
  if (!body) return;
  const total = run.progress?.total || run.results.length || 1;
  const done = run.progress?.done || 0;
  const percent = Math.round((done / total) * 100);
  title.textContent = run.taskName || '正在采集';
  sub.textContent = `${fmtDateTime(run.startedAt)} · ${run.trigger === 'schedule' ? '定时运行' : '手动运行'}进行中 · ${done}/${total}`;
  const waiting = (run.results || []).filter((result) => result.status === 'waiting').length;
  const summarizing = run.summary?.status === 'running';
  body.innerHTML = `<div class="run-live">
    <span class="spinner"></span>
    <div class="run-live-meta"><b>${esc(run.phase || '正在采集')}</b><span>${summarizing ? `已完成采集，${esc(run.summary?.name || 'AI')} 正在整理最终汇总…` : `已完成 ${done}/${total} 个来源；全文会在采集完成后显示。`}</span></div>
    <div class="run-live-bar"><span style="width:${percent}%"></span></div>
  </div>
  ${runSummaryHtml(run)}
  <div class="empty" style="padding:20px 10px">
    <div class="empty-text">${summarizing ? `${esc(run.summary?.name || 'AI')} 正在把原始回答整理成最终汇总，完成后会显示在这里。` : waiting ? `有 ${waiting} 条定时对话还没有生成回答，AI Flow 会按设定间隔自动重新检查。` : '采集进行中。每个来源完成后，汇总文档会自动生成。'}</div>
  </div>`;
  foot.innerHTML = `<button class="btn" data-action="stop-waiting" data-id="${esc(run.taskId)}">强制结束</button><button class="btn" data-action="close-modal">关闭</button>`;
}

function runModalOnState() {
  if (!state.openRunId) return;
  const current = state.data.currentRun;
  if (current && current.id === state.openRunId) {
    renderLiveRun(current);
    return;
  }
  const meta = (state.data.runs || []).find((run) => run.id === state.openRunId);
  if (meta && meta.status !== 'running' && !state.runFinalLoaded) {
    state.runFinalLoaded = true;
    loadRunDetail(state.openRunId);
  }
}

function confirmAction({ title, message, confirmText = '确定', danger = false, onConfirm }) {
  openModal(`<div class="modal" style="width:min(450px,92vw)">
    <div class="modal-head">
      <div class="modal-head-copy"><h2 class="modal-title">${esc(title)}</h2><p class="modal-sub">${esc(message)}</p></div>
      <button class="modal-close" data-action="close-modal" aria-label="关闭">${icon('x')}</button>
    </div>
    <div class="modal-foot">
      <button class="btn" data-action="close-modal">取消</button>
      <button class="btn ${danger ? 'danger' : 'dark'}" id="confirm-action">${esc(confirmText)}</button>
    </div>
  </div>`);
  document.getElementById('confirm-action').addEventListener('click', async () => {
    const button = document.getElementById('confirm-action');
    button.disabled = true;
    try {
      await onConfirm();
      closeModal();
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = false;
    }
  });
}

function openTaskMenu(anchor, taskId) {
  const task = state.data.tasks.find((item) => item.id === taskId);
  if (!task) return;
  openPopover(anchor, `
    <button class="menu-item" data-action="run-task" data-id="${esc(task.id)}">${icon('play')}立即运行</button>
    <button class="menu-item" data-action="edit-task" data-id="${esc(task.id)}">${icon('edit')}编辑任务</button>
    <div class="menu-sep"></div>
    <button class="menu-item danger" data-action="delete-task" data-id="${esc(task.id)}">${icon('trash')}删除任务</button>
  `);
}

function openPlatformMenu(anchor, platformId) {
  const platform = platformById(platformId);
  if (!platform) return;
  openPopover(anchor, `
    <button class="menu-item" data-action="check-platform" data-id="${esc(platform.id)}">${icon('refresh')}检查登录</button>
    <button class="menu-item" data-action="open-platform" data-id="${esc(platform.id)}">${icon('external')}${platform.login === 'logged_in' ? '打开页面' : '打开登录'}</button>
    <button class="menu-item" data-action="toggle-platform" data-id="${esc(platform.id)}" data-enabled="${!platform.enabled}">${icon('power')}${platform.enabled ? '停用平台' : '启用平台'}</button>
    ${platform.builtin ? '' : '<div class="menu-sep"></div><button class="menu-item danger" data-action="delete-platform" data-id="' + esc(platform.id) + '">' + icon('trash') + '删除平台</button>'}
  `);
}

function openBellMenu(anchor) {
  const runs = (state.data.runs || []).filter((run) => run.status !== 'running').slice(0, 5);
  const latest = runs[0];
  if (latest) localStorage.setItem('aiFlowSeenRun', latest.id);
  renderTopbar();
  const items = runs.map((run) => `<button class="menu-item" data-action="open-run" data-id="${esc(run.id)}">
    <span class="status-dot" style="background:${run.status === 'failed' ? '#e85d5d' : run.status === 'partial' ? '#e8a126' : '#20b477'}"></span>
    <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(run.taskName)}</span>
    <span style="font-size:9px;color:#a4aebe">${esc(fmtDateTime(run.finishedAt))}</span>
  </button>`).join('');
  openPopover(anchor, `${items || '<div class="menu-item" style="color:#a4aebe">还没有完成的汇总</div>'}`);
}

async function refreshState() {
  const response = await api('/api/state');
  state.data = response.state;
  render();
}

async function runTask(taskId) {
  try {
    const response = await api(`/api/tasks/${taskId}/run`, { method: 'POST' });
    toast('已开始采集，浏览器会在后台依次打开各平台', 'success');
    if (response.runId) {
      setTimeout(() => {
        if (state.data.currentRun?.id === response.runId) openRunModal(response.runId);
      }, 700);
    }
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function toggleTask(taskId, enabled) {
  try {
    const response = await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { enabled } });
    await refreshState();
    toast(enabled ? `已启用，下次运行：${nextRunText(response.task.nextRunAt)}` : '已暂停定时运行', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function stopWaiting(taskId) {
  try {
    await api(`/api/tasks/${taskId}/stop-waiting`, { method: 'POST' });
    toast('已请求强制结束，正在用读到的内容生成汇总…', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function togglePlatform(platformId, enabled) {
  try {
    await api(`/api/platforms/${platformId}`, { method: 'PATCH', body: { enabled } });
    await refreshState();
    toast(enabled ? '平台已启用' : '平台已停用', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function checkPlatform(platformId) {
  try {
    await api(`/api/platforms/${platformId}/check`, { method: 'POST' });
    toast('正在检查登录状态，可能需要十几秒');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function checkPlatforms(ids) {
  for (let index = 0; index < ids.length; index += 1) {
    try {
      await api(`/api/platforms/${ids[index]}/check`, { method: 'POST' });
    } catch (error) {
      toast(error.message, 'error');
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
}

async function checkAllPlatforms() {
  const ids = state.data.platforms.filter((platform) => platform.enabled).map((platform) => platform.id);
  if (!ids.length) {
    toast('没有启用的平台', 'error');
    return;
  }
  toast(`开始检查 ${ids.length} 个平台的登录状态`);
  checkPlatforms(ids);
}

async function openPlatformPage(platformId) {
  try {
    toast('正在打开浏览器…');
    await api(`/api/platforms/${platformId}/open`, { method: 'POST' });
    toast('已打开。登录完成后回来点「检查登录」。', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function openFolder(runId, target = '') {
  try {
    await api('/api/open-folder', { method: 'POST', body: target ? { target } : (runId ? { runId } : {}) });
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function resetWatermarks(key) {
  try {
    await api('/api/watermarks', { method: 'POST', body: { key } });
    await refreshState();
    toast(key ? '已清除这条来源的记录' : '已清除全部来源记录，下次运行会重新完整采集', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function copyRunBundle(runId, withInstruction = false) {
  try {
    const response = await api(`/api/runs/${runId}`);
    const bundle = response.bundle || (response.run?.results || [])
      .map((result) => `## ${result.name}\n\n${result.text || result.error || '未采集到回答'}`)
      .join('\n\n---\n\n');
    if (!bundle.trim()) {
      toast('这次运行没有可复制的内容', 'error');
      return;
    }
    const instruction = response.run?.mode === 'scheduled' ? SCHEDULED_SUMMARY_INSTRUCTION : SUMMARY_INSTRUCTION;
    const copied = await copyText(withInstruction ? instruction + bundle : bundle);
    toast(copied ? (withInstruction ? '已复制汇总和总结指令' : '已复制汇总全文') : '复制失败，请手动选择文本', copied ? 'success' : 'error');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function copySummary(runId) {
  try {
    let summary = state.runDetail?.run?.id === runId ? state.runDetail.run.summary : null;
    if (!summary?.text) {
      const response = await api(`/api/runs/${runId}`);
      summary = response.run?.summary;
    }
    if (!summary?.text) {
      toast('这次还没有 AI 总结', 'error');
      return;
    }
    const copied = await copyText(summary.text);
    toast(copied ? '已复制 AI 总结' : '复制失败，请手动选择文本', copied ? 'success' : 'error');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function copyAnswer(index) {
  const result = state.runDetail?.run?.results?.[index];
  if (!result?.text) {
    toast('这段没有可复制的文本', 'error');
    return;
  }
  const copied = await copyText(result.text);
  toast(copied ? '已复制这段回答' : '复制失败', copied ? 'success' : 'error');
}

function deleteTask(taskId) {
  const task = state.data.tasks.find((item) => item.id === taskId);
  if (!task) return;
  confirmAction({
    title: '删除任务',
    message: `确定删除「${task.name}」吗？已经生成的运行记录会保留。`,
    confirmText: '删除',
    danger: true,
    onConfirm: async () => {
      await api(`/api/tasks/${taskId}`, { method: 'DELETE' });
      await refreshState();
      toast('任务已删除', 'success');
    }
  });
}

async function rerunTask(taskId) {
  if (!taskId) return;
  try {
    await api(`/api/tasks/${taskId}/run`, { method: 'POST' });
    closeModal();
    toast('已重新开始采集', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function deleteRun(runId) {  const run = (state.data.runs || []).find((item) => item.id === runId);
  if (!run) return;
  confirmAction({
    title: '删除记录',
    message: `删除「${run.taskName}」这次运行记录？对应的汇总 .md 文件也会一起删除，无法恢复。`,
    confirmText: '删除',
    danger: true,
    onConfirm: async () => {
      await api(`/api/runs/${runId}`, { method: 'DELETE' });
      await refreshState();
      toast('记录已删除', 'success');
    }
  });
}

function deletePlatform(platformId) {
  const platform = platformById(platformId);
  if (!platform) return;
  const builtin = Boolean(platform.builtin);
  confirmAction({
    title: builtin ? '移除平台' : '删除平台',
    message: builtin
      ? `从平台列表里移除「${platform.name}」？以后可以在「恢复默认平台」里找回，不会删除任何本地记录。`
      : `确定删除「${platform.name}」吗？它会从所有任务中移除。`,
    confirmText: builtin ? '移除' : '删除',
    danger: true,
    onConfirm: async () => {
      await api(`/api/platforms/${platformId}`, { method: 'DELETE' });
      await refreshState();
      toast(builtin ? '平台已移除，可随时恢复' : '平台已删除', 'success');
    }
  });
}

async function restorePlatforms() {
  try {
    await api('/api/platforms/restore-defaults', { method: 'POST' });
    await refreshState();
    toast('已恢复默认平台', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function windowInvoke(command) {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) return Promise.reject(new Error('桌面窗口不可用'));
  return invoke(command, { label: 'main' });
}

async function syncWindowState() {
  try {
    const maximized = await windowInvoke('plugin:window|is_maximized');
    document.body.classList.toggle('window-maximized', Boolean(maximized));
    const button = document.querySelector('[data-window="toggle-maximize"]');
    if (button) {
      const label = maximized ? '还原' : '最大化';
      button.title = label;
      button.setAttribute('aria-label', label);
    }
  } catch {
    // 浏览器预览没有桌面内核，保留默认的最大化图标
  }
}

let windowChromeReady = false;
function initWindowChrome() {
  if (windowChromeReady) return;
  windowChromeReady = true;
  window.addEventListener('resize', syncWindowState);
  syncWindowState();
}

async function windowAction(action) {
  if (!window.__TAURI_INTERNALS__?.invoke) return;
  try {
    if (action === 'toggle-maximize') {
      const maximized = await windowInvoke('plugin:window|is_maximized').catch(() => false);
      await windowInvoke(maximized ? 'plugin:window|unmaximize' : 'plugin:window|toggle_maximize');
      syncWindowState();
    } else {
      await windowInvoke(`plugin:window|${action}`);
    }
  } catch {
    // 权限或运行时不支持时忽略：任务栏里的窗口仍然可以操作
  }
}

function shutdownApp() {
  confirmAction({
    title: '退出 AI Flow',
    message: '退出后本地服务会停止，定时任务将不再触发。下次双击启动器即可重新运行。',
    confirmText: '退出',
    danger: true,
    onConfirm: async () => {
      try {
        await api('/api/shutdown', { method: 'POST' });
      } catch {
        // 服务关闭时连接可能中断
      }
      closeModal();
      document.getElementById('view').innerHTML = `<section class="panel"><div class="empty">
        <div class="empty-icon">${icon('power')}</div>
        <div class="empty-title">AI Flow 已退出</div>
        <div class="empty-text">可以关闭这个页面。下次双击「启动 AI Flow」即可继续。</div>
      </div></section>`;
      toast('已退出 AI Flow');
    }
  });
}

async function handleAction(element) {
  const action = element.dataset.action;
  const id = element.dataset.id;
  switch (action) {
    case 'new-task':
      openTaskModal();
      break;
    case 'start-now':
      openTaskModal();
      break;
    case 'login-guide':
      openLoginGuide();
      break;
    case 'guide-check':
      closeModal();
      location.hash = 'platforms';
      await checkAllPlatforms();
      break;
    case 'run-task':
      await runTask(id);
      break;
    case 'stop-waiting':
      await stopWaiting(id);
      break;
    case 'edit-task':
      openTaskModal(id);
      break;
    case 'delete-task':
      deleteTask(id);
      break;
    case 'task-menu':
      openTaskMenu(element, id);
      break;
    case 'open-platforms':
      location.hash = 'platforms';
      break;
    case 'platform-menu':
      openPlatformMenu(element, id);
      break;
    case 'add-platform':
      openPlatformModal();
      break;
    case 'check-platform':
      await checkPlatform(id);
      break;
    case 'check-all':
      await checkAllPlatforms();
      break;
    case 'open-platform':
      await openPlatformPage(id);
      break;
    case 'delete-platform':
      deletePlatform(id);
      break;
    case 'restore-platforms':
      await restorePlatforms();
      break;
    case 'open-run':
      openRunModal(id);
      break;
    case 'go-history':
      location.hash = 'history';
      break;
    case 'filter-runs':
      state.runFilter = element.dataset.filter || 'all';
      renderView();
      break;
    case 'delete-run':
      deleteRun(id);
      break;
    case 'rerun-task':
      await rerunTask(id);
      break;
    case 'copy-run':
      await copyRunBundle(id, false);
      break;
    case 'copy-summary':
      await copySummary(id);
      break;
    case 'copy-with-instruction':
      await copyRunBundle(id, true);
      break;
    case 'copy-answer':
      await copyAnswer(Number(element.dataset.index));
      break;
    case 'open-folder':
      await openFolder(id);
      break;
    case 'open-dataset-folder':
      await api('/api/open-folder', { method: 'POST', body: { datasetRunId: id } });
      break;
    case 'open-data-folder':
      await openFolder('', 'data');
      break;
    case 'open-output-folder':
      await openFolder('', 'output');
      break;
    case 'open-desktop':
      await api('/api/open-folder', { method: 'POST', body: { target: 'desktop' } }).catch((error) => toast(error.message, 'error'));
      break;
    case 'clear-summary-conversation':
      try {
        await api('/api/settings', { method: 'POST', body: { summaryConversation: null } });
        await refreshState();
        toast('已清除共用总结对话，下次总结会新建一条', 'success');
      } catch (error) {
        toast(error.message, 'error');
      }
      break;
    case 'reset-watermark':
      await resetWatermarks(element.dataset.key || '');
      break;
    case 'close-browser':
      try {
        await api('/api/browser/close', { method: 'POST' });
        await refreshState();
        toast('自动化浏览器已关闭', 'success');
      } catch (error) {
        toast(error.message, 'error');
      }
      break;
    case 'shutdown':
      shutdownApp();
      break;
    case 'close-modal':
      closeModal();
      break;
    default:
      break;
  }
}

function connectSSE() {
  const source = new EventSource('/api/events');
  source.addEventListener('state', (event) => {
    try {
      const next = JSON.parse(event.data);
      state.data = next;
      renderNav();
      renderTopbar();
      if (!(state.view === 'settings' && state.settingsDirty)) renderView();
      runModalOnState();
    } catch {
      // 忽略单条坏消息
    }
  });
  source.addEventListener('error', () => {
    // EventSource 会自动重连；不打断界面。
  });
}

function bindGlobalEvents() {
  document.addEventListener('click', (event) => {
    const control = event.target.closest('[data-window]');
    if (control) windowAction(control.dataset.window);
  });
  document.addEventListener('input', (event) => {
    if (event.target.id !== 'run-search') return;
    state.runQuery = event.target.value;
    const query = event.target.value.trim().toLowerCase();
    $$('.run-table tbody tr').forEach((row) => {
      row.style.display = !query || row.textContent.toLowerCase().includes(query) ? '' : 'none';
    });
  });
  document.addEventListener('click', (event) => {
    const nav = event.target.closest('[data-view]');
    if (nav) {
      location.hash = nav.dataset.view;
      return;
    }
    const toggleTaskButton = event.target.closest('[data-toggle-task]');
    if (toggleTaskButton) {
      event.stopPropagation();
      const id = toggleTaskButton.dataset.toggleTask;
      const task = state.data.tasks.find((item) => item.id === id);
      if (!task) return;
      toggleTask(id, !task.enabled);
      return;
    }
    const togglePlatformButton = event.target.closest('[data-toggle-platform]');
    if (togglePlatformButton) {
      event.stopPropagation();
      const id = togglePlatformButton.dataset.togglePlatform;
      const platform = platformById(id);
      if (!platform) return;
      togglePlatform(id, !platform.enabled);
      return;
    }
    const action = event.target.closest('[data-action]');
    if (action) {
      event.preventDefault();
      event.stopPropagation();
      closePopover();
      Promise.resolve(handleAction(action)).catch((error) => toast(error.message, 'error'));
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (document.getElementById('modal-root').innerHTML) closeModal();
      else closePopover();
    }
  });

  document.getElementById('bell-btn').addEventListener('click', (event) => {
    event.stopPropagation();
    openBellMenu(event.currentTarget);
  });
  document.getElementById('avatar-btn').addEventListener('click', () => {
    location.hash = 'settings';
  });
  window.addEventListener('hashchange', () => {
    const view = location.hash.replace('#', '') || 'home';
    state.view = VIEW_META[view] ? view : 'home';
    state.settingsDirty = false;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  window.addEventListener('resize', closePopover);
  window.addEventListener('scroll', closePopover, true);
}

async function init() {
  state.view = VIEW_META[location.hash.replace('#', '')] ? location.hash.replace('#', '') : 'home';
  bindGlobalEvents();
  try {
    const response = await api('/api/state');
    state.data = response.state;
    render();
    connectSSE();
  } catch (error) {
    document.getElementById('view').innerHTML = `<section class="panel"><div class="empty">
      <div class="empty-icon">${icon('power')}</div>
      <div class="empty-title">无法连接本地工作台</div>
      <div class="empty-text">${esc(error.message)}<br>请确认「启动 AI Flow」窗口仍在运行，然后刷新页面。</div>
      <button class="btn dark" onclick="location.reload()">刷新页面</button>
    </div></section>`;
  }
}

init();
