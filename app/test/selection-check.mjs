import assert from 'node:assert/strict';
import { selectReportAnswers, pickNewAnswers, pickReport, trimPreamble, isInterimReport, retryDelayMs, sameConversationEntry } from '../src/scheduled.mjs';

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`  ok  ${name}`); }

console.log('回答选取自检（用真实数据构造）');

check('Gemini：铺垫 + 报告 → 只保留报告', () => {
  const items = [
    { index: 0, text: '没问题，已为你全面更新并同步了配置：\n\n- 自动化调度任务更新：已更新 08:00 的三轮采集快照\n- 日常对话输出：后续保持 Markdown', time: null },
    { index: 1, text: '### 全球趋势雷达｜13:00 午间采集简报\n\n' + '正文内容 '.repeat(120), time: null },
    { index: 2, text: '## 第二部分\n\n' + '更多正文 '.repeat(150), time: null },
    { index: 3, text: '# 完整晚报\n\n' + '长正文段落 '.repeat(400), time: null }
  ];
  const picked = selectReportAnswers(items);
  assert.ok(picked.length >= 1);
  assert.ok(picked.every((item) => !item.text.startsWith('没问题')));
  assert.ok(picked.some((item) => item.text.includes('长正文段落')));
});

check('Muse：进度话 + 报告 → 丢掉进度话', () => {
  const items = [
    { index: 0, text: '18:30 最终快照已保存：当天共 1008 个去重事件，1830 轮采集 372 条记录。', time: null },
    { index: 1, text: '# 全球趋势雷达｜2026年10月24日\n\n## 全球互联网热点\n\n' + '- 条目内容 '.repeat(300), time: null }
  ];
  const picked = selectReportAnswers(items);
  assert.equal(picked.length, 1);
  assert.ok(picked[0].text.startsWith('# 全球趋势雷达'));
});

check('通义千问：只有过程说明 → 判为无可用正文', () => {
  const items = [
    { index: 0, text: '收到你的指令，我将开始执行相关任务。\n\n我来读取定时任务技能文件…', time: null }
  ];
  assert.equal(selectReportAnswers(items).length, 0);
});

check('manus：用户自己说的话 → 无可用正文', () => {
  const items = [{ index: 0, text: '你以后定时任务以MD格式发给我吧', time: null }];
  assert.equal(selectReportAnswers(items).length, 0);
});

check('被拆成两半的长报告 → 两段都保留', () => {
  const items = [
    { index: 0, text: '# 报告上半部分\n\n' + '上半 '.repeat(400), time: null },
    { index: 1, text: '## 报告下半部分\n\n' + '下半 '.repeat(400), time: null }
  ];
  assert.equal(selectReportAnswers(items).length, 2);
});

check('pickNewAnswers 仍按水印取新增', () => {
  const messages = [
    { index: 0, text: 'a', time: null },
    { index: 1, text: 'b', time: null }
  ];
  assert.equal(pickNewAnswers(null, messages, 'latest').items.length, 1);
  assert.equal(pickNewAnswers({ count: 1, lastHash: 'x' }, messages, 'latest').items.length, 1);
});

check('Muse：铺垫「晚报已生成，完整内容如下」被切掉', () => {
  const raw = '全球趋势雷达 2026-10-24 晚报已生成，完整内容如下：\n\n# 全球趋势雷达｜2026年10月24日\n\n' + '- 条目 '.repeat(300);
  const trimmed = trimPreamble(raw);
  assert.ok(trimmed.startsWith('# 全球趋势雷达'));
  assert.ok(!trimmed.includes('晚报已生成'));
});

check('没有标题的纯文本不被切', () => {
  const raw = '这是一段没有标题的纯文字报告，' + '内容 '.repeat(300);
  assert.equal(trimPreamble(raw), raw);
});

check('只采最终总结：13:00/18:30 监控简报不进正文', () => {
  const items = [
    { index: 0, text: '### 全球趋势雷达｜13:00 午间采集与异动监测简报\n\n' + '- 监控数据 '.repeat(400), time: null },
    { index: 1, text: '# 全球趋势雷达｜18:30 晚间采集与待分析事件简报\n\n' + '- 监控数据 '.repeat(600), time: null },
    { index: 2, text: '# 全球趋势雷达｜2026年10月24日\n\n## 全球互联网热点与趋势异动晚报\n\n' + '- 晚报正文 '.repeat(1500), time: null }
  ];
  assert.equal(isInterimReport(items[0].text), true);
  assert.equal(isInterimReport(items[1].text), true);
  assert.equal(isInterimReport(items[2].text), false);
  const picked = selectReportAnswers(items);
  assert.equal(picked.length, 1);
  assert.ok(picked[0].text.includes('2026年10月24日'));
  assert.ok(!picked[0].text.includes('13:00'));
  assert.ok(!picked[0].text.includes('18:30'));
});

check('任务本身只产出简报时，退回全部（不误判为空）', () => {
  const items = [
    { index: 0, text: '### 全球趋势雷达｜13:00 午间采集与异动监测简报\n\n' + '- 内容 '.repeat(400), time: null }
  ];
  assert.equal(selectReportAnswers(items).length, 1);
});

