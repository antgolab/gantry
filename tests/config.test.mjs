/**
 * config.test.mjs — 配置读取单一事实源
 * 锁定 readConfig 统一后:project 覆盖 global、深合并、解析容错。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig, deepMerge } from '../src/lib/config.mjs';

const TMP = join(import.meta.dirname, '.tmp-config-' + Date.now());

function setup() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, '.gantry/planning'), { recursive: true });
}
function teardown() {
  rmSync(TMP, { recursive: true, force: true });
}

test('deepMerge: 嵌套对象合并,override 覆盖', () => {
  const r = deepMerge(
    { a: 1, nested: { x: 1, y: 2 } },
    { b: 2, nested: { y: 9, z: 3 } }
  );
  assert.deepEqual(r, { a: 1, b: 2, nested: { x: 1, y: 9, z: 3 } });
});

test('deepMerge: 数组整体替换,不合并', () => {
  const r = deepMerge({ list: [1, 2, 3] }, { list: [9] });
  assert.deepEqual(r.list, [9]);
});

test('readConfig: 读取项目 config.json', () => {
  setup();
  try {
    writeFileSync(join(TMP, '.gantry/planning/config.json'),
      JSON.stringify({ pipeline: 'light', stages: { review: { requiresApproval: true } } }));
    const cfg = readConfig(TMP);
    assert.equal(cfg.pipeline, 'light');
    assert.equal(cfg.stages.review.requiresApproval, true);
  } finally { teardown(); }
});

test('readConfig: config.json 损坏时容错返回(不抛)', () => {
  setup();
  try {
    writeFileSync(join(TMP, '.gantry/planning/config.json'), '{ 坏 json');
    let cfg;
    assert.doesNotThrow(() => { cfg = readConfig(TMP); });
    assert.equal(typeof cfg, 'object');
  } finally { teardown(); }
});

test('readConfig: 无 config 文件返回空对象', () => {
  setup();
  try {
    const cfg = readConfig(TMP);
    assert.equal(typeof cfg, 'object');
  } finally { teardown(); }
});

test('readConfig: 旧 standard 自动迁移为 full', () => {
  setup();
  try {
    writeFileSync(join(TMP, '.gantry/planning/config.json'), JSON.stringify({ pipeline: 'standard' }));
    assert.equal(readConfig(TMP).pipeline, 'full');
  } finally { teardown(); }
});
