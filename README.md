# 🤖 AI Flow · 本地多 AI 定时协同与汇总工作台

<p align="center">
  <b>0 成本免 API 费用！复用本机已登录的网页版大模型，打造自动化工作流与日报神器</b><br>
  一键免 Key 调度 ChatGPT / Claude / Gemini / DeepSeek 网页端 · 全自动多模型交叉对比 · 定时生成热点与日报
</p>

<p align="center">
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License" />
  <img src="https://img.shields.io/badge/Platform-Windows%2010%2F11-0078D6?logo=windows&logoColor=white" alt="Platform" />
  <img src="https://img.shields.io/badge/API%20Cost-￥0%20(无需购买Key)-brightgreen" alt="Zero Cost" />
  <img src="https://img.shields.io/badge/Browser-复用本地Edge%2FChrome-0078D7?logo=microsoftedge&logoColor=white" alt="Browser" />
  <img src="https://img.shields.io/badge/100%25-本地隔离隐私-success" alt="Privacy" />
  <img src="https://img.shields.io/badge/AI%20Agent-MCP%20Ready-orange.svg" alt="MCP" />
</p>

<p align="center">
  <a href="https://github.com/zhangtt08/ai-flow/releases/latest"><b>🚀 [点击立即下载 Windows 绿色开箱即用版]</b></a>
</p>

---

## ⚡ 为什么开发 AI Flow？

如今市面上的 AI 工作流工具，几乎无一例外都要求你**提供官方 API Key**：
- 官方 API 价格昂贵，按 Token 计费，多模型对比一次几块钱就没了；
- 购买和充值 API 门槛极高，动辄封号或限制国内网络；
- 但事实上，你的电脑浏览器里明明**已经登录了** ChatGPT、Claude、Gemini、DeepSeek 的网页端！

**AI Flow 的创新构想：为什么不直接利用本机已登录的网页端大模型？**  
AI Flow 让你彻底告别 API 账单！它会在本地隔离的环境中，全自动、按时向你登录的多个大模型派发任务、抓取答案、对比结论，并汇总成精美的行业报告与 Markdown / Excel 文件！

---

## 🎯 核心使用场景

1. 📰 **每日早报与行业热点自动追踪**：每天早上 8:00，自动让 DeepSeek 检索最新 AI 资讯，交由 Claude 润色成日报，准时发送到你的桌面。
2. ⚖️ **多大模型交叉对比（防幻觉）**：遇到重大技术方案或决策难题，一键同时提问 ChatGPT、Claude 和 DeepSeek，多方观点一目了然。
3. 🔄 **无人值守自动化流水线**：定义周期性循环任务（如每 2 小时监控特定主题），无需人工一直盯盘刷新。

---

## ✨ 核心特性

- 💰 **真正的零 API 成本**：完全基于本机 Chrome / Edge 的登录态自动化调度，不花一分钱 Token 费。
- 🌐 **广泛兼容主流大模型**：已原生适配 ChatGPT、Claude、Gemini、DeepSeek、Perplexity、Kimi、通义千问、豆包 等，并支持添加自定义站点。
- ⏰ **灵活强大的定时调度器**：支持固定时间间隔（如每 30 分钟）或每天定时定点触发；支持断点续跑与失败自动重试。
- 📊 **丰富的结构化导出**：自动生成带溯源标签的 Markdown 早报、Excel（xlsx）、CSV 与 JSONL，便于二次分析。
- 🔒 **严格的本地隐私沙箱**：所有登录凭证和对话数据仅保存在本机程序目录中，绝不上传任何云端服务器。
- 🤖 **开发者友好（REST API + MCP）**：提供本地标准 HTTP 接口与 MCP 服务，Cursor 或 Claude Code 可直接调用 AI Flow 执行后台流水线。

---

## 📥 3 步快速上手

### 步骤 1：下载解压
前往 **[Releases 页面](https://github.com/zhangtt08/ai-flow/releases/latest)** 下载最新的 `AI-Flow-Windows-x64.zip`，解压到任意文件夹。

### 步骤 2：登录你的 AI 账号
双击运行 `AI Flow Launcher.cmd`（或 `AI Flow.exe`）。首次使用时，在「AI 平台」页面点击「打开登录」，在弹出的独立浏览器窗口中正常登录你的 ChatGPT / Claude / DeepSeek 账号（只需登录一次，凭证永久保存在本地独立目录）。

### 步骤 3：创建你的第一个定时任务
在工作台中点击「新建任务」，填入你想询问的 Prompt（例如：*“总结过去 24 小时全球最重要的 3 条 AI 开源项目进展”*），勾选执行的大模型平台并设置时间，点击保存即可！到点工作台会自动唤起并生成聚合日报！

---

## 🤖 开发者与 AI Agent 接口 (MCP)

AI Flow 原生提供开箱即用的 MCP 标准工具，供 Claude Code、Cursor 等直接编排调用：

```bash
# 启动面向 Agent 的本地服务（默认端口 4321）
node app/src/server.mjs --no-open

# 启动 MCP stdio 桥接
node agent/mcp-server.mjs
```

---

## ⭐ 支持与致谢

如果 AI Flow 帮你省下了宝贵的 API 费用并提升了日常信息获取效率，请给本项目点一个 **Star ⭐** 鼓励一下作者吧！

## 📄 开源许可证
本项目基于 [MIT License](LICENSE) 协议开源。