check('最终晚报被拆成两半 → 两段都保留', () => {
  const items = [
    { index: 0, text: '# 今日热点汇总\n\n' + '上半 '.repeat(600), time: null },
    { index: 1, text: '# 今日热点汇总（续）\n\n' + '下半 '.repeat(600), time: null }
  ];
  assert.equal(selectReportAnswers(items).length, 2);
});

check('对话里累积多天晚报 → 只取最新那一天', () => {
  const items = [
    { index: 0, text: '# 全球趋势雷达｜2026年10月23日\n\n' + '- 旧晚报 '.repeat(500), time: null },
    { index: 1, text: '# 全球趋势雷达｜2026年10月24日\n\n' + '- 旧晚报 '.repeat(500), time: null },
    { index: 2, text: '# 全球趋势雷达｜2026年10月25日\n\n' + '- 今天晚报 '.repeat(500), time: null }
  ];
  const picked = selectReportAnswers(items);
  assert.equal(picked.length, 1);
  assert.ok(picked[0].text.includes('2026年10月25日'));
  assert.ok(!picked[0].text.includes('10月23日'));
  assert.ok(!picked[0].text.includes('10月24日'));
});

check('同一天被拆成上下两篇 → 都保留', () => {
  const items = [
    { index: 0, text: '# 全球趋势雷达｜2026年10月25日（上）\n\n' + '上半 '.repeat(600), time: null },
    { index: 1, text: '# 全球趋势雷达｜2026年10月25日（下）\n\n' + '下半 '.repeat(600), time: null }
  ];
  assert.equal(selectReportAnswers(items).length, 2);
});

check('快照在最后一条时，仍然取晚报而不是快照', () => {
  // ChatGPT 的真实顺序：… 晚报(第4条) … 次日 08:00 快照(最后一条)
  const messages = [
    { index: 0, text: '已调整完成，3个采集任务更新成功。', time: null },
    { index: 1, text: '**全球趋势雷达｜10月24日13:00午间采集完成**\n\n' + '- 记录 '.repeat(200), time: null },
    { index: 2, text: '**全球趋势雷达｜10月24日18:30晚间采集完成**\n\n' + '- 记录 '.repeat(200), time: null },
    { index: 3, text: '# 全球趋势雷达｜2026年10月24日\n\n**全球互联网热点与趋势异动晚报**\n\n' + '- 晚报正文 '.repeat(800), time: null },
    { index: 4, text: '**全球趋势雷达｜2026年10月25日08:00早间采集完成**\n\n本轮于北京时间 08:01 完成采集，共保存 362 条。', time: null }
  ];
  const decision = pickReport({ watermark: null, messages });
  assert.equal(decision.items.length, 1);
  assert.ok(decision.items[0].text.includes('晚报'));
  assert.ok(!decision.items[0].text.includes('08:00早间采集'));
  assert.equal(decision.reason, 'first-report');
});

check('同一份报告第二次运行不重复采集', () => {
  const messages = [
    { index: 0, text: '# 全球趋势雷达｜2026年10月24日\n\n' + '- 晚报正文 '.repeat(800), time: null }
  ];
  const first = pickReport({ watermark: null, messages });
  const second = pickReport({ watermark: { reportHash: first.reportHash }, messages });
  assert.equal(second.items.length, 0);
  assert.equal(second.reason, 'same-report');
});

check('手动重跑同一份报告照样返回正文（不能被当成“无新回答”）', () => {
  // 1.10 实测故障：手动跑过 4 次、每次都是 0/6，因为第一次成功后 reportHash 就把它挡住了。
  const messages = [
    { index: 0, text: '# 全球趋势雷达｜2026-10-27 晚报\n\n' + '- 晚报正文 '.repeat(800), time: null }
  ];
  const first = pickReport({ watermark: null, messages });
  assert.equal(first.items.length, 1);

  const manual = pickReport({ watermark: { reportHash: first.reportHash }, messages, acceptSame: true });
  assert.equal(manual.items.length, 1);
  assert.equal(manual.reason, 'report-unchanged');
  assert.match(manual.items[0].text, /晚报正文/);

  // 只读内容仍然按 reportHash 变更
  const changed = [...messages, { index: 1, text: '# 全球趋势雷达｜2026-10-28 晚报\n\n' + '- 新晚报 '.repeat(800), time: null }];
  assert.equal(pickReport({ watermark: { reportHash: first.reportHash }, messages: changed }).items.length, 1);
});

