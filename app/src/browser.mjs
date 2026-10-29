import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { ensureDir } from './util.mjs';

export const BROWSER_LABELS = { edge: 'Microsoft Edge', chrome: 'Google Chrome' };

export function browserCandidates() {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  return {
    edge: [
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    ],
    chrome: [
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')
    ]
  };
}

export function detectBrowsers() {
  const candidates = browserCandidates();
  const found = {};
  for (const [kind, paths] of Object.entries(candidates)) {
    found[kind] = paths.find((candidate) => fs.existsSync(candidate)) || null;
  }
  return found;
}

export function resolveBrowserKind(settings) {
  const found = detectBrowsers();
  const preferred = settings?.browser === 'chrome' ? 'chrome' : 'edge';
  if (found[preferred]) return preferred;
  if (found.edge) return 'edge';
  if (found.chrome) return 'chrome';
  return preferred;
}

export function browserProbe() {
  const found = detectBrowsers();
  return {
    installed: found,
    labels: BROWSER_LABELS,
    edgeUserData: process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data') : null,
    chromeUserData: process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data') : null
  };
}

export function profileDirFor(dataDir, kind) {
  return path.join(dataDir, 'profiles', kind);
}

export class BrowserManager {
  constructor({ dataDir, getSettings }) {
    this.dataDir = dataDir;
    this.getSettings = getSettings;
    this.context = null;
    this.kind = null;
    this.headless = null;
    this.launchSignature = null;
  }

  currentKind() {
    return resolveBrowserKind(this.getSettings());
  }

  currentExecutable() {
    const kind = this.currentKind();
    return detectBrowsers()[kind];
  }

  signature() {
    const settings = this.getSettings();
    const kind = this.currentKind();
    return JSON.stringify({
      kind,
      exe: this.currentExecutable(),
      visible: Boolean(settings.visible),
      proxy: String(settings.proxy || ''),
      minimize: Boolean(settings.minimizeDuringRun)
    });
  }

  async launch({ forceVisible = false } = {}) {
    const kind = this.currentKind();
    const executablePath = this.currentExecutable();
    if (!executablePath) {
      throw new Error('没有找到可用的 Edge 或 Chrome。请先安装 Microsoft Edge。');
    }

    const signature = JSON.stringify({ signature: this.signature(), forceVisible });
    if (this.context) {
      // context 存在但不代表还活着（用户关窗后 close 事件有时还没到）。
      if (!this.isAlive()) {
        await this.close();
      } else if (!forceVisible || !this.headless) {
        return this.context;
      } else {
        await this.close();
      }
    }

    const settings = this.getSettings();
    const headless = forceVisible ? false : !settings.visible;
    const userDataDir = profileDirFor(this.dataDir, kind);
    ensureDir(userDataDir);
    ensureDir(path.join(this.dataDir, 'downloads'));

    const args = [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--lang=zh-CN',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding'
    ];
    if (!headless) args.push('--start-maximized');

    const options = {
      executablePath,
      headless,
      args,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      viewport: headless ? { width: 1440, height: 1000 } : null,
      acceptDownloads: false,
      ignoreDefaultArgs: ['--enable-automation']
    };

    if (settings.proxy && String(settings.proxy).trim()) {
      options.proxy = { server: String(settings.proxy).trim() };
    }

    this.context = await chromium.launchPersistentContext(userDataDir, options);
    this.kind = kind;
    this.headless = headless;
    this.launchSignature = signature;

    this.context.on('close', () => {
      this.context = null;
      this.kind = null;
      this.headless = null;
    });

    if (!headless && settings.minimizeDuringRun) {
      await this.minimize().catch(() => {});
    }
    return this.context;
  }

  /** 浏览器是否还活着；被用户关掉或进程崩了要能立刻发现。 */
  isAlive() {
    if (!this.context) return false;
    try {
      if (this.context.browser && this.context.browser() && !this.context.browser().isConnected()) return false;
      this.context.pages();
      return true;
    } catch {
      return false;
    }
  }

  /** 关掉已经死掉的 context，下次 newPage 会重新拉起浏览器。 */
  async ensureHealthy() {
    if (!this.context) return;
    if (this.isAlive()) return;
    await this.close();
  }

  async ensure() {
    if (this.context) {
      if (this.isAlive()) return this.context;
      await this.close();
    }
    return this.launch();
  }

  async newPage() {
    await this.ensureHealthy();
    let context;
    try {
      context = await this.ensure();
      return await context.newPage();
    } catch (error) {
      // 用户中途关掉浏览器时，context 可能还没触发 close 事件就失效了。这里重开一次。
      if (/Target closed|has been closed|Browser closed|Connection closed/i.test(String(error?.message || error))) {
        await this.close();
        const fresh = await this.ensure();
        return fresh.newPage();
      }
      throw error;
    }
  }

  async minimize() {
    if (!this.context) return;
    const page = this.context.pages()[0] || (await this.context.newPage());
    const session = await this.context.newCDPSession(page);
    try {
      const { windowId } = await session.send('Browser.getWindowForTarget');
      await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    } finally {
      await session.detach().catch(() => {});
    }
  }

  async restore() {
    if (!this.context) return;
    const pages = this.context.pages();
    const page = pages[pages.length - 1] || (await this.context.newPage());
    const session = await this.context.newCDPSession(page);
    try {
      const { windowId } = await session.send('Browser.getWindowForTarget');
      await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    } finally {
      await session.detach().catch(() => {});
      await page.bringToFront().catch(() => {});
    }
  }

  async close() {
    const context = this.context;
    this.context = null;
    this.kind = null;
    this.headless = null;
    this.launchSignature = null;
    if (context) await context.close().catch(() => {});
  }

  async restartIfChanged() {
    if (!this.context) return false;
    const signature = JSON.stringify({ signature: this.signature(), forceVisible: !this.headless ? false : false });
    if (this.launchSignature !== signature) {
      await this.close();
      return true;
    }
    return false;
  }

  info() {
    const settings = this.getSettings();
    const kind = this.currentKind();
    return {
      kind,
      label: BROWSER_LABELS[kind],
      executable: this.currentExecutable(),
      running: Boolean(this.context),
      headless: this.headless,
      profileDir: profileDirFor(this.dataDir, kind),
      visible: settings.visible !== false,
      installed: detectBrowsers()
    };
  }
}
