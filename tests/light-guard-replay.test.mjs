/**
 * light-guard-replay.test.mjs — AC-18 执行期守卫红线回放
 *
 * 从 tests/fixtures/light-guard-replay.json 逐条回放 runLightGuard，用真实红线定义
 * (hard-rules.mjs 的 detectRedLines / isTestPath) 而非 stub，衡量红线召回率与误报数。
 *
 * 回放约定：
 * - scope 由每条样本的 changedFiles 派生（每个文件的顶层目录 + '/'，根级文件取文件本身），
 *   保证 out-of-scope 永不触发 —— 本回放只衡量红线，不衡量范围检查。
 * - baseline 为空、testEntries 为空、verify 记录新鲜，因此除红线外的检查项（越界 /
 *   测试弱化 / verify 过期 / 意图非法）都不会命中。
 * - description 不参与：runLightGuard 以 '' 调 detectRedLines（创建期已单独预检描述）。
 * - 「检出」= 任一条 ruleId 不属于 NON_REDLINE_RULE_IDS 的命中。
 *
 * 从 AC-18 派生：样本 ≥ 10；正例召回率 = 100%；误报数打印供 TEST.md 记录。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { runLightGuard } from '../src/lib/light-guard.mjs';
import { detectRedLines, isTestPath } from '../src/lib/hard-rules.mjs';

const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/light-guard-replay.json', import.meta.url),
);

// 非红线命中：这些命中不代表「命中硬红线」，不计入检出。
const NON_REDLINE_RULE_IDS = new Set([
  'out-of-scope',
  'intent-scope-invalid',
  'stale-verify',
  'test-weakened',
  'guard-error',
]);

const hashOf = () => 'x';

/**
 * 从 changedFiles 派生一个覆盖全部改动的合法 scope（不引入 `**`）。
 * 含 `/` 的文件取其顶层目录 `dir/`（目录项允许其下任意文件）；根级文件取文件本身。
 */
function scopeFor(changedFiles) {
  const items = new Set();
  for (const file of changedFiles) {
    const slash = file.indexOf('/');
    items.add(slash === -1 ? file : `${file.slice(0, slash)}/`);
  }
  return [...items];
}

/** 回放单条样本，返回命中列表。 */
function replay(sample) {
  const result = runLightGuard({
    scope: scopeFor(sample.changedFiles),
    changedFiles: sample.changedFiles,
    baseline: {},
    hashOf,
    testEntries: [],
    verifyRecord: { pass: true, at: 2 },
    maxMtime: 1,
    description: sample.description ?? '',
    pkgJsonDepsDelta: sample.pkgJsonDepsDelta ?? [],
    isTestPath,
    detectRedLines,
  });
  return result.hits;
}

/** 检出 = 任一非 guard-error / 范围 / 弱化 / 过期的命中。 */
function isDetected(hits) {
  return hits.some((hit) => !NON_REDLINE_RULE_IDS.has(hit.ruleId));
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const samples = Array.isArray(fixture.samples) ? fixture.samples : [];

describe('AC-18 · 执行期守卫红线回放', () => {
  it('样本集规模 ≥ 10', () => {
    assert.ok(samples.length >= 10, `样本数 ${samples.length} < 10`);
  });

  it('逐条回放：正例召回 100%、无误报断言（仅打印）、无 guard-error', () => {
    const rows = [];
    const undetectedPositives = [];
    const missingRuleIds = [];
    const guardErrors = [];

    for (const sample of samples) {
      const hits = replay(sample);
      const detected = isDetected(hits);
      const ruleIds = [...new Set(hits.map((hit) => hit.ruleId))].sort();

      if (hits.some((hit) => hit.ruleId === 'guard-error')) {
        guardErrors.push({
          id: sample.id,
          detail: hits.find((hit) => hit.ruleId === 'guard-error').detail,
        });
      }

      if (sample.expectRedLine && !detected) {
        undetectedPositives.push(sample.id);
      }

      if (sample.expectRuleIds) {
        for (const expected of sample.expectRuleIds) {
          if (!ruleIds.includes(expected)) {
            missingRuleIds.push({ id: sample.id, expected, ruleIds });
          }
        }
      }

      rows.push({
        id: sample.id,
        source: sample.source,
        expectRedLine: Boolean(sample.expectRedLine),
        detected,
        ruleIds,
      });
    }

    const positives = samples.filter((s) => s.expectRedLine).length;
    const negatives = samples.length - positives;
    const recallHits = positives - undetectedPositives.length;
    const recall = positives === 0 ? 1 : recallHits / positives;
    const falsePositives = rows.filter((r) => !r.expectRedLine && r.detected).length;

    // 单行摘要，供 TEST.md 记录
    console.log(
      `[replay] samples=${samples.length} positives=${positives} recall=${Math.round(
        recall * 100,
      )}% falsePositives=${falsePositives}`,
    );

    // 摘要数字自洽性
    assert.equal(positives + negatives, rows.length, '正负例之和 != 样本总数');
    assert.equal(recallHits + undetectedPositives.length, positives, '召回计数不自洽');
    assert.equal(
      falsePositives,
      rows.filter((r) => !r.expectRedLine && r.detected).length,
      '误报计数不自洽',
    );

    // 无环境性失败
    assert.deepEqual(guardErrors, [], `出现 guard-error: ${JSON.stringify(guardErrors)}`);

    // 正例召回 100%（缺口即真实守缺陷，此处失败不弱化样本）
    assert.deepEqual(
      undetectedPositives,
      [],
      `正例漏检（守卫缺口，勿改样本）: ${undetectedPositives.join(', ')}`,
    );

    // 声明的 expectRuleIds 必须出现
    assert.deepEqual(
      missingRuleIds,
      [],
      `正例未命中声明的 ruleId: ${JSON.stringify(missingRuleIds)}`,
    );

    assert.equal(recall, 1, `正例召回率 ${recall * 100}% != 100%`);

    // 误报数只打印，不断言为 0（D11/D12 方向安全，误报为可接受成本）
  });
});