check('Muse 虚拟列表：晚报只在滚动后出现，也要能选出来', () => {
  // 真实场景：初次只挂载 5 条旧消息（最后一条是「记住了…」），晚报在下面没渲染。
  const firstPaint = [
    { index: 0, text: '现在先查一下已有的定时任务，避免重复创建，然后再建这 3 个。', time: null },
    { index: 1, text: '已创建并启用 3 个任务，今天不直接生成报告，首轮都是明天：' + '- 任务 '.repeat(40), time: null },
    { index: 2, text: '明白，我先把之前那几个趋势相关的旧任务删掉。', time: null },
    { index: 3, text: '删好了，复核过了。已删除 5 个旧任务。', time: null },
    { index: 4, text: '记住了，我刚逐一核查过，这 3 个都是这样设的。', time: null }
  ];
  assert.equal(pickReport({ watermark: null, messages: firstPaint }).items.length, 0);

  const afterScroll = [
    ...firstPaint,
    { index: 5, text: '# 全球趋势雷达｜2026-10-27 晚报\n\n' + '- 晚报正文 '.repeat(500), time: null }
  ];
  const decision = pickReport({ watermark: null, messages: afterScroll });
  assert.equal(decision.items.length, 1);
  assert.match(decision.items[0].text, /2026-10-27 晚报/);
});

check('新增了快照消息但没有新报告 → 仍判为无新报告', () => {
  const base = { index: 0, text: '# 全球趋势雷达｜2026年10月24日\n\n' + '- 晚报正文 '.repeat(800), time: null };
  const first = pickReport({ watermark: null, messages: [base] });
  const withSnapshot = [base, { index: 1, text: '**全球趋势雷达｜10月25日08:00早间采集完成**\n\n共 362 条。', time: null }];
  const second = pickReport({ watermark: { reportHash: first.reportHash }, messages: withSnapshot });
  assert.equal(second.items.length, 0);
});

check('晚报正文提到「快照」不算中途简报', () => {
  const evening = [
    '# 全球趋势雷达｜2026年10月24日',
    '',
    '**全球互联网热点与趋势异动晚报**',
    '',
    '> **实际数据截止：** 18:36:29 的持久化快照',
    '> **观察窗口：** 10月23日19:00—10月24日19:00',
    '',
    '## 数据完整性',
    '',
    '- 条目 '.repeat(300)
  ].join('\n');
  assert.equal(isInterimReport(evening), false);
});

check('任务创建确认（已成功创建/已删除）不算报告', () => {
  const confirms = [
    '已检查现有任务，未发现重复任务。3 个 VALORANT 定时任务均已成功创建并启用。',
    '删好了，复核过了。已删除 5 个旧任务：全球趋势雷达｜08:00 瓦社区采集',
    '任务已成功创建并启用，确认信息如下：任务名称 VALORANT全天完整晚报',
    '已成功创建并启用唯一的定时任务：VALORANT全球全天深度资讯',
    '已创建并启用 3 个任务，今天不直接生成报告，首轮都是明天：全球趋势雷达｜08:00',
    '### 已写入定时任务的执行与核验规则\n\n- 监测地区与来源：覆盖北美、欧洲、巴西、日本'
  ];
  for (const text of confirms) {
    assert.equal(selectReportAnswers([{ index: 0, text: text.repeat(3), time: null }]).length, 0, text.slice(0, 20));
  }
});

check('重试间隔：读不到内容时快速重试，读到了就按轮询间隔', () => {
  // 1.10.1 的故障：Gemini/Muse 读到 0 条后要等满 5 分钟才进下一轮，界面看起来就是卡死。
  assert.equal(retryDelayMs({ attempts: 1, totalCount: 0, pollMinutes: 5 }), 3000);
  assert.equal(retryDelayMs({ attempts: 2, totalCount: 0, pollMinutes: 5 }), 6000);
  assert.equal(retryDelayMs({ attempts: 3, totalCount: 0, pollMinutes: 5 }), 12000);
  // 前 4 次快速试完，之后回到正常轮询，避免把整个等待窗口烧光
  assert.equal(retryDelayMs({ attempts: 4, totalCount: 0, pollMinutes: 5 }), 300000);
  // 已经读到内容（只是还没出报告），按轮询间隔等
  assert.equal(retryDelayMs({ attempts: 1, totalCount: 8, pollMinutes: 5 }), 300000);
  // 轮询间隔有下限，避免设置成 0 造成疯狂请求
  assert.equal(retryDelayMs({ attempts: 9, totalCount: 0, pollMinutes: 0.01 }), 5000);
});

check('被重定向到首页时，不把首页「最近对话」当成回答', () => {
  // 1.10.2 实测：坏链接会跳回 chatgpt.com 首页，首页正文曾被抓成 477 字“回答”。
  const source = { url: 'https://chatgpt.com/c/6adf6445-4d4c-83e8-9f8f-2b6879319b37' };
  assert.equal(sameConversationEntry('https://chatgpt.com/c/6adf6445-4d4c-83e8-9f8f-2b6879319b37', source), true);
  assert.equal(sameConversationEntry('https://chatgpt.com/', source), false);
  assert.equal(sameConversationEntry('https://chatgpt.com/?model=auto', source), false);
  // 没有指定链接（靠关键词找对话）时不限制
  assert.equal(sameConversationEntry('https://chatgpt.com/', { url: '' }), true);
});

console.log(`\n${passed} 项通过`);
