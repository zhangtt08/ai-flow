import { sleep, stripOuterFence } from '../util.mjs';

export class AdapterError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    Object.assign(this, options);
  }
}

export class LoginRequiredError extends AdapterError {
  constructor(message = '未登录，或登录状态已经失效。') {
    super('NEEDS_LOGIN', message);
  }
}

const DEFAULT_LOGIN_SELECTORS = [
  'a[href*="/auth/login"]',
  'a[href*="/login"]',
  'a[href*="/signin"]',
  'a[href*="accounts.google.com/ServiceLogin"]',
  'a[href*="accounts.google.com/v3/signin"]',
  'button[data-testid*="login"]',
  'button:has-text("Log in")',
  'button:has-text("Sign in")',
  'button:has-text("登录")',
  'button:has-text("登入")',
  'a:has-text("Log in")',
  'a:has-text("Sign in")',
  'a:has-text("登录")'
];

// 登录成功的正向信号。只有看到输入框时才会用它们区分“已登录”和“访客可用”。
const DEFAULT_LOGGED_IN_SELECTORS = [
  'button[aria-label*="个人资料"]',
  'button[aria-label*="打开个人资料"]',
  'button[aria-label*="Profile"]',
  'button[aria-label*="Account"]',
  'button[aria-label*="账号"]',
  'a[aria-label*="Google 账号"]',
  'a[aria-label*="Google Account"]',
  '[aria-label*="Google 账号"]',
  'a[href*="SignOutOptions"]',
  'img[alt*="个人资料"]',
  'img[alt*="Profile"]',
  '[data-testid*="avatar"]',
  '[data-testid*="profile-button"]'
];

const CHATGPT = {
  id: 'chatgpt',
  homeUrl: 'https://chatgpt.com/',
  composerSelectors: [
    '#prompt-textarea',
    'textarea#mobile-composer-prompt',
    'textarea[aria-label*="ChatGPT"]',
    'textarea[aria-label*="聊天"]',
    'div[contenteditable="true"][data-placeholder]',
    'form div[contenteditable="true"]',
    'textarea[data-id="root"]',
    'textarea[placeholder]'
  ],
  sendSelectors: [
    'button[data-testid="send-button"]',
    'button[aria-label="发送消息"]',
    'button[aria-label="Send message"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="发送"]',
    'form button[type="submit"]'
  ],
  stopSelectors: [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop"]',
    'button[aria-label*="停止"]',
    'button:has-text("停止生成")'
  ],
  // 2026 新壳：assistant 消息带 data-chatgpt-search-unit-key="…:assistant"，
  // 正文根节点是 data-markdown-text-style="assistant-message"；旧版 DOM 保留作为回退。
  messageSelectors: [
    '[data-chatgpt-search-unit-key$=":assistant"]',
    '[data-markdown-text-style="assistant-message"]',
    'ol[aria-label^="对话"] > li',
    'ol[aria-label^="Conversation"] > li',
    'ol[aria-label^="Messages"] > li',
    '[data-message-author-role="assistant"]',
    'article[data-testid^="conversation-turn"] [data-message-author-role="assistant"]'
  ],
  contentSelectors: [
    '[data-markdown-text-style="assistant-message"]',
    'section[aria-label^="DIL content"]',
    '[data-d-component="text"]',
    '.markdown',
    '.prose'
  ],
  userMarkers: [
    '[data-user-message-bubble="true"]',
    '[data-chatgpt-search-unit-key$=":user"]',
    '[data-user-message-copy]',
    '[data-message-author-role="user"]'
  ],
  historyLinkSelectors: ['nav a[href*="/c/"]', 'aside a[href*="/c/"]', 'a[href*="/c/"]'],
  scheduledEntryUrl: '/tasks',
  scheduledEntrySelectors: ['a:has-text("任务")', 'a:has-text("Tasks")', 'button:has-text("任务")'],
  newChatSelectors: [
    '[data-testid="create-new-chat-button"]',
    'a[data-testid="create-new-chat-button"]',
    'a:has-text("新聊天")',
    'button:has-text("新聊天")',
    'a:has-text("New chat")',
    'button:has-text("New chat")',
    'button[aria-label*="New chat"]',
    'button[aria-label*="新聊天"]'
  ],
  resetOnHome: true,
  loginSelectors: DEFAULT_LOGIN_SELECTORS
};

const GEMINI = {
  id: 'gemini',
  homeUrl: 'https://gemini.google.com/app',
  composerSelectors: [
    'rich-textarea div[contenteditable="true"]',
    '.ql-editor[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][aria-label*="prompt"]',
    'textarea[aria-label*="prompt"]'
  ],
  sendSelectors: [
    'button[aria-label*="Send message"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="发送"]',
    'button.send-button'
  ],
  stopSelectors: [
    'button[aria-label*="Stop"]',
    'button[aria-label*="停止"]',
    'button:has(mat-icon[fonticon="stop"])'
  ],
  messageSelectors: ['model-response', 'message-content', '.model-response-text'],
  contentSelectors: ['.markdown', 'message-content', '.model-response-text'],
  userMarkers: ['user-query', '[data-message-author-role="user"]', '.user-query'],
  historyLinkSelectors: ['a[href*="/app/"]', 'side-nav-thread-list a', 'mat-nav-list a[href*="/app/"]'],
  scheduledEntrySelectors: [
    'button[aria-label*="已安排"]',
    'a:has-text("已安排的活动")',
    'button:has-text("已安排")',
    'a:has-text("Scheduled")',
    'a:has-text("定时")'
  ],
  newChatSelectors: [
    'button[aria-label*="New chat"]',
    'button[aria-label*="新对话"]',
    'button[aria-label*="新聊天"]',
    'side-nav-action-button[aria-label*="New"]'
  ],
  resetOnHome: true,
  loginSelectors: DEFAULT_LOGIN_SELECTORS
};

const CLAUDE = {
  id: 'claude',
  homeUrl: 'https://claude.ai/new',
  composerSelectors: [
    'div[contenteditable="true"].ProseMirror',
    'div[contenteditable="true"][aria-label*="Write"]',
    'fieldset div[contenteditable="true"]',
    'div[contenteditable="true"]'
  ],
  sendSelectors: [
    'button[aria-label="Send message"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="发送"]',
    'button[type="submit"]'
  ],
  stopSelectors: [
    'button[aria-label="Stop response"]',
    'button[aria-label*="Stop"]',
    'button[aria-label*="停止"]'
  ],
  messageSelectors: ['.font-claude-message', '[data-testid="chat-message-content"] .font-claude-message'],
  contentSelectors: ['.standard-markdown', '.prose', '.markdown'],
  userMarkers: ['.font-user-message', '[data-message-author-role="user"]'],
  historyLinkSelectors: ['a[href*="/chat/"]', 'nav a[href*="/chat/"]'],
  newChatSelectors: [],
  resetOnHome: false,
  loginSelectors: DEFAULT_LOGIN_SELECTORS
};

