/**
 * test-commands-parse.test.mjs — 零依赖 yaml parser 契约
 *
 * 对齐 SPEC AC-1。
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTestCommands, parseTestCommandsFromString } from '../src/lib/test-commands.mjs';
import { checkAcCoverage } from '../src/lib/loop.mjs';

function makeTmpYaml(content) {
  const dir = mkdtempSync(join(tmpdir(), 'gantry-tc-'));
  const path = join(dir, 'test-commands.yml');
  writeFileSync(path, content, 'utf-8');
  return { dir, path };
}

test('AC-1 · 顶级 map + 单行数组 covers', () => {
  const yml = `unit:
  cmd: node --test tests/
  covers: [AC-1, AC-2]
lint:
  cmd: node scripts/lint.mjs
  covers: ['*']
`;
  const result = parseTestCommandsFromString(yml);
  assert.deepEqual(result, {
    unit: { cmd: 'node --test tests/', covers: ['AC-1', 'AC-2'] },
    lint: { cmd: 'node scripts/lint.mjs', covers: ['*'] },
  });
});

test('AC-1 · 允许 # 注释(行首与行内)', () => {
  const yml = `# 顶级注释
unit:  # 行内注释
  cmd: node --test tests/ # 命令后注释
  covers: [AC-1]
`;
  const result = parseTestCommandsFromString(yml);
  assert.equal(result.unit.cmd, 'node --test tests/');
  assert.deepEqual(result.unit.covers, ['AC-1']);
});

test('AC-1 · 空文件不存在时返回 null', () => {
  const result = parseTestCommands(join(tmpdir(), 'gantry-nonexistent-xyz.yml'));
  assert.equal(result, null);
});

test('AC-1 · 缺 cmd 字段抛错', () => {
  const yml = `unit:
  covers: [AC-1]
`;
  assert.throws(() => parseTestCommandsFromString(yml), /\[test-commands\] invalid.*缺少 cmd/);
});

test('AC-1 · 顶级 key 不接受行内值', () => {
  const yml = `unit: something inline
`;
  assert.throws(() => parseTestCommandsFromString(yml), /不接受行内值/);
});

test('AC-1 · 空 covers 数组合法', () => {
  const yml = `unit:
  cmd: echo hi
  covers: []
`;
  const result = parseTestCommandsFromString(yml);
  assert.deepEqual(result.unit.covers, []);
});

test('AC-1 · 与 checkAcCoverage 联通', () => {
  const yml = `unit:
  cmd: node --test tests/
  covers: [AC-1, AC-2]
smoke:
  cmd: bash smoke.sh
  covers: ['*']
`;
  const testCommands = parseTestCommandsFromString(yml);

  const specDir = mkdtempSync(join(tmpdir(), 'gantry-ac-cov-'));
  writeFileSync(join(specDir, 'SPEC.md'),
    `# SPEC\n\n### AC-1 · one\n### AC-2 · two\n### AC-3 · three\n`,
    'utf-8');

  const result = checkAcCoverage(specDir, testCommands);
  assert.equal(result.skipped, false);
  assert.deepEqual(result.missing, []); // 通配符覆盖
});

test('AC-1 · 从磁盘读取真实文件', () => {
  const { path } = makeTmpYaml(`only:
  cmd: date
  covers: [AC-9]
`);
  const result = parseTestCommands(path);
  assert.equal(result.only.cmd, 'date');
  assert.deepEqual(result.only.covers, ['AC-9']);
});
