# AI Flow Agent API & MCP 服务

将 AI Flow 的完整多 AI 采集、任务调度、多平台登录检测与热点汇总能力暴露为统一的 Agent API 与 MCP (Model Context Protocol) 工具，供任何智能体（Antigravity、Claude Code、Cursor、Codex 等）直接调用。

服务默认监听 `127.0.0.1:4321`，与桌面软件完全共用同一个内核与状态表。

## 启动方式

```bash
# 启动本地服务（无头模式）
node app/src/server.mjs --no-open

# 启动 MCP stdio 桥（未启动服务时会自动拉起）
node agent/mcp-server.mjs
```

## HTTP 契约

```
GET  /api/health          -> { ok: true, app: 'ai-flow', data: { project, version, agent_api: 1, tools, ... } }
GET  /api/agent/tools     -> { ok: true, data: [ { name, description, risk, input_schema } ] }
GET  /api/agent/manifest  -> { ok: true, data: { project, version, base_url, tools } }
POST /api/agent/tool      -> body { tool, input } -> { ok: true, tool, ms, data }
```

## 工具清单（前缀 `aiflow.`）

| 工具 | 风险 | 说明 |
|---|---|---|
| `aiflow.status` | read | 获取系统状态、当前运行任务、浏览器与平台登录状态、数据路径与版本 |
| `aiflow.list_platforms` | read | 列出所有支持的 AI 平台（ChatGPT, Gemini, Grok, 通义千问, manus 等）及其登录态 |
| `aiflow.platform_check` | read | 探测指定 AI 平台的登录态 |
| `aiflow.list_tasks` | read | 列出所有已配置的采集任务、模式、时间表与启用状态 |
| `aiflow.create_task` | write | 创建新的采集/汇总任务（支持 prompt 模式与 scheduled 模式） |
| `aiflow.run_task` | **exec** | 启动执行指定的采集任务，驱动真实自动化浏览器；**必须 `confirm: true`** |
| `aiflow.stop_waiting` | write | 停止当前任务的轮询等待，直接进入下一步 |
| `aiflow.get_run` | read | 查询指定运行记录的详细结果、各阶段状态、字数统计与回答摘要 |
| `aiflow.list_runs` | read | 列出历史运行记录列表 |
| `aiflow.get_digest` | read | 读取最新「今日汇总.md」或指定运行记录的 Markdown 汇总文本全文 |
| `aiflow.list_outputs` | read | 列出所有生成的数据产物路径（今日汇总.md、回答集 xlsx/csv/jsonl 等） |
| `aiflow.get_settings` | read | 读取全局配置（浏览器引擎、并发读取数、超时时限、输出目录等） |
| `aiflow.update_settings` | write | 更新全局配置 |

## MCP 配置示例

```json
{
  "mcpServers": {
    "ai-flow": {
      "command": "node",
      "args": ["C:/path/to/AI-Flow/agent/mcp-server.mjs"]
    }
  }
}
```

## 统一入口（一个 MCP / 一个 HTTP API）

五个软件（AI Flow、FrameBoost、Agent 对话管理、清影下载器、声析）可以由
`agent-bus` 一个入口统一调用：本项目的 `aiflow.*` 工具原样暴露，
服务没起时会自动拉起。见 `agent-bus/README.md`。本项目自己的 `agent/mcp-server.mjs` 仍可单独使用。