const PERPLEXITY = {
  id: 'perplexity',
  homeUrl: 'https://www.perplexity.ai/',
  composerSelectors: [
    'textarea#ask-input',
    'div#ask-input[contenteditable="true"]',
    'textarea[placeholder*="Ask"]',
    'textarea[placeholder*="提问"]',
    'textarea'
  ],
  sendSelectors: [
    'button[aria-label="Submit"]',
    'button[aria-label*="Submit"]',
    'button[aria-label*="Send"]',
    'button[data-testid="submit-button"]',
    'button[type="submit"]'
  ],
  stopSelectors: ['button[aria-label*="Stop"]', 'button[aria-label*="停止"]'],
  messageSelectors: ['[data-testid="answer"]', '[class*="answer"] .prose', 'div.prose'],
  contentSelectors: ['.prose', '[class*="markdown"]'],
  userMarkers: ['[data-testid="query"]', '[class*="query"]'],
  historyLinkSelectors: ['a[href*="/search/"]', 'a[href^="/p/"]'],
  newChatSelectors: [],
  resetOnHome: false,
  loginSelectors: DEFAULT_LOGIN_SELECTORS
};

const GROK = {
  id: 'grok',
  homeUrl: 'https://grok.com/',
  automationsUrl: 'https://grok.com/automations',
  composerSelectors: [
    'textarea[aria-label*="Ask"]',
    'textarea[placeholder*="Ask"]',
    'textarea[placeholder*="问"]',
    'div[contenteditable="true"]',
    'textarea'
  ],
  sendSelectors: [
    'button[aria-label*="Submit"]',
    'button[aria-label*="Send"]',
    'button[type="submit"]'
  ],
  stopSelectors: ['button[aria-label*="Stop"]', 'button[aria-label*="停止"]'],
  // 已用真实页面验证：自动化运行的对话里，回答是 [data-testid="assistant-message"]，
  // 正文在 .response-content-markdown 里（不含“Grok / 工作了 19s”这层外壳）。
  messageSelectors: [
    '[data-testid="assistant-message"]',
    'div.message-bubble',
    '[data-testid*="assistant-message"]',
    '[data-testid="chat-transcript-scroller"] .chat-md',
    '[data-testid*="message"]'
  ],
  contentSelectors: ['.response-content-markdown', '[class*="response-content-markdown"]', '.chat-md', '.prose', '.markdown'],
  userMarkers: ['[data-testid="user-message"]', '[class*="user-message"]'],
  historyLinkSelectors: ['a[href*="/chat/"]', 'a[href*="/c/"]'],
  newChatSelectors: [],
  resetOnHome: false,
  loginSelectors: DEFAULT_LOGIN_SELECTORS
};

const MUSE = {
  id: 'muse',
  homeUrl: 'https://muse.ai/',
  // Meta 的个人 AI 智能体 Muse（不是 meta.ai 聊天页）。未登录会跳到 auth.muse.ai。
  composerSelectors: [
    'div[contenteditable="true"][role="textbox"]',
    'textarea[placeholder]',
    'div[contenteditable="true"]',
    'textarea'
  ],
  sendSelectors: [
    'button[aria-label*="Send"]',
    'button[aria-label*="发送"]',
    'button[type="submit"]'
  ],
  stopSelectors: ['button[aria-label*="Stop"]', 'button[aria-label*="停止"]'],
  messageSelectors: [
    '[data-testid*="message"]',
    '[data-message-author-role="assistant"]',
    '[class*="markdown"]',
    '.prose'
  ],
  userMarkers: ['[data-message-author-role="user"]', '[data-user-message-copy]'],
  contentSelectors: ['[class*="markdown"]', '.prose'],
  historyLinkSelectors: ['a[href*="/chat"]', 'a[href*="/c/"]', 'a[href*="/task"]', 'a[href^="/"]'],
  scheduledEntrySelectors: ['a:has-text("Scheduled")', 'a:has-text("定时")', 'button:has-text("即将到来")'],
  newChatSelectors: [],
  resetOnHome: false,
  needsLogin: true,
  loginSelectors: DEFAULT_LOGIN_SELECTORS
};

const DEEPSEEK = {
  id: 'deepseek',
  homeUrl: 'https://chat.deepseek.com/',
  composerSelectors: [
    'textarea[placeholder]',
    'div[contenteditable="true"]',
    'textarea'
  ],
  sendSelectors: ['button[aria-label*="Send"]', 'button[aria-label*="发送"]', 'div[class*="send"]', 'button[type="submit"]'],
  stopSelectors: ['button[aria-label*="Stop"]', 'button[aria-label*="停止"]'],
  messageSelectors: ['[data-testid*="assistant"]', '[class*="markdown"]', '.ReactMarkdown', 'pre'],
  userMarkers: ['[data-testid*="user"]'],
  contentSelectors: ['[class*="markdown"]', '.ReactMarkdown'],
  historyLinkSelectors: ['a[href*="/chat/"]', 'li[class*="conversation"]', 'a[href*="share"]'],
  newChatSelectors: ['a:has-text("新建对话")', 'button:has-text("新建对话")'],
  resetOnHome: false,
  needsLogin: true,
  loginSelectors: DEFAULT_LOGIN_SELECTORS
};

const KIMI = {
  id: 'kimi',
  homeUrl: 'https://kimi.moonshot.cn/',
  composerSelectors: ['div[contenteditable="true"]', 'textarea[placeholder]', 'textarea'],
  sendSelectors: ['button[aria-label*="发送"]', 'button[aria-label*="Send"]', 'button[type="submit"]'],
  stopSelectors: ['button[aria-label*="停止"]', 'button[aria-label*="Stop"]'],
  messageSelectors: ['[class*="answer"]', '[class*="markdown"]', '[data-testid*="message"]'],
  userMarkers: ['[class*="question"]'],
  contentSelectors: ['[class*="markdown"]', '[class*="answer-content"]'],
  historyLinkSelectors: ['a[href*="/chat/"]', '[class*="session"] a', 'li[role="listitem"]'],
  newChatSelectors: ['button:has-text("新建对话")', 'a:has-text("新建对话")'],
  resetOnHome: false,
  needsLogin: true,
  loginSelectors: DEFAULT_LOGIN_SELECTORS
};

const DOUBAO = {
  id: 'doubao',
  homeUrl: 'https://www.doubao.com/',
  composerSelectors: ['div[contenteditable="true"]', 'textarea[placeholder]', 'textarea'],
  sendSelectors: ['button[aria-label*="发送"]', 'button[aria-label*="Send"]', 'button[type="submit"]'],
  stopSelectors: ['button[aria-label*="停止"]', 'button[aria-label*="Stop"]'],
  messageSelectors: ['[class*="message-content"]', '[class*="markdown"]', '[data-testid*="message"]'],
  userMarkers: ['[class*="user-message"]'],
  contentSelectors: ['[class*="markdown"]', '[class*="message-content"]'],
  historyLinkSelectors: ['a[href*="/chat/"]', '[class*="history"] a', 'li[class*="conversation"]'],
  newChatSelectors: ['a:has-text("新建对话")', 'button:has-text("新建对话")', 'a[href*="/chat"]'],
  resetOnHome: false,
  needsLogin: true,
  loginSelectors: DEFAULT_LOGIN_SELECTORS
};

const QWEN = {
  id: 'qwen',
  homeUrl: 'https://www.tongyi.com/',
  composerSelectors: ['div[contenteditable="true"]', 'textarea[placeholder]', 'textarea'],
  sendSelectors: ['button[aria-label*="发送"]', 'button[aria-label*="Send"]', 'button[type="submit"]'],
  stopSelectors: ['button[aria-label*="停止"]', 'button[aria-label*="Stop"]'],
  messageSelectors: ['[class*="markdown"]', '[data-testid*="message"]', '[class*="chat-message"]'],
  userMarkers: ['[class*="user"]'],
  contentSelectors: ['[class*="markdown"]'],
  historyLinkSelectors: ['a[href*="/chat/"]', '[class*="session"]', 'li[class*="history"]'],
  newChatSelectors: ['button:has-text("新建对话")', 'a:has-text("新建对话")'],
  resetOnHome: false,
  needsLogin: true,
  loginSelectors: DEFAULT_LOGIN_SELECTORS
};

