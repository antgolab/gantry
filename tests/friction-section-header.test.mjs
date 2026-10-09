/**
 * friction-section-header.test.mjs — AC-16 friction 段头正则共享
 *
 * 验证 SECTION_HEADER_RE 从 SECTION_HEADER 派生, 原 headerRe 局部正则字面量已被移除,
 * NEXT_SECTION_RE 保持独立不被合并。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SECTION_HEADER_RE } from '../src/lib/friction.mjs';

const SOURCE = readFileSync(new URL('../src/lib/friction.mjs', import.meta.url), 'utf-8');
const SOURCE_LINES = SOURCE.split('\n');

test('AC-16 · 文件内只有一处段头字面定义, 且归于 SECTION_HEADER_RE', () => {
  // 原局部正则字面量 /^## friction-events/ 已不存在
  assert.equal(SOURCE.includes('/^## friction-events'), false, '不应残留 /^## friction-events 正则字面量');
  // SECTION_HEADER_RE 只声明一次
  const decls = SOURCE_LINES.filter((line) => /const SECTION_HEADER_RE\s*=/.test(line));
  assert.equal(decls.length, 1, 'SECTION_HEADER_RE 应只声明一次');
  // 段头字符串 '## friction-events' 只在 SECTION_HEADER 出现一次 (单一事实源; 注释用反引号不受影响)
  const headerLiterals = SOURCE.match(/'## friction-events'/g) ?? [];
  assert.equal(headerLiterals.length, 1, "'## friction-events' 字面量应只出现一次");
});

test('AC-16 · appendToContent 使用点改为引用 SECTION_HEADER_RE', () => {
  assert.equal(SOURCE.includes('const headerRe'), false, 'headerRe 局部变量应已删除');
  assert.ok(/SECTION_HEADER_RE\.exec\(content\)/.test(SOURCE), 'appendToContent 应引用 SECTION_HEADER_RE.exec');
});

test('AC-16 · NEXT_SECTION_RE 保持独立不被合并', () => {
  assert.ok(
    SOURCE.includes('const NEXT_SECTION_RE = /^##[ \\t]/m'),
    'NEXT_SECTION_RE 声明应保持原样独立存在',
  );
  // 语义不同: SECTION_HEADER_RE 只匹配 friction 段头, 不匹配其他 ## 段头
  assert.equal(SECTION_HEADER_RE.test('## friction-events'), true);
  assert.equal(SECTION_HEADER_RE.test('## friction-events   '), true);
  assert.equal(SECTION_HEADER_RE.test('## other'), false);
});

test('两处使用点行为等价 (与原字面正则给相同输入返回相同结果)', () => {
  const oldRe = /^## friction-events[ \t]*$/m;
  const inputs = [
    '## friction-events',
    '## friction-events   ',
    '## friction-events\t\t',
    '## friction-events extra',
    'not a header\n## friction-events\n## other',
    '## other\n## friction-events  \nend',
    '',
    '## friction-eventsX',
  ];
  for (const input of inputs) {
    assert.equal(
      SECTION_HEADER_RE.test(input),
      oldRe.test(input),
      `test(${JSON.stringify(input)}) 应与原字面正则一致`,
    );
  }

  // exec 命中内容与位置也一致
  const doc = '# EXECUTION\n\n## friction-events\n## other\n';
  const got = SECTION_HEADER_RE.exec(doc);
  const want = oldRe.exec(doc);
  assert.equal(got[0], want[0]);
  assert.equal(got.index, want.index);
});
