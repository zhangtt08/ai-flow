import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Store, DEFAULT_PLATFORMS, normalizeSummaryConversation } from './store.mjs';
import { Engine } from './engine.mjs';
import { Scheduler } from './scheduler.mjs';
import { ensureDir, uid } from './util.mjs';
import { openExternalUrl, openFolder } from './notify.mjs';
import { createAgentApi } from './agent_api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.AI_FLOW_DATA_DIR ? path.resolve(process.env.AI_FLOW_DATA_DIR) : path.join(ROOT, 'data');
const PORT = Number(process.env.AI_FLOW_PORT) || 4321;
const HOST = '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_VERSION = '1.10.2';

ensureDir(DATA_DIR);
const LOG_FILE = path.join(DATA_DIR, 'ai-flow.log');

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(' ')}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, `${line}\n`, 'utf8');
  } catch {
    // 忽略日志写入失败
  }
}

const store = new Store(DATA_DIR);
// 上次异常退出/浏览器被关掉时，运行记录会永远停在 running（界面一直显示“采集中”）。
// 启动时先把这些不可能再继续的记录标成中断。
const interrupted = store.settleInterruptedRuns();
const clients = new Set();
const sockets = new Set();

const bus = {
  emitState() {
    broadcastState();
  }
};

const engine = new Engine({ store, bus, dataDir: DATA_DIR });
const scheduler = new Scheduler({ store, engine, bus });
const START_TIME = Date.now();

const agentApi = createAgentApi({
  store,
  engine,
  dataDir: DATA_DIR,
  appVersion: APP_VERSION,
  getBaseUrl: () => `http://${HOST}:${PORT}`
});

function publicState() {
  return store.publicState({
    currentRun: engine.currentPublic(),
    busy: engine.isBusy(),
    browser: engine.browser.info(),
    loginReady: store.state.platforms.some((platform) => platform.enabled && platform.login === 'logged_in'),
    paths: store.paths(),
    dataDir: DATA_DIR,
    appVersion: APP_VERSION,
    port: PORT,
    desktop: process.env.AI_FLOW_DESKTOP === '1'
  });
}

function broadcastState() {
  if (!clients.size) return;
  const payload = JSON.stringify(publicState());
  for (const response of clients) {
    try {
      response.write(`event: state\ndata: ${payload}\n\n`);
    } catch {
      clients.delete(response);
    }
  }
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload)
  });
  response.end(payload);
}

function httpError(statusCode, message, code = 'ERROR') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function readBody(request, limit = 1_500_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(httpError(413, '请求内容过大。', 'BODY_TOO_LARGE'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        return resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        return reject(httpError(400, '请求不是合法的 JSON。', 'BAD_JSON'));
      }
    });
    request.on('error', reject);
  });
}

function pickSchedule(input, current) {
  const fallback = current || { type: 'daily', time: '09:00', weekday: 1, everyHours: 6 };
  if (!input || typeof input !== 'object') return fallback;
  return {
    type: ['manual', 'daily', 'weekly', 'interval'].includes(input.type) ? input.type : fallback.type,
    time: /^\d{1,2}:\d{2}$/.test(String(input.time || '')) ? String(input.time) : fallback.time,
    weekday: Number.isFinite(Number(input.weekday)) ? Math.min(6, Math.max(0, Number(input.weekday))) : fallback.weekday,
    everyHours: Math.min(168, Math.max(1, Number(input.everyHours) || fallback.everyHours || 6))
  };
}

function validUrl(value) {
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function cleanCustomSelectors(input) {
  if (!input || typeof input !== 'object') return null;
  const output = {};
  for (const key of ['composer', 'send', 'stop', 'answer']) {
    const value = String(input[key] || '').trim();
    if (value) output[key] = value.slice(0, 500);
  }
  return Object.keys(output).length ? output : null;
}

function cleanSources(input) {
  if (!Array.isArray(input)) return null;
  return input
    .slice(0, 12)
    .map((item) => ({
      platformId: String(item?.platformId || ''),
      url: String(item?.url || '').trim(),
      keyword: String(item?.keyword || '').trim(),
      firstRun: item?.firstRun === 'all' ? 'all' : 'latest'
    }))
    .filter((item) => store.findPlatform(item.platformId));
}

function findRunOrThrow(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(String(id))) throw httpError(400, '运行记录 ID 不合法。', 'BAD_ID');
  const run = store.loadRun(id);
  if (!run) throw httpError(404, '没有找到这条运行记录。', 'NOT_FOUND');
  return run;
}

