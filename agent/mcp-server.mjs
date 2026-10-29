#!/usr/bin/env node
// AI Flow MCP (Model Context Protocol) stdio 桥
// 统一标准：把 AI Flow 的全部能力暴露为标准 MCP tools。
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PROTOCOL = '2025-06-18';
const PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const SERVER_INFO = { name: 'ai-flow-agent-api', version: '1.9.0' };

function endpointFile() {
  const p = path.join(__dirname, '.endpoint');
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
}

async function rpc(base, method, params) {
  const headers = { 'content-type': 'application/json' };
  const res = await fetch(`${base}/api/agent/${method === 'tools/list' ? 'tools' : 'tool'}`, {
    method: method === 'tools/list' ? 'GET' : 'POST',
    headers,
    body: method === 'tools/list' ? undefined : JSON.stringify(params),
    // 采集任务会驱动浏览器跑很久，桥不能比服务端先放弃
    signal: AbortSignal.timeout(method === 'tools/list' ? 60_000 : 1_800_000)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    throw new Error(body?.error?.message || `HTTP ${res.status}`);
  }
  return body;
}

async function ensureBase() {
  const candidates = [
    process.env.AGENT_BASE_URL,
    process.env.AI_FLOW_BASE_URL,
    endpointFile(),
    process.env.AGENT_DEFAULT_BASE,
    'http://127.0.0.1:4321'
  ].filter(Boolean);

  for (const base of candidates) {
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) {
        const data = await r.json().catch(() => null);
        if (data?.app === 'ai-flow' || data?.data?.project === 'aiflow') {
          return base;
        }
      }
    } catch {
      // 继续探测
    }
  }

  // 自动拉起
  const launchFile = path.join(__dirname, 'launch.json');
  if (!existsSync(launchFile)) {
    throw new Error(`AI Flow 服务未启动且缺少 ${launchFile}，请先启动 AI Flow`);
  }
  const spec = JSON.parse(readFileSync(launchFile, 'utf8'));
  const child = spawn(spec.command, spec.args, {
    cwd: PROJECT_ROOT,
    stdio: 'ignore',
    detached: true,
    shell: false
  });
  child.unref();

  const port = spec.ready_port || 4321;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
      if (r.ok) {
        const data = await r.json().catch(() => null);
        if (data?.app === 'ai-flow' || data?.data?.project === 'aiflow') return `http://127.0.0.1:${port}`;
      }
    } catch {
      // 继续等待
    }
  }
  throw new Error('自动拉起 AI Flow 本地服务超时（30s）');
}

let BASE = null;

function msg(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function err(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize') {
    const asked = String(params?.protocolVersion || '').trim();
    return msg(id, {
      protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO
    });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return null;
  if (method === 'ping') return msg(id, {});
  if (method === 'tools/list') {
    BASE = BASE || (await ensureBase());
    const body = await rpc(BASE, 'tools/list');
    return msg(id, {
      tools: body.data.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.input_schema,
        annotations: {
          readOnlyHint: t.risk === 'read',
          destructiveHint: t.risk === 'write' && t.name.includes('delete'),
          openWorldHint: false
        }
      }))
    });
  }
  if (method === 'tools/call') {
    BASE = BASE || (await ensureBase());
    try {
      const body = await rpc(BASE, 'tools/call', {
        tool: params.name,
        input: params.arguments || {}
      });
      return msg(id, {
        content: [{ type: 'text', text: JSON.stringify(body.data, null, 2) }],
        isError: false
      });
    } catch (e) {
      return msg(id, {
        content: [{ type: 'text', text: `调用失败：${e.message}` }],
        isError: true
      });
    }
  }
  return err(id, -32601, `不支持的方法：${method}`);
}

let buf = '';

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const req = JSON.parse(trimmed);
      handle(req)
        .then((res) => {
          if (res) write(res);
        })
        .catch((e) => {
          if (req.id != null) write(err(req.id, -32603, e.message || String(e)));
        });
    } catch (e) {
      write(err(null, -32700, `无法解析的 JSON-RPC 请求：${e.message}`));
    }
  }
});
