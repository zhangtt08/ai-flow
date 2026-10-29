import fs from 'node:fs';
import path from 'node:path';
import { BrowserManager } from './browser.mjs';
import {
  getAdapter,
  startConversation,
  sendPrompt,
  snapshotAnswers,
  pageDiagnostics,
  probeLogin,
  inspectLogin,
  AdapterError,
  normalizeForCompare,
  sanitizeAnswer
} from './adapters/index.mjs';
import { readScheduledSource, sourceKey, retryDelayMs } from './scheduled.mjs';
import { clamp, ensureDir, mapLimit, nowIso, pad2, renderPrompt, safeFilePart, sleep, uid, writeJsonAtomic, writeTextAtomic } from './util.mjs';
import { buildBundle, buildDailyDigest, buildSummaryDocument, computeRunStatus, isGoodResult, mergeDigestRuns } from './bundle.mjs';
import { writeAnswerDataset } from './export.mjs';
import { DEFAULT_SUMMARY_PROMPT, SUMMARY_PROFILES, DEFAULT_SUMMARY_PROFILE, nextOccurrence } from './store.mjs';
import { copyToClipboard, showNotification } from './notify.mjs';

function humanError(error) {
  const message = String(error?.message || error || '未知错误');
  if (/net::ERR_|Timeout .* exceeded|page\.goto/i.test(message)) {
    return `页面加载失败或超时：${message.slice(0, 240)}`;
  }
  return message.slice(0, 500);
}

function errorStatus(error) {
  if (error.code === 'NEEDS_LOGIN') return 'login';
  if (error.code === 'TIMEOUT') return 'timeout';
  return 'error';
}

function humanDuration(minutes) {
  const value = Number(minutes) || 0;
  if (value < 1) return `${Math.max(1, Math.round(value * 60))} 秒`;
  if (value < 60) return `${Math.round(value * 10) / 10} 分钟`;
  return `${Math.round(value / 6) / 10} 小时`;
}

// 这次运行允许“等回答”的窗口（分钟），看门狗按它放宽上限。
function waitMinutesFor(run) {
  return Math.max(0, Number(run?.waitMinutes) || 0);
}