const CUSTOM = {
  id: 'custom',
  homeUrl: '',
  composerSelectors: [
    'textarea',
    'div[contenteditable="true"]',
    '[role="textbox"]'
  ],
  sendSelectors: [
    'button[type="submit"]',
    'button[aria-label*="Send"]',
    'button:has-text("发送")'
  ],
  stopSelectors: ['button[aria-label*="Stop"]', 'button:has-text("Stop")'],
  messageSelectors: [
    '[data-message-author-role="assistant"]',
    '[data-testid*="assistant"]',
    '[class*="assistant"]',
    '[class*="message"]',
    '.prose',
    '[class*="markdown"]',
    'article'
  ],
  contentSelectors: ['.markdown', '.prose', '[class*="markdown"]'],
  userMarkers: ['[data-message-author-role="user"]', '[class*="user"]'],
  historyLinkSelectors: ['a[href*="/chat"]', 'a[href*="/c/"]', 'nav a[href^="/"]'],
  newChatSelectors: [],
  resetOnHome: false,
  loginSelectors: DEFAULT_LOGIN_SELECTORS
};

export const ADAPTERS = {
  chatgpt: CHATGPT,
  gemini: GEMINI,
  claude: CLAUDE,
  perplexity: PERPLEXITY,
  grok: GROK,
  muse: MUSE,
  deepseek: DEEPSEEK,
  kimi: KIMI,
  doubao: DOUBAO,
  qwen: QWEN,
  custom: CUSTOM
};

export function getAdapter(platform) {
  const base = ADAPTERS[platform?.adapterId] || CUSTOM;
  const custom = platform?.customSelectors || {};
  const prepend = (list, value) => (value ? [value, ...(list || [])] : list || []);
  return {
    ...base,
    homeUrl: platform?.url || base.homeUrl,
    composerSelectors: prepend(base.composerSelectors, custom.composer),
    sendSelectors: prepend(base.sendSelectors, custom.send),
    stopSelectors: prepend(base.stopSelectors, custom.stop),
    messageSelectors: prepend(base.messageSelectors, custom.answer),
    historyLinkSelectors: prepend(base.historyLinkSelectors, custom.history),
    loginSelectors: [...(base.loginSelectors || []), ...DEFAULT_LOGIN_SELECTORS],
    loggedInSelectors: [...(base.loggedInSelectors || []), ...DEFAULT_LOGGED_IN_SELECTORS]
  };
}

async function findVisible(scope, selectors, options = {}) {
  const { last = false, requireEnabled = false } = options;
  for (const selector of selectors || []) {
    if (!selector) continue;
    const locator = scope.locator(selector);
    const count = await locator.count().catch(() => 0);
    if (!count) continue;
    const indexes = last ? [count - 1] : Array.from({ length: Math.min(count, 8) }, (_, index) => index);
    for (const index of indexes) {
      const element = locator.nth(index);
      const visible = await element.isVisible().catch(() => false);
      if (!visible) continue;
      if (requireEnabled) {
        const enabled = await element.isEnabled().catch(() => false);
        if (!enabled) continue;
      }
      return element;
    }
  }
  return null;
}

async function readBodyText(page, max = 5000) {
  return page
    .evaluate((limit) => (document.body?.innerText || '').slice(0, limit), max)
    .catch(() => '');
}

export function looksLikeChallenge(text) {
  return /just a moment|verify (that )?you are (a )?human|checking your browser|attention required|unusual traffic|enable javascript and cookies|安全验证|人机验证|验证您是真人|正在验证|异常流量|确认这些请求|不是自动程序|自动程序发出|访问过于频繁|环境异常|captcha/i.test(
    String(text || '')
  );
}

export function looksLikeAuthUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return false;
  }
  const host = parsed.hostname || '';
  if (/^(auth|accounts|login|signin|passport|sso|id)\./i.test(host)) return true;
  if (/accounts\.google\.com/i.test(host)) return true;
  const pathname = parsed.pathname || '';
  return /\/(login|signin|oauth|auth)(\/|$)/i.test(pathname);
}

async function hasLoginCta(page, adapter) {
  const selectors = adapter.loginSelectors || DEFAULT_LOGIN_SELECTORS;
  for (const selector of selectors) {
    if (!selector) continue;
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < Math.min(count, 8); index += 1) {
      const element = locator.nth(index);
      if (!(await element.isVisible().catch(() => false))) continue;
      const text = await element.innerText().catch(() => '');
      const href = await element.getAttribute('href').catch(() => '');
      // Google 的账号菜单也指向 accounts.google.com/SignOutOptions，已登录时不能把它当登录入口。
      if (/SignOutOptions|accounts\.google\.com\/.*(logout|signout)/i.test(String(href || ''))) continue;
      if (/(Google 账号|账号：|退出|登出|注销|log\s?out|sign\s?out)/i.test(text)) continue;
      return true;
    }
  }
  return false;
}

function looksLikeChallengeUrl(url) {
  return /(\/sorry\/|cdn-cgi\/challenge|\/challenge\b|hcaptcha|recaptcha|captcha)/i.test(String(url || ''));
}

function loginBlocked() {
  return {
    state: 'blocked',
    message: '网站要求人机验证或网络验证。请点「打开登录」，在弹出的浏览器窗口里完成验证后，这里会自动更新状态。'
  };
}

export async function inspectLogin(page, adapter) {
  if (page.isClosed()) return { state: 'error', message: '页面被关闭。' };
  const current = page.url();
  if (looksLikeChallengeUrl(current)) return loginBlocked();

  const composer = await findVisible(page, adapter.composerSelectors);
  if (composer) {
    const marker = await findVisible(page, adapter.loggedInSelectors || []);
    if (marker) return { state: 'logged_in', message: '已登录，输入框可用。' };
    if (await hasLoginCta(page, adapter)) {
      return { state: 'guest', message: '输入框可用；要读取账号内的定时对话，请在 AI Flow 浏览器里登录一次。' };
    }
    return { state: 'logged_in', message: '输入框已就绪。' };
  }

  const body = await readBodyText(page);
  if (looksLikeChallenge(body)) return loginBlocked();
  if (looksLikeAuthUrl(current)) return { state: 'logged_out', message: '页面跳转到了登录地址。' };
  if (await hasLoginCta(page, adapter)) {
    return { state: 'logged_out', message: '页面显示登录入口（该站点可能允许访客试用，但账号尚未登录）。' };
  }
  return { state: 'unknown', message: null };
}

export async function dismissConsent(page) {
  const selectors = [
    'button:has-text("Accept all")',
    'button:has-text("Accept cookies")',
    'button:has-text("全部接受")',
    'button:has-text("接受全部")',
    'button:has-text("同意")',
    'button:has-text("Got it")',
    'button:has-text("知道了")',
    'button[aria-label*="Accept"]'
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.click({ timeout: 1200 }).catch(() => {});
      await sleep(250);
    }
  }
}

