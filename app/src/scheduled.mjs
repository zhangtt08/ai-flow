import crypto from 'node:crypto';
import {
  getAdapter,
  navigate,
  findScheduledConversation,
  readAnswerMessages,
  readMainContent,
  looksLikePageChrome,
  readGrokAutomation,
  isGrokAutomationSource,
  scrollConversationToEnd,
  findComposer,
  pageDiagnostics,
  looksLikeChallenge,
  looksLikeAuthUrl,
  inlineRemoteImages,
  AdapterError,
  LoginRequiredError
} from './adapters/index.mjs';
import { sleep } from './util.mjs';

export function sourceKey(platformId, url = '', keyword = '') {
  const identity = String(url || '').trim() || `kw:${String(keyword || '').trim()}`;
  return `${platformId}::${identity}`;
}

export function hashText(text) {
  // 图表像素/签名链接可能因渲染变化，不参与“是否新回答”的判定；文字和表格仍然参与。
  const stableText = String(text || '').replace(/!\[[^\]]*\]\((?:data:image\/|https?:\/\/|blob:)[^)]*\)/gi, '[embedded-image]');
  return crypto.createHash('sha1').update(stableText).digest('hex').slice(0, 16);
}

export function snapshotOf(messages) {
  const last = messages[messages.length - 1];
  return {
    count: messages.length,
    lastHash: last ? hashText(last.text) : '',
    lastTime: last?.time || null
  };
}

// 一次定时任务常常把报告拆成“我先开始执行…”+“报告如下”+“完整版如下”好几条。
// 真正有价值的是那份带标题/表格/长正文的报告；把明显是过程说明、寒暄、进度话的条目滤掉。
const CHATTER_PATTERN =
  /^(收到|好的|好，|没问题|已完成|任务已完成|任务已成功创建|已成功创建|任务创建|创建成功|已启用|确认信息如下|我正在|我来|我先|已为你|已找到|已保存|快照已保存|报告已生成|本期研究已完成|以下是|完整内容如下|完整版|需要我|要不要|是否)/;

// 定时任务通常分两类内容：白天多轮“监控/简报/快照”，最后一份才是“总结/晚报/日报”。
// 只采最终总结，否则 13:00、18:30 的监控数据会把正文撑爆、污染汇总。
const INTERIM_PATTERN =
  /(采集与异动监测|异动监测简报|午间简报|午间采集|晚间采集|早间监测|早间采集|采集完成|采集结果|监测简报|采集简报|采集快照|快照|阶段性|预演|待分析事件|数据采集与|中间结果)/i;
const FINAL_PATTERN =
  /(晚报|日报|早报|今日汇总|今日热点|最终汇总|完整版|final\s*report|总结报告|情报日报|趋势日报|周报)/i;

