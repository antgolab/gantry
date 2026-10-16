/**
 * integration-ac-gate.test.mjs — integration 阶段门禁挂 ac-gate(SPEC AC-7)
 *
 * 断言 checkGate('integration', ...) 在 pipeline=full 场景下:
 *   - 全覆盖 → passed:true
 *   - 缺失 → passed:false + reason 含 'ac-gate: missing ...'
 *   - SPEC 无 AC → passed:true + skipReason
 *   - SPEC 有 AC 但 test-commands.yml 缺失/为空 → passed:false(fail-closed,2026-10-12)
 *   - dev/test/review 不受 ac-gate 影响
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkGate } from '../src/lib/phases.mjs';

function makeSpecsDir({
  specAcIds = ['AC-1', 'AC-2', 'AC-3'],
  covers = ['AC-1', 'AC-2', 'AC-3'],
  withTestCommands = true,
  withReview = true,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'int-ac-gate-'));
  const specsDir = join(root, '.gantry/specs/demo');
  const loopDir = join(root, '.gantry/loop');
  mkdirSync(specsDir, { recursive: true });
  mkdirSync(loopDir, { recursive: true });

  writeFileSync(join(specsDir, 'PROPOSAL.md'), '# PROPOSAL\n\n## 待澄清问题\n', 'utf-8');
  writeFileSync(join(specsDir, 'DESIGN.md'), '# DESIGN\n', 'utf-8');
  writeFileSync(join(specsDir, 'TASKS.md'), '# TASKS\n', 'utf-8');
  writeFileSync(join(specsDir, 'TEST.md'), '# TEST\n', 'utf-8');
  if (withReview) {
    writeFileSync(join(specsDir, 'REVIEW.md'), '# REVIEW · APPROVED\n\n通过 · pass · approved\n', 'utf-8');
  }

  const acSections = specAcIds.map(ac => `## ${ac} · demo\n\nGiven ... When ... Then ...\n`).join('\n');
  writeFileSync(join(specsDir, 'SPEC.md'), `# SPEC: demo\n\n${acSections}`, 'utf-8');

  if (withTestCommands) {
    const coversList = covers.map(c => `'${c}'`).join(', ');
    writeFileSync(
      join(loopDir, 'test-commands.yml'),
      `unit:\n  cmd: node --test tests/\n  covers: [${coversList}]\n`,
      'utf-8',
    );
  }
  return { root, specsDir };
}

test('AC-7 · SPEC AC-1..3 全覆盖 → passed:true', () => {
  const { root, specsDir } = makeSpecsDir();
  try {
    const r = checkGate('integration', specsDir, { pipeline: 'full' });
    assert.equal(r.passed, true, `reason=${r.reason}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-7 · SPEC AC-1..3,test 只覆盖 AC-1 → passed:false + reason', () => {
  const { root, specsDir } = makeSpecsDir({ covers: ['AC-1'] });
  try {
    const r = checkGate('integration', specsDir, { pipeline: 'full' });
    assert.equal(r.passed, false);
    assert.match(r.reason, /ac-gate: missing AC-2, AC-3/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-7 · SPEC 无 AC → passed:true + skipReason', () => {
  const { root, specsDir } = makeSpecsDir({ specAcIds: [] });
  try {
    const r = checkGate('integration', specsDir, { pipeline: 'full' });
    assert.equal(r.passed, true);
    assert.match(r.skipReason || '', /ac-gate/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 2026-10-12 fail-closed:此前缺失即放行,而 install 从不生成该文件 —— 等于这道闸
// 在真实项目里不存在。现在 SPEC 有 AC 就必须有覆盖映射。
test('AC-7 · test-commands.yml 缺失且 SPEC 有 AC → passed:false + 指路', () => {
  const { root, specsDir } = makeSpecsDir({ withTestCommands: false });
  try {
    const r = checkGate('integration', specsDir, { pipeline: 'full' });
    assert.equal(r.passed, false, '缺失不再放行');
    assert.match(r.reason, /ac-gate: missing AC-1, AC-2, AC-3/);
    assert.match(r.reason, /test-commands\.yml 缺失/);
    assert.match(r.reason, /gantry install/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-7 · test-commands.yml 存在但无有效条目 → passed:false', () => {
  const { root, specsDir } = makeSpecsDir({ withTestCommands: false });
  try {
    // 全注释文件 = 解析为 {},即 install 铺的模板在用户填写前的状态
    writeFileSync(
      join(root, '.gantry/loop/test-commands.yml'),
      "# unit:\n#   cmd: npm test\n#   covers: ['*']\n",
      'utf-8',
    );
    const r = checkGate('integration', specsDir, { pipeline: 'full' });
    assert.equal(r.passed, false);
    assert.match(r.reason, /ac-gate: missing AC-1/);
    assert.match(r.reason, /无有效命令条目/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-7 · test-commands.yml 语法非法 → passed:false 而非抛穿', () => {
  const { root, specsDir } = makeSpecsDir({ withTestCommands: false });
  try {
    writeFileSync(join(root, '.gantry/loop/test-commands.yml'), 'unit:\n  covers: [AC-1]\n', 'utf-8');
    const r = checkGate('integration', specsDir, { pipeline: 'full' });
    assert.equal(r.passed, false);
    assert.match(r.reason, /ac-gate: test-commands\.yml 解析失败/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-7 · REVIEW 未通过时 ac-gate 不掩盖 review 失败', () => {
  const { root, specsDir } = makeSpecsDir({ withReview: false });
  try {
    const r = checkGate('integration', specsDir, { pipeline: 'full' });
    assert.equal(r.passed, false);
    // review 门禁在 ac-gate 之前,应该报 REVIEW 缺失,不到 ac-gate
    assert.match(r.reason, /REVIEW/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-7 · dev 门禁不受 ac-gate 影响(不同阶段隔离)', () => {
  const { root, specsDir } = makeSpecsDir({ covers: ['AC-1'] });
  try {
    // dev 门禁只查 TASKS.md,不会因缺 AC 覆盖被阻塞
    const r = checkGate('dev', specsDir, { pipeline: 'full' });
    assert.equal(r.passed, true, `reason=${r.reason}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