// Grok 创建自动化后会弹“自动化权限”确认框；它会挡住运行列表。
// 这里只负责关掉（Esc），不替用户授权；关不掉就给明确提示，避免被误判成“找不到运行”。
async function dismissGrokDialog(page) {
  const body = await readVisibleMainText(page).catch(() => '');
  if (!/全部允许|全部拒绝|确认我的选择/.test(body)) return;
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(800);
  const after = await readVisibleMainText(page).catch(() => '');
  if (/全部允许|全部拒绝|确认我的选择/.test(after)) {
    throw new AdapterError(
      'AUTOMATION_PERMISSION',
      'Grok 弹出了「自动化权限」确认框，挡住了运行列表。请在自动化浏览器里手动处理一次（允许或拒绝），之后再运行采集。'
    );
  }
}

export async function findComposer(page, adapter, timeoutMs = 0) {
  const deadline = Date.now() + timeoutMs;
  do {
    const composer = await findVisible(page, adapter.composerSelectors);
    if (composer) return composer;
    if (Date.now() >= deadline) break;
    await sleep(500);
  } while (Date.now() < deadline);
  return null;
}

export async function navigate(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  } catch (error) {
    if (!/ERR_ABORTED|frame was detached|ERR_FAILED|ERR_TIMED_OUT|ERR_CONNECTION/i.test(String(error.message))) {
      throw error;
    }
    await sleep(900);
    try {
      await page.goto(url, { waitUntil: 'commit', timeout: 60_000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
    } catch (retryError) {
      throw new AdapterError('PAGE_ERROR', `无法打开页面：${String(retryError.message || retryError).slice(0, 200)}`);
    }
  }
}

export async function probeLogin(page, adapter, platform, timeoutMs = 60_000) {
  const url = platform?.url || adapter.homeUrl;
  try {
    await navigate(page, url);
  } catch (error) {
    return { state: 'error', message: error.message || `无法打开页面：${String(error.message || error).slice(0, 180)}` };
  }
  await sleep(1200);
  await dismissConsent(page);

  const deadline = Date.now() + timeoutMs;
  let last = { state: 'unknown', message: null };
  while (Date.now() < deadline) {
    last = await inspectLogin(page, adapter);
    if (['logged_in', 'logged_out', 'blocked', 'error'].includes(last.state)) return last;
    if (last.state === 'guest') {
      // 给账号入口一点加载时间；若确实只是访客，返回“可用（未登录）”，不要误判成未登录。
      await sleep(1200);
      const again = await inspectLogin(page, adapter);
      if (again.state === 'logged_in') return again;
      return again.state === 'unknown' ? last : again;
    }
    await sleep(600);
  }

  return last.state === 'unknown'
    ? { state: 'unknown', message: '没有找到输入框或登录入口，页面结构可能已变化。' }
    : last;
}

export async function startConversation(page, adapter, platform, options = {}) {
  const conversationUrl = String(options.conversationUrl || '').trim();
  const url = conversationUrl || platform?.url || adapter.homeUrl;
  await navigate(page, url);
  await sleep(1200);
  await dismissConsent(page);

  if (!conversationUrl && adapter.resetOnHome) {
    const newChat = await findVisible(page, adapter.newChatSelectors || []);
    if (newChat) {
      await newChat.click({ timeout: 2500 }).catch(() => {});
      await sleep(900);
    }
  }

  let composer = await findComposer(page, adapter, 5000);
  if (!composer) {
    const state = await probeLogin(page, adapter, platform, 45_000);
    if (state.state === 'logged_out') throw new LoginRequiredError('未登录或登录状态已失效。');
    if (state.state === 'blocked') throw new AdapterError('CHALLENGE', state.message);
    if (state.state === 'error') throw new AdapterError('PAGE_ERROR', state.message);
    composer = await findComposer(page, adapter, 5000);
  }
  if (!composer) {
    throw new AdapterError('NO_COMPOSER', '页面已打开，但没有找到输入框。可能是未登录或网站结构变化。');
  }
  return composer;
}

export async function sendPrompt(page, adapter, prompt) {
  const composer = await findComposer(page, adapter, 8000);
  if (!composer) throw new LoginRequiredError('没有找到输入框，请先登录。');

  await composer.click({ timeout: 5000 }).catch(() => {});
  const tag = await composer.evaluate((element) => element.tagName.toLowerCase()).catch(() => 'div');
  if (tag === 'textarea' || tag === 'input') {
    await composer.fill(prompt, { timeout: 8000 }).catch(async () => {
      await page.keyboard.press('Control+A');
      await page.keyboard.insertText(prompt);
    });
  } else {
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await page.keyboard.insertText(prompt);
  }
  await sleep(350);

  const send = await findVisible(page, adapter.sendSelectors || [], { requireEnabled: true });
  if (send) {
    await send.click({ timeout: 4000 }).catch(async () => {
      await page.keyboard.press('Enter');
    });
  } else {
    await page.keyboard.press('Enter');
  }
  await sleep(900);

  const sendAgain = await findVisible(page, adapter.sendSelectors || [], { requireEnabled: true });
  if (sendAgain) {
    const composerText = await composer.innerText().catch(() => '');
    if (composerText.trim().length > 20) {
      await sendAgain.click({ timeout: 2500 }).catch(() => {});
      await sleep(600);
    }
  }
}

function domToMarkdown(root) {
  const SKIP = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'BUTTON',
    'MAT-ICON',
    'INPUT',
    'TEXTAREA',
    'SELECT',
    'VIDEO',
    'AUDIO'
  ]);
  const BLOCK = new Set([
    'P',
    'DIV',
    'SECTION',
    'ARTICLE',
    'HEADER',
    'FOOTER',
    'UL',
    'OL',
    'LI',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'BLOCKQUOTE',
    'PRE',
    'TABLE',
    'TR',
    'FIGURE',
    'FIGCAPTION'
  ]);

  function children(node, inPre) {
    let output = '';
    for (const child of node.childNodes) output += walk(child, inPre);
    return output;
  }

  function walk(node, inPre) {
    if (node.nodeType === 3) {
      const text = node.nodeValue || '';
      return inPre ? text : text.replace(/\s+/g, ' ');
    }
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toUpperCase();
    if (SKIP.has(tag)) return '';
    if (node.hidden) return '';
    if (node.getAttribute('aria-hidden') === 'true') return '';
    const className = String(node.getAttribute('class') || '');
    if (/(^|\s)sr-only(\s|$)/.test(className)) return '';
    const testId = String(node.getAttribute('data-testid') || '');
    if (/copy|feedback|thumbs|share|regenerate|toolbar/i.test(testId)) return '';
    try {
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return '';
    } catch {
      // 忽略跨域样式错误
    }

    if (tag === 'BR') return '\n';
    if (tag === 'HR') return '\n\n---\n\n';
    if (tag === 'IMG') {
      const src = node.currentSrc || node.src || '';
      const alt = String(node.alt || '').trim();
      if (/^https?:/i.test(src)) return `![${alt}](${src})`;
      if (/^data:image\//i.test(src) && src.length <= 300_000) {
        return `\n\n![${alt || '图表'}](${src})\n\n`;
      }
      try {
        if (node.complete && node.naturalWidth >= 80 && node.naturalHeight >= 60) {
          const canvas = document.createElement('canvas');
          canvas.width = node.naturalWidth;
          canvas.height = node.naturalHeight;
          canvas.getContext('2d').drawImage(node, 0, 0);
          const data = canvas.toDataURL('image/png');
          if (data.length <= 300_000) return `\n\n![${alt || '图表'}](${data})\n\n`;
        }
      } catch {
        // 跨域图片无法转存，保留文字说明
      }
      return alt ? `\n\n[图片：${alt}]\n\n` : '';
    }
    if (tag === 'CANVAS') {
      const rect = node.getBoundingClientRect();
      const width = Math.max(rect.width, Number(node.getAttribute('width')) || 0, node.width || 0);
      const height = Math.max(rect.height, Number(node.getAttribute('height')) || 0, node.height || 0);
      if (width < 80 || height < 40) return '';
      try {
        const data = node.toDataURL('image/png');
        if (data.length <= 300_000) return `\n\n![图表](${data})\n\n`;
      } catch {
        // 被污染的 canvas 无法导出
      }
      return `\n\n[图表：canvas ${Math.round(width)}x${Math.round(height)}]\n\n`;
    }
    if (tag === 'SVG') {
      const rect = node.getBoundingClientRect();
      const width = Math.max(rect.width, Number(node.getAttribute('width')) || 0);
      const height = Math.max(rect.height, Number(node.getAttribute('height')) || 0);
      if (width < 80 || height < 40) return '';
      const labels = [...new Set(
        Array.from(node.querySelectorAll('text'))
          .map((item) => String(item.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
      )].slice(0, 48);
      const title = String(node.querySelector('title')?.textContent || node.getAttribute('aria-label') || '').trim();
      if (labels.length) return `\n\n[图表${title ? `：${title}` : ''}] ${labels.join(' | ')}\n\n`;
      return title ? `\n\n[图表：${title}]\n\n` : '';
    }
    if (node.getAttribute('role') === 'img') {
      const label = String(node.getAttribute('aria-label') || '').trim();
      if (label && !node.querySelector('img,svg,canvas,table')) return `\n\n[图表：${label}]\n\n`;
    }
    if (tag === 'A') {
      const href = node.href || '';
      const inner = children(node, inPre).replace(/\s+/g, ' ').trim();
      if (!inner) return '';
      return /^https?:/i.test(href) ? `[${inner}](${href})` : inner;
    }
    if (tag === 'CODE' && !inPre) {
      const code = (node.textContent || '').trim();
      return code ? `\`${code}\`` : '';
    }
    if (tag === 'PRE') {
      const text = (node.innerText || node.textContent || '').replace(/\n+$/, '');
      const code = node.querySelector('code');
      const language = code ? (String(code.className || '').match(/language-([\w-]+)/) || [])[1] || '' : '';
      return `\n\n\`\`\`${language}\n${text}\n\`\`\`\n\n`;
    }
    if (tag === 'STRONG' || tag === 'B') return `**${children(node, inPre).trim()}**`;
    if (tag === 'EM' || tag === 'I') return `*${children(node, inPre).trim()}*`;
    if (/^H[1-6]$/.test(tag)) {
      return `\n\n${'#'.repeat(Number(tag[1]))} ${children(node, inPre).trim()}\n\n`;
    }
    if (tag === 'LI') {
      const parent = node.parentElement;
      const marker = parent && parent.tagName === 'OL' ? '1.' : '-';
      return `\n${marker} ${children(node, inPre).trim()}`;
    }
    if (tag === 'BLOCKQUOTE') {
      const inner = children(node, inPre).trim().replace(/\n/g, '\n> ');
      return `\n\n> ${inner}\n\n`;
    }
    if (tag === 'TABLE') {
      const rows = Array.from(node.querySelectorAll('tr'));
      if (!rows.length) return '';
      const lines = rows.map((row) => {
        const cells = Array.from(row.querySelectorAll('th,td')).map((cell) =>
          (cell.innerText || '').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')
        );
        return `| ${cells.join(' | ')} |`;
      });
      if (lines.length > 1) {
        const columns = rows[0].querySelectorAll('th,td').length || 1;
        lines.splice(1, 0, `| ${Array.from({ length: columns }, () => '---').join(' | ')} |`);
      }
      return `\n\n${lines.join('\n')}\n\n`;
    }
    if (BLOCK.has(tag)) return `\n${children(node, inPre).trim()}\n`;
    return children(node, inPre);
  }

  let markdown = walk(root, false);
  markdown = markdown
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return markdown;
}

export function sanitizeAnswer(text) {
  let value = stripOuterFence(text)
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .trim();
  value = value.replace(
    /^(ChatGPT|Gemini|Claude|Perplexity|Grok|Meta AI|Muse)(\s*(说|said|回答|says))?\s*[:：]\s*/i,
    ''
  );
  const uiLine =
    /^(Copy|Copied|Copy code|复制|复制代码|Edit|编辑|Regenerate|重新生成|Retry|重试|Read aloud|朗读|Share|分享|Good response|Bad response|赞|踩|Like|Dislike|Show more|Show less|展开|收起|More|更多)$/i;
  value = value
    .split('\n')
    .filter((line) => !uiLine.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return value;
}

async function extractElement(element, adapter) {
  for (const selector of adapter.contentSelectors || []) {
    const content = element.locator(selector);
    const count = await content.count().catch(() => 0);
    if (!count) continue;
    const parts = [];
    for (let index = 0; index < Math.min(count, 6); index += 1) {
      const part = content.nth(index);
      if (!(await part.isVisible().catch(() => false))) continue;
      const markdown = await part.evaluate(domToMarkdown).catch(() => '');
      if (markdown && markdown.trim()) parts.push(markdown.trim());
    }
    const joined = sanitizeAnswer(parts.join('\n\n'));
    if (joined) return joined;
  }
  const fallback = await element.evaluate(domToMarkdown).catch(() => '');
  return sanitizeAnswer(fallback);
}

export async function snapshotAnswers(page, adapter, preferredSelector = null) {
  let selector = preferredSelector || null;
  let count = 0;
  let root = null;

  if (selector) {
    const locator = page.locator(selector);
    count = await locator.count().catch(() => 0);
    if (count) root = locator;
  }
  if (!root) {
    for (const candidate of adapter.messageSelectors || []) {
      const locator = page.locator(candidate);
      const found = await locator.count().catch(() => 0);
      if (found) {
        selector = candidate;
        count = found;
        root = locator;
        break;
      }
    }
  }

  let text = '';
  if (root && count) {
    text = await extractElement(root.nth(count - 1), adapter).catch(() => '');
  }

  return {
    selector,
    count,
    text,
    stop: await isStopVisible(page, adapter)
  };
}

export async function isStopVisible(page, adapter) {
  const selectors = [
    ...(adapter.stopSelectors || []),
    'button:has-text("Stop generating")',
    'button:has-text("停止生成")',
    'button:has-text("停止")'
  ];
  const found = await findVisible(page, selectors);
  return Boolean(found);
}

// 输入框、工具栏、操作按钮：这些区域永远不是“AI 回答”。
// 注意：不能用 CSS 的 [class*="chat-input"] —— Tailwind 会把 CSS 变量写进 class
// （如 [--chat-input-height:56px]），属性选择器会命中整页容器，导致什么都读不到。
// 也只看“节点自己”的 class，不看祖先：Gemini 的回答外层就叫 message-actions-hover-boundary。
const NON_ANSWER_TOKENS = /^(?:.*-)?(composer|chat-input-editor|message-actions|message-actions-hover-boundary)$/i;

// 用户气泡：只认明确的用户消息标记，且只对“单个消息节点”生效。
const USER_BUBBLE =
  '[class*="user-message"], [class*="user-query"], [class*="user-bubble"], [data-message-author-role="user"], [data-testid="user-message"]';

// 判定一个节点是不是“AI 回答”：返回 drop 原因或 keep。
function classifyNode(node, markers, bubble) {
  for (const marker of markers) {
    try {
      if (node.matches(marker)) return 'user-self';
    } catch {
      // 忽略非法选择器
    }
  }
  const head = (node.innerText || '').slice(0, 24).trim();
  if (/^(你说：|你说:|You said|用户：|用户:)/.test(head)) return 'user-prefix';

  // 输入框 / 工具栏：只看“节点自己”的 class 与属性，不向上找祖先
  // （Gemini 的 model-response 外层就叫 message-actions-hover-boundary，看祖先会误杀）。
  const selfTokens = String(node.className || '')
    .split(/\s+/)
    .filter((token) => token && !token.startsWith('[') && !token.startsWith('--'));
  if (selfTokens.some((token) => /^(composer|chat-input-editor|message-actions|message-actions-hover-boundary)$/i.test(token))) {
    return 'zone';
  }
  if (node.tagName === 'TEXTAREA') return 'zone';
  if (node.getAttribute && node.getAttribute('contenteditable') === 'true') return 'zone';
  // 输入框内部的节点（ProseMirror 编辑器）也不是回答。
  try {
    const editable = node.closest('[contenteditable="true"], textarea, .ProseMirror, .tiptap, [class*="chat-input-editor"]');
    if (editable && !node.matches(USER_BUBBLE)) return 'zone';
  } catch {
    // 忽略
  }

  // 自己就是用户气泡，或处在用户气泡内部。
  try {
    if (node.matches(bubble) || node.closest(bubble)) return 'user-bubble';
  } catch {
    // 忽略
  }

  // 整页/整列表容器：文本里既有用户气泡又有回答，不能当成一条消息。
  const bubbles = node.querySelectorAll(bubble).length;
  const length = (node.innerText || '').trim().length;
  if (bubbles && length > 800) return 'container';
  return 'keep';
}

// 嵌套重复：Qwen 同一段回答会同时出现在 wrapper/inner/card/markdown 四层里，
// 按文字归一化后去重，只保留信息量最大的那一层。
function normalizeForDedupe(text) {
  return String(text || '').replace(/\s+/g, '').replace(/[，。！？、；：""''（）《》【】\-—_*#>|]/g, '').slice(0, 600);
}

export async function readAnswerMessages(page, adapter) {
  let selector = null;
  let locator = null;
  let count = 0;
  for (const candidate of adapter.messageSelectors || []) {
    const candidateLocator = page.locator(candidate);
    const found = await candidateLocator.count().catch(() => 0);
    if (found) {
      selector = candidate;
      locator = candidateLocator;
      count = found;
      break;
    }
  }
  if (!locator) return { selector: null, messages: [] };

  const markers = adapter.userMarkers || [];
  const collected = [];
  for (let index = 0; index < count; index += 1) {
    const element = locator.nth(index);
    // 用户消息判定：节点“自己”就是用户气泡，或者只含用户气泡而没有别的正文。
    // 不能因为子孙里有一个用户气泡就把整页容器判成用户消息（manus 踩过）。
    const verdict = await element
      .evaluate((node, opts) => {
        const { list, bubble } = opts;
        for (const marker of list) {
          try {
            if (node.matches(marker)) return 'user-self';
          } catch {
            // 忽略非法选择器
          }
        }
        const head = (node.innerText || '').slice(0, 24).trim();
        if (/^(你说：|你说:|You said|用户：|用户:)/.test(head)) return 'user-prefix';

        // 输入框 / 工具栏：只看“节点自己”的 class 与属性，不向上找祖先
        // （Gemini 的 model-response 外层就叫 message-actions-hover-boundary，看祖先会误杀）。
        const selfTokens = String(node.className || '')
          .split(/\s+/)
          .filter((token) => token && !token.startsWith('[') && !token.startsWith('--'));
        if (selfTokens.some((token) => /^(composer|chat-input-editor|message-actions|message-actions-hover-boundary)$/i.test(token))) {
          return 'zone';
        }
        if (node.tagName === 'TEXTAREA') return 'zone';
        if (node.getAttribute && node.getAttribute('contenteditable') === 'true') return 'zone';
        try {
          const editable = node.closest('[contenteditable="true"], textarea, .ProseMirror, .tiptap, [class*="chat-input-editor"]');
          if (editable && !node.matches(bubble)) return 'zone';
        } catch {
          // 忽略
        }

        try {
          if (node.matches(bubble) || node.closest(bubble)) return 'user-bubble';
        } catch {
          // 忽略
        }

        const bubbles = node.querySelectorAll(bubble).length;
        const length = (node.innerText || '').trim().length;
        if (bubbles && length > 800) return 'container';
        return 'keep';
      }, { list: markers, bubble: USER_BUBBLE })
      .catch(() => 'keep');
    if (verdict !== 'keep') continue;

    const text = await extractElement(element, adapter).catch(() => '');
    if (!text) continue;

    const time = await element.evaluate((node) => {
      const scope = node.closest('li') || node;
      const tag = node.querySelector('time[datetime]') || scope.querySelector('time[datetime]');
      if (tag) return tag.getAttribute('datetime');
      const stamp = node.querySelector('[data-timestamp]') || scope.querySelector('[data-timestamp]');
      if (stamp) {
        const value = Number(stamp.getAttribute('data-timestamp'));
        if (value) return new Date(value > 1e12 ? value : value * 1000).toISOString();
      }
      return null;
    }).catch(() => null);

    collected.push({ index, text, time });
  }

  // 去嵌套重复：外层容器和它内部的正文字节点会给出同一段内容，保留最长的那份。
  const messages = [];
  const byKey = new Map();
  for (const item of collected) {
    const key = normalizeForDedupe(item.text);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      messages.push(item);
      continue;
    }
    if (item.text.length > existing.text.length) {
      // 更完整的那份替换掉先前较短的（保持原顺序位置）。
      const position = messages.indexOf(existing);
      if (position >= 0) messages[position] = { ...item, index: existing.index };
      byKey.set(key, item);
    }
  }
  messages.sort((a, b) => a.index - b.index);
  return { selector, messages };
}

// 纯文字 / 富文本兜底：页面没有消息节点时，直接按主区域输出 Markdown。
export async function readMainContent(page) {
  for (const selector of ['main', '[role="main"]', 'article']) {
    const element = page.locator(selector).first();
    if (!(await element.count().catch(() => 0))) continue;
    if (!(await element.isVisible().catch(() => false))) continue;
    const markdown = await element.evaluate(domToMarkdown).catch(() => '');
    const text = sanitizeAnswer(markdown);
    if (text.length > 80) return text;
  }
  return '';
}

// 整页兜底只适合“报告就在正文里”的页面。侧边栏/导航混进来的内容（Gemini 曾抓到
// 「发起新对话」「食物热量对比」这些链接）必须排除，否则会把菜单当回答。
const CHROME_PATTERN = /发起新对话|新建对话|New chat|Sign out|退出登录|与 .* 对话|回答未必正确|AI 工具，其回答/i;

export function looksLikePageChrome(text) {
  const value = String(text || '');
  if (!value) return true;
  const links = (value.match(/\]\(https?:\/\//g) || []).length;
  const lines = value.split('\n').filter((line) => line.trim()).length;
  if (CHROME_PATTERN.test(value)) return true;
  // 一行一个链接、几乎没有正文：这是导航菜单。
  if (links >= 5 && value.length / Math.max(1, lines) < 40) return true;
  return false;
}

function resolveEntryUrl(entry, currentUrl) {
  if (!entry) return null;
  try {
    const base = new URL(currentUrl);
    if (/^https?:/i.test(entry)) {
      const target = new URL(entry);
      return target.origin === base.origin ? target.toString() : null;
    }
    return new URL(entry, base.origin).toString();
  } catch {
    return null;
  }
}

async function clickHistoryLink(page, adapter, wanted) {
  const linkSelectors = adapter.historyLinkSelectors || [];
  if (!linkSelectors.length) return null;
  const links = page.locator(linkSelectors.join(', '));
  const count = await links.count().catch(() => 0);
  const limit = Math.min(count, 80);
  if (!limit) return null;

  if (wanted) {
    for (let index = 0; index < limit; index += 1) {
      const link = links.nth(index);
      const text = normalizeForCompare(await link.innerText().catch(() => ''));
      if (text && text.includes(wanted)) {
        await link.click({ timeout: 5000 }).catch(() => {});
        await sleep(1800);
        return page.url();
      }
    }
    return null;
  }

  await links.first().click({ timeout: 5000 }).catch(() => {});
  await sleep(1800);
  return page.url();
}

export async function findScheduledConversation(page, adapter, keyword) {
  const homeUrl = page.url();
  const wanted = keyword ? normalizeForCompare(keyword) : '';

  const entry = resolveEntryUrl(adapter.scheduledEntryUrl, homeUrl);
  if (entry) {
    await navigate(page, entry).catch(() => {});
    await sleep(1200);
  } else if (adapter.scheduledEntrySelectors?.length) {
    const button = await findVisible(page, adapter.scheduledEntrySelectors);
    if (button) {
      await button.click({ timeout: 3000 }).catch(() => {});
      await sleep(1500);
    }
  }

  let found = await clickHistoryLink(page, adapter, wanted);
  if (found) return found;

  // 定时任务入口可能不可用：回到首页再扫一遍侧边栏
  await navigate(page, homeUrl).catch(() => {});
  await sleep(1200);
  found = await clickHistoryLink(page, adapter, wanted);
  if (found) return found;

  if (wanted) {
    throw new AdapterError(
      'NO_CONVERSATION',
      `没找到标题包含「${keyword}」的对话。可以把关键词改短一点，或者打开那条定时对话后点「抓取当前链接」。`
    );
  }
  return null;
}

export function normalizeForCompare(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export async function pageDiagnostics(page, adapter) {
  const body = await readBodyText(page, 1500);
  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
    challenge: looksLikeChallenge(body),
    body: body.slice(0, 800)
  };
}

// 小图标/追踪像素不是“图表”，下载它们只会白白拖慢采集
// （ChatGPT 一条回答里 16 个 gstatic favicon，每个最多等 15 秒，单条就耗掉 200 秒）。
const ICON_URL_PATTERN =
  /favicon|s2\/favicons|google\.com\/s2|gstatic\.com\/favicon|doubleclick|\/pixel|beacon|analytics|1x1|spacer|blank\.(gif|png)/i;

// 按图片 URL 特征预估：明显是小图标的直接跳过，不发起请求。
function isLikelyIcon(src) {
  return ICON_URL_PATTERN.test(String(src || ''));
}

export async function inlineRemoteImages(text, page, { limit = 6, maxBytes = 300_000, budgetMs = 20_000 } = {}) {
  let value = String(text || '');
  if (!value || !page) return value;
  const sources = [...new Set(
    Array.from(value.matchAll(/!\[[^\]]*\]\(((?:https?:\/\/|blob:)[^)\s]+)\)/gi), (match) => match[1])
  )].filter((src) => !isLikelyIcon(src));
  if (!sources.length) return value;

  // 整个下载过程设总预算：超时就用原链接，不为了图片拖住整次采集。
  const deadline = Date.now() + budgetMs;
  let used = 0;
  for (const src of sources) {
    if (used >= limit || Date.now() >= deadline) break;
    let dataUrl = '';
    const remaining = Math.max(1500, deadline - Date.now());
    try {
      if (/^blob:/i.test(src)) {
        dataUrl = await page.evaluate(async (url) => {
          try {
            const response = await fetch(url);
            const blob = await response.blob();
            if (!/^image\//i.test(blob.type) || blob.size > 400_000) return '';
            return await new Promise((resolve) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result || ''));
              reader.onerror = () => resolve('');
              reader.readAsDataURL(blob);
            });
          } catch {
            return '';
          }
        }, src);
      } else {
        const response = await page.request
          .get(src, { timeout: Math.min(6000, remaining) })
          .catch(() => null);
        if (response && response.ok()) {
          const type = String(response.headers()['content-type'] || '').split(';')[0].trim().toLowerCase();
          const body = await response.body().catch(() => null);
          if (body && /^image\//i.test(type) && body.length <= maxBytes) {
            dataUrl = `data:${type};base64,${body.toString('base64')}`;
          }
        }
      }
    } catch {
      // 跨域、过期或需要授权的图片保持原链接
    }
    if (dataUrl && dataUrl.length <= maxBytes * 1.5) {
      value = value.split(src).join(dataUrl);
      used += 1;
    }
  }
  return value;
}

// —— Grok 自动化任务 ——
// 页面路径：grok.com/automations → 「运行」列表 → 点开最新一条运行 → 项目/对话里是文字汇总。
// 只对 grok.com/automations 生效；其它平台仍走普通对话读取。
export function isGrokAutomationSource(platform, source = {}) {
  return platform?.adapterId === 'grok' && /grok\.com\/automations/i.test(String(source.url || ''));
}

async function clickText(page, text, { exact = true, timeout = 4000 } = {}) {
  const locator = page.getByText(text, { exact }).first();
  if (!(await locator.isVisible().catch(() => false))) return false;
  await locator.click({ timeout }).catch(() => {});
  await sleep(1200);
  return true;
}

async function clickRowContaining(page, keyword) {
  // 已实测：Grok 的运行列表每行是一个 <button>（不是 tr），整行文字包含自动化名称和时间。
  for (const selector of ['button', 'tr', '[role="row"]', 'li']) {
    const rows = page.locator(selector);
    const count = Math.min(await rows.count().catch(() => 0), 120);
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      if (!(await row.isVisible().catch(() => false))) continue;
      const text = (await row.innerText().catch(() => '')).replace(/\s+/g, ' ');
      if (!text || !text.includes(keyword)) continue;
      if (text.length > 300) continue; // 跳过整页容器
      const link = row.locator('a').first();
      if (await link.count().catch(() => 0)) await link.click({ timeout: 5000 }).catch(() => {});
      else await row.click({ timeout: 5000 }).catch(() => {});
      await sleep(1500);
      return true;
    }
  }
  return false;
}