function serveStatic(request, response, pathname) {
  let relative = pathname;
  if (relative === '/' || relative === '') relative = '/index.html';
  let decoded;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    return false;
  }
  const file = path.resolve(PUBLIC_DIR, `.${decoded}`);
  if (!file.startsWith(`${PUBLIC_DIR}${path.sep}`) && file !== PUBLIC_DIR) return false;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const extension = path.extname(file).toLowerCase();
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.json': 'application/json; charset=utf-8',
    '.woff2': 'font/woff2'
  }[extension] || 'application/octet-stream';

  response.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Cache-Control': extension === '.html' ? 'no-store' : 'no-cache'
  });
  fs.createReadStream(file)
    .on('error', () => response.destroy())
    .pipe(response);
  return true;
}

async function handleApi(request, response, url) {
  const method = request.method || 'GET';
  const parts = url.pathname.split('/').filter(Boolean);
  const [, resource, ...rest] = parts;

  if (resource === 'health' && method === 'GET') {
    return sendJson(response, 200, {
      ok: true,
      app: 'ai-flow',
      version: APP_VERSION,
      data: {
        project: 'aiflow',
        name: 'AI Flow',
        version: APP_VERSION,
        agent_api: 1,
        tools: agentApi.tools.length,
        uptime_ms: Date.now() - START_TIME,
        busy: engine.isBusy(),
        loginReady: store.state.platforms.some((platform) => platform.enabled && platform.login === 'logged_in')
      }
    });
  }

  if (resource === 'agent') {
    return agentApi.handleAgentRequest(request, response, url, readBody, sendJson);
  }

  if (resource === 'events' && method === 'GET') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    response.write(`retry: 3000\n\n`);
    response.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
    clients.add(response);
    request.on('close', () => clients.delete(response));
    return;
  }

  if (resource === 'state' && method === 'GET') {
    return sendJson(response, 200, { ok: true, state: publicState() });
  }

  if (resource === 'tasks') {
    if (method === 'POST' && rest.length === 0) {
      const body = await readBody(request);
      const mode = body.mode === 'scheduled' ? 'scheduled' : 'prompt';
      const name = String(body.name || '').trim().slice(0, 60);
      const prompt = String(body.prompt || '').trim();
      if (!name) throw httpError(400, '请填写任务名称。', 'BAD_TASK');
      if (mode === 'prompt' && !prompt) throw httpError(400, '请填写要发送给 AI 的提示词。', 'BAD_TASK');
      const platformIds = Array.isArray(body.platformIds)
        ? [...new Set(body.platformIds.map(String))].filter((id) => {
          const platform = store.findPlatform(id);
          return platform && !platform.hidden;
        })
        : [];
      const sources = cleanSources(body.sources) || [];
      if (mode === 'prompt' && !platformIds.length) throw httpError(400, '请至少选择一个 AI 平台。', 'BAD_TASK');
      if (mode === 'scheduled' && !sources.length) {
        throw httpError(400, '定时采集需要至少一个来源：粘贴定时对话链接，或填写标题关键词。', 'BAD_TASK');
      }
      const task = store.createTask({
        name,
        mode,
        prompt: prompt || '（定时采集模式不使用提示词）',
        platformIds,
        sources,
        summaryProfile: body.summaryProfile,
        conversations: body.conversations,
        summaryConversation: body.summaryConversation,
        wait: body.wait,
        schedule: pickSchedule(body.schedule),
        enabled: Boolean(body.enabled)
      });
      log(`task created: ${task.name} (${task.mode})`);
      broadcastState();
      return sendJson(response, 201, { ok: true, task });
    }

    if (rest.length === 2 && rest[1] === 'run' && method === 'POST') {
      const task = store.findTask(rest[0]);
      if (!task) throw httpError(404, '任务不存在。', 'NOT_FOUND');
      if (engine.isBusy()) throw httpError(409, '已经有一个采集任务在运行，请等待完成。', 'BUSY');
      const promise = engine.runTask(task, 'manual');
      const runId = engine.current?.id;
      if (!runId) {
        try {
          await promise;
        } catch (error) {
          throw httpError(400, error.message || '任务未能启动。', error.code || 'RUN_REJECTED');
        }
        throw httpError(500, '任务没有启动。', 'RUN_NOT_STARTED');
      }
      promise.catch((error) => log(`run failed: ${error.message}`));
      return sendJson(response, 202, { ok: true, runId });
    }

    if (rest.length === 2 && rest[1] === 'stop-waiting' && method === 'POST') {
      if (!engine.current) throw httpError(409, '当前没有正在等待的任务。', 'NOT_WAITING');
      const stopped = engine.stopWaiting();
      broadcastState();
      return sendJson(response, 200, { ok: true, stopped });
    }

    if (rest.length === 1) {
      const task = store.findTask(rest[0]);
      if (!task) throw httpError(404, '任务不存在。', 'NOT_FOUND');
      if (method === 'PATCH') {
        const body = await readBody(request);
        const patch = {};
        if (typeof body.name === 'string') {
          const name = body.name.trim().slice(0, 60);
          if (!name) throw httpError(400, '任务名称不能为空。', 'BAD_TASK');
          patch.name = name;
        }
        const nextMode = body.mode === 'scheduled' || body.mode === 'prompt' ? body.mode : task.mode;
        if (body.mode) patch.mode = body.mode;
        if (typeof body.prompt === 'string') {
          if (body.mode !== 'scheduled' && nextMode !== 'scheduled' && !body.prompt.trim()) {
            throw httpError(400, '提示词不能为空。', 'BAD_TASK');
          }
          patch.prompt = body.prompt;
        }
        if (typeof body.summaryProfile === 'string') patch.summaryProfile = body.summaryProfile;
        if (body.conversations && typeof body.conversations === 'object') patch.conversations = body.conversations;
        if (Object.prototype.hasOwnProperty.call(body, 'summaryConversation')) patch.summaryConversation = body.summaryConversation;
        if (Array.isArray(body.sources)) {
          const sources = cleanSources(body.sources);
          if (!sources.length && nextMode === 'scheduled') {
            throw httpError(400, '定时采集需要至少一个有效来源。', 'BAD_TASK');
          }
          patch.sources = sources;
        }
        if (body.wait) patch.wait = body.wait;
        if (Array.isArray(body.platformIds)) {
          const platformIds = [...new Set(body.platformIds.map(String))].filter((id) => {
            const platform = store.findPlatform(id);
            return platform && !platform.hidden;
          });
          if (!platformIds.length && nextMode === 'prompt') throw httpError(400, '请至少选择一个 AI 平台。', 'BAD_TASK');
          patch.platformIds = platformIds;
        }
        if (body.schedule) patch.schedule = pickSchedule(body.schedule, task.schedule);
        if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
        const updated = store.updateTask(task.id, patch);
        broadcastState();
        return sendJson(response, 200, { ok: true, task: updated });
      }
      if (method === 'DELETE') {
        store.deleteTask(task.id);
        broadcastState();
        return sendJson(response, 200, { ok: true });
      }
    }
    throw httpError(405, '不支持的操作。', 'METHOD_NOT_ALLOWED');
  }

  if (resource === 'platforms') {
    if (method === 'POST' && rest.length === 0) {
      const body = await readBody(request);
      const name = String(body.name || '').trim().slice(0, 40);
      const target = String(body.url || '').trim();
      if (!name) throw httpError(400, '请填写平台名称。', 'BAD_PLATFORM');
      if (!validUrl(target)) throw httpError(400, '请填写以 http:// 或 https:// 开头的网址。', 'BAD_PLATFORM');
      const platform = {
        id: uid('platform'),
        name,
        adapterId: 'custom',
        url: target,
        icon: 'custom',
        tone: 'ink',
        builtin: false,
        enabled: true,
        login: 'unknown',
        lastCheckAt: null,
        loginError: null,
        createdAt: new Date().toISOString(),
        customSelectors: cleanCustomSelectors(body.customSelectors)
      };
      store.state.platforms.push(platform);
      store.save();
      broadcastState();
      return sendJson(response, 201, { ok: true, platform });
    }

    if (rest.length === 2 && rest[1] === 'check' && method === 'POST') {
      const platform = store.findPlatform(rest[0]);
      if (!platform) throw httpError(404, '平台不存在。', 'NOT_FOUND');
      if (engine.current) throw httpError(409, '正在执行汇总，请稍后再检查。', 'BUSY');
      const promise = engine.checkPlatform(platform.id);
      promise.catch((error) => log(`check failed: ${platform.name}: ${error.message}`));
      return sendJson(response, 202, { ok: true });
    }

    if (rest.length === 2 && rest[1] === 'current-url' && method === 'GET') {
      const platform = store.findPlatform(rest[0]);
      if (!platform) throw httpError(404, '平台不存在。', 'NOT_FOUND');
      const info = await engine.currentUrl(platform.id);
      return sendJson(response, 200, { ok: true, ...info });
    }

    if (rest.length === 2 && rest[1] === 'open' && method === 'POST') {
      const platform = store.findPlatform(rest[0]);
      if (!platform) throw httpError(404, '平台不存在。', 'NOT_FOUND');
      if (engine.current) throw httpError(409, '正在执行汇总，请稍后再打开。', 'BUSY');
      const result = await engine.openPlatform(platform.id);
      return sendJson(response, 200, { ok: true, ...result });
    }

    if (rest.length === 1 && rest[0] === 'restore-defaults' && method === 'POST') {
      const restored = [];
      for (const seed of DEFAULT_PLATFORMS) {
        const platform = store.state.platforms.find((item) => item.id === seed.id);
        if (!platform || !platform.hidden) continue;
        platform.hidden = false;
        platform.enabled = seed.enabled !== false;
        platform.login = 'unknown';
        platform.loginError = null;
        platform.lastCheckAt = null;
        restored.push(seed.id);
      }
      store.save();
      broadcastState();
      return sendJson(response, 200, { ok: true, restored });
    }

    if (rest.length === 1 && method === 'PATCH') {
      const platform = store.findPlatform(rest[0]);
      if (!platform) throw httpError(404, '平台不存在。', 'NOT_FOUND');
      const body = await readBody(request);
      if (typeof body.name === 'string' && body.name.trim() && !platform.builtin) {
        platform.name = body.name.trim().slice(0, 40);
      }
      if (typeof body.enabled === 'boolean') platform.enabled = body.enabled;
      if (typeof body.url === 'string' && !platform.builtin) {
        if (!validUrl(body.url)) throw httpError(400, '网址格式不正确。', 'BAD_PLATFORM');
        platform.url = body.url.trim();
        platform.login = 'unknown';
      }
      if (body.customSelectors && !platform.builtin) {
        platform.customSelectors = cleanCustomSelectors(body.customSelectors);
      }
      store.save();
      broadcastState();
      return sendJson(response, 200, { ok: true, platform });
    }

    if (rest.length === 1 && method === 'DELETE') {
      const platform = store.findPlatform(rest[0]);
      if (!platform) throw httpError(404, '平台不存在。', 'NOT_FOUND');
      const wasBuiltin = Boolean(platform.builtin);
      if (wasBuiltin) {
        platform.hidden = true;
        platform.enabled = false;
        platform.login = 'unknown';
        platform.loginError = null;
        platform.lastCheckAt = null;
      } else {
        store.state.platforms = store.state.platforms.filter((item) => item.id !== platform.id);
      }
      for (const task of store.state.tasks) {
        task.platformIds = (task.platformIds || []).filter((id) => id !== platform.id);
        if (Array.isArray(task.sources)) {
          task.sources = task.sources.filter((source) => source.platformId !== platform.id);
        }
      }
      store.save();
      broadcastState();
      return sendJson(response, 200, { ok: true, hidden: wasBuiltin });
    }

    throw httpError(405, '不支持的操作。', 'METHOD_NOT_ALLOWED');
  }

  if (resource === 'runs') {
    if (method === 'GET' && rest.length === 1) {
      const run = findRunOrThrow(rest[0]);
      const finalFile = store.finalPathFor(run);
      const rawFile = store.rawPathFor(run);
      let bundle = null;
      let bundleName = null;
      let rawBundle = null;
      let rawBundleName = null;
      try {
        bundle = fs.readFileSync(finalFile, 'utf8');
        bundleName = path.basename(finalFile);
      } catch {
        // 文件可能已被手动删除
      }
      try {
        if (rawFile !== finalFile) {
          rawBundle = fs.readFileSync(rawFile, 'utf8');
          rawBundleName = path.basename(rawFile);
        }
      } catch {
        // 原始回答可能已被手动删除
      }
      const copy = { ...run, prompt: run.prompt };
      delete copy.bundlePath;
      return sendJson(response, 200, { ok: true, run: copy, bundle, bundleName, rawBundle, rawBundleName });
    }

    if (method === 'GET' && rest.length === 2 && rest[1] === 'bundle') {
      const run = findRunOrThrow(rest[0]);
      const file = store.finalPathFor(run);
      if (!fs.existsSync(file)) throw httpError(404, '汇总文件不存在。', 'NOT_FOUND');
      const text = fs.readFileSync(file, 'utf8');
      const filename = `AI-Flow_${path.basename(file)}`;
      response.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="ai-flow-${run.id}.md"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store'
      });
      response.end(text);
      return;
    }

    if (method === 'GET' && rest.length === 2 && rest[1] === 'raw') {
      const run = findRunOrThrow(rest[0]);
      const file = store.rawPathFor(run);
      if (!fs.existsSync(file)) throw httpError(404, '原始回答文件不存在。', 'NOT_FOUND');
      const text = fs.readFileSync(file, 'utf8');
      const filename = `AI-Flow_${path.basename(file)}`;
      response.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="ai-flow-raw-${run.id}.md"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store'
      });
      response.end(text);
      return;
    }

    if (method === 'GET' && rest.length === 2 && rest[1] === 'digest') {
      const run = findRunOrThrow(rest[0]);
      const file = String(run.digestPath || '');
      const desktopDir = path.resolve(store.desktopDir());
      const inside =
        file &&
        (path.resolve(file).startsWith(`${desktopDir}${path.sep}`) ||
          path.resolve(file).startsWith(`${path.resolve(store.outputDir())}${path.sep}`));
      if (!inside || !fs.existsSync(file)) throw httpError(404, '桌面总文档不存在。', 'NOT_FOUND');
      const text = fs.readFileSync(file, 'utf8');
      const filename = `AI-Flow_${path.basename(file)}`;
      response.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="ai-flow-digest-${run.id}.md"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store'
      });
      response.end(text);
      return;
    }

    if (method === 'GET' && rest.length === 3 && rest[1] === 'dataset') {
      const run = findRunOrThrow(rest[0]);
      let wanted = String(rest[2] || '');
      try {
        wanted = decodeURIComponent(wanted);
      } catch {
        throw httpError(400, '数据文件名不合法。', 'BAD_FILE');
      }
      const allowed = {
        '回答集.csv': 'text/csv; charset=utf-8',
        '回答集.jsonl': 'application/x-ndjson; charset=utf-8',
        '回答集.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '运行摘要.json': 'application/json; charset=utf-8',
        '说明.md': 'text/markdown; charset=utf-8'
      };
      if (!allowed[wanted]) throw httpError(400, '不支持的数据文件。', 'BAD_FILE');
      const dir = run.datasetDir ? path.resolve(run.datasetDir) : '';
      const file = dir ? path.join(dir, wanted) : '';
      if (!dir || path.dirname(file) !== dir || !fs.existsSync(file)) {
        throw httpError(404, '数据文件不存在。', 'NOT_FOUND');
      }
      const data = fs.readFileSync(file);
      const prefix = path.basename(dir, '_数据');
      const filename = `AI-Flow_${prefix}_${wanted}`;
      response.writeHead(200, {
        'Content-Type': allowed[wanted],
        'Content-Disposition': `attachment; filename="ai-flow-${run.id}.${wanted.split('.').pop()}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store'
      });
      response.end(data);
      return;
    }

    if (method === 'DELETE' && rest.length === 1) {
      if (!/^[a-zA-Z0-9_-]+$/.test(String(rest[0]))) throw httpError(400, '运行记录 ID 不合法。', 'BAD_ID');
      if (engine.current?.id === rest[0]) throw httpError(409, '这条记录正在运行中，不能删除。', 'BUSY');
      if (!store.deleteRun(rest[0])) throw httpError(404, '没有找到这条运行记录。', 'NOT_FOUND');
      log(`run deleted: ${rest[0]}`);
      broadcastState();
      return sendJson(response, 200, { ok: true });
    }

    throw httpError(405, '不支持的操作。', 'METHOD_NOT_ALLOWED');
  }

  if (resource === 'latest' && method === 'GET') {
    const latest = store.latestBundle();
    if (!latest) throw httpError(404, '还没有生成过汇总。', 'NOT_FOUND');
    return sendJson(response, 200, {
      ok: true,
      run: latest.run,
      bundle: latest.text,
      bundleName: path.basename(latest.file)
    });
  }

  if (resource === 'watermarks') {
    if (method === 'GET') {
      return sendJson(response, 200, { ok: true, watermarks: store.watermarkSummary() });
    }
    if (method === 'POST') {
      const body = await readBody(request);
      const key = typeof body.key === 'string' ? String(body.key) : '';
      if (key && !/^[a-zA-Z0-9_.:-]+$/.test(key)) throw httpError(400, '来源标识不合法。', 'BAD_KEY');
      const kept = store.resetWatermarks(key);
      log(`watermarks reset: ${key || 'ALL'} (kept ${kept})`);
      broadcastState();
      return sendJson(response, 200, { ok: true, kept, watermarks: store.watermarkSummary() });
    }
    throw httpError(405, '不支持的操作。', 'METHOD_NOT_ALLOWED');
  }

  if (resource === 'browser') {
    if (method === 'GET' && rest[0] === 'status') {
      return sendJson(response, 200, {
        ok: true,
        browser: engine.browser.info(),
        loginReady: store.state.platforms.some((platform) => platform.enabled && platform.login === 'logged_in')
      });
    }

    if (method === 'POST' && rest[0] === 'close') {
      await engine.closeBrowser();
      return sendJson(response, 200, { ok: true });
    }

    throw httpError(405, '不支持的操作。', 'METHOD_NOT_ALLOWED');
  }

  if (resource === 'settings' && method === 'POST') {
    const body = await readBody(request);
    const settings = store.state.settings;
    const previous = JSON.stringify({
      browser: settings.browser,
      visible: settings.visible,
      proxy: settings.proxy,
      minimize: settings.minimizeDuringRun
    });

    if (body.browser === 'edge' || body.browser === 'chrome') settings.browser = body.browser;
    if (typeof body.visible === 'boolean') settings.visible = body.visible;
    if (typeof body.minimizeDuringRun === 'boolean') settings.minimizeDuringRun = body.minimizeDuringRun;
    if (typeof body.proxy === 'string') {
      const proxy = body.proxy.trim();
      if (proxy && !/^(https?|socks5):\/\//i.test(proxy)) {
        throw httpError(400, '代理地址需要以 http://、https:// 或 socks5:// 开头。', 'BAD_PROXY');
      }
      settings.proxy = proxy;
    }
    if (typeof body.autoCopy === 'boolean') settings.autoCopy = body.autoCopy;
    if (typeof body.notify === 'boolean') settings.notify = body.notify;
    if (typeof body.catchUp === 'boolean') settings.catchUp = body.catchUp;
    if (typeof body.debugScreenshots === 'boolean') settings.debugScreenshots = body.debugScreenshots;
    if (typeof body.autoSummarize === 'boolean') settings.autoSummarize = body.autoSummarize;
    if (typeof body.desktopDigest === 'boolean') settings.desktopDigest = body.desktopDigest;
    if (Object.prototype.hasOwnProperty.call(body, 'summaryConversation')) {
      settings.summaryConversation = normalizeSummaryConversation(body.summaryConversation);
    }
    if (Number.isFinite(Number(body.maxAttempts))) {
      settings.maxAttempts = Math.min(20, Math.max(1, Number(body.maxAttempts)));
    }
    if (Number.isFinite(Number(body.concurrency))) {
      settings.concurrency = Math.min(4, Math.max(1, Number(body.concurrency)));
    }
    if (Number.isFinite(Number(body.sourceTimeoutSec))) {
      settings.sourceTimeoutSec = Math.min(900, Math.max(60, Number(body.sourceTimeoutSec)));
    }
    if (Number.isFinite(Number(body.stallMinutes))) {
      settings.stallMinutes = Math.min(120, Math.max(5, Number(body.stallMinutes)));
    }
    if (typeof body.summaryPlatformId === 'string') {
      const id = body.summaryPlatformId.trim();
      const platform = id ? store.findPlatform(id) : null;
      if (id && !platform) throw httpError(400, '总结用的 AI 平台不存在。', 'BAD_SUMMARY_PLATFORM');
      if (platform?.hidden) throw httpError(400, '这个平台已被移除，不能作为总结 AI。', 'BAD_SUMMARY_PLATFORM');
      settings.summaryPlatformId = id || 'chatgpt';
    }
    if (typeof body.summaryPrompt === 'string') {
      settings.summaryPrompt = body.summaryPrompt.slice(0, 4000);
    }
    if (Number.isFinite(Number(body.summaryWaitSec))) {
      settings.summaryWaitSec = Math.min(900, Math.max(60, Number(body.summaryWaitSec)));
    }
    if (Number.isFinite(Number(body.stableMs))) {
      settings.stableMs = Math.min(15_000, Math.max(1200, Number(body.stableMs)));
    }
    if (Number.isFinite(Number(body.maxWaitSec))) {
      settings.maxWaitSec = Math.min(900, Math.max(60, Number(body.maxWaitSec)));
    }
    if (Number.isFinite(Number(body.catchUpHours))) {
      settings.catchUpHours = Math.min(72, Math.max(1, Number(body.catchUpHours)));
    }
    if (typeof body.outputDir === 'string') {
      const dir = body.outputDir.trim();
      if (dir && !path.isAbsolute(dir)) {
        throw httpError(400, '输出目录需要是完整路径，例如 C:\\Users\\你的用户名\\Documents\\AI Flow。', 'BAD_OUTPUT');
      }
      if (dir) ensureDir(dir);
      settings.outputDir = dir;
    }
    if (typeof body.digestTitle === 'string') {
      settings.digestTitle = body.digestTitle.trim().slice(0, 60) || 'Valorant 资讯晚报';
    }
    if (Number.isFinite(Number(body.waitMinutes))) {
      settings.waitMinutes = Math.min(720, Math.max(0, Number(body.waitMinutes)));
    }
    if (Number.isFinite(Number(body.pollMinutes))) {
      settings.pollMinutes = Math.min(120, Math.max(0.05, Number(body.pollMinutes)));
    }
    store.save();

    const next = JSON.stringify({
      browser: settings.browser,
      visible: settings.visible,
      proxy: settings.proxy,
      minimize: settings.minimizeDuringRun
    });
    if (previous !== next) await engine.closeBrowser();

    broadcastState();
    return sendJson(response, 200, { ok: true, settings });
  }

  if (resource === 'open-folder' && method === 'POST') {
    const body = await readBody(request);
    let target = store.runsDir;
    let datasetDir = '';
    if (body.target === 'output') target = store.outputDir();
    else if (body.target === 'data') target = DATA_DIR;
    else if (body.target === 'logs') target = path.dirname(store.paths().logFile);
    else if (body.target === 'desktop') target = store.desktopDir();
    if (body.runId) {
      const meta = store.getRunMeta(String(body.runId));
      if (!meta) throw httpError(404, '运行记录不存在。', 'NOT_FOUND');
      target = fs.existsSync(path.dirname(store.bundlePathFor(meta)))
        ? path.dirname(store.bundlePathFor(meta))
        : store.runsDir;
    }
    if (body.datasetRunId) {
      const run = store.loadRun(String(body.datasetRunId));
      if (!run || !run.datasetDir || !fs.existsSync(run.datasetDir)) {
        throw httpError(404, '数据文件夹不存在。', 'NOT_FOUND');
      }
      target = run.datasetDir;
      datasetDir = run.datasetDir;
    }
    const resolved = path.resolve(target);
    const allowed =
      resolved.startsWith(path.resolve(DATA_DIR)) ||
      resolved === path.resolve(store.outputDir()) ||
      resolved === path.resolve(store.desktopDir()) ||
      (datasetDir && resolved === path.resolve(datasetDir));
    if (!allowed) {
      throw httpError(400, '目录不在应用数据目录内。', 'BAD_PATH');
    }
    const opened = openFolder(resolved);
    if (!opened) throw httpError(404, '目录不存在。', 'NOT_FOUND');
    return sendJson(response, 200, { ok: true, path: resolved });
  }

  if (resource === 'shutdown' && method === 'POST') {
    sendJson(response, 200, { ok: true });
    log('shutdown requested');
    queueShutdown();
    return;
  }

  throw httpError(404, '接口不存在。', 'NOT_FOUND');
}

async function handle(request, response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  try {
    const url = new URL(request.url, BASE_URL);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url);
      return;
    }
    if (url.pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (serveStatic(request, response, url.pathname)) return;
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) log(`api error: ${error.message}`);
    if (!response.headersSent) {
      sendJson(response, status, {
        ok: false,
        error: { code: error.code || 'ERROR', message: error.message || '服务器错误' }
      });
    } else {
      response.end();
    }
  }
}

const server = http.createServer((request, response) => {
  handle(request, response);
});

server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

const heartbeat = setInterval(() => {
  for (const client of clients) {
    try {
      client.write(': ping\n\n');
    } catch {
      clients.delete(client);
    }
  }
}, 25_000);

let shuttingDown = false;
function queueShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  setTimeout(async () => {
    scheduler.stop();
    clearInterval(heartbeat);
    for (const client of clients) {
      try {
        client.end();
      } catch {
        // 忽略
      }
    }
    clients.clear();
    await engine.shutdown().catch(() => {});
    server.close(() => {
      log('server closed');
    });
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  }, 250);
}

async function openExistingInstance() {
  clearInterval(heartbeat);
  try {
    const response = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(1500) });
    const data = await response.json();
    if (data.app === 'ai-flow') {
      openExternalUrl(BASE_URL);
      console.log('AI Flow 已在运行，已打开现有页面。');
      return;
    }
  } catch {
    // 端口被其他程序占用
  }
  console.error(`端口 ${PORT} 被占用，且不是 AI Flow。请关闭占用该端口的程序，或设置 AI_FLOW_PORT。`);
  process.exitCode = 1;
}

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    openExistingInstance();
  } else {
    console.error(error);
    process.exitCode = 1;
  }
});

server.listen(PORT, HOST, () => {
  log(`AI Flow ${APP_VERSION} listening on ${BASE_URL}`);
  log(`data: ${DATA_DIR}`);
  try {
    const epDirs = [
      path.join(ROOT, '..', 'agent'),
      path.join(ROOT, 'agent')
    ];
    for (const d of epDirs) {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, '.endpoint'), BASE_URL, 'utf8');
    }
  } catch {
    // 忽略 endpoint 写入失败
  }
  scheduler.start();
  if (!process.argv.includes('--no-open')) openExternalUrl(BASE_URL);
});

process.on('SIGINT', () => queueShutdown());
process.on('SIGTERM', () => queueShutdown());