function answerScore(text) {
  const value = String(text || '');
  if (!value) return 0;
  const headings = (value.match(/^#{1,6} \S/gm) || []).length;
  const tables = (value.match(/^\|/gm) || []).length;
  const bullets = (value.match(/^[-*] \S/gm) || []).length;
  // 有标题/表格/大量列表，或者本身就很长，才算“正文”。
  return value.length + headings * 800 + tables * 120 + bullets * 20;
}

// 标题行（前几行里最像标题的那句），用来判断这条是“最终总结”还是“中途简报”。
function titleOf(text) {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 6);
  const heading = lines.find((line) => /^#{1,6}\s+\S/.test(line));
  if (heading) return heading.replace(/^#{1,6}\s+/, '');
  return lines[0] || '';
}

export function isInterimReport(text) {
  const value = String(text || '');
  const title = titleOf(value);
  // 只按“标题”判断，绝不能扫正文：
  // 晚报正文里常写「实际数据截止：18:36 的持久化快照」，扫正文会把真晚报误杀。
  if (FINAL_PATTERN.test(title)) return false;
  if (INTERIM_PATTERN.test(title)) return true;

  // 标题判断不出来时，只看最前面两行（不是整段正文）。
  const head = value.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 2).join(' ');
  return INTERIM_PATTERN.test(head);
}

function looksLikeChatter(text) {
  const value = String(text || '').trim();
  if (!value) return true;
  const firstLine = value.split('\n').find((line) => line.trim()) || '';
  if (CHATTER_PATTERN.test(firstLine.trim())) {
    // 除非这条本身就带标题/表格（说明它虽然开头寒暄，但正文在这里）。
    if (!/^#{1,6} \S/m.test(value) && !/^\|/m.test(value)) return true;
  }
  return false;
}

// 有些回答把“晚报已生成，完整内容如下”这类铺垫放在正文前面，标题却是报告自己的。
// 找到正文起点（第一个 # 标题），把前面的铺垫切掉；切完太短就不动。
export function trimPreamble(text) {
  const value = String(text || '');
  const match = value.match(/^#{1,6} \S/m);
  if (!match || match.index === 0) return value;
  const preamble = value.slice(0, match.index);
  const body = value.slice(match.index);
  if (body.length < 400) return value;
  if (preamble.length > 1200) return value; // 前半段本身就是内容，别乱切
  return body;
}

// 新建/删除定时任务后，AI 常回一条“任务已创建并启用/已删除 N 个任务”的确认。
// 这不是资讯正文，不能当成报告采进晚报。
const MANAGEMENT_PATTERN =
  /(均已成功创建|已成功创建并启用|任务已成功创建|已创建并启用|已实际创建并启用|实际创建并启用|已创建.{0,6}定时任务|已在平台.{0,10}创建|已核实.{0,12}定时任务|已核实.{0,12}任务|每日定时任务|今天不直接生成报告|首轮都是明天|已写入定时任务|定时任务的执行与核验规则|已删除\s*\d+\s*个|删好了|已检查现有任务|定时任务.{0,12}(创建|启用|删除|更新|修改)|确认信息如下|任务名称.{0,6}执行时间)/;

function looksLikeTaskManagement(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  // 真正的报告第一行就是 # 标题；只有“开头不是标题、却在前 300 字里讲任务创建”的才算管理确认。
  const startsWithHeading = /^#{1,6}\s+\S/.test(value);
  if (startsWithHeading && value.length > 800) return false;
  return MANAGEMENT_PATTERN.test(value.slice(0, 300));
}

// 从标题里取日期，用来判断“这是哪一天的报告”。
// 支持 2026年10月24日 / 2026-10-24 / 2026/10/24 / 10月24日。
function dateKeyOf(text) {
  const title = titleOf(text);
  const head = title || String(text || '').split('\n').find((line) => line.trim()) || '';
  let match = head.match(/(20\d{2})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})/);
  if (match) {
    return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
  }
  match = head.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (match) {
    const year = new Date().getFullYear();
    return `${year}-${String(match[1]).padStart(2, '0')}-${String(match[2]).padStart(2, '0')}`;
  }
  return '';
}

// 从“本次新增的若干条”里挑出真正的报告：
// 1) 丢掉寒暄/过程说明；2) 丢掉白天多轮的监控/简报；
// 3) 对话里累积了多天的晚报时，只取最新那一天，别把前几天的也拼进来。
export function selectReportAnswers(items = []) {
  if (!items.length) return [];
  const candidates = items.filter(
    (item) =>
      !looksLikeChatter(item.text) &&
      !looksLikeTaskManagement(item.text) &&
      String(item.text || '').trim().length >= 120
  );
  if (!candidates.length) return [];

  const finals = candidates.filter((item) => !isInterimReport(item.text));
  // 有明确的最终总结就只用它；全都是监控简报时（任务本身就只产出简报），退回全部。
  let pool = finals.length ? finals : candidates;

  // 多天累积：按标题日期分组，只保留最新一天（同一天的上下半篇都保留）。
  const dated = pool
    .map((item) => ({ item, key: dateKeyOf(item.text) }))
    .filter((entry) => entry.key);
  if (dated.length >= 2) {
    const newest = dated.map((entry) => entry.key).sort().at(-1);
    pool = dated.filter((entry) => entry.key === newest).map((entry) => entry.item);
  }

  const ranked = [...pool].sort((a, b) => answerScore(b.text) - answerScore(a.text));
  const best = ranked[0];
  const bestScore = answerScore(best.text);

  // 只保留“体量接近”的片段（报告被拆成上下两半的情况）；短很多的监控简报一律不要。
  const keep = pool.filter((item) => {
    if (item === best) return true;
    const score = answerScore(item.text);
    return score >= bestScore * 0.6 && String(item.text).trim().length >= 400;
  });
  keep.sort((a, b) => pool.indexOf(a) - pool.indexOf(b));
  return keep;
}

// 判断“这次有没有新报告”：以报告内容本身为准，而不是“对话里有没有新消息”。
// 定时对话里每天还会混进 08:00/13:00/18:30 的采集快照，它们不算新报告。
// acceptSame：手动运行时用户明确要再看一次，同一份报告也要返回，不能判成“没新内容”。
export function pickReport({ watermark, messages, windowSize = 15, acceptSame = false } = {}) {
  const window = messages.slice(-windowSize);
  const picked = selectReportAnswers(window);
  if (!picked.length) return { items: [], reportHash: '', reason: 'no-report' };
  const reportHash = hashText(picked.map((item) => item.text).join('\n\n'));
  if (watermark?.reportHash && watermark.reportHash === reportHash) {
    if (!acceptSame) return { items: [], reportHash, reason: 'same-report' };
    return { items: picked, reportHash, reason: 'report-unchanged' };
  }
  return { items: picked, reportHash, reason: watermark?.reportHash ? 'report-changed' : 'first-report' };
}

// 每个来源下一次检查的间隔。
// 关键：读不到任何东西（totalCount=0，通常是页面没加载出来）时必须尽快重开页面重试，
// 不能等满「轮询间隔」（默认 5 分钟）——1.10.1 之前就是这样卡住的。
// 已经读到内容、只是在等平台生成新报告的，才按用户设置的轮询间隔等。
export function retryDelayMs({ attempts = 1, totalCount = 0, pollMinutes = 5 } = {}) {
  const pollMs = Math.max(5000, Number(pollMinutes || 5) * 60_000);
  if (Number(totalCount) > 0) return pollMs;
  // 前 4 次快速重试（3/6/12/24 秒）；之后回到正常轮询，别把整个等待窗口烧光。
  if (Number(attempts || 1) < 4) return Math.min(30_000, 3000 * 2 ** Math.max(0, Number(attempts || 1) - 1));
  return pollMs;
}

export function pickNewAnswers(watermark, messages, firstRun = 'latest') {  const last = messages[messages.length - 1];

  if (!watermark) {
    if (firstRun === 'all') return { items: messages.slice(), reason: 'first-all' };
    return { items: last ? [last] : [], reason: 'first-latest' };
  }

  const known = Number(watermark.count) || 0;
  if (messages.length > known) {
    return { items: messages.slice(known), reason: 'count-grew' };
  }
  if (last && watermark.lastHash && hashText(last.text) !== watermark.lastHash) {
    return { items: [last], reason: 'last-changed' };
  }
  if (last?.time && watermark.lastTime && new Date(last.time).getTime() > new Date(watermark.lastTime).getTime()) {
    return { items: [last], reason: 'time-newer' };
  }
  return { items: [], reason: 'no-new' };
}

export function sameConversationEntry(url, source) {
  if (!source.url) return true;
  try {
    const wanted = new URL(source.url);
    const current = new URL(url);
    if (current.hostname !== wanted.hostname) return false;
    const wantedPath = wanted.pathname.replace(/\/$/, '');
    const currentPath = current.pathname.replace(/\/$/, '');
    if (!wantedPath || wantedPath === '/') return true;
    // 目标是一条具体对话，却被重定向回首页：这不是同一条对话。
    // （之前 currentPath 为空时 startsWith('') 恒为真，首页「最近对话」会被当成回答采走。）
    if (!currentPath) return false;
    return currentPath.startsWith(wantedPath.slice(0, 24)) || wantedPath.startsWith(currentPath.slice(0, 24));
  } catch {
    return true;
  }
}

async function hasConversationShell(page, adapter) {
  for (const selector of adapter.messageSelectors || []) {
    if (await page.locator(selector).count().catch(() => 0)) return true;
  }
  return Boolean(await findComposer(page, adapter, 0));
}

async function openPageWithRetry(page, url, attempts = 2) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await navigate(page, url);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await sleep(1500);
    }
  }
  throw lastError;
}

