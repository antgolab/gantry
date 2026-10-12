import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HARD_RULE_KEYWORDS,
  HARD_RULE_PATH_GLOBS,
  HARD_RULE_MODULE_COUNT_THRESHOLD,
  detectHardRuleHit,
} from '../src/lib/hard-rules.mjs';

function snap({ modifiedFiles = ['src/foo.mjs'], newFiles = [], pkgJsonDepsDelta = [] } = {}) {
  return { modifiedFiles, newFiles, pkgJsonDepsDelta };
}

/** 断言命中,且 ruleId 与 ruleIds 一致 (ruleId 为首个命中)。 */
function assertHit(r, ruleId) {
  assert.equal(r.hit, true);
  assert.equal(r.ruleId, ruleId);
  assert.ok(r.ruleIds.includes(ruleId), `ruleIds 应包含 ${ruleId},实际 ${JSON.stringify(r.ruleIds)}`);
}

/** 断言未命中。 */
function assertNoHit(r) {
  assert.equal(r.hit, false);
  assert.equal(r.ruleId, null);
  assert.deepEqual(r.ruleIds, []);
}

describe('hard-rules 常量', () => {
  it('导出硬红线关键词列表且覆盖 7 个钦定英文关键词', () => {
    const all = HARD_RULE_KEYWORDS.flatMap((r) => r.keywords.map((k) => k.toLowerCase()));
    for (const kw of ['schema', 'migrations', 'auth', 'permission', 'crypto', 'token', 'secret']) {
      assert.ok(all.includes(kw), `缺少关键词 ${kw}`);
    }
  });

  it('导出硬红线路径 glob 列表', () => {
    const globs = HARD_RULE_PATH_GLOBS.map((r) => r.glob);
    // T-FIX-10: 单段 * → ** 覆盖嵌套路径（B7）
    for (const g of ['schema/**', 'migrations/**', '**/*.sql', 'prisma/**', 'api/**/*.ts', 'openapi.yaml', 'proto/**']) {
      assert.ok(globs.includes(g), `缺少 glob ${g}`);
    }
  });

  it('模块数阈值恒等于 3', () => {
    assert.equal(HARD_RULE_MODULE_COUNT_THRESHOLD, 3);
  });
});

describe('detectHardRuleHit · 关键词红线', () => {
  const cases = [
    ['schema', 'schema-change'],
    ['migrations', 'migration-change'],
    ['auth', 'auth-keyword'],
    ['permission', 'permission-keyword'],
    ['crypto', 'crypto-keyword'],
    ['token', 'token-keyword'],
    ['secret', 'secret-keyword'],
  ];
  for (const [kw, ruleId] of cases) {
    it(`描述含 "${kw}" → ${ruleId}`, () => {
      const r = detectHardRuleHit(snap(), `add ${kw} logic`);
      assertHit(r, ruleId);
    });
  }

  it('中文描述「修改鉴权逻辑」→ auth-keyword', () => {
    const r = detectHardRuleHit(snap(), '修改鉴权逻辑');
    assertHit(r, 'auth-keyword');
  });
});

describe('detectHardRuleHit · 路径 glob 红线', () => {
  it('schema/*.ts 命中 → schema-change', () => {
    const r = detectHardRuleHit(snap({ modifiedFiles: ['schema/user.ts'] }), 'update types');
    assertHit(r, 'schema-change');
  });

  it('migrations/init.sql 命中 → migration-change', () => {
    const r = detectHardRuleHit(snap({ modifiedFiles: ['migrations/init.sql'] }), 'update db');
    assertHit(r, 'migration-change');
  });

  it('prisma/schema.prisma 命中 → schema-change', () => {
    const r = detectHardRuleHit(snap({ modifiedFiles: ['prisma/schema.prisma'] }), 'update orm');
    assertHit(r, 'schema-change');
  });

  it('*.sql 命中 → sql-change', () => {
    const r = detectHardRuleHit(snap({ modifiedFiles: ['db/seed.sql'] }), 'update seeds');
    assertHit(r, 'sql-change');
  });

  it('api/*.ts 命中 → contract-change', () => {
    const r = detectHardRuleHit(snap({ modifiedFiles: ['api/users.ts'] }), 'update handler');
    assertHit(r, 'contract-change');
  });

  it('openapi.yaml 命中 → contract-change', () => {
    const r = detectHardRuleHit(snap({ modifiedFiles: ['openapi.yaml'] }), 'update spec');
    assertHit(r, 'contract-change');
  });

  it('proto/* 命中 → contract-change', () => {
    const r = detectHardRuleHit(snap({ modifiedFiles: ['proto/order.proto'] }), 'update proto');
    assertHit(r, 'contract-change');
  });
});

describe('detectHardRuleHit · 跨模块 / 依赖', () => {
  it('modifiedFiles 分布在 ≥3 个顶层目录 → cross-module-change', () => {
    // D11: 跨模块只统计非测试、非文档路径;此处用三个代码目录以仍能证明该规则。
    const r = detectHardRuleHit(
      snap({ modifiedFiles: ['src/a.mjs', 'lib/b.mjs', 'bin/c.mjs'] }),
      'fix something',
    );
    assertHit(r, 'cross-module-change');
  });

  it('modifiedFiles 分布在 2 个顶层目录不触发跨模块', () => {
    const r = detectHardRuleHit(
      snap({ modifiedFiles: ['src/a.mjs', 'tests/a.test.mjs'] }),
      'fix something',
    );
    assertNoHit(r);
  });

  it('pkgJsonDepsDelta 非空 → dep-change', () => {
    const r = detectHardRuleHit(
      snap({ modifiedFiles: ['src/foo.mjs'], pkgJsonDepsDelta: ['wink-bm25-text-search'] }),
      'add dependency',
    );
    assertHit(r, 'dep-change');
  });
});

describe('detectHardRuleHit · 非红线', () => {
  it('纯文档改动 → hit=false', () => {
    const r = detectHardRuleHit(snap({ modifiedFiles: ['README.md'] }), 'fix typo in README');
    assertNoHit(r);
  });

  it('空 snapshot + 空描述 → hit=false (不抛异常)', () => {
    const r = detectHardRuleHit({}, '');
    assertNoHit(r);
  });
});
