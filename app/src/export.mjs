import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fmtLocal } from './util.mjs';

const SCHEMA = 'ai-flow.answers.v1';
const CHART_DIR = '图表';
const MAX_XLSX_CELL = 32_000;

const COLUMNS = [
  ['collected_at', '采集时间'],
  ['task', '任务'],
  ['platform', '平台'],
  ['status', '状态'],
  ['conversation_url', '对话链接'],
  ['answer_index', '回答序号'],
  ['answer_time', '回答时间'],
  ['chars', '字数'],
  ['table_count', '表格数'],
  ['chart_count', '图表数'],
  ['text', '正文'],
  ['error', '错误']
];

const STATUS_LABELS = {
  ok: '成功',
  partial: '部分完成',
  'no-new': '无新回答',
  'no-answer': '未生成回答',
  login: '需要登录',
  timeout: '超时',
  error: '失败',
  waiting: '等待中',
  running: '读取中',
  pending: '排队中',
  skipped: '已跳过'
};

export function extractMarkdownTables(text) {
  const lines = String(text || '').split('\n');
  const tables = [];
  let current = [];
  let sawDivider = false;
  const flush = () => {
    if (current.length > 1 && sawDivider) tables.push(current);
    current = [];
    sawDivider = false;
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!/^\|.*\|$/.test(trimmed)) {
      flush();
      continue;
    }
    const cells = trimmed
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split(/(?<!\\)\|/)
      .map((cell) => cell.replace(/\\\|/g, '|').trim());
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) {
      sawDivider = true;
      continue;
    }
    current.push(cells);
  }
  flush();
  return tables;
}

function parseImages(text) {
  const found = [];
  const pattern = /!\[([^\]]*)\]\((data:image\/[^)]+|https?:\/\/[^)\s]+|blob:[^)\s]+)\)/gi;
  let match;
  while ((match = pattern.exec(String(text || '')))) {
    found.push({ alt: match[1] || '图表', src: match[2], index: match.index });
  }
  return found;
}

function imageExtension(mime) {
  if (/jpe?g/i.test(mime)) return 'jpg';
  if (/webp/i.test(mime)) return 'webp';
  if (/gif/i.test(mime)) return 'gif';
  return 'png';
}

function decodeDataImage(src) {
  const match = /^data:(image\/[\w+.-]+);base64,(.+)$/i.exec(src);
  if (!match) return null;
  try {
    return { mime: match[1].toLowerCase(), buffer: Buffer.from(match[2], 'base64') };
  } catch {
    return null;
  }
}

function safeName(value) {
  return String(value || 'ai')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40) || 'ai';
}