const RUN_TIME_HINT = /(AM|PM|小时|分钟|昨天|Oct|Nov|Dec|月\s*\d|\d{1,2}:\d{2})/i;

async function clickFirstRunRow(page) {
  for (const selector of ['table tbody tr', '[role="row"]']) {
    const rows = page.locator(selector);
    const count = Math.min(await rows.count().catch(() => 0), 5);
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      if (!(await row.isVisible().catch(() => false))) continue;
      await row.click({ timeout: 5000 }).catch(() => {});
      await sleep(1500);
      return true;
    }
  }
  const buttons = page.locator('button');
  const count = Math.min(await buttons.count().catch(() => 0), 120);
  for (let index = 0; index < count; index += 1) {
    const row = buttons.nth(index);
    if (!(await row.isVisible().catch(() => false))) continue;
    const text = (await row.innerText().catch(() => '')).replace(/\s+/g, ' ');
    if (text.length < 10 || text.length > 200) continue;
    if (!RUN_TIME_HINT.test(text)) continue;
    await row.click({ timeout: 5000 }).catch(() => {});
    await sleep(1500);
    return true;
  }
  return false;
}

async function readVisibleMainText(page) {
  // innerText 默认按 20 秒等元素出现：元素不存在时一次就白等 20 秒
  // （Grok 自动化一次读取要调它好几回，单条来源因此被 180 秒硬超时掐断）。
  const quick = { timeout: 1500 };
  const scroller = await page
    .locator('[data-testid="chat-transcript-scroller"]')
    .first()
    .innerText(quick)
    .catch(() => '');
  if (scroller && scroller.trim()) return scroller;
  // 只取前 2 万字：Grok 页面模板区很长，整页 innerText 会明显拖慢读取。
  const main = await page.locator('main').first().innerText(quick).catch(() => '');
  if (main && main.trim()) return main.slice(0, 20000);
  return page.evaluate(() => (document.body?.innerText || '').slice(0, 20000)).catch(() => '');
}

