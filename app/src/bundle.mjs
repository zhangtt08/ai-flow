import { fmtDuration, fmtLocal, stripOuterFence, truncate } from './util.mjs';

export { stripOuterFence };

export const RESULT_LABELS = {
  pending: '排队中',
  running: '读取中',
  waiting: '等待新回答',
  ok: '成功',
  partial: '部分完成',
  'no-new': '无新回答',
  'no-answer': '未生成回答',
  login: '需要登录',
  timeout: '超时',
  error: '失败',
  skipped: '已跳过'
};

export const RUN_LABELS = {
  running: '运行中',
  done: '已完成',
  partial: '部分完成',
  empty: '无新内容',
  failed: '失败'
};

export function isGoodResult(result) {
  return result.status === 'ok' || result.status === 'partial';
}

export function isSoftResult(result) {
  return result.status === 'no-new' || result.status === 'no-answer';
}

export function computeRunStatus(results) {
  const attempted = (results || []).filter((result) => !['pending', 'skipped', 'waiting'].includes(result.status));
  if (!attempted.length) return 'empty';
  const good = attempted.filter(isGoodResult).length;
  if (good === attempted.length) return 'done';
  if (good > 0) return 'partial';
  if (attempted.every(isSoftResult)) return 'empty';
  return 'failed';
}

export function stripEmbeddedChartPixels(text) {
  return String(text || '').replace(
    /!\[([^\]]*)\]\((data:image\/[^)]+)\)/gi,
    (_match, alt) => `[图表${alt ? `：${alt}` : ''}，已保留在原始文件中]`
  );
}

