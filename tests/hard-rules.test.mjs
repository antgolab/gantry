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

describe('hard-rules 常量', () => {
  it('导出硬红线关键词列表且覆盖 7 个钦定英文关键词', () => {
    const all = HARD_RULE_KEYWORDS.flatMap((r) => r.keywords.map((k) => k.toLowerCase()));
    for (const kw of ['schema', 'migrations', 'auth', 'permission', 'crypto', 'token', 'secret']) {
      assert.ok(all.includes(kw), `缺少关键词 ${kw}`);
    }
  });

  it('导出硬红线路径 glob 列表', () => {
    const globs = HARD_RULE_PATH_GLOBS.map((r) => r.glob);
    for (const g of ['schema/*', 'migrations/*', '*.sql', 'prisma/*', 'api/*.ts', 'openapi.yaml', 'proto/*']) {
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
      assert.deepEqual(r, { hit: true, ruleId });
    });
  }

  it('中文描述「修改鉴权逻辑」→ auth-keyword', () => {
    const r = detectHardRuleHit(snap(), '修改鉴权逻辑');
    assert.deepEqual(r, { hit: true, ruleId: 'auth-keyword' });
  });
});

describe('detectHardRuleHit · 路径 glob 红线', () => {
  it('schema/*.ts 命中 → schema-change', () => {
    const r = detectHardRuleHit(snap({ modifiedFiles: ['schema/user.ts'] }), 'update types');
    assert.deepEqual(r, { hit: true, ruleId: 'schema-change' });
  });

  it('migrations/init.sql 命中 → migration-change', () => {
    const r = detectHardRuleHit(snap({ modifiedFiles: ['migrations/init.sql'] }), 'update db');
    assert.deepEqual(r, { hit: true, ruleId: 'migration-change' });
  });

  it('prisma/schema.prisma 命中 → schema-change', () => {
    const r = detectHardRuleHit(snap({ modifiedFiles: ['prisma/schema.prisma'] }), 'update orm');
    assert.deepEqual(r, { hit: true, ruleId: 'schema-change' });
  });

  it('*.sql 命中 → sql-change', () => {
    const r = detectHardRuleHit(snap({ modifiedFiles: ['db/seed.sql'] }), 'update seeds');
    assert.deepEqual(r, { hit: true, ruleId: 'sql-change' });
  });

  it('api/*.ts 命中 → contract-change', () => {
    const r = detectHardRuleHit(snap({ modifiedFiles: ['api/users.ts'] }), 'update handler');
    assert.deepEqual(r, { hit: true, ruleId: 'contract-change' });
  });

  it('openapi.yaml 命中 → contract-change', () => {
    const r = detectHardRuleHit(snap({ modifiedFiles: ['openapi.yaml'] }), 'update spec');
    assert.deepEqual(r, { hit: true, ruleId: 'contract-change' });
  });

  it('proto/* 命中 → contract-change', () => {
    const r = detectHardRuleHit(snap({ modifiedFiles: ['proto/order.proto'] }), 'update proto');
    assert.deepEqual(r, { hit: true, ruleId: 'contract-change' });
  });
});

describe('detectHardRuleHit · 跨模块 / 依赖', () => {
  it('modifiedFiles 分布在 ≥3 个顶层目录 → cross-module-change', () => {
    const r = detectHardRuleHit(
      snap({ modifiedFiles: ['src/lib/a.mjs', 'tests/a.test.mjs', 'docs/readme.md'] }),
      'fix something',
    );
    assert.deepEqual(r, { hit: true, ruleId: 'cross-module-change' });
  });

  it('modifiedFiles 分布在 2 个顶层目录不触发跨模块', () => {
    const r = detectHardRuleHit(
      snap({ modifiedFiles: ['src/a.mjs', 'tests/a.test.mjs'] }),
      'fix something',
    );
    assert.deepEqual(r, { hit: false, ruleId: null });
  });

  it('pkgJsonDepsDelta 非空 → dep-change', () => {
    const r = detectHardRuleHit(
      snap({ modifiedFiles: ['src/foo.mjs'], pkgJsonDepsDelta: ['wink-bm25-text-search'] }),
      'add dependency',
    );
    assert.deepEqual(r, { hit: true, ruleId: 'dep-change' });
  });
});

describe('detectHardRuleHit · 非红线', () => {
  it('纯文档改动 → hit=false', () => {
    const r = detectHardRuleHit(snap({ modifiedFiles: ['README.md'] }), 'fix typo in README');
    assert.deepEqual(r, { hit: false, ruleId: null });
  });

  it('空 snapshot + 空描述 → hit=false (不抛异常)', () => {
    const r = detectHardRuleHit({}, '');
    assert.deepEqual(r, { hit: false, ruleId: null });
  });
});