export function collectRecords(task, run) {
  const results = run.results || [];
  const collectedAt = run.finishedAt || run.startedAt || new Date().toISOString();
  const records = [];
  for (const result of results) {
    const answers = Array.isArray(result.answers) && result.answers.length
      ? result.answers
      : result.status === 'ok' || result.status === 'partial'
        ? [{ index: 1, time: result.lastAnswerTime || null, text: result.text || '' }]
        : [];
    if (!answers.length) {
      records.push({
        schema: SCHEMA,
        run_id: run.id,
        task: task.name,
        mode: run.mode || 'scheduled',
        collected_at: collectedAt,
        platform_id: result.platformId,
        platform: result.name,
        status: result.status,
        status_label: STATUS_LABELS[result.status] || result.status,
        conversation_url: result.url || result.sourceUrl || '',
        source_keyword: result.sourceKeyword || '',
        answer_index: null,
        answer_time: null,
        chars: 0,
        table_count: 0,
        chart_count: 0,
        has_text_chart: false,
        charts: [],
        tables: [],
        text: '',
        error: result.error || ''
      });
      continue;
    }
    for (const answer of answers) {
      const text = String(answer.text || '');
      records.push({
        schema: SCHEMA,
        run_id: run.id,
        task: task.name,
        mode: run.mode || 'scheduled',
        collected_at: collectedAt,
        platform_id: result.platformId,
        platform: result.name,
        status: result.status,
        status_label: STATUS_LABELS[result.status] || result.status,
        conversation_url: result.url || result.sourceUrl || '',
        source_keyword: result.sourceKeyword || '',
        answer_index: Number.isFinite(answer.index) ? answer.index : null,
        answer_time: answer.time || null,
        chars: text.length,
        table_count: 0,
        chart_count: 0,
        has_text_chart: /\[图表[：:]/.test(text),
        charts: [],
        tables: [],
        text,
        error: result.error || ''
      });
    }
  }
  return records;
}

export function writeAnswerDataset({ dir, task, run }) {
  fs.mkdirSync(dir, { recursive: true });
  const chartDir = path.join(dir, CHART_DIR);
  const records = collectRecords(task, run);

  for (const record of records) {
    let text = record.text;
    const charts = [];
    for (const image of parseImages(text)) {
      let fileName = null;
      if (/^data:image\//i.test(image.src)) {
        const decoded = decodeDataImage(image.src);
        if (decoded && decoded.buffer.length <= 2_000_000) {
          if (!fs.existsSync(chartDir)) fs.mkdirSync(chartDir, { recursive: true });
          fileName = `${safeName(record.platform_id)}-${record.answer_index || 1}-${charts.length + 1}.${imageExtension(decoded.mime)}`;
          fs.writeFileSync(path.join(chartDir, fileName), decoded.buffer);
        }
      }
      charts.push({
        alt: image.alt,
        file: fileName ? `${CHART_DIR}/${fileName}` : null,
        url: fileName ? null : (/^https?:|^blob:/i.test(image.src) ? image.src : null)
      });
      if (fileName) text = text.split(image.src).join(`${CHART_DIR}/${fileName}`);
    }
    record.text = text;
    record.charts = charts;
    record.chart_count = charts.length;
    record.tables = extractMarkdownTables(text);
    record.table_count = record.tables.length;
    record.chars = text.length;
  }

  const jsonl = records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '');
  fs.writeFileSync(path.join(dir, '回答集.jsonl'), jsonl, 'utf8');
  fs.writeFileSync(path.join(dir, '回答集.csv'), '\ufeff' + toCsv(records), 'utf8');
  fs.writeFileSync(path.join(dir, '回答集.xlsx'), buildXlsx(records));
  fs.writeFileSync(path.join(dir, '运行摘要.json'), JSON.stringify(runSummary(task, run, records), null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, '说明.md'), datasetReadme(task, run, records), 'utf8');

  return {
    dir,
    records,
    files: ['回答集.jsonl', '回答集.csv', '回答集.xlsx', '运行摘要.json', '说明.md']
  };
}

function runSummary(task, run, records) {
  const results = run.results || [];
  return {
    schema: 'ai-flow.run.v1',
    run_id: run.id,
    task: task.name,
    mode: run.mode || 'scheduled',
    status: run.status,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    answer_records: records.length,
    summary: run.summary?.text ? { platform: run.summary.name, chars: run.summary.chars } : null,
    sources: results.map((result) => ({
      platform_id: result.platformId,
      platform: result.name,
      status: result.status,
      conversation_url: result.url || result.sourceUrl || '',
      total_count: result.totalCount || 0,
      new_count: result.newCount || 0,
      chars: result.chars || 0,
      error: result.error || null
    }))
  };
}

