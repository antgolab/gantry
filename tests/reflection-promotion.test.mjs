import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const read = path => readFileSync(join(ROOT, path), 'utf-8');

describe('integration reflection and lessons contract', () => {
  it('Integrator writes reflection and limits TASKS changes to failure fixes', () => {
    const integrator = read('src/agents/integrator.md');

    assert.match(integrator, /write: \[[^\]]*EXECUTION\.md/);
    assert.match(integrator, /write: \[[^\]]*TASKS\.md/);
    assert.match(integrator, /TASKS\.md.*仅用于.*失败.*T-FIX/s);
    assert.match(integrator, /Keep.*Problem.*Next/s);
    assert.match(integrator, /没有有效内容.*none/);
    assert.doesNotMatch(integrator, /经验晋升.*T-FIX/s);
  });

  it('Integration scans all execution evidence and records an idempotent retrospective', () => {
    const integration = read('phases/7-integration.md');

    assert.match(integration, /EXECUTION\.md.*\*-SUMMARY\.md.*\*-PROGRESS\.md/s);
    assert.match(integration, /## Retrospective/);
    assert.match(integration, /Keep.*Problem.*Next/s);
    assert.match(integration, /已存在.*更新.*不得重复追加/s);
    assert.doesNotMatch(integration, /第二次.*第三次.*高损失/s);
  });

  it('LESSONS keeps only searchable and verifiable experience fields', () => {
    const lessons = read('templates/LESSONS.md');

    for (const field of ['状态', '关键词']) {
      assert.match(lessons, new RegExp(`\\*\\*${field}\\*\\*:`), `missing ${field}`);
    }
    for (const field of ['类型', '命中次数', '最近命中', '验证状态', '晋升去向']) {
      assert.doesNotMatch(lessons, new RegExp(`\\*\\*${field}\\*\\*:`), `retired ${field}`);
    }
    assert.match(lessons, /\*\*问题场景\*\*/);
    assert.match(lessons, /\*\*原因\*\*/);
    assert.match(lessons, /\*\*当前推荐做法\*\*/);
    assert.match(lessons, /\*\*验证记录\*\*/);
    assert.match(lessons, /验证证据/);
    assert.match(lessons, /不只是.*注意检查/s);
    assert.match(lessons, /历史.*为什么不行.*无需.*迁移/s);
  });

  it('v1 does not prescribe a manual recurrence state machine', () => {
    const contract = `${read('phases/7-integration.md')}\n${read('templates/LESSONS.md')}`;

    assert.doesNotMatch(contract, /第二次.*test.*hook.*checklist.*阶段门禁/s);
    assert.doesNotMatch(contract, /第三次.*高损失.*必须/s);
    assert.match(contract, /基于.*证据.*LESSONS/s);
  });
});
