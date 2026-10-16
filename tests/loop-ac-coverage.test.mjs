/**
 * loop-ac-coverage.test.mjs — checkAcCoverage 正例 / 缺 AC / null 三种
 *
 * 对齐 AC-7。
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAcCoverage, extractAcIds } from '../src/lib/loop.mjs';

function makeSpecDir(specContent) {
  const dir = mkdtempSync(join(tmpdir(), 'gantry-ac-'));
  writeFileSync(join(dir, 'SPEC.md'), specContent, 'utf-8');
  return dir;
}

const SAMPLE_SPEC = `# SPEC: sample

### AC-1 · foo

- Given ...

### AC-2 · bar

...

#### AC-3 · nested

...

## 非 AC 标题
`;

// 2026-10-12 契约变更(fail-closed):SPEC 有 AC 时,null / 空表都算「无覆盖映射」,
// 判为全部 missing,不再 skipped 放行。理由是 install 从不生成 test-commands.yml,
// fail-open 会让这道闸在真实项目里永远等于不存在。
test('AC-7 · testCommands 为 null → 全部 AC missing(fail-closed)', () => {
  const dir = makeSpecDir(SAMPLE_SPEC);
  const result = checkAcCoverage(dir, null);
  assert.equal(result.skipped, false, 'null 不再降级放行');
  assert.deepEqual(result.covered, []);
  assert.deepEqual(result.missing, ['AC-1', 'AC-2', 'AC-3']);
});

test('AC-7 · testCommands 为空表 {} → 全部 AC missing(fail-closed)', () => {
  const dir = makeSpecDir(SAMPLE_SPEC);
  const result = checkAcCoverage(dir, {});
  assert.equal(result.skipped, false, '空表不再降级放行');
  assert.deepEqual(result.missing, ['AC-1', 'AC-2', 'AC-3']);
});

test('AC-7 · 条目存在但 covers 为空 → 全部 AC missing', () => {
  const dir = makeSpecDir(SAMPLE_SPEC);
  const result = checkAcCoverage(dir, { unit: { cmd: 'npm test', covers: [] } });
  assert.equal(result.skipped, false);
  assert.deepEqual(result.missing, ['AC-1', 'AC-2', 'AC-3']);
});

test('AC-7 · 全覆盖 → missing 为空', () => {
  const dir = makeSpecDir(SAMPLE_SPEC);
  const testCommands = {
    unit: { cmd: 'npm test', covers: ['AC-1', 'AC-2'] },
    e2e:  { cmd: 'npm run e2e', covers: ['AC-3'] },
    lint: { cmd: 'npm run lint', covers: ['*'] },
  };
  const result = checkAcCoverage(dir, testCommands);
  assert.equal(result.skipped, false);
  assert.deepEqual(result.missing, []);
  assert.ok(result.covered.includes('AC-1'));
  assert.ok(result.covered.includes('AC-2'));
  assert.ok(result.covered.includes('AC-3'));
  assert.ok(result.covered.includes('*'), '通配符应保留信号');
});

test('AC-7 · 缺 AC → missing 列出', () => {
  const dir = makeSpecDir(SAMPLE_SPEC);
  const testCommands = {
    unit: { cmd: 'npm test', covers: ['AC-1', 'AC-2'] },
  };
  const result = checkAcCoverage(dir, testCommands);
  assert.equal(result.skipped, false);
  assert.deepEqual(result.missing, ['AC-3']);
});

test('AC-7 · 通配符命中即全覆盖', () => {
  const dir = makeSpecDir(SAMPLE_SPEC);
  const testCommands = {
    lint: { cmd: 'npm run lint', covers: ['*'] },
  };
  const result = checkAcCoverage(dir, testCommands);
  assert.deepEqual(result.missing, []);
});

test('AC-7 · SPEC.md 缺失 → skipped:true', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gantry-ac-nospec-'));
  const result = checkAcCoverage(dir, { unit: { covers: ['AC-1'] } });
  assert.equal(result.skipped, true);
});

test('AC-7 · SPEC.md 无 AC → skipped:true', () => {
  const dir = makeSpecDir('# SPEC without ACs\n\nsome prose');
  const result = checkAcCoverage(dir, { unit: { covers: ['AC-1'] } });
  assert.equal(result.skipped, true);
});

test('extractAcIds 按数字排序', () => {
  const ids = extractAcIds(`### AC-10 · ten\n### AC-2 · two\n### AC-1 · one\n`);
  assert.deepEqual(ids, ['AC-1', 'AC-2', 'AC-10']);
});