async function reopenTargetConversation(page, source, targetUrl) {
  if (!source.url) return true;
  if (looksLikeAuthUrl(page.url())) return false;
  if (!sameConversationEntry(page.url(), source)) {
    await openPageWithRetry(page, targetUrl).catch(() => {});
    await sleep(1500);
  }
  return sameConversationEntry(page.url(), source);
}

export async function readScheduledSource({ browser, platform, source, watermark, loadTimeoutMs = 20_000, onPage, acceptSame = false }) {
  const adapter = getAdapter(platform);
  const page = await browser.newPage();
  page.setDefaultTimeout(20_000);
  // 把页面交给调用方登记：超时/中止时才能把它关掉，避免残页占着浏览器。
  try {
    onPage?.(page);
  } catch {
    // 忽略登记失败
  }

  try {
    // Grok 的自动化任务不是一个固定对话：每次运行都生成新的项目/对话，走专用读取路径。
    if (isGrokAutomationSource(platform, source)) {
      const picked = await readGrokAutomation(page, adapter, source);
      // 自动化还没跑过：不是错误，按“还没有内容”交给等待窗口重试。
      if (picked.empty) {
        return {
          state: 'empty',
          reason: picked.reason || 'no-runs',
          text: '',
          newCount: 0,
          totalCount: 0,
          snapshot: null,
          lastTime: null,
          url: picked.url
        };
      }
      const text = String(await inlineRemoteImages(picked.text, page)).trim();
      if (!text) {
        throw new AdapterError('AUTOMATION_EMPTY', 'Grok 自动化已经打开，但这次运行还没有文字内容。');
      }
      const messages = [{ index: 1, text, time: null }];
      const decision = pickNewAnswers(watermark, messages, 'latest');
      const snapshot = snapshotOf(messages);
      if (!decision.items.length) {
        return {
          state: 'no-new',
          reason: decision.reason,
          text: '',
          newCount: 0,
          totalCount: 1,
          snapshot,
          lastTime: null,
          url: picked.url
        };
      }
      return {
        state: 'new',
        reason: decision.reason,
        text,
        answers: [{ index: 1, time: null, text }],
        newCount: 1,
        totalCount: 1,
        snapshot,
        lastTime: null,
        url: picked.url
      };
    }

    let targetUrl = source.url;
    if (!targetUrl) {
      await openPageWithRetry(page, platform.url || adapter.homeUrl);
      await sleep(1500);
      targetUrl = await findScheduledConversation(page, adapter, source.keyword);
      if (!targetUrl) {
        throw new AdapterError(
          'NO_CONVERSATION',
          '请先粘贴定时对话链接，或填写标题关键词。'
        );
      }
    } else {
      await openPageWithRetry(page, targetUrl);
    }
    await sleep(1500);
    await reopenTargetConversation(page, source, targetUrl);

    if (looksLikeAuthUrl(page.url())) {
      throw new LoginRequiredError('这条定时对话需要登录后才能查看，请先在「AI 平台」里打开登录。');
    }

    const started = Date.now();
    const deadline = started + loadTimeoutMs;
    let messages = [];
    let selectorSeen = null;
    let shellSeen = false;
    let wrongConversationRetries = 0;
    while (Date.now() < deadline) {
      if (page.isClosed()) {
        throw new AdapterError('PAGE_CLOSED', '页面已被关闭（上一次超时被取消），本次先跳过这条来源。');
      }
      if (looksLikeAuthUrl(page.url())) {
        throw new LoginRequiredError('页面跳到了登录地址，说明这个浏览器还没有登录。');
      }
      const read = await readAnswerMessages(page, adapter);
      selectorSeen = selectorSeen || read.selector;
      const onTarget = !source.url || sameConversationEntry(page.url(), source);
      if (read.messages.length && onTarget) {
        messages = read.messages;
        break;
      }
      // Gemini 这类 SPA：对话区是异步渲染的，头几秒只有侧边栏；实测首屏要 12–15 秒。
      // 以前 12 秒就判“没有回答”，正好卡在渲染完成前，是偶发 0 条的主因。
      if (Date.now() - started < 18_000) {
        await sleep(1000);
        continue;
      }
      if (!onTarget && wrongConversationRetries < 3) {
        // ChatGPT 偶尔会先落回上一条对话；只在目标对话里读，不能误采。
        wrongConversationRetries += 1;
        await reopenTargetConversation(page, source, targetUrl);
        await sleep(600);
        continue;
      }
      shellSeen = shellSeen || (await hasConversationShell(page, adapter));
      const body = await page.evaluate(() => (document.body?.innerText || '').slice(0, 3000)).catch(() => '');
      if (/请登录|请先登录|需要登录|sign in to continue|log in to continue/i.test(body)) {
        throw new LoginRequiredError('页面要求登录后才能查看这条对话。');
      }
      // 对话外壳已出现但回答列表还可能懒加载；给已有回答留足渲染时间，再交给等待窗口。
      if (shellSeen && Date.now() - started > 7000) break;
      await sleep(1000);
    }

    // 第一次打开偶发白屏（窗口最小化、SPA 脚本没跑起来）时，刷新一次再给 12 秒。
    // 只在“连输入框都没有”时做；已经渲染出对话壳的，交给引擎下一轮重开新页面，别在这白等。
    if (!messages.length && !shellSeen && !page.isClosed() && !looksLikeAuthUrl(page.url())) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      await sleep(1200);
      const retryUntil = Date.now() + 12_000;
      while (Date.now() < retryUntil && !page.isClosed()) {
        const read = await readAnswerMessages(page, adapter).catch(() => null);
        if (read?.messages?.length) {
          messages = read.messages;
          selectorSeen = selectorSeen || read.selector;
          break;
        }
        await sleep(1000);
      }
    }

    // 有些平台是边滚动边加载历史回答的（通义千问、Muse 的虚拟列表）：
    // 读到第一条就收手会漏掉真正的报告——Muse 初次只挂载 5 条旧消息，晚报在下面还没渲染。
    // 滚到底后连续两次读到完全相同的内容，才算真的读完。
    if (messages.length) {
      const stableUntil = Date.now() + 10_000;
      const signature = (list) => `${list.length}:${hashText(list.map((item) => item.text).join('\u0000'))}`;
      let previous = signature(messages);
      let steady = 0;
      while (Date.now() < stableUntil && steady < 2 && !page.isClosed()) {
        await sleep(700);
        await scrollConversationToEnd(page);
        const again = await readAnswerMessages(page, adapter).catch(() => null);
        if (!again?.messages?.length) break;
        if (again.messages.length >= messages.length) messages = again.messages;
        const next = signature(messages);
        steady = next === previous ? steady + 1 : 0;
        previous = next;
      }
    }

    // 找不到任何消息节点时，按整页正文兜底：有些平台把汇总渲染成一整块纯文字/富文本。
    // 但必须排除“只有侧边栏/导航”的情况，否则会把菜单当成回答（Gemini 踩过）。
    // 还必须在目标对话里：被重定向到首页时，首页的「最近对话」不是回答。
    const onTargetPage = !source.url || sameConversationEntry(page.url(), source);
    if (!messages.length && !selectorSeen && onTargetPage) {
      const fallback = await readMainContent(page).catch(() => '');
      if (fallback.length > 120 && !looksLikePageChrome(fallback)) {
        messages = [{ index: 1, text: fallback, time: null }];
      }
    }

    if (messages.length && source.url && !sameConversationEntry(page.url(), source)) {
      throw new AdapterError(
        'WRONG_CONVERSATION',
        `页面临时跳到了另一条对话（当前停在 ${page.url().slice(0, 120)}）。本次没有采集，避免把别的对话当成定时日报。`
      );
    }

    if (!messages.length) {
      const diagnostics = await pageDiagnostics(page, adapter);
      if (diagnostics.challenge) {
        throw new AdapterError('CHALLENGE', '网站要求人机验证。请在「打开登录」的可见窗口里完成验证后重试。');
      }
      if (source.url && !sameConversationEntry(diagnostics.url, source)) {
        throw new AdapterError(
          'WRONG_CONVERSATION',
          `链接没有打开那条对话（当前停在 ${diagnostics.url.slice(0, 120)}）。请重新用「抓取当前链接」获取。`
        );
      }
      // 对话能打开但还没有任何回答：交给上层按等待窗口重试
      return {
        state: 'empty',
        text: '',
        newCount: 0,
        totalCount: 0,
        snapshot: null,
        url: diagnostics.url,
        shellSeen
      };
    }

    // 以“报告”为单位判断新旧：定时对话里 08:00/13:00/18:30 的采集快照不是报告，
    // 不能因为它们是最后一条就当成新内容（ChatGPT 曾因此只采到 08:00 快照）。
    const decision = pickReport({ watermark, messages, acceptSame });
    const picked = decision.items;
    const snapshot = snapshotOf(messages);
    const answers = [];
    for (let index = 0; index < picked.length; index += 1) {
      const item = picked[index];
      answers.push({
        index: index + 1,
        time: item.time || null,
        // 切掉“晚报已生成，完整内容如下”这类铺垫，正文从第一个标题开始。
        text: await inlineRemoteImages(trimPreamble(item.text), page)
      });
    }
    const text = answers.map((item) => item.text).join('\n\n');

    if (!picked.length) {
      const reason = decision.reason === 'no-report' ? 'chatter' : 'no-new';
      return {
        state: reason,
        reason: decision.reason,
        text: '',
        newCount: 0,
        totalCount: messages.length,
        snapshot,
        reportHash: decision.reportHash || '',
        lastTime: snapshot.lastTime,
        url: page.url()
      };
    }

    return {
      state: 'new',
      reason: decision.reason,
      text,
      answers,
      newCount: picked.length,
      totalCount: messages.length,
      snapshot,
      reportHash: decision.reportHash,
      lastTime: snapshot.lastTime,
      url: page.url()
    };
  } catch (error) {
    if (page && !page.isClosed()) {
      try {
        const dir = process.env.AI_FLOW_FAILURE_DIR;
        if (dir) {
          const fs = await import('node:fs');
          const path = await import('node:path');
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, `${platform.id}.png`);
          await page.screenshot({ path: file, timeout: 12_000 });
          error.screenshot = file;
        }
      } catch {
        // 忽略截图失败
      }
    }
    throw error;
  } finally {
    await page.close().catch(() => {});
  }
}
