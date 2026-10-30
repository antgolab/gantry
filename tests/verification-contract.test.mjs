/**
 * verification-contract.test.mjs — 锁定单一 <verify> 在各阶段的职责边界
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const read = path => readFileSync(join(root, path), 'utf-8');

test('TASK 将 verify 定义为当前 task 的最小、直接、可重复命令', () => {
  const task = read('phases/3-task.md');
  const template = read('templates/TASKS.md');

  assert.match(task, /证明当前 task 完成的最小、直接、可重复命令/);
  assert.match(task, /工作目录.*环境.*runner/);
  assert.match(template, /证明当前 task 完成的最小、直接、可重复命令/);
});

test('DEV、TEST、INTEGRATION 各自只承担一层验证职责', () => {
  const dev = read('phases/4-dev.md');
  const testPhase = read('phases/5-test.md');
  const integration = read('phases/7-integration.md');

  assert.match(dev, /只运行当前 task 的 focused verification/);
  assert.match(dev, /不在 DEV 重复运行与当前 task 无关的全套测试/);
  assert.match(testPhase, /从 SPEC 的 AC 出发扩大覆盖/);
  assert.match(integration, /全量自动化、远程依赖与端到端验证/);
});

test('verify 命令允许任务必需的数据库或远程依赖，但不扩展字段或 runner 抽象', () => {
  const files = [
    'phases/3-task.md',
    'phases/4-dev.md',
    'phases/5-test.md',
    'phases/7-integration.md',
    'templates/TASKS.md',
  ];
  const contract = files.map(read).join('\n');

  assert.match(contract, /数据库或远程依赖/);
  assert.doesNotMatch(contract, /<integration_verify>|<test_verify>|verifyProfile|verify_profile/);
});

test('任务按独立验收切分，共用环境验证按 change 收口并保留失效重验', () => {
  const task = read('phases/3-task.md');
  const testPhase = read('phases/5-test.md');
  const integration = read('phases/7-integration.md');
  assert.doesNotMatch(task, /2~10 分钟/);
  assert.match(task, /相同目标、共用验收.*合并/);
  assert.match(task, /不能仅因命令相同合并不同目标/);
  assert.match(testPhase, /不按 task \/ wave 启动完整五轮/);
  assert.match(testPhase, /不要先手跑同一命令后立即让 CLI 再跑/);
  assert.match(integration, /只执行缺失或失效部分/);
  assert.match(integration, /不同目标环境分别验证/);
  assert.match(integration, /单 task 的 focused verify 不能代替全量证据/);
  assert.match(read('templates/TEST.md'), /共用执行与证据归属/);
  assert.match(read('templates/UAT.md'), /自动化证据收口/);
});
