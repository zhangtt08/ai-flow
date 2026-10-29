import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const nowIso = () => new Date().toISOString();

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function replaceWithRetry(from, to) {
  const attempts = 6;
  for (let index = 0; index < attempts; index += 1) {
    try {
      fs.renameSync(from, to);
      return true;
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(error.code) || index === attempts - 1) throw error;
      const wait = 20 * (index + 1);
      const until = Date.now() + wait;
      while (Date.now() < until) {
        // 在 Windows 上短暂等待文件句柄释放
      }
    }
  }
  return false;
}

export function writeJsonAtomic(file, data) {
  writeAtomic(file, JSON.stringify(data, null, 2));
}

export function writeTextAtomic(file, text) {
  writeAtomic(file, String(text));
}

function writeAtomic(file, content) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    replaceWithRetry(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 忽略临时文件清理失败
    }
    // 最后兜底：直接写目标文件，保证不丢数据
    fs.writeFileSync(file, content, 'utf8');
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const pad2 = (n) => String(n).padStart(2, '0');

export function localStamp(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}_${pad2(date.getHours())}${pad2(date.getMinutes())}`;
}

export function fmtLocal(iso, withSeconds = false) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}${withSeconds ? `:${pad2(d.getSeconds())}` : ''}`;
  return `${date} ${time}`;
}

export function fmtClock(date = new Date()) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function fmtDuration(ms) {
  if (!ms || ms < 0) return '0 秒';
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return s ? `${m} 分 ${s} 秒` : `${m} 分钟`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

export function safeFilePart(value, fallback = 'task') {
  const cleaned = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return cleaned || fallback;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value)));
}

export function truncate(value, max = 400) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function renderPrompt(template) {
  const now = new Date();
  const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  return String(template || '')
    .replaceAll('{date}', `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`)
    .replaceAll('{weekday}', weekdays[now.getDay()])
    .replaceAll('{time}', fmtClock(now));
}

// 模型有时会把整篇 Markdown 包在 ```markdown 里；拆掉外壳，正文按 Markdown 使用。
export function stripOuterFence(text) {
  let value = String(text || '').trim();
  const fenced = value.match(/^```(?:markdown|md|text)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
  if (fenced) value = fenced[1].trim();
  return value;
}

// 固定并发地跑一批异步任务，顺序启动、失败由 worker 自己处理。
// 借鉴 sindresorhus/p-limit（MIT）的队列思路，这里只需要 map，内联实现避免新增依赖。
export async function mapLimit(items, limit, worker) {
  const list = Array.from(items || []);
  if (!list.length) return;
  const size = Math.max(1, Math.min(Number(limit) || 1, list.length));
  let cursor = 0;
  const runners = Array.from({ length: size }, async () => {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      await worker(list[index], index);
    }
  });
  await Promise.all(runners);
}