function toCsv(records) {
  const escape = (value) => {
    let text = value === null || value === undefined ? '' : String(value);
    // 防止 AI 输出被 Excel/WPS 当公式执行；不以空格开头的 - 才算公式
    if (/^[=@+]/.test(text) || /^-(?!\s)/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [COLUMNS.map(([, label]) => escape(label)).join(',')];
  for (const record of records) {
    lines.push(COLUMNS.map(([key]) => escape(record[key])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

function datasetReadme(task, run, records) {
  const good = records.filter((record) => record.answer_index !== null).length;
  const charts = records.reduce((total, record) => total + record.chart_count, 0);
  const tables = records.reduce((total, record) => total + record.table_count, 0);
  return `# ${task.name} · 回答数据

> 运行 ${run.id} · ${fmtLocal(run.finishedAt || run.startedAt)} · 共 ${records.length} 条记录，其中 ${good} 条回答、${tables} 个表格、${charts} 张图表

这个文件夹是给「人看表」和「AI 读数据」两种用途准备的。同目录上级的 .md 是排版好的日报。

## 文件

| 文件 | 用途 |
| --- | --- |
| 回答集.xlsx | Excel / WPS 直接打开的多行表格，一行一条回答 |
| 回答集.csv | 同样的表格，UTF-8 带 BOM，程序或 AI 读取更方便 |
| 回答集.jsonl | 一行一个 JSON，字段最全；直接把整个文件交给 AI 即可 |
| 图表/ | 从回答里提取的图表图片；正文里的相对链接指向这里 |
| 运行摘要.json | 本次运行的状态、来源、错误信息 |

## 回答集.jsonl 字段

| 字段 | 说明 |
| --- | --- |
| platform / platform_id | 哪个 AI 平台 |
| conversation_url | 读取的那条对话链接 |
| answer_index | 这条回答在对话里的序号（从 1 开始） |
| answer_time | 平台能给出回答时间时的 ISO 时间，否则为 null |
| collected_at | 本次采集时间 |
| status | ok / partial / no-new / no-answer / error |
| table_count / tables | 回答里的 Markdown 表格；tables 已解析成二维数组 |
| chart_count / charts | 回答里的图表；charts 给出图片相对路径或原始链接 |
| text | 回答正文，图表位置已换成「图表/xxx.png」相对链接 |

## 给 AI 的说法

把 \`回答集.jsonl\` 整个上传或粘贴给 AI，加一句：
「每行是一份 JSON，代表一个 AI 的一条回答。请按 platform 去重、按主题合并，保留 conversation_url 方便核对。」

正文里的表格已经是 Markdown 和数组两种形式，图表是本地文件，不需要 AI 重新生成。
`;
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function columnLetter(index) {
  let value = index + 1;
  let letters = '';
  while (value > 0) {
    const mod = (value - 1) % 26;
    letters = String.fromCharCode(65 + mod) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

function sheetXml(records) {
  const rows = [];
  const header = COLUMNS.map(([, label], index) => {
    const ref = `${columnLetter(index)}1`;
    return `<c r="${ref}" s="1" t="inlineStr"><is><t>${xmlEscape(label)}</t></is></c>`;
  }).join('');
  rows.push(`<row r="1">${header}</row>`);
  records.forEach((record, rowIndex) => {
    const rowNumber = rowIndex + 2;
    const cells = COLUMNS.map(([key], columnIndex) => {
      let text = record[key];
      if (text === null || text === undefined) text = '';
      text = String(text);
      if (text.length > MAX_XLSX_CELL) {
        text = `${text.slice(0, MAX_XLSX_CELL)}\n…（已截断，完整内容见 回答集.jsonl）`;
      }
      const ref = `${columnLetter(columnIndex)}${rowNumber}`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
    }).join('');
    rows.push(`<row r="${rowNumber}">${cells}</row>`);
  });
  const cols = COLUMNS.map((_, index) => {
    const width = [22, 26, 14, 12, 48, 10, 22, 10, 10, 10, 90, 32][index] || 20;
    return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${cols}</cols>
<sheetData>${rows.join('')}</sheetData>
</worksheet>`;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipArchive(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const deflated = zlib.deflateRawSync(raw, { level: 6 });
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralSize = centrals.reduce((total, buffer) => total + buffer.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

function buildXlsx(records) {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="回答集" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Microsoft YaHei"/></font><font><b/><sz val="11"/><name val="Microsoft YaHei"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="0"/></xf><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  return zipArchive([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/styles.xml', data: styles },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml(records) }
  ]);
}
