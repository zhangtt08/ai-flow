# AI Flow · 多 AI 定时汇总工作台

把本机已登录的多个 AI 网页变成一条定时流水线：按计划逐家提问、收集回答，合并成一份当日汇总（Markdown / Excel / CSV / JSONL），也可以再交给指定的 AI 生成「今日热点」类报告。全程本地运行，登录态只保存在本机独立浏览器配置里。

- 桌面端：Tauri 2 + WebView2，单窗口，双击即用
- 支持的平台：ChatGPT、Gemini、Claude、Perplexity、Grok、Muse、DeepSeek、Kimi、豆包、通义千问，以及自定义站点
- 定时任务：固定间隔或每日时刻，支持断点续跑、失败重试与「无新回答」判定
- 汇总产物：今日汇总.md、回答集 xlsx / csv / jsonl，来源逐条标注
- Agent 接口：本机 HTTP API + 标准 MCP（13 个 `aiflow.*` 工具），供 Codex / Claude Code / Cursor 等直接调用

## 下载与使用（普通用户）

到 [Releases](https://github.com/zhangtt08/ai-flow/releases) 下载最新的 `AI-Flow-<版本>-Windows-x64.zip`，解压后：

1. 双击 `AI Flow Launcher.cmd`（或直接双击 `AI Flow.exe`）。首次启动会自动打开工作台窗口。
2. 在「AI 平台」页点「打开登录」，用本机 Edge / Chrome 登录一次各家 AI 账号。
3. 新建任务，选择平台与时间表；到点后工作台会依次采集并生成汇总。

系统要求：Windows 10/11 x64，需要 Microsoft Edge WebView2 Runtime（Win11 自带；Win10 如缺失请先安装）。采集依赖本机已安装的 Edge 或 Chrome。

数据都在程序目录的 `app/data`（可用环境变量 `AI_FLOW_DATA_DIR` 指向别处）：任务、运行记录、汇总产物与独立的浏览器登录配置。**不上传任何账号或采集内容。**

## 从源码运行

```bash
cd app
npm install          # 只有一个运行时依赖 playwright-core
npm start            # http://127.0.0.1:4321
```

需要 Node.js 20+。源码模式使用本机 Edge / Chrome，不会安装或修改你日常浏览器的配置。

## Agent API 与 MCP

```bash
# 无头启动本地服务（默认 127.0.0.1:4321）
node app/src/server.mjs --no-open

# 启动 MCP stdio 桥（服务未起时会自动拉起）
node agent/mcp-server.mjs
```

- `GET /api/health`、`GET /api/agent/tools`、`GET /api/agent/manifest`、`POST /api/agent/tool`
- 工具清单与调用示例见 [agent/README.md](agent/README.md)
- 执行类工具（如 `aiflow.run_task`）必须显式传 `confirm: true`

## 目录

```
app/            桌面端与服务端源码（src / public / test）
agent/          Agent API 文档与 MCP stdio 桥
node/           随包 Node 运行时（仅发布包，不入库）
AI Flow.exe     桌面程序（仅发布包，不入库）
```

## 第三方说明

参考与依赖说明见 [app/NOTICE.md](app/NOTICE.md)。

## 版本

当前源码版本：1.10.2
