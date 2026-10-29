import fs from 'node:fs';
import path from 'node:path';

export function createAgentApi({ store, engine, dataDir, appVersion, getBaseUrl }) {
  const START_TIME = Date.now();

  const tools = [
    {
      name: 'aiflow.status',
      description: '获取 AI Flow 系统状态：当前任务执行情况、浏览器状态、AI 平台登录就绪状态、存储路径与版本号。',
      risk: 'read',
      input_schema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      handler: async () => {
        return {
          app: 'ai-flow',
          version: appVersion,
          busy: engine.isBusy(),
          currentRun: engine.currentPublic(),
          browser: engine.browser.info(),
          loginReady: store.state.platforms.some((p) => p.enabled && p.login === 'logged_in'),
          tasksCount: store.state.tasks.length,
          platformsCount: store.state.platforms.filter((p) => !p.hidden).length,
          paths: store.paths(),
          dataDir,
          uptime_ms: Date.now() - START_TIME
        };
      }
    },
    {
      name: 'aiflow.list_platforms',
      description: '列出所有支持的 AI 平台（ChatGPT、Gemini、Grok、通义千问、Muse、manus 等）及当前登录态。',
      risk: 'read',
      input_schema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      handler: async () => {
        const platforms = store.state.platforms
          .filter((p) => !p.hidden)
          .map((p) => ({
            id: p.id,
            name: p.name,
            adapterId: p.adapterId,
            url: p.url,
            builtin: Boolean(p.builtin),
            enabled: Boolean(p.enabled),
            login: p.login,
            loginError: p.loginError,
            lastCheckAt: p.lastCheckAt
          }));
        return { platforms, count: platforms.length };
      }
    },
    {
      name: 'aiflow.platform_check',
      description: '探测指定 AI 平台的登录态或获取其当前网页地址。',
      risk: 'read',
      input_schema: {
        type: 'object',
        properties: {
          platformId: { type: 'string', description: '平台ID，如 chatgpt, gemini, qwen, grok 等' }
        },
        required: ['platformId'],
        additionalProperties: false
      },
      handler: async (input) => {
        const platform = store.findPlatform(input.platformId);
        if (!platform) throw new AgentError('not_found', `平台不存在：${input.platformId}`);
        if (engine.isBusy()) throw new AgentError('busy', '当前正在执行采集任务，请稍后再试。');
        await engine.checkPlatform(platform.id);
        const refreshed = store.findPlatform(input.platformId);
        return {
          platformId: refreshed.id,
          name: refreshed.name,
          login: refreshed.login,
          loginError: refreshed.loginError,
          lastCheckAt: refreshed.lastCheckAt
        };
      }
    },
    {
      name: 'aiflow.list_tasks',
      description: '列出所有已配置的采集任务，包含模式（提示词采集/定时读取）、关联平台或来源、计划时间与启用状态。',
      risk: 'read',
      input_schema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      handler: async () => {
        return {
          tasks: store.state.tasks.map((t) => ({
            id: t.id,
            name: t.name,
            mode: t.mode,
            prompt: t.prompt,
            platformIds: t.platformIds || [],
            sources: t.sources || [],
            schedule: t.schedule,
            enabled: t.enabled,
            lastRunAt: t.lastRunAt,
            lastStatus: t.lastStatus
          })),
          count: store.state.tasks.length
        };
      }
    },
    {
      name: 'aiflow.create_task',
      description: '创建新的多 AI 采集或汇总任务。prompt 模式发送提示词并收集回答；scheduled 模式定时访问指定对话链接并提取最新回答。',
      risk: 'write',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '任务名称' },
          mode: { type: 'string', enum: ['prompt', 'scheduled'], description: '任务模式：prompt 发送提示词，scheduled 定时读取' },
          prompt: { type: 'string', description: '提示词（prompt 模式必填）' },
          platformIds: { type: 'array', items: { type: 'string' }, description: 'AI平台ID列表（prompt 模式使用）' },
          sources: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                platformId: { type: 'string' },
                url: { type: 'string' },
                keyword: { type: 'string' },
                firstRun: { type: 'string', enum: ['latest', 'all'] }
              },
              required: ['platformId']
            },
            description: '来源列表（scheduled 模式使用）'
          },
          summaryProfile: { type: 'string', description: '总结配置：hotspot (今日热点汇总) / ai (AI 早报) / valorant / custom' },
          schedule: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['manual', 'daily', 'weekly', 'interval'] },
              time: { type: 'string', description: '如 09:00 或 19:00' },
              weekday: { type: 'integer' },
              everyHours: { type: 'integer' }
            }
          },
          enabled: { type: 'boolean', description: '是否启用定时' }
        },
        required: ['name'],
        additionalProperties: false
      },
      handler: async (input) => {
        const mode = input.mode === 'scheduled' ? 'scheduled' : 'prompt';
        const name = String(input.name || '').trim().slice(0, 60);
        if (!name) throw new AgentError('bad_input', '请填写任务名称');
        const prompt = String(input.prompt || '').trim();
        if (mode === 'prompt' && !prompt) throw new AgentError('bad_input', 'prompt 模式必须填写提示词');
        const platformIds = Array.isArray(input.platformIds) ? input.platformIds : [];
        if (mode === 'prompt' && !platformIds.length) throw new AgentError('bad_input', '请至少选择一个 AI 平台');
        const sources = Array.isArray(input.sources) ? input.sources : [];
        if (mode === 'scheduled' && !sources.length) throw new AgentError('bad_input', 'scheduled 模式必须提供至少一个来源');

        const task = store.createTask({
          name,
          mode,
          prompt: prompt || '（定时采集模式不使用提示词）',
          platformIds,
          sources,
          summaryProfile: input.summaryProfile,
          schedule: input.schedule || { type: 'daily', time: '19:00', weekday: 1, everyHours: 6 },
          enabled: Boolean(input.enabled)
        });
        return { task };
      }
    },
    {
      name: 'aiflow.run_task',
      description: '启动执行指定的采集/汇总任务。会驱动自动化浏览器访问各 AI 平台，抓取回答并落盘文档。必须设置 confirm: true。',
      risk: 'exec',
      input_schema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '任务 ID' },
          confirm: { type: 'boolean', description: '必须为 true 以启动真实浏览器采集任务' }
        },
        required: ['taskId', 'confirm'],
        additionalProperties: false
      },
      handler: async (input) => {
        if (input.confirm !== true) {
          throw new AgentError('confirm_required', 'aiflow.run_task 会启动浏览器自动化采集，必须带 confirm: true');
        }
        const task = store.findTask(input.taskId);
        if (!task) throw new AgentError('not_found', `任务不存在：${input.taskId}`);
        if (engine.isBusy()) throw new AgentError('busy', '已经有一个采集任务在运行，请等待完成。');
        const promise = engine.runTask(task, 'manual');
        const runId = engine.current?.id;
        if (!runId) {
          try {
            await promise;
          } catch (e) {
            throw new AgentError('run_rejected', e.message || '任务未能启动');
          }
          throw new AgentError('run_not_started', '任务没有启动');
        }
        promise.catch(() => {});
        return {
          runId,
          taskId: task.id,
          taskName: task.name,
          mode: task.mode,
          message: '采集任务已在后台启动，可用 aiflow.get_run 轮询进度'
        };
      }
    },
    {
      name: 'aiflow.stop_waiting',
      description: '停止当前采集任务中正在进行的等待重试（跳过等待直接进入下一阶段或汇总）。',
      risk: 'write',
      input_schema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      handler: async () => {
        if (!engine.current) throw new AgentError('not_waiting', '当前没有正在运行或等待的任务。');
        const stopped = engine.stopWaiting();
        return { stopped };
      }
    },
    {
      name: 'aiflow.get_run',
      description: '查询一次运行记录的详细结果：包含各平台采集阶段、成功/失败状态、耗时、字数统计、回答摘要。',
      risk: 'read',
      input_schema: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: '运行记录 ID' }
        },
        required: ['runId'],
        additionalProperties: false
      },
      handler: async (input) => {
        const run = store.loadRun(input.runId);
        if (!run) throw new AgentError('not_found', `没有找到运行记录：${input.runId}`);
        const finalFile = store.finalPathFor(run);
        let bundleSnippet = null;
        let bundleSize = 0;
        try {
          if (fs.existsSync(finalFile)) {
            const stat = fs.statSync(finalFile);
            bundleSize = stat.size;
            bundleSnippet = fs.readFileSync(finalFile, 'utf8').slice(0, 3000);
          }
        } catch {
          // ignore
        }
        return {
          runId: run.id,
          taskId: run.taskId,
          taskName: run.taskName,
          status: run.status,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          durationSec: run.durationSec,
          sources: (run.sources || []).map((s) => ({
            platformId: s.platformId,
            platformName: s.platformName,
            status: s.status,
            chars: s.chars,
            error: s.error
          })),
          bundleSize,
          bundleSnippet
        };
      }
    },
    {
      name: 'aiflow.list_runs',
      description: '列出历史运行记录列表，按时间倒序。',
      risk: 'read',
      input_schema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '最多条数，默认 20，上限 100' }
        },
        additionalProperties: false
      },
      handler: async (input) => {
        const limit = Math.min(100, Math.max(1, Number(input?.limit) || 20));
        const runs = (store.state.runs || []).slice(0, limit).map((r) => ({
          id: r.id,
          taskId: r.taskId,
          taskName: r.taskName,
          mode: r.mode,
          status: r.status,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
          durationSec: r.durationSec,
          successCount: (r.sources || []).filter((s) => s.status === 'ok').length,
          totalSources: (r.sources || []).length
        }));
        return { runs, count: runs.length };
      }
    },
    {
      name: 'aiflow.get_digest',
      description: '读取最新生成的「今日汇总.md」或指定运行记录的 Markdown 汇总文本全文。',
      risk: 'read',
      input_schema: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: '运行记录 ID；不传则返回桌面/输出目录里的最新汇总' }
        },
        additionalProperties: false
      },
      handler: async (input) => {
        if (input.runId) {
          const run = store.loadRun(input.runId);
          if (!run) throw new AgentError('not_found', `没有找到运行记录：${input.runId}`);
          const file = store.finalPathFor(run);
          if (!fs.existsSync(file)) throw new AgentError('not_found', '汇总文件不存在');
          const content = fs.readFileSync(file, 'utf8');
          return { runId: run.id, path: file, bytes: Buffer.byteLength(content), content };
        }
        const latest = store.latestBundle();
        if (!latest) throw new AgentError('not_found', '还没有生成过汇总文档');
        return {
          runId: latest.run?.id,
          path: latest.file,
          bytes: Buffer.byteLength(latest.text),
          content: latest.text
        };
      }
    },
    {
      name: 'aiflow.list_outputs',
      description: '列出 AI Flow 生成的全部数据产物路径（今日汇总.md、各次运行 Markdown、回答集.xlsx/.csv/.jsonl 数据集）。',
      risk: 'read',
      input_schema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '限制数量，默认 50' }
        },
        additionalProperties: false
      },
      handler: async (input) => {
        const limit = Math.min(200, Math.max(1, Number(input?.limit) || 50));
        const desktopDigest = path.join(store.desktopDir(), '今日汇总.md');
        const outputDir = store.outputDir();
        const outputs = [];
        if (fs.existsSync(desktopDigest)) {
          const st = fs.statSync(desktopDigest);
          outputs.push({
            name: '今日汇总.md',
            type: 'desktop_digest',
            path: desktopDigest,
            size: st.size,
            mtime: st.mtime.toISOString()
          });
        }
        if (fs.existsSync(outputDir)) {
          const entries = fs.readdirSync(outputDir, { withFileTypes: true });
          for (const ent of entries) {
            if (outputs.length >= limit) break;
            const full = path.join(outputDir, ent.name);
            const st = fs.statSync(full);
            outputs.push({
              name: ent.name,
              type: ent.isDirectory() ? 'dataset_dir' : 'file',
              path: full,
              size: ent.isDirectory() ? 0 : st.size,
              mtime: st.mtime.toISOString()
            });
          }
        }
        return { count: outputs.length, outputDir, outputs };
      }
    },
    {
      name: 'aiflow.get_settings',
      description: '读取 AI Flow 的全局配置（浏览器引擎、并发读取数、最大等待时间、输出目录、AI 总结配置等）。',
      risk: 'read',
      input_schema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      handler: async () => {
        return { settings: store.state.settings };
      }
    },
    {
      name: 'aiflow.update_settings',
      description: '更新 AI Flow 的全局配置（例如调整并发数 1-4、超时等待秒数、是否开启桌面总文档、输出目录等）。',
      risk: 'write',
      input_schema: {
        type: 'object',
        properties: {
          concurrency: { type: 'integer', description: '并发读取数（1-4）' },
          browser: { type: 'string', enum: ['edge', 'chrome'] },
          autoSummarize: { type: 'boolean', description: '是否在采集后自动调用 AI 进行总结' },
          desktopDigest: { type: 'boolean', description: '是否在桌面生成「今日汇总.md」' },
          outputDir: { type: 'string', description: '输出目录绝对路径' },
          maxWaitSec: { type: 'integer', description: '单次采集最大等待秒数' },
          visible: { type: 'boolean', description: '采集时是否显示自动化浏览器窗口' }
        },
        additionalProperties: false
      },
      handler: async (input) => {
        const s = store.state.settings;
        if (Number.isFinite(Number(input.concurrency))) s.concurrency = Math.min(4, Math.max(1, Number(input.concurrency)));
        if (input.browser === 'edge' || input.browser === 'chrome') s.browser = input.browser;
        if (typeof input.autoSummarize === 'boolean') s.autoSummarize = input.autoSummarize;
        if (typeof input.desktopDigest === 'boolean') s.desktopDigest = input.desktopDigest;
        if (typeof input.visible === 'boolean') s.visible = input.visible;
        if (Number.isFinite(Number(input.maxWaitSec))) s.maxWaitSec = Math.min(900, Math.max(60, Number(input.maxWaitSec)));
        if (typeof input.outputDir === 'string' && input.outputDir.trim()) {
          s.outputDir = path.resolve(input.outputDir.trim());
        }
        store.save();
        return { settings: s };
      }
    }
  ];

  class AgentError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  async function handleAgentRequest(request, response, url, readBody, sendJson) {
    const method = request.method || 'GET';
    const parts = url.pathname.split('/').filter(Boolean);
    const sub = parts[2]; // /api/agent/<sub...>

    if (method === 'GET' && (sub === 'tools' || sub === 'manifest')) {
      const toolSummaries = tools.map((t) => ({
        name: t.name,
        description: t.description,
        risk: t.risk,
        input_schema: t.input_schema
      }));
      if (sub === 'tools') {
        return sendJson(response, 200, { ok: true, data: toolSummaries });
      }
      return sendJson(response, 200, {
        ok: true,
        data: {
          project: 'aiflow',
          version: appVersion,
          base_url: getBaseUrl(),
          tools: toolSummaries
        }
      });
    }

    if (method === 'POST' && sub === 'tool') {
      const body = await readBody(request);
      const toolName = String(body.tool || '').trim();
      const input = body.input && typeof body.input === 'object' ? body.input : {};
      const targetTool = tools.find((t) => t.name === toolName);

      if (!targetTool) {
        return sendJson(response, 400, {
          ok: false,
          error: {
            code: 'unknown_tool',
            message: `未知的工具名称：${toolName}`,
            available: tools.map((t) => t.name)
          }
        });
      }

      const t0 = Date.now();
      try {
        const data = await targetTool.handler(input);
        const ms = Date.now() - t0;
        return sendJson(response, 200, {
          ok: true,
          tool: toolName,
          ms,
          data
        });
      } catch (err) {
        const ms = Date.now() - t0;
        const code = err.code || 'internal_error';
        const status = code === 'bad_input' || code === 'not_found' || code === 'confirm_required' ? 400 : 500;
        return sendJson(response, status, {
          ok: false,
          tool: toolName,
          ms,
          error: {
            code,
            message: err.message || String(err)
          }
        });
      }
    }

    return sendJson(response, 404, { ok: false, error: { code: 'not_found', message: '未找到该 Agent 接口' } });
  }

  return {
    tools,
    handleAgentRequest,
    AgentError
  };
}
