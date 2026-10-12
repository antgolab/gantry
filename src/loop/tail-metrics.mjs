#!/usr/bin/env node
// tail-metrics.mjs — 读 <项目>/.gantry/loop/metrics.jsonl 实时展示 loop 执行指标
//
// 用法: node <包>/src/loop/tail-metrics.mjs [--follow] [--last N]
//   --follow  持续 tail(默认)
//   --last N  只显示最后 N 行(默认 20)
//   --once    打印一次就退出
//
// 输出列: step  stage         token         rc  dispatch  advance   ts

import { createReadStream, existsSync, statSync, watchFile, unwatchFile } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const METRICS = join(process.cwd(), '.gantry/loop/metrics.jsonl');

const args = process.argv.slice(2);
const once = args.includes('--once');
const follow = !once && (args.includes('--follow') || args.length === 0);
const lastN = (() => {
  const i = args.indexOf('--last');
  return i >= 0 ? parseInt(args[i + 1], 10) || 20 : 20;
})();

if (!existsSync(METRICS)) {
  console.error(`metrics 文件不存在: ${METRICS}`);
  console.error('先跑 gantry loop <claude|codex> 产生指标');
  process.exit(1);
}

const COLS = ['step', 'stage', 'token', 'rc', 'dispatch', 'advance', 'ts'];
const WIDTHS = [5, 12, 20, 3, 9, 9, 20];

function fmt(row) {
  const cells = [
    String(row.step ?? '').padStart(WIDTHS[0]),
    String(row.stage ?? '').padEnd(WIDTHS[1]),
    String(row.token ?? '').padEnd(WIDTHS[2]),
    String(row.rc ?? '').padStart(WIDTHS[3]),
    `${row.dispatch_ms ?? 0}ms`.padStart(WIDTHS[4]),
    `${row.advance_ms ?? 0}ms`.padStart(WIDTHS[5]),
    String(row.ts ?? '').padEnd(WIDTHS[6]),
  ];
  // rc 非 0 整行标红(ANSI);rc=0 不渲染
  const line = cells.join('  ');
  return row.rc !== 0 ? `\x1b[31m${line}\x1b[0m` : line;
}

function header() {
  const cells = COLS.map((c, i) =>
    i < 4 ? c.padStart(WIDTHS[i]) : c.padEnd(WIDTHS[i])
  );
  return cells.join('  ');
}

async function readAll() {
  const lines = [];
  const rl = createInterface({ input: createReadStream(METRICS, 'utf-8') });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { lines.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return lines;
}

async function printSnapshot() {
  const rows = await readAll();
  const slice = rows.slice(-lastN);
  console.log(header());
  console.log('-'.repeat(WIDTHS.reduce((a, b) => a + b + 2, 0)));
  for (const row of slice) console.log(fmt(row));
}

await printSnapshot();

if (follow) {
  let lastSize = statSync(METRICS).size;
  console.log('\n(following... Ctrl+C 退出)');
  watchFile(METRICS, { interval: 500 }, async (cur) => {
    if (cur.size <= lastSize) { lastSize = cur.size; return; }
    const stream = createReadStream(METRICS, { start: lastSize, encoding: 'utf-8' });
    let buf = '';
    for await (const chunk of stream) buf += chunk;
    lastSize = cur.size;
    for (const line of buf.split('\n')) {
      if (!line.trim()) continue;
      try { console.log(fmt(JSON.parse(line))); } catch { /* skip */ }
    }
  });
  process.on('SIGINT', () => { unwatchFile(METRICS); process.exit(0); });
}
