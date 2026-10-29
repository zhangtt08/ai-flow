# 第三方开源项目借鉴说明

AI Flow 的代码由本项目维护；升级过程中参考了下面这些开源项目的思路或实现方式。
没有直接把它们的源码复制进程序（除运行时依赖 playwright-core 外，不新增任何 npm 依赖）。

| 项目 | 许可证 | 借鉴内容 |
| --- | --- | --- |
| [sindresorhus/p-limit](https://github.com/sindresorhus/p-limit) | MIT | 固定并发队列的实现思路；`app/src/util.mjs` 的 `mapLimit` 是内联精简版（约 15 行），没有引入 yocto-queue 依赖。 |
| [Alionkissadeer/ai-daily-news](https://github.com/Alionkissadeer/ai-daily-news) | MIT | 多来源每日汇总的产品思路：按来源合并、保留最新成功内容、来源标注。落点在 `app/src/bundle.mjs` 的 `mergeDigestRuns` 与 `buildDailyDigest`。 |
| [DIYgod/RSSHub](https://github.com/DIYgod/RSSHub) | MIT | 用公开 RSS 路由补充热点源的方案（评估中，1.7 未内置）。 |
| [microsoft/playwright](https://github.com/microsoft/playwright) | Apache-2.0 | 运行时依赖 `playwright-core`，用于驱动本机 Edge/Chrome。 |

如果后续直接复制上述项目的代码片段，需要在该文件头部保留原版权声明与许可证文本。