const LIMIT_PATTERN = /too many requests|rate limit|message limit|usage limit|you['’]ve reached|操作过于频繁|次数已达|额度已|超出限制|今日次数/i;
const LOGIN_PATTERN = /sign in to continue|log in to continue|登录后继续|请先登录/i;

async function wallError(page, { allowLogin = true } = {}) {
  const body = await page.evaluate(() => (document.body?.innerText || '').slice(0, 4000)).catch(() => '');
  if (LIMIT_PATTERN.test(body)) {
    const matched = body.match(/[^\n]*(?:limit|额度|过于频繁|次数)[^\n]*/i)?.[0] || '';
    return new AdapterError('LIMIT', `账号可能达到额度或频率限制。${matched.slice(0, 140)}`);
  }
  if (allowLogin && LOGIN_PATTERN.test(body)) {
    return new AdapterError('NEEDS_LOGIN', '页面要求登录后才能继续。');
  }
  return null;
}

function conversationUrlFor(platform, pageUrl) {
  try {
    const current = new URL(pageUrl);
    const home = new URL(platform?.url || '');
    if (current.origin !== home.origin) return null;
    if (current.pathname === home.pathname && current.search === home.search) return null;
    if (/^\/(new|app)?\/?$/i.test(current.pathname)) return null;
    if (/\/(login|signin|auth|captcha|challenge)(\/|$)/i.test(current.pathname)) return null;
    return current.toString();
  } catch {
    return null;
  }
}

export class Engine {
  constructor({ store, bus, dataDir }) {
    this.store = store;
    this.bus = bus;
    this.dataDir = dataDir;
    this.browser = new BrowserManager({ dataDir, getSettings: () => this.store.state.settings });
    this.current = null;
    this.checking = new Set();
    this.loginWatchers = new Map();
    this.activePages = new Map();
    this.stopRequested = false;
  }

  isBusy() {
    return Boolean(this.current) || this.checking.size > 0;
  }

  currentPublic() {
    if (!this.current) return null;
    const run = this.current;
    return {
      id: run.id,
      taskId: run.taskId,
      taskName: run.taskName,
      mode: run.mode,
      trigger: run.trigger,
      status: run.status,
      phase: run.phase,
      startedAt: run.startedAt,
      progress: run.progress,
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
      results: run.results.map((result) => ({
        platformId: result.platformId,
        name: result.name,
        icon: result.icon,
        status: result.status,
        chars: result.chars || 0,
        durationMs: result.durationMs || 0,
        error: result.error || null,
        newCount: result.newCount || 0,
        totalCount: result.totalCount || 0,
        attempts: result.attempts || 0,
        waitedMs: result.waitedMs || 0,
        nextRetryInSec: result.nextRetryInSec || 0,
        lastAnswerTime: result.lastAnswerTime || null,
        sourceKeyword: result.sourceKeyword || '',
        sourceUrl: result.sourceUrl || ''
      }))
    };
  }

  persistRun(run) {
    ensureDir(this.store.runsDir);
    writeJsonAtomic(this.store.runJsonPath(run.id), run);
  }

  async checkPlatform(platformId) {
    if (this.current) throw new Error('正在执行采集，请等它结束后再检查登录状态。');
    if (this.checking.has(platformId)) return;

    const platform = this.store.findPlatform(platformId);
    if (!platform) throw new Error('平台不存在。');

    this.checking.add(platformId);
    platform.login = 'checking';
    platform.loginError = null;
    this.store.save();
    this.bus.emitState();

    let page = null;
    try {
      await this.browser.launch();
      page = await this.browser.newPage();
      page.setDefaultTimeout(20_000);
      const adapter = getAdapter(platform);
      const state = await probeLogin(page, adapter, platform, 60_000);
      platform.login = state.state;
      platform.loginError = state.message || null;
    } catch (error) {
      platform.login = 'error';
      platform.loginError = humanError(error);
    } finally {
      platform.lastCheckAt = nowIso();
      this.store.save();
      this.bus.emitState();
      await page?.close().catch(() => {});
      this.checking.delete(platformId);
    }
  }

  async openPlatform(platformId) {
    if (this.current) throw new Error('正在执行采集，请等它结束。');
    const platform = this.store.findPlatform(platformId);
    if (!platform) throw new Error('平台不存在。');
    const adapter = getAdapter(platform);
    await this.browser.launch({ forceVisible: true });
    await this.browser.restore();
    const page = await this.browser.newPage();
    page.setDefaultTimeout(30_000);
    await page.goto(platform.url || adapter.homeUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.bringToFront().catch(() => {});
    this.watchLogin(platform, page);
    return { url: page.url() };
  }

  watchLogin(platform, page) {
    const existing = this.loginWatchers.get(platform.id);
    if (existing) clearTimeout(existing);

    const started = Date.now();
    const tick = async () => {
      this.loginWatchers.delete(platform.id);
      if (this.current || page.isClosed() || !this.browser.context) return;
      const current = this.store.findPlatform(platform.id);
      if (!current || current.hidden) return;

      let state = { state: 'unknown', message: null };
      try {
        state = await inspectLogin(page, getAdapter(current));
      } catch {
        // 页面跳转/刷新期间忽略，下一轮再查
      }
      const message = state.message || null;
      if (state.state && state.state !== 'unknown') {
        const changed = current.login !== state.state || current.loginError !== message;
        current.login = state.state;
        current.loginError = message;
        current.lastCheckAt = nowIso();
        if (changed) {
          this.store.save();
          this.bus.emitState();
        }
        // 登录成功后不需要继续盯着；失败/验证/访客状态继续观察，用户在窗口里操作后会自动更新。
        if (state.state === 'logged_in') return;
      }
      if (Date.now() - started < 15 * 60_000) {
        const timer = setTimeout(tick, 2500);
        this.loginWatchers.set(platform.id, timer);
      }
    };

    const timer = setTimeout(tick, 1500);
    this.loginWatchers.set(platform.id, timer);
  }

  stopLoginWatchers() {
    for (const timer of this.loginWatchers.values()) clearTimeout(timer);
    this.loginWatchers.clear();
  }

  async currentUrl(platformId) {
    const context = this.browser.context;
    if (!context) throw new Error('自动化浏览器还没有打开。先在「AI 平台」点「打开登录」。');
    const platform = this.store.findPlatform(platformId);
    const pages = context.pages().filter((page) => !page.isClosed());
    if (!pages.length) throw new Error('自动化浏览器里没有打开的页面。');
    let wantedHost = '';
    try {
      wantedHost = new URL(platform?.url || '').hostname;
    } catch {
      wantedHost = '';
    }
    const hostMatch = wantedHost
      ? pages.filter((page) => {
        try {
          const host = new URL(page.url()).hostname;
          return host === wantedHost || host.endsWith(`.${wantedHost}`) || wantedHost.endsWith(`.${host}`);
        } catch {
          return false;
        }
      })
      : [];
    const pool = hostMatch.length ? hostMatch : pages.filter((page) => !/^(about|chrome|edge|data):/i.test(page.url()));
    const pick = (pool.length ? pool : pages).at(-1);
    const url = pick.url();
    if (/^(about|chrome|edge|data):/i.test(url)) throw new Error('当前页面还是空白页，请先在自动化浏览器里打开那条定时对话。');
    return { url, title: await pick.title().catch(() => '') };
  }

  async closeBrowser() {
    this.stopLoginWatchers();
    await this.browser.close();
    this.bus.emitState();
  }

  async shutdown() {
    this.stopLoginWatchers();
    await this.browser.close();
  }

  stopWaiting() {
    if (!this.current) return false;
    this.stopRequested = true;
    this.current.phase = '正在结束等待…';
    // 关掉当前打开的页面，让卡在读取里的调用立刻失败，而不是等满单项超时。
    for (const page of this.activePages.values()) page.close().catch(() => {});
    this.activePages.clear();
    this.bus.emitState();
    return true;
  }

  async sleepPolling(ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (this.stopRequested) return;
      await sleep(Math.min(1000, deadline - Date.now()));
    }
  }

  async withHardTimeout(promise, ms, label, onTimeout) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        // 超时后把还在跑的页面关掉，避免它继续挂在后台、和后面的采集抢同一个浏览器。
        try {
          onTimeout?.();
        } catch {
          // 忽略取消失败
        }
        reject(new AdapterError('TIMEOUT', `${label} 采集超过最长等待时间，已跳过。`));
      }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  async captureFailure(page, runId, platform) {
    try {
      const dir = path.join(this.store.runsDir, runId);
      ensureDir(dir);
      const screenshot = path.join(dir, `${platform.id}.png`);
      await page.screenshot({ path: screenshot, fullPage: false, timeout: 15_000 });
      const html = await page.content().catch(() => '');
      if (html && html.length < 3_000_000) {
        fs.writeFileSync(path.join(dir, `${platform.id}.html`), html, 'utf8');
      }
      return screenshot;
    } catch {
      return null;
    }
  }

  async rememberConversation(task, platform, page, { summary = false } = {}) {
    if (!task) return;
    const url = conversationUrlFor(platform, page.url());
    if (!url) return;
    const title = String(await page.title().catch(() => '')).slice(0, 160);
    if (summary) {
      const stamp = { url, platformId: platform.id, title, updatedAt: nowIso() };
      // 所有任务的 AI 总结共用一个「汇总数据」对话；任务里单独绑定的仍然保留。
      if (task.summaryConversation?.url !== url) task.summaryConversation = stamp;
      if (this.store.state.settings.summaryConversation?.url !== url) {
        this.store.state.settings.summaryConversation = stamp;
      }
    } else {
      if (!task.conversations || typeof task.conversations !== 'object') task.conversations = {};
      const previous = task.conversations[platform.id];
      if (previous?.url === url) return;
      task.conversations[platform.id] = { url, title, updatedAt: nowIso() };
    }
    this.store.save();
    this.bus.emitState();
  }

  async collectOne({ task, platform, prompt, runId, conversationUrl = '' }) {
    const adapter = getAdapter(platform);
    const settings = this.store.state.settings;
    const page = await this.browser.newPage();
    page.setDefaultTimeout(20_000);
    this.activePages.set(platform.id, page);
    const startedAt = Date.now();
    let baseline = { selector: null, count: 0, text: '', stop: false };

    try {
      await startConversation(page, adapter, platform, { conversationUrl });
      await sleep(700);
      baseline = await snapshotAnswers(page, adapter);

      await sendPrompt(page, adapter, prompt);
      await this.rememberConversation(task, platform, page);

      const startDeadline = Date.now() + 45_000;
      let started = false;
      while (Date.now() < startDeadline) {
        const snap = await snapshotAnswers(page, adapter, baseline.selector);
        const sameAsPrompt = snap.text && normalizeForCompare(snap.text) === normalizeForCompare(prompt);
        const textChanged =
          snap.text && !sameAsPrompt && normalizeForCompare(snap.text) !== normalizeForCompare(baseline.text);
        if (snap.stop || textChanged || (snap.count > baseline.count && snap.text && !sameAsPrompt)) {
          started = true;
          break;
        }

        const wall = await wallError(page, { allowLogin: snap.count === 0 });
        if (wall) throw wall;
        await sleep(700);
      }

      if (!started) {
        const diagnostics = await pageDiagnostics(page, adapter);
        if (diagnostics.challenge) {
          throw new AdapterError('CHALLENGE', '网站要求人机验证。请到「AI 平台」点「打开浏览器」手动完成验证后再试。');
        }
        throw new AdapterError('NO_RESPONSE', '发送后没有检测到新的回答。可能是提示词没有真正发出、被限流，或网站结构已变化。已保存页面诊断，可在运行记录里查看。');
      }

      const maxWaitMs = Math.max(60, Number(settings.maxWaitSec) || 300) * 1000;
      const stableMs = Math.max(1200, Number(settings.stableMs) || 2800);
      const genStarted = Date.now();
      let stableText = '';
      let stableSince = 0;

      while (Date.now() - genStarted < maxWaitMs) {
        const snap = await snapshotAnswers(page, adapter, baseline.selector);
        const sameAsPrompt = snap.text && normalizeForCompare(snap.text) === normalizeForCompare(prompt);

        if (snap.stop) {
          stableSince = 0;
          stableText = snap.text || '';
        } else if (snap.text && !sameAsPrompt) {
          if (snap.text !== stableText) {
            stableText = snap.text;
            stableSince = 0;
          } else {
            if (!stableSince) stableSince = Date.now();
            if (Date.now() - stableSince >= stableMs && Date.now() - genStarted > 1200) {
              const text = sanitizeAnswer(snap.text);
              if (text) {
                return { text, url: page.url(), partial: false, durationMs: Date.now() - startedAt };
              }
            }
          }
        } else {
          stableSince = 0;
          // 一直没有可用正文：可能不是慢，而是被限流或要求登录，别把它报成普通超时。
          if (Date.now() - genStarted > 20_000) {
            const wall = await wallError(page, { allowLogin: !snap.count });
            if (wall) throw wall;
          }
        }
        await sleep(700);
      }

      const last = await snapshotAnswers(page, adapter, baseline.selector).catch(() => null);
      const text = sanitizeAnswer(last?.text || stableText || '');
      if (text && normalizeForCompare(text) !== normalizeForCompare(prompt)) {
        return {
          text,
          url: page.url(),
          partial: true,
          warning: `等待回答结束超时（${Math.round(maxWaitMs / 1000)} 秒），已保留目前生成的内容。`,
          durationMs: Date.now() - startedAt
        };
      }
      throw new AdapterError('TIMEOUT', `等待回答超时（${Math.round(maxWaitMs / 1000)} 秒），没有获取到内容。已保存页面截图和 HTML；如果网站改版，请在平台页的自定义选择器里修正。`);
    } catch (error) {
      error.screenshot = await this.captureFailure(page, runId, platform);
      throw error;
    } finally {
      await this.rememberConversation(task, platform, page).catch(() => {});
      if (this.activePages.get(platform.id) === page) this.activePages.delete(platform.id);
      await page.close().catch(() => {});
    }
  }

  async summarizeWithPlatform({ run, task, platform, rawText, promptText }) {
    const settings = this.store.state.settings;
    const adapter = getAdapter(platform);
    const maxWaitSec = Math.max(60, Number(settings.summaryWaitSec) || 300);
    const maxWaitMs = maxWaitSec * 1000;
    const stableMs = Math.max(1200, Number(settings.stableMs) || 2800);
    const startedAt = Date.now();
    // 总结对话全局共用一条（专门的「汇总数据」项目）；任务里单独绑定的优先。
    const bound =
      [task?.summaryConversation, settings.summaryConversation].find(
        (item) => item && item.platformId === platform.id && item.url
      ) || null;
    const conversationUrl = bound?.url || '';
    let page = null;
    try {
      page = await this.browser.newPage();
      page.setDefaultTimeout(20_000);
      await startConversation(page, adapter, platform, { conversationUrl });
      await sleep(700);
      const baseline = await snapshotAnswers(page, adapter);
      const prompt = `${String(promptText || '').trim()}\n\n<RAW>\n${rawText}\n</RAW>\n\n请只输出整理后的最终汇总，不要重复原始回答。`;
      await sendPrompt(page, adapter, prompt);
      await this.rememberConversation(task, platform, page, { summary: true });

      const startDeadline = Date.now() + 45_000;
      let started = false;
      let snap = baseline;
      while (Date.now() < startDeadline) {
        snap = await snapshotAnswers(page, adapter, baseline.selector);
        const sameAsPrompt = snap.text && normalizeForCompare(snap.text) === normalizeForCompare(prompt);
        const textChanged =
          snap.text && !sameAsPrompt && normalizeForCompare(snap.text) !== normalizeForCompare(baseline.text);
        if (snap.stop || textChanged || (snap.count > baseline.count && snap.text && !sameAsPrompt)) {
          started = true;
          break;
        }
        const wall = await wallError(page, { allowLogin: snap.count === 0 });
        if (wall) throw wall;
        await sleep(700);
      }

      if (!started) {
        const diagnostics = await pageDiagnostics(page, adapter);
        if (diagnostics.challenge) {
          throw new AdapterError('CHALLENGE', 'AI 总结平台要求人机验证。请到「AI 平台」打开它完成验证后再运行。原始回答已保留。');
        }
        throw new AdapterError('NO_RESPONSE', 'AI 总结平台没有生成新的总结。可能是登录失效、额度限制或网站结构变化。原始回答已保留。');
      }

      const genStarted = Date.now();
      let stableText = '';
      let stableSince = 0;
      while (Date.now() - genStarted < maxWaitMs) {
        const current = await snapshotAnswers(page, adapter, baseline.selector);
        const sameAsPrompt = current.text && normalizeForCompare(current.text) === normalizeForCompare(prompt);
        if (current.stop) {
          stableSince = 0;
          stableText = current.text || '';
        } else if (current.text && !sameAsPrompt) {
          if (current.text !== stableText) {
            stableText = current.text;
            stableSince = 0;
          } else {
            if (!stableSince) stableSince = Date.now();
            if (Date.now() - stableSince >= stableMs && Date.now() - genStarted > 1200) {
              const text = sanitizeAnswer(current.text);
              if (text) {
                return {
                  text,
                  url: page.url(),
                  durationMs: Date.now() - startedAt,
                  inputChars: rawText.length,
                  promptChars: prompt.length,
                  partial: false
                };
              }
            }
          }
        } else {
          stableSince = 0;
          if (Date.now() - genStarted > 20_000) {
            const wall = await wallError(page, { allowLogin: !current.count });
            if (wall) throw wall;
          }
        }
        await sleep(700);
      }

      const last = await snapshotAnswers(page, adapter, baseline.selector).catch(() => null);
      const text = sanitizeAnswer(last?.text || stableText || '');
      if (text && normalizeForCompare(text) !== normalizeForCompare(prompt)) {
        return {
          text,
          url: page.url(),
          durationMs: Date.now() - startedAt,
          inputChars: rawText.length,
          promptChars: prompt.length,
          partial: true,
          warning: `AI 总结超时（${maxWaitSec} 秒），已保留目前生成的内容。原始回答已保留。`
        };
      }
      throw new AdapterError('TIMEOUT', `AI 总结超时（${maxWaitSec} 秒），没有获取到内容。原始回答已保留。`);
    } catch (error) {
      if (page) error.screenshot = await this.captureFailure(page, run.id, { id: 'summary', name: platform.name });
      throw error;
    } finally {
      if (page) await this.rememberConversation(task, platform, page, { summary: true }).catch(() => {});
      await page?.close().catch(() => {});
    }
  }

  buildRunFiles(run, task, { rawText, summaryText }) {
    const date = new Date(run.startedAt);
    const stamp = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}_${pad2(
      date.getHours()
    )}${pad2(date.getMinutes())}`;
    const base = `${stamp}_${safeFilePart(task.name)}_${run.id.slice(-4)}`;
    const rawName = summaryText ? `${base}_原始.md` : `${base}.md`;
    const finalName = `${base}.md`;
    const rawFile = path.join(this.store.runsDir, rawName);
    writeTextAtomic(rawFile, rawText);

    let summaryFile = null;
    let finalFile = rawFile;
    let finalText = rawText;
    if (summaryText) {
      finalText = buildSummaryDocument(task, run, rawName);
      summaryFile = path.join(this.store.runsDir, finalName);
      writeTextAtomic(summaryFile, finalText);
      finalFile = summaryFile;
    }

    run.bundlePath = rawFile;
    run.rawBundlePath = rawFile;
    run.summaryPath = summaryFile;
    run.finalPath = finalFile;
    run.outputPath = null;
    run.rawOutputPath = null;

    const outputDir = this.store.outputDir();
    if (outputDir && path.resolve(outputDir) !== path.resolve(this.store.runsDir)) {
      try {
        const finalCopy = path.join(outputDir, path.basename(finalFile));
        writeTextAtomic(finalCopy, finalText);
        run.outputPath = finalCopy;
        if (summaryText) {
          const rawCopy = path.join(outputDir, rawName);
          writeTextAtomic(rawCopy, rawText);
          run.rawOutputPath = rawCopy;
        }
        writeTextAtomic(path.join(outputDir, '最新汇总.md'), finalText);
      } catch {
        run.outputPath = null;
        run.rawOutputPath = null;
      }
    }

    return { rawFile, summaryFile, finalFile, finalText, base, outputDir };
  }

  writeDataset(run, task, files) {
    const primary = files.outputDir || this.store.runsDir;
    const dirName = `${files.base}_数据`;
    const targets = [primary, this.store.runsDir].filter(
      (dir, index, list) => dir && list.findIndex((item) => path.resolve(item) === path.resolve(dir)) === index
    );
    for (const baseDir of targets) {
      try {
        const dir = path.join(baseDir, dirName);
        const dataset = writeAnswerDataset({ dir, task, run });
        run.datasetDir = dir;
        run.datasetFiles = dataset.files;
        run.datasetRecords = dataset.records.length;
        run.datasetCharts = dataset.records.reduce((total, record) => total + record.chart_count, 0);
        run.datasetError = null;
        if (path.resolve(baseDir) === path.resolve(primary)) {
          const latest = path.join(baseDir, '最新数据');
          try {
            // 只清理 AI Flow 自己生成的目录，避免误删同名文件夹
            if (fs.existsSync(path.join(latest, '说明.md'))) fs.rmSync(latest, { recursive: true, force: true });
            fs.cpSync(dir, latest, { recursive: true });
            run.latestDatasetDir = latest;
          } catch {
            // 最新副本失败不影响本次数据
          }
        }
        return;
      } catch (error) {
        run.datasetError = humanError(error);
      }
    }
  }

  // 桌面总文档：把今天所有任务的来源合并成一份 .md，直接放桌面，供手动交给 AI。
  writeDailyDigest(run) {
    const settings = this.store.state.settings;
    if (settings.desktopDigest === false) return null;
    const day = new Date(run.finishedAt || run.startedAt || Date.now());
    const sameDay = (iso) => {
      const d = new Date(iso);
      return d.getFullYear() === day.getFullYear() && d.getMonth() === day.getMonth() && d.getDate() === day.getDate();
    };
    // 今天所有运行都参与合并：同一平台的较新失败不会冲掉今天早些时候的成功内容。
    const metas = (this.store.state.runs || []).filter(
      (meta) => meta?.taskId && meta.status !== 'running' && sameDay(meta.finishedAt || meta.startedAt)
    );
    if (!metas.some((meta) => meta.id === run.id)) metas.push({ id: run.id, taskId: run.taskId, startedAt: run.startedAt });
    const fullRuns = [];
    for (const meta of metas) {
      const full = meta.id === run.id ? run : this.store.loadRun(meta.id);
      if (full?.results?.length) fullRuns.push(full);
    }
    const runs = mergeDigestRuns(fullRuns).filter((entry) => (entry.results || []).some(isGoodResult));
    if (!runs.length) return null; // 全是失败/空结果时不往桌面写噪音
    runs.sort((a, b) => new Date(a.finishedAt || a.startedAt) - new Date(b.finishedAt || b.startedAt));

    const profile = SUMMARY_PROFILES[run.summaryProfile] || SUMMARY_PROFILES[DEFAULT_SUMMARY_PROFILE];
    const title = String(settings.digestTitle || profile.digestTitle || '今日汇总').trim().slice(0, 60) || '今日汇总';
    const text = buildDailyDigest({ runs, now: day, title, instruction: profile.digestInstruction });
    const file = this.store.dailyDigestPath();
    writeTextAtomic(file, text);
    run.digestPath = file;
    try {
      const archive = this.store.dailyDigestArchivePath(day);
      if (path.resolve(archive) !== path.resolve(file)) writeTextAtomic(archive, text);
    } catch {
      // 输出目录失败不影响桌面文档
    }
    return file;
  }

  async collectPrompts(plan, run, prompt, task) {
    const maxWaitSec = Math.max(60, Number(this.store.state.settings.maxWaitSec) || 300);
    for (let index = 0; index < plan.length; index += 1) {
      const { platform } = plan[index];
      const result = run.results[index];

      if (!platform.enabled) {
        run.progress.done += 1;
        continue;
      }

      result.status = 'running';
      result.startedAt = nowIso();
      run.phase = `正在采集 ${platform.name}`;
      run.progress.current = platform.id;
      this.persistRun(run);
      this.store.upsertRunMeta(run);
      this.bus.emitState();

      const started = Date.now();
      try {
        const conversationUrl = task.conversations?.[platform.id]?.url || '';
        const collected = await this.withHardTimeout(
          this.collectOne({ task, platform, prompt, runId: run.id, conversationUrl }),
          (maxWaitSec + 150) * 1000,
          platform.name,
          () => this.activePages.get(platform.id)?.close().catch(() => {})
        );
        result.status = collected.partial ? 'partial' : 'ok';
        result.text = collected.text;
        result.answers = [{ index: 1, time: null, text: collected.text }];
        result.url = collected.url;
        result.chars = collected.text.length;
        result.totalCount = 1;
        result.newCount = 1;
        result.error = collected.warning || null;
        result.durationMs = collected.durationMs;
      } catch (error) {
        result.status = errorStatus(error);
        result.error = humanError(error);
        result.screenshot = error.screenshot || null;
        result.durationMs = Date.now() - started;
      } finally {
        result.finishedAt = nowIso();
        run.progress.done = Math.min(plan.length, run.progress.done + 1);
        run.progress.current = null;
        this.persistRun(run);
        this.store.upsertRunMeta(run);
        this.bus.emitState();
      }
    }
  }

  finalizePending(pending, run, reason) {
    for (const index of [...pending]) {
      const result = run.results[index];
      result.status = (result.totalCount || 0) > 0 ? 'no-new' : 'no-answer';
      result.error =
        reason === 'stopped'
          ? (result.totalCount || 0) > 0
            ? '已手动结束等待：这条对话没有新的回答。'
            : '已手动结束等待：这条对话里还没有出现回答。'
          : (result.totalCount || 0) > 0
            ? '等到设定时间结束仍没有新回答（可能今天已经采集过，或平台定时任务还没生成新内容）。'
            : '等到设定时间结束，这条对话里仍未出现回答。请确认该平台定时任务是否已执行。';
      result.finishedAt = nowIso();
      pending.delete(index);
      run.progress.done += 1;
    }
    this.persistRun(run);
    this.store.upsertRunMeta(run);
    this.bus.emitState();
  }

  async collectScheduled(plan, run) {
    const settings = this.store.state.settings;
    const waitMinutes = clamp(Number(run.waitMinutes ?? settings.waitMinutes ?? 60), 0, 720);
    const pollMinutes = clamp(Number(run.pollMinutes ?? settings.pollMinutes ?? 5), 0.05, 120);
    // 同一条对话最多检查几次：到上限就停，避免“等不到 → 跳过 → 重采”的死循环。
    const maxAttempts = Math.max(1, Number(settings.maxAttempts) || 6);
    // 同时读几个来源：默认 2，兼顾速度和网站风控。
    const concurrency = clamp(Number(settings.concurrency) || 2, 1, 4);
    const startedAt = Date.now();
    const deadline = startedAt + waitMinutes * 60_000;
    const pending = new Set(plan.map((entry, index) => (entry.platform.enabled ? index : null)).filter((index) => index !== null));
    this.stopRequested = false;
    let round = 0;
    // 每个来源各自的下一次尝试时间。失败的来源按自己的节奏马上重开页面重试，
    // 不会被别的慢来源拖住，也不用等满 pollMinutes（之前就是卡在这里）。
    const nextAttemptAt = new Map([...pending].map((index) => [index, 0]));

    if (!pending.size) {
      run.progress.done = plan.length;
      return;
    }

    while (pending.size) {
      if (this.stopRequested) {
        this.finalizePending(pending, run, 'stopped');
        break;
      }
      if (Date.now() >= deadline) {
        this.finalizePending(pending, run, 'deadline');
        break;
      }

      const now = Date.now();
      const due = [...pending]
        .filter((index) => (nextAttemptAt.get(index) || 0) <= now)
        .sort((a, b) => a - b);

      // 还没到任何来源的重试时间：只睡一小段，保持“强制结束”能立刻响应。
      if (!due.length) {
        const earliest = Math.min(...[...pending].map((index) => nextAttemptAt.get(index) || now));
        const waitMs = Math.max(150, Math.min(1000, earliest - now));
        run.phase = `等待重试 · 还差 ${pending.size} 个 · ${Math.max(1, Math.ceil((earliest - now) / 1000))} 秒后重试`;
        this.persistRun(run);
        this.store.upsertRunMeta(run);
        this.bus.emitState();
        await this.sleepPolling(waitMs);
        continue;
      }

      round += 1;
      const batch = due.slice(0, concurrency);
      const retrying = batch.filter((index) => (run.results[index].attempts || 0) > 0).length;
      run.phase = round === 1
        ? `正在读取 ${batch.length} 个来源`
        : `第 ${round} 轮检查 · 还差 ${pending.size} 个${retrying ? `（其中 ${retrying} 个重试）` : ''}`;
      this.persistRun(run);
      this.store.upsertRunMeta(run);
      this.bus.emitState();

      const attempt = async (index) => {
        const { platform, source } = plan[index];
        const result = run.results[index];
        if (this.stopRequested) return;
        result.status = 'running';
        result.startedAt = result.startedAt || nowIso();
        run.progress.current = platform.id;
        this.bus.emitState();

        const started = Date.now();
        result.attempts = (result.attempts || 0) + 1;
        run.lastProgressAt = started;
        const key = sourceKey(platform.id, source?.url, source?.keyword);
        // 同一个平台可能有多个来源（比如两个 Grok 自动化任务），页面按 index 登记，避免互相顶掉。
        const pageKey = `${platform.id}::${index}`;
        // 单个来源的硬上限：页面卡住、浏览器被关、网站一直不响应时，这里必须能结束，
        // 否则 run 会永远停在“采集中”。预留 90 秒给图片/收尾。
        const readBudgetMs = Math.max(120, Number(settings.sourceTimeoutSec) || 180) * 1000;
        try {
          const watermark = this.store.getWatermark(key);
          // 手动运行 = 用户现在就要这份内容，同一份报告也要采；只有定时触发才按“新报告”去重，
          // 否则采过一次之后每次重跑都是 0 个来源（1.10 的实测故障）。
          const acceptSame = run.trigger !== 'schedule';
          const outcome = await this.withHardTimeout(
            readScheduledSource({
              browser: this.browser,
              platform,
              source: source || {},
              watermark,
              acceptSame,
              // 首屏渲染给到 30 秒（Gemini 实测要 12–15 秒，之前 20 秒的上限偶尔不够）。
              loadTimeoutMs: Math.min(30_000, readBudgetMs - 60_000 > 0 ? readBudgetMs - 60_000 : 30_000),
              onPage: (page) => this.activePages.set(pageKey, page)
            }),
            readBudgetMs,
            platform.name,
            () => {
              // 超时后把它开的页面关掉，避免残页继续占着浏览器。
              this.activePages.get(pageKey)?.close().catch(() => {});
            }
          );
          result.durationMs = Date.now() - started;
          result.url = outcome.url || result.sourceUrl || null;
          result.totalCount = outcome.totalCount || 0;
          result.newCount = outcome.newCount || 0;
          result.lastAnswerTime = outcome.lastTime || null;
          result.readReason = outcome.reason || null;
          // 记录每次尝试的结果，方便在运行记录里核对“到底重试了几次、间隔多久”。
          (result.attemptLog = result.attemptLog || []).push({
            at: nowIso(),
            state: outcome.state,
            total: outcome.totalCount || 0
          });

          if (outcome.state === 'new') {
            result.status = 'ok';
            result.text = outcome.text;
            result.answers = outcome.answers || [];
            result.chars = outcome.text.length;
            result.error = null;
            result.finishedAt = nowIso();
            this.store.setWatermark(key, {
              ...outcome.snapshot,
              // 记录“这份报告”的指纹，下次同一份报告不会重复采集（快照消息不算）。
              reportHash: outcome.reportHash || '',
              label: source?.keyword || source?.url || platform.name
            });
            pending.delete(index);
            run.progress.done += 1;
          } else if (waitMinutes <= 0 || this.stopRequested) {
            result.status = outcome.state === 'no-new' ? 'no-new' : 'no-answer';
            const prefix = this.stopRequested
              ? '已手动结束等待：'
              : '这次不等：';
            result.error =
              prefix +
              (outcome.state === 'chatter'
                ? '这条对话里只有采集快照/过程说明，没有最终报告正文。等平台生成当天的晚报后再运行。'
                : outcome.state === 'no-new'
                  ? '这条对话没有新的报告（可能已经采集过，或平台定时任务还没生成新内容）。'
                  : '这条对话里还没有出现回答。请确认该平台定时任务是否已经执行。');
            result.finishedAt = nowIso();
            pending.delete(index);
            run.progress.done += 1;
          } else if (result.attempts >= maxAttempts) {
            // 到重试上限直接结束这个来源，不把它留到下一轮继续重采。
            result.status = 'timeout';
            result.error = outcome.state === 'chatter'
              ? `已检查 ${result.attempts} 次，这条对话里始终只有过程说明、没有报告正文，停止重试。`
              : `已检查 ${result.attempts} 次仍没有新回答，停止重试（上限 ${maxAttempts} 次，可在「设置 · 定时回答与等待」里调整）。`;
            result.finishedAt = nowIso();
            pending.delete(index);
            run.progress.done += 1;
          } else if (Date.now() >= deadline) {
            result.status = outcome.state === 'chatter' ? 'no-answer' : (outcome.state === 'no-new' ? 'no-new' : 'no-answer');
            result.error =
              `等待 ${humanDuration(waitMinutes)}后：` +
              (outcome.state === 'chatter'
                ? '只读到过程说明，没有报告正文。请确认平台是否把报告生成在别的对话里。'
                : outcome.state === 'no-new'
                  ? '这条对话没有新的回答（可能已经采集过，或平台定时任务还没生成新内容）。'
                  : '这条对话里还没有出现回答。请确认该平台定时任务是否已经执行。');
            result.finishedAt = nowIso();
            pending.delete(index);
            run.progress.done += 1;
          } else {
            result.status = 'waiting';
            result.error = null;
          }
        } catch (error) {
          const recovery = this.browser.isAlive() ? this.browser.ensureHealthy() : Promise.resolve();
          await recovery.catch(() => {});
          result.durationMs = Date.now() - started;
          (result.attemptLog = result.attemptLog || []).push({
            at: nowIso(),
            state: 'error',
            error: String(error?.message || error).slice(0, 120)
          });
          if (this.stopRequested) {
            // 用户点了「强制结束等待」会主动关页面；这不是故障，留在 pending 里
            // 交给 finalizePending 统一收尾，别改写成“浏览器被关闭”。
            result.status = 'waiting';
            result.error = null;
            result.readReason = 'stopped';
          } else {
            // 浏览器被关掉、页面被关掉、单项超时：这些不是“这个来源没内容”，而是环境问题。
            // 重开浏览器再来一次，而不是直接判失败（用户关窗后应该能自愈）。
            // 注意：页面关闭时很多底层错误会被内部 catch 掉，最后变成业务错误
            // （例如“找不到运行列表”）。所以还要看浏览器本身是不是已经死了。
            const browserDead = !this.browser.isAlive();
            const recoverable =
              browserDead ||
              ['PAGE_CLOSED', 'TIMEOUT', 'PAGE_ERROR', 'WRONG_CONVERSATION', 'AUTOMATION_EMPTY', 'AUTOMATION_NOT_FOUND'].includes(error.code) ||
              /Target (page|closed)|has been closed|Browser (closed|has been closed)|Connection closed|browserType\.launch/i.test(
                String(error?.message || '')
              );
            const recoveries = Number(result.recoveries) || 0;
            // 重试上限按「每个来源最多检查几次」算，而不是固定 2 次：
            // 浏览器偶发关闭/页面被杀时，多试几次才能真正采到（1.10.1 之前 2 次就放弃了）。
            if (recoverable && recoveries < maxAttempts) {
              result.recoveries = recoveries + 1;
              result.status = 'waiting';
              result.error = null;
              result.readReason = 'retry-after-browser-closed';
              // 只有“浏览器真的没了”才需要整个关掉重开；
              // 单纯超时只要关掉这一条自己的页面，别连累并发中的其它来源。
              if (browserDead) await this.browser.close().catch(() => {});
              run.stallReason = null;
              this.bus.emitState();
            } else {
              result.status = errorStatus(error);
              // 环境问题（浏览器被关/超时）重试到上限时，别报成“找不到运行列表”这种业务错误，
              // 否则用户会以为是自己配置错了。
              if (recoverable) {
                result.error = browserDead
                  ? `浏览器被关闭，已自动重开重试 ${result.recoveries || 0} 次仍未成功。请保持自动化浏览器窗口打开后重新运行。`
                  : error.code === 'TIMEOUT'
                    ? `读取超过 ${Math.round(readBudgetMs / 1000)} 秒没有完成，已自动重试 ${result.recoveries || 0} 次仍未成功。可以稍后重新运行。`
                    : String(error.code || '') === 'WRONG_CONVERSATION' || String(error.code || '').startsWith('AUTOMATION_')
                      ? humanError(error)
                      : `读取失败（${error.code || '页面异常'}），已自动重试 ${result.recoveries || 0} 次仍未成功。可以稍后重新运行。`;
              } else {
                result.error = humanError(error);
              }
              result.screenshot = error.screenshot || null;
              result.finishedAt = nowIso();
              pending.delete(index);
              run.progress.done += 1;
            }
          }
        }

        if (result.startedAt) {
          result.waitedMs = Date.now() - new Date(result.startedAt).getTime();
        }
        // 这一轮读过就清掉页面登记，别让 activePages 越攒越多。
        this.activePages.delete(pageKey);
        run.lastProgressAt = Date.now();
        this.persistRun(run);
        this.store.upsertRunMeta(run);
        this.bus.emitState();
      };

      await mapLimit(batch, concurrency, attempt);

      if (!pending.size) break;

      // 给这一批里还没完成的来源各自安排下一次尝试。
      // 读不到内容的（totalCount=0）按 3s→6s→12s→24s→30s 快速重开页面重试；
      // 已经读到内容、只是还没出报告的，才按「轮询间隔」等。
      for (const index of batch) {
        if (!pending.has(index)) continue;
        const result = run.results[index];
        const delayMs = retryDelayMs({
          attempts: result.attempts || 1,
          totalCount: result.totalCount || 0,
          pollMinutes
        });
        nextAttemptAt.set(index, Date.now() + delayMs);
        result.nextRetryInSec = Math.max(1, Math.round(delayMs / 1000));
        if (result.status === 'waiting') {
          const sec = result.nextRetryInSec;
          const when = sec >= 60 ? `${Math.round(sec / 60)} 分钟` : `${sec} 秒`;
          result.error =
            (result.totalCount || 0) > 0
              ? `第 ${result.attempts || 1} 次检查：平台还没生成新报告，${when}后自动重试。`
              : `第 ${result.attempts || 1} 次没读到内容，${when}后自动重新打开页面重试。`;
        }
      }

      this.persistRun(run);
      this.store.upsertRunMeta(run);
      this.bus.emitState();
    }

    run.progress.current = null;
  }

  async runTask(task, trigger = 'manual') {
    if (this.current) throw new Error('已经有一个采集任务在运行，请等待完成。');
    if (this.checking.size) throw new Error('正在检查登录状态，请稍后再运行。');
    this.stopLoginWatchers();

    const mode = task.mode === 'scheduled' ? 'scheduled' : 'prompt';
    const plan =
      mode === 'scheduled'
        ? (task.sources || [])
          .map((source) => ({ source, platform: this.store.findPlatform(source.platformId) }))
          .filter((entry) => entry.platform && !entry.platform.hidden)
        : (task.platformIds || [])
          .map((id) => ({ platform: this.store.findPlatform(id) }))
          .filter((entry) => entry.platform && !entry.platform.hidden);

    if (!plan.length) {
      throw new Error(
        mode === 'scheduled'
          ? '这个任务还没有添加有效的定时来源（需要选择平台，并填写对话链接或标题关键词）。'
          : '这个任务还没有选择任何 AI 平台。'
      );
    }
    if (!plan.some((entry) => entry.platform.enabled)) {
      throw new Error('任务选中的平台都被停用了，请先在「AI 平台」里启用。');
    }

    const prompt = mode === 'scheduled' ? '' : renderPrompt(task.prompt);
    const runId = uid('run');
    const settings = this.store.state.settings;
    const run = {
      id: runId,
      taskId: task.id,
      taskName: task.name,
      mode,
      trigger,
      prompt,
      summaryProfile: task.summaryProfile || DEFAULT_SUMMARY_PROFILE,
      waitMinutes: mode === 'scheduled' ? clamp(Number(task.wait?.minutes ?? settings.waitMinutes ?? 60), 0, 720) : 0,
      pollMinutes: mode === 'scheduled' ? clamp(Number(task.wait?.pollMinutes ?? settings.pollMinutes ?? 5), 0.05, 120) : 5,
      startedAt: nowIso(),
      finishedAt: null,
      status: 'running',
      phase: '准备浏览器',
      progress: { done: 0, total: plan.length, current: null },
      results: plan.map((entry) => ({
        platformId: entry.platform.id,
        name: entry.platform.name,
        icon: entry.platform.icon,
        sourceKeyword: entry.source?.keyword || '',
        sourceUrl: entry.source?.url || '',
        status: entry.platform.enabled ? 'pending' : 'skipped',
        text: '',
        error: entry.platform.enabled ? null : '平台已停用',
        url: null,
        screenshot: null,
        startedAt: null,
        finishedAt: null,
        durationMs: 0,
        chars: 0,
        newCount: 0,
        totalCount: 0,
        lastAnswerTime: null
      })),
      bundlePath: null,
      outputPath: null,
      error: null
    };

    this.current = run;
    run.lastProgressAt = Date.now();
    this.store.upsertRunMeta(run);
    this.bus.emitState();

    // 看门狗：万一某个环节真的挂住（页面假死、浏览器无响应），
    // 超过 stallMinutes 没有任何进展就强制收尾，绝不能永远停在“采集中”。
    const stallMs = Math.max(5, Number(settings.stallMinutes) || 15) * 60_000;
    let watchdogTripped = false;
    const watchdog = setInterval(async () => {
      if (this.current !== run) return;
      const last = Number(run.lastProgressAt) || new Date(run.startedAt).getTime();
      const idle = Date.now() - last;
      // 等待窗口本身可能很长，按“等待窗口 + 看门狗”算，避免误杀正常等待。
      const allowance = Math.max(stallMs, waitMinutesFor(run) * 60_000 + stallMs);
      if (idle < allowance) return;
      watchdogTripped = true;
      run.phase = '采集无响应，正在强制结束';
      run.stallReason = `超过 ${Math.round(allowance / 60_000)} 分钟没有任何进展，已强制结束这次采集。`;
      this.bus.emitState();
      // 关掉浏览器能让所有挂起的页面操作立即失败，从而跳出等待。
      await Promise.race([
        this.browser.close().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 15_000))
      ]);
      this.stopRequested = true;
    }, 30_000);

    try {
      await this.browser.launch();
      process.env.AI_FLOW_FAILURE_DIR = path.join(this.store.runsDir, runId);

      if (mode === 'scheduled') {
        await this.collectScheduled(plan, run);
      } else {
        await this.collectPrompts(plan, run, prompt, task);
      }

      // 看门狗触发后，采集循环可能只是“正常收尾”；这里统一转成失败，界面不会显示成功。
      if (watchdogTripped) {
        throw new AdapterError('STALLED', run.stallReason || '采集长时间无响应，已强制结束。');
      }

      const summarySettings = this.store.state.settings;
      const good = run.results.filter(isGoodResult).length;
      const summaryProfile = SUMMARY_PROFILES[task.summaryProfile] || SUMMARY_PROFILES[DEFAULT_SUMMARY_PROFILE];
      let summaryText = '';
      if (summarySettings.autoSummarize !== false && good > 0) {
        const requestedId = summarySettings.summaryPlatformId || 'chatgpt';
        const summaryPlatform = this.store.findPlatform(requestedId) || this.store.findPlatform('chatgpt');
        const summaryName = summaryPlatform?.name || 'AI';
        run.summary = {
          status: 'running',
          platformId: summaryPlatform?.id || requestedId,
          name: summaryName,
          profileId: summaryProfile.id,
          profileName: summaryProfile.name,
          startedAt: nowIso(),
          text: '',
          chars: 0,
          error: null,
          warning: null,
          url: null,
          inputChars: 0,
          promptChars: 0
        };
        run.phase = `${summaryName} 正在总结`;
        this.persistRun(run);
        this.store.upsertRunMeta(run);
        this.bus.emitState();

        try {
          if (!summaryPlatform || summaryPlatform.hidden) {
            throw new AdapterError(
              'SUMMARY_PLATFORM',
              'AI 总结平台不可用，请到「AI 平台」启用一个平台，或在设置里更换总结 AI。'
            );
          }
          const summaryInput = buildBundle(task, run, prompt, { forSummary: true });
          const summaryPromptBase = summaryProfile.id === 'custom'
            ? (summarySettings.summaryPrompt || DEFAULT_SUMMARY_PROMPT)
            : summaryProfile.prompt;
          const summaryPrompt = renderPrompt(summaryPromptBase);
          const result = await this.withHardTimeout(
            this.summarizeWithPlatform({
              run,
              task,
              platform: summaryPlatform,
              rawText: summaryInput,
              promptText: summaryPrompt
            }),
            (Math.max(60, Number(summarySettings.summaryWaitSec) || 300) + 180) * 1000,
            summaryPlatform.name
          );
          summaryText = result.text;
          run.summary = {
            ...run.summary,
            status: 'ok',
            text: result.text,
            chars: result.text.length,
            error: result.warning || null,
            warning: result.warning || null,
            url: result.url || null,
            durationMs: result.durationMs,
            inputChars: result.inputChars || summaryInput.length,
            promptChars: result.promptChars || 0,
            finishedAt: nowIso()
          };
        } catch (error) {
          run.summary = {
            ...run.summary,
            status: 'error',
            error: humanError(error),
            screenshot: error.screenshot || null,
            finishedAt: nowIso(),
            durationMs: Date.now() - new Date(run.summary.startedAt).getTime()
          };
        }
      }

      run.finishedAt = nowIso();
      run.status = computeRunStatus(run.results);
      if (run.summary && (run.summary.status === 'error' || run.summary.warning) && run.status === 'done') {
        run.status = 'partial';
      }
      run.phase = '生成最终汇总';
      const rawArchive = buildBundle(task, run, prompt, { rawArchive: Boolean(summaryText) });
      const files = this.buildRunFiles(run, task, { rawText: rawArchive, summaryText });
      this.writeDataset(run, task, files);
      try {
        this.writeDailyDigest(run);
      } catch (error) {
        run.digestPath = null;
        run.digestError = humanError(error);
      }
      this.persistRun(run);
      this.store.upsertRunMeta(run);

      task.lastRunAt = run.finishedAt;
      task.lastError = null;
      if (task.schedule?.type === 'interval') {
        task.nextRunAt = nextOccurrence(task.schedule, new Date());
      }
      this.store.save();
      try {
        fs.writeFileSync(path.join(this.store.runsDir, 'latest.md'), files.finalText, 'utf8');
      } catch {
        // 忽略 latest 副本失败
      }

      if (trigger === 'schedule' && summarySettings.notify) {
        const summaryPart = summaryText
          ? `已由 ${run.summary.name} 总结`
          : run.summary?.status === 'error'
            ? 'AI 总结失败，原始回答已保存'
            : '只生成原文，未发给 AI';
        const digestPart = run.digestPath ? `，桌面总文档：${path.basename(run.digestPath)}` : '';
        showNotification(
          'AI Flow · 汇总完成',
          `${task.name}：${good}/${run.results.length} 个来源有内容，${summaryPart}${digestPart}。`
        );
      }
      if (summarySettings.autoCopy) {
        await copyToClipboard(files.finalText).catch(() => false);
      }

      run.phase = '完成';
      this.persistRun(run);
      this.store.upsertRunMeta(run);
      this.bus.emitState();
      return run;
    } catch (error) {
      run.status = 'failed';
      run.error = watchdogTripped
        ? (run.stallReason || '采集长时间无响应，已强制结束。')
        : humanError(error);
      run.finishedAt = run.finishedAt || nowIso();
      // 卡住时可能有来源还停在 running，统一收尾，别让界面一直显示采集。
      for (const result of run.results) {
        if (result.status === 'running' || result.status === 'waiting') {
          result.status = 'timeout';
          result.error = '采集被强制结束（长时间无响应）。';
          result.finishedAt = nowIso();
        }
      }
      this.persistRun(run);
      this.store.upsertRunMeta(run);
      this.bus.emitState();
      throw error;
    } finally {
      clearInterval(watchdog);
      delete process.env.AI_FLOW_FAILURE_DIR;
      this.current = null;
      this.stopRequested = false;
      if (this.browser.headless) await this.browser.close().catch(() => {});
      this.bus.emitState();
    }
  }
}