function dayLabelOf(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 桌面「今日汇总」：把今天所有任务、所有来源的原文合并成一份，供手动交给 AI。
// 同一任务今天跑了多次时，每个来源保留最新一次成功的内容；最新的失败信息单独列出。
export function mergeDigestRuns(runs = []) {
  const sorted = [...runs].sort(
    (a, b) => new Date(b.finishedAt || b.startedAt) - new Date(a.finishedAt || a.startedAt)
  );
  const byTask = new Map();
  for (const full of sorted) {
    if (!full?.taskId) continue;
    let entry = byTask.get(full.taskId);
    if (!entry) {
      entry = {
        taskId: full.taskId,
        taskName: full.taskName,
        mode: full.mode,
        startedAt: full.startedAt,
        finishedAt: full.finishedAt,
        runCount: 0,
        results: [],
        seen: new Set(),
        newest: full
      };
      byTask.set(full.taskId, entry);
    }
    entry.runCount += 1;
    for (const result of full.results || []) {
      if (!isGoodResult(result)) continue;
      // 同一个平台可以有多个来源（例如两个 Grok 自动化任务），按“平台 + 链接 + 关键词”去重。
      const key = `${result.platformId}::${result.sourceUrl || ''}::${result.sourceKeyword || ''}`;
      if (entry.seen.has(key)) continue;
      entry.seen.add(key);
      entry.results.push({ ...result, capturedAt: full.finishedAt || full.startedAt });
    }
  }
  for (const entry of byTask.values()) {
    for (const result of entry.newest.results || []) {
      if (isGoodResult(result) || ['skipped', 'pending'].includes(result.status)) continue;
      const key = `${result.platformId}::${result.sourceUrl || ''}::${result.sourceKeyword || ''}`;
      if (entry.seen.has(key)) continue; // 今天已经有成功内容，不重复报错
      entry.results.push({ ...result, capturedAt: entry.newest.finishedAt || entry.newest.startedAt });
    }
    delete entry.seen;
    delete entry.newest;
  }
  return [...byTask.values()];
}

function fmtTime(iso) {
  const text = fmtLocal(iso);
  return text === '—' ? '' : text.slice(11);
}

export function buildDailyDigest({ runs = [], now = new Date(), title = '今日热点汇总', instruction = '' } = {}) {
  const dayLabel = dayLabelOf(now);
  const sources = [];
  const failed = [];
  for (const run of runs) {
    for (const result of run.results || []) {
      if (isGoodResult(result)) sources.push({ run, result });
      else if (!['skipped', 'pending'].includes(result.status)) failed.push({ run, result });
    }
  }

  const lines = [];
  lines.push(`# ${title} · ${dayLabel}`);
  lines.push('');
  lines.push(
    `> 由 AI Flow 自动合并，**原文未经任何 AI 处理** · ${sources.length} 个来源 · ${runs.length} 个任务 · 更新于 ${fmtLocal(now.toISOString())}`
  );
  lines.push('> 每次运行后都会更新桌面上的这个文件；需要 AI 汇总时，把整份内容复制给 ChatGPT 即可。');
  lines.push('');
  lines.push('## 复制给 AI 的指令（连同全文一起复制）');
  lines.push('');
  lines.push(
    `> ${instruction || '下面是我今天从多个 AI 定时任务收集的原文。请去重合并，按主题整理成一份报告：每条写标题、发生了什么、时间、来源；原文没有的来源和数字不要编；开头先列今天最值得看的 3-5 条。全部用 Markdown 输出。'}`
  );
  lines.push('');
  lines.push('## 来源概览');
  lines.push('');
  for (const run of runs) {
    for (const result of run.results || []) {
      const label = RESULT_LABELS[result.status] || result.status;
      const detail = isGoodResult(result)
        ? `${result.chars || 0} 字${result.newCount ? ` · 新增 ${result.newCount} 条` : ''}${result.capturedAt ? ` · 抓取 ${fmtTime(result.capturedAt)}` : ''}`
        : truncate(result.error || '未采集到内容', 120);
      lines.push(`- ${label}｜${run.taskName}｜${result.name}${detail ? `｜${detail}` : ''}`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  const seen = new Set();
  for (const run of runs) {
    const good = (run.results || []).filter(isGoodResult);
    if (!good.length) continue;
    lines.push(`## 任务：${run.taskName}`);
    lines.push('');
    lines.push(`> ${run.mode === 'scheduled' ? '读取定时回答' : '提示词采集'} · ${fmtLocal(run.finishedAt || run.startedAt)} · ${good.length} 个来源${run.runCount > 1 ? ` · 合并今天 ${run.runCount} 次运行` : ''}`);
    lines.push('');
    good.forEach((result, index) => {
      const text = stripOuterFence(stripEmbeddedChartPixels(result.text || '')).trim();
      if (!text) return;
      const dedupeKey = normalizeKey(text);
      if (seen.has(dedupeKey)) {
        lines.push(`### ${index + 1}. ${result.name}（内容与前面重复，已略）`);
        lines.push('');
        return;
      }
      seen.add(dedupeKey);
      lines.push(`### ${index + 1}. ${result.name}${result.sourceKeyword ? ` · 「${result.sourceKeyword}」` : ''}${result.capturedAt ? ` · ${fmtTime(result.capturedAt)}` : ''}`);
      lines.push('');
      lines.push(text);
      if (result.url) {
        lines.push('');
        lines.push(`[打开这条对话](${result.url})`);
      }
      lines.push('');
    });
    lines.push('---');
    lines.push('');
  }

  if (failed.length) {
    lines.push('## 采集异常');
    lines.push('');
    for (const { run, result } of failed) {
      lines.push(`- ${run.taskName}｜${result.name}｜${RESULT_LABELS[result.status] || result.status}｜${truncate(result.error || '', 160)}`);
    }
    lines.push('');
  }

  lines.push(`<sub>由 AI Flow 于 ${fmtLocal(now.toISOString())} 合并 · 原文逐字保留，未经过模型</sub>`);
  lines.push('');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function normalizeKey(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
}

function collectChartImages(results) {
  const images = [];
  const seen = new Set();
  for (const result of results || []) {
    if (!isGoodResult(result)) continue;
    const matches = String(result.text || '').matchAll(/!\[([^\]]*)\]\((data:image\/[^)]+)\)/gi);
    for (const match of matches) {
      const src = match[2];
      if (src.length > 300_000 || seen.has(src)) continue;
      seen.add(src);
      images.push({ alt: match[1] || '图表', src, platform: result.name || result.platformId || 'AI' });
      if (images.length >= 6) return images;
    }
  }
  return images;
}

function sourceNote(result) {
  if (result.sourceKeyword) return `关键词「${result.sourceKeyword}」`;
  if (result.sourceUrl) return '指定对话链接';
  return '';
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function sourceTag(result) {
  if (result.sourceKeyword) return ` · 「${result.sourceKeyword}」`;
  const host = hostOf(result.sourceUrl || '');
  return host ? ` · ${host}` : '';
}

export function buildBundle(task, run, prompt = '', options = {}) {
  const results = run.results || [];
  const scheduled = run.mode === 'scheduled';
  const good = results.filter(isGoodResult).length;
  const lines = [];

  lines.push(`# ${task.name}`);
  lines.push('');
  lines.push(
    `> AI Flow ${scheduled ? '定时回答采集' : '提示词采集'} · ${fmtLocal(run.startedAt)} · ${good}/${results.length} 个来源有新内容 · 原文未经任何模型处理`
  );
  lines.push('');
  if (options.forSummary) {
    lines.push('以下是从多个 AI 收集的原始回答，供整理使用。');
  } else if (options.rawArchive) {
    lines.push('原始回答 · 供核对；最终汇总见同目录同名文件（文件名不带「_原始」的 .md）。');
  } else {
    lines.push('将全文复制给任意 AI，附一句「请去重、合并、提炼成一份简洁的日报」即可。');
  }
  lines.push('');
  lines.push('## 采集概览');
  lines.push('');
  for (const result of results) {
    const label = RESULT_LABELS[result.status] || result.status;
    const note = scheduled ? sourceNote(result) : '';
    const detail = isGoodResult(result)
      ? `${result.chars || 0} 字 · ${fmtDuration(result.durationMs)}${scheduled && result.newCount ? ` · 新增 ${result.newCount} 条` : ''}`
      : truncate(result.error || '未采集到内容', 180);
    lines.push(`- ${label}｜${result.name}${note ? `｜${note}` : ''}｜${detail}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  results.forEach((result, index) => {
    lines.push(`## ${index + 1}. ${result.name}${scheduled ? sourceTag(result) : ''}`);
    lines.push('');
    if (scheduled) {
      const meta = [];
      if (result.newCount) meta.push(`本次新增 ${result.newCount} 条回答`);
      if (result.totalCount) meta.push(`对话内共 ${result.totalCount} 条回答`);
      if (result.lastAnswerTime) meta.push(`最新回答时间 ${fmtLocal(result.lastAnswerTime)}`);
      if (meta.length) {
        lines.push(meta.join(' · '));
        lines.push('');
      }
    }
    if (isGoodResult(result)) {
      if (result.status === 'partial') {
        lines.push(`> 注意：${result.error || '回答可能没有生成完整'}`);
        lines.push('');
      }
      lines.push(options.forSummary ? stripEmbeddedChartPixels(result.text) : (result.text || '（空回答）'));
      if (result.url) {
        lines.push('');
        lines.push(`[打开这条对话](${result.url})`);
      }
    } else {
      lines.push(`> 未采集到内容。原因：${result.error || RESULT_LABELS[result.status] || '未知'}`);
      const link = result.url || result.sourceUrl;
      if (link) {
        lines.push('');
        lines.push(`[打开对话核对](${link})`);
      }
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  });

  if (!scheduled && prompt) {
    lines.push('## 附：本次发送给各 AI 的提示词');
    lines.push('');
    lines.push('```text');
    lines.push(prompt.trim());
    lines.push('```');
    lines.push('');
  }

  lines.push(`<sub>由 AI Flow 于 ${fmtLocal(run.finishedAt || new Date().toISOString())} 生成 · 所有回答均为原样保留</sub>`);
  lines.push('');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function buildSummaryDocument(task, run, rawFileName) {
  const results = run.results || [];
  const good = results.filter(isGoodResult).length;
  const summary = run.summary || {};
  const lines = [];
  lines.push(`> ${summary.profileName || 'AI 总结'} · 任务「${task.name}」`);
  lines.push(
    `> 由 ${summary.name || 'AI'} 于 ${fmtLocal(run.finishedAt || new Date().toISOString())} 总结 · 基于 ${good}/${results.length} 个来源`
  );
  if (rawFileName) lines.push(`> 原始回答：${rawFileName}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(String(summary.text || '').trim());
  lines.push('');
  const charts = collectChartImages(results);
  if (charts.length) {
    lines.push('## 图表附件');
    lines.push('> 以下图表来自原始回答，AI 汇总不改写图片本身；原始文字见同目录的原始文件。');
    lines.push('');
    for (const chart of charts) {
      lines.push(`**${chart.platform} · ${chart.alt}**`);
      lines.push('');
      lines.push(`![${chart.alt}](${chart.src})`);
      lines.push('');
    }
  }
  lines.push('---');
  lines.push('');
  lines.push(`<sub>最终汇总由 ${summary.name || 'AI'} 生成；原始回答原样保存在 ${rawFileName || '运行目录'}。</sub>`);
  lines.push('');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

export const SUMMARY_INSTRUCTION = `下面是我从多个 AI 分别获取的同一问题的回答汇总。请帮我：
1. 去掉重复、过时和互相矛盾的信息；
2. 按主题重新整合，保留关键数据、结论和来源链接；
3. 不要添加原文没有的事实；
4. 输出一份简洁的中文日报，开头给 3 条最重要的结论。

---
`;