// 虚拟列表（Muse 等）只挂载可视窗口：初次读到的可能还是上半段旧消息，
// 真正的晚报在下面没挂载。滚到底再读一次，才能拿到最新那几条。
export async function scrollConversationToEnd(page) {
  await page
    .evaluate(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const scrollers = [...document.querySelectorAll('*')].filter(
        (el) => el.scrollHeight > el.clientHeight + 200 && el.clientHeight > 150
      );
      const scroller = scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
      for (let step = 0; step < 8; step += 1) {
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
        window.scrollTo(0, document.body.scrollHeight);
        await sleep(80);
      }
    })
    .catch(() => {});
}

// 「运行」tab 才是运行历史；「自动化任务」tab 有模板区，用这个区分。
async function openRunsTab(page) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const tab = page.getByRole('tab', { name: '运行', exact: true }).first();
    if (await tab.count().catch(() => 0)) await tab.click({ timeout: 4000 }).catch(() => {});
    else await clickText(page, '运行', { exact: true });
    await sleep(1200);
    const text = await readVisibleMainText(page);
    if (text && !text.includes('模板')) return true;
  }
  return false;
}

export async function readGrokAutomation(page, adapter, source = {}) {
  const keyword = String(source.keyword || '').trim();
  const listUrl = /grok\.com\/automations/i.test(String(source.url || ''))
    ? source.url
    : adapter.automationsUrl || 'https://grok.com/automations';

  await navigate(page, listUrl);
  // 这是 SPA：等页面把自动化列表渲染出来，而不是固定睡死。
  const readyDeadline = Date.now() + 20_000;
  while (Date.now() < readyDeadline) {
    const text = await readVisibleMainText(page).catch(() => '');
    if (text.includes('自动化') && text.length > 100) break;
    await sleep(1000);
  }
  await dismissConsent(page);

  if (looksLikeAuthUrl(page.url())) {
    throw new LoginRequiredError('Grok 自动化页跳到了登录地址，请先在「AI 平台」里登录 Grok。');
  }

  // 还没有任何运行记录：任务页也会显示「0 次运行」，不用切 tab、也不用扫按钮，直接返回。
  const taskPageText = await readVisibleMainText(page).catch(() => '');
  if (/0 次运行|暂无运行|还没有运行|No runs yet/i.test(taskPageText)) {
    return { text: '', url: page.url(), messages: [], empty: true, reason: 'no-runs' };
  }

  const runsReady = await openRunsTab(page);
  if (!runsReady) {
    throw new AdapterError(
      'AUTOMATION_EMPTY',
      'Grok 自动化页打开了，但没有找到「运行」列表。请确认账号里已经有自动化任务（https://grok.com/automations）；Grok 会拦截无头浏览器，请在设置里保持「显示浏览器窗口」开启。'
    );
  }

  // Grok 有时会弹出“自动化权限”确认框挡住列表；先关掉，关不掉就明确提示。
  await dismissGrokDialog(page);

  // 还没有任何运行记录不是错误：第一次运行前就该是空的，交给上层按等待窗口重试。
  const listText = await readVisibleMainText(page).catch(() => '');
  if (/0 次运行|暂无运行|还没有运行|No runs yet/i.test(listText)) {
    return { text: '', url: page.url(), messages: [], empty: true, reason: 'no-runs' };
  }

  // 点击可能新开标签页；先挂监听，避免弹窗已经打开才注册。
  const popupPromise = page.context().waitForEvent('page', { timeout: 5000 }).catch(() => null);
  let clicked = keyword ? await clickRowContaining(page, keyword) : false;
  if (!clicked && !keyword) clicked = await clickFirstRunRow(page);

  if (!clicked) {
    const body = await readVisibleMainText(page).catch(() => '');
    throw new AdapterError(
      'AUTOMATION_NOT_FOUND',
      `Grok 运行列表里没有找到包含「${keyword || '（未填关键词）'}」的运行。请把关键词写得接近自动化任务名称（例如「全球趋势雷达 19:00」）。当前页面摘录：${String(body).replace(/\s+/g, ' ').slice(0, 140)}`
    );
  }

  const popup = await popupPromise;
  let target = page;
  if (popup && !popup.isClosed()) {
    target = popup;
    await target.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
  }

  // 点开之后读回答；真实页面里回答是 [data-testid="assistant-message"]。
  const started = Date.now();
  const deadline = started + 25_000;
  let messages = [];
  while (Date.now() < deadline) {
    if (target.isClosed()) break;
    if (looksLikeAuthUrl(target.url())) {
      throw new LoginRequiredError('Grok 自动化页要求重新登录，请先在「AI 平台」里登录。');
    }
    const read = await readAnswerMessages(target, adapter);
    if (read.messages.length) {
      messages = read.messages;
      break;
    }
    if (Date.now() - started > 8000) {
      const body = await readVisibleMainText(target);
      const text = sanitizeAnswer(body);
      let onAutomationList = true;
      try {
        onAutomationList = /\/automations(\/|$)/i.test(new URL(target.url()).pathname);
      } catch {
        onAutomationList = false;
      }
      if (text.length > 200 && !onAutomationList) {
        return { text, url: target.url(), messages: [] };
      }
    }
    await sleep(1000);
  }

  if (!messages.length) {
    const body = await readVisibleMainText(target).catch(() => '');
    throw new AdapterError(
      'AUTOMATION_EMPTY',
      `已经打开 Grok 自动化运行，但没有读到汇总正文（${target.url().slice(0, 120)}）。请确认这次运行已经完成。页面摘录：${String(body).replace(/\s+/g, ' ').slice(0, 120)}`
    );
  }

  const text = messages.map((item) => item.text).join('\n\n');
  return {
    text,
    url: target.url(),
    messages,
    key: `${keyword || 'automation'}:${sanitizeAnswer(text).slice(0, 40)}`
  };
}
