import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PIPELINES, getNextStage, checkGate } from '../src/lib/phases.mjs';

const TMP = join(import.meta.dirname, '.tmp-phases-micro');

function setup() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
}

function teardown() {
  rmSync(TMP, { recursive: true, force: true });
}

describe('micro pipeline 阶段图 (T10)', () => {
  it('PIPELINES.micro === [change, dev, done]', () => {
    assert.deepEqual(PIPELINES.micro, ['change', 'dev', 'done']);
  });

  it('light/full pipelines 原样未变', () => {
    assert.deepEqual(
      PIPELINES.full,
      ['change', 'requirement', 'design', 'ui-design', 'task', 'dev', 'test', 'review', 'integration'],
    );
    assert.deepEqual(PIPELINES.light, ['change', 'fast', 'integration']);
  });

  it('micro 阶段图不含 requirement/design/task 占位阶段', () => {
    for (const placeholder of ['requirement', 'design', 'task', 'test', 'review', 'integration']) {
      assert.equal(PIPELINES.micro.includes(placeholder), false, `micro 不应包含 ${placeholder}`);
    }
  });

  it('micro advance: change → dev (不进 requirement/design/task)', () => {
    const cfg = { pipeline: 'micro' };
    assert.equal(getNextStage('change', cfg), 'dev');
  });

  it('micro advance: dev → done', () => {
    assert.equal(getNextStage('dev', { pipeline: 'micro' }), 'done');
  });

  it('micro advance: done 到达终点 (返回 null)', () => {
    assert.equal(getNextStage('done', { pipeline: 'micro' }), null);
  });

  it('micro 的 dev 门禁不要求 TASKS.md 占位 (仅 CHANGE.md 即放行)', () => {
    setup();
    try {
      // 只写 CHANGE.md，不写 SPEC.md / DESIGN.md / TASKS.md
      writeFileSync(join(TMP, 'CHANGE.md'), '# CHANGE\n\nfix: 更新 README 的 npm 命令\n');
      const result = checkGate('dev', TMP, { pipeline: 'micro' });
      assert.equal(result.passed, true, `dev 门禁应放行, 实际 reason: ${result.reason}`);
    } finally {
      teardown();
    }
  });

  it('micro 的 dev 门禁仍要求 CHANGE 就绪 (无 CHANGE 时阻断)', () => {
    setup();
    try {
      const result = checkGate('dev', TMP, { pipeline: 'micro' });
      assert.equal(result.passed, false);
    } finally {
      teardown();
    }
  });

  it('full 的 dev 门禁仍要求 TASKS.md (回归保护)', () => {
    setup();
    try {
      writeFileSync(join(TMP, 'CHANGE.md'), '# CHANGE\n');
      const missingTasks = checkGate('dev', TMP, { pipeline: 'full' });
      assert.equal(missingTasks.passed, false);
    } finally {
      teardown();
    }
  });
});
