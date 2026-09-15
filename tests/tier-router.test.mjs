import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideTier } from '../src/lib/tier-router.mjs';

function snap({ modifiedFiles = ['src/foo.mjs'], newFiles = [], pkgJsonDepsDelta = [] } = {}) {
  return { modifiedFiles, newFiles, pkgJsonDepsDelta };
}

describe('AC-1 · Micro 档判定 (软打分 0)', () => {
  it('纯 README 改动 → micro', () => {
    const r = decideTier('fix: 更新 README 的 npm 命令', snap({ modifiedFiles: ['README.md'] }));
    assert.deepEqual(r, { tier: 'micro', hits: [], score: 0 });
  });

  it('纯文档改动 → micro', () => {
    const r = decideTier('update docs', snap({ modifiedFiles: ['docs/guide.md'] }));
    assert.deepEqual(r, { tier: 'micro', hits: [], score: 0 });
  });
});

describe('AC-2 · 硬红线强制 full (每类 ruleId ≥1)', () => {
  const cases = [
    ['描述含 schema → schema-change', snap({ modifiedFiles: ['src/a.mjs'] }), 'add schema to model', 'schema-change'],
    ['描述含 auth → auth-keyword', snap({ modifiedFiles: ['src/a.mjs'] }), 'add auth logic', 'auth-keyword'],
    ['schema/* 路径 → schema-change', snap({ modifiedFiles: ['schema/user.ts'] }), 'update types', 'schema-change'],
    ['migrations/* 路径 → migration-change', snap({ modifiedFiles: ['migrations/init.sql'] }), 'update db', 'migration-change'],
    ['*.sql 路径 → sql-change', snap({ modifiedFiles: ['db/seed.sql'] }), 'update seeds', 'sql-change'],
    ['prisma/* 路径 → schema-change', snap({ modifiedFiles: ['prisma/schema.prisma'] }), 'update orm', 'schema-change'],
    ['api/*.ts 路径 → contract-change', snap({ modifiedFiles: ['api/users.ts'] }), 'update handler', 'contract-change'],
    ['openapi.yaml → contract-change', snap({ modifiedFiles: ['openapi.yaml'] }), 'update spec', 'contract-change'],
    ['proto/* 路径 → contract-change', snap({ modifiedFiles: ['proto/order.proto'] }), 'update proto', 'contract-change'],
    ['依赖增量 → dep-change', snap({ modifiedFiles: ['src/a.mjs'], pkgJsonDepsDelta: ['wink-bm25-text-search'] }), 'add dependency', 'dep-change'],
    ['跨模块 (3 顶层目录) → cross-module-change', snap({ modifiedFiles: ['src/lib/a.mjs', 'tests/a.test.mjs', 'docs/readme.md'] }), 'fix something', 'cross-module-change'],
  ];

  for (const [name, snapshot, description, ruleId] of cases) {
    it(`${name}`, () => {
      const r = decideTier(description, snapshot);
      assert.equal(r.tier, 'full');
      assert.deepEqual(r.hits, [ruleId]);
    });
  }

  it('硬红线命中时软打分低也强制 full (override)', () => {
    // 单文件文档 + 无新增 + 无依赖,软打分本应 0 → 但 schema 关键词触发硬红线
    const r = decideTier('add schema to README', snap({ modifiedFiles: ['README.md'] }));
    assert.deepEqual(r, { tier: 'full', hits: ['schema-change'], score: 0 });
  });

  it('硬红线优先于软打分: 命中硬红线时 hits 只含 ruleId,不含软信号', () => {
    const r = decideTier('refactor maybe add auth', snap({ modifiedFiles: ['src/a.mjs', 'src/b.mjs'], newFiles: ['src/c.mjs'] }));
    assert.deepEqual(r, { tier: 'full', hits: ['auth-keyword'], score: 0 });
  });
});

describe('AC-3 · 软打分档位边界 (0/1/2/3/4/5)', () => {
  const cases = [
    {
      name: 'score=0 → micro',
      description: 'fix typo',
      snapshot: snap({ modifiedFiles: ['README.md'] }),
      expected: { tier: 'micro', hits: [], score: 0 },
    },
    {
      name: 'score=1 → light (仅歧义词)',
      description: 'maybe fix this',
      snapshot: snap({ modifiedFiles: ['src/a.mjs'] }),
      expected: { tier: 'light', hits: ['soft:ambiguous'], score: 1 },
    },
    {
      name: 'score=2 → light (多文件 + 重构关键词)',
      description: 'refactor helper',
      snapshot: snap({ modifiedFiles: ['src/a.mjs', 'src/b.mjs'] }),
      expected: { tier: 'light', hits: ['soft:multi-file', 'soft:refactor-keyword'], score: 2 },
    },
    {
      name: 'score=3 → full (多文件 + 新增 + 重构)',
      description: 'refactor helper',
      snapshot: snap({ modifiedFiles: ['src/a.mjs', 'src/b.mjs'], newFiles: ['src/c.mjs'] }),
      expected: { tier: 'full', hits: ['soft:multi-file', 'soft:new-file', 'soft:refactor-keyword'], score: 3 },
    },
    {
      name: 'score=4 → full (多文件 + 新增 + 重构 + config 前缀)',
      description: 'refactor config',
      snapshot: snap({ modifiedFiles: ['config/a.mjs', 'config/b.mjs'], newFiles: ['config/c.mjs'] }),
      expected: {
        tier: 'full',
        hits: ['soft:multi-file', 'soft:new-file', 'soft:refactor-keyword', 'soft:config-infra'],
        score: 4,
      },
    },
    {
      name: 'score=5 → full (多文件 + 新增 + 重构 + config 前缀 + 歧义)',
      description: 'refactor config maybe',
      snapshot: snap({ modifiedFiles: ['config/a.mjs', 'config/b.mjs'], newFiles: ['config/c.mjs'] }),
      expected: {
        tier: 'full',
        hits: ['soft:multi-file', 'soft:new-file', 'soft:refactor-keyword', 'soft:config-infra', 'soft:ambiguous'],
        score: 5,
      },
    },
  ];

  for (const { name, description, snapshot, expected } of cases) {
    it(name, () => {
      assert.deepEqual(decideTier(description, snapshot), expected);
    });
  }
});

describe('软打分信号独立命中', () => {
  it('config/ 前缀单独命中 soft:config-infra', () => {
    const r = decideTier('tweak', snap({ modifiedFiles: ['config/app.json'] }));
    assert.deepEqual(r, { tier: 'light', hits: ['soft:config-infra'], score: 1 });
  });

  it('infra/ 前缀单独命中 soft:config-infra', () => {
    const r = decideTier('tweak', snap({ modifiedFiles: ['infra/terragrunt.hcl'] }));
    assert.deepEqual(r, { tier: 'light', hits: ['soft:config-infra'], score: 1 });
  });

  it('新增文件单独命中 soft:new-file', () => {
    const r = decideTier('add helper', snap({ modifiedFiles: ['src/a.mjs'], newFiles: ['src/b.mjs'] }));
    assert.deepEqual(r, { tier: 'light', hits: ['soft:new-file'], score: 1 });
  });

  it('中文重构关键词「重构」命中 soft:refactor-keyword', () => {
    const r = decideTier('重构工具模块', snap({ modifiedFiles: ['src/a.mjs'] }));
    assert.deepEqual(r, { tier: 'light', hits: ['soft:refactor-keyword'], score: 1 });
  });

  it('大小写不敏感: 英文 Refactor 命中 soft:refactor-keyword', () => {
    const r = decideTier('Refactor the module', snap({ modifiedFiles: ['src/a.mjs'] }));
    assert.deepEqual(r, { tier: 'light', hits: ['soft:refactor-keyword'], score: 1 });
  });
});

describe('空输入防御', () => {
  it('空 snapshot + 空描述 → micro (不抛异常)', () => {
    assert.deepEqual(decideTier('', {}), { tier: 'micro', hits: [], score: 0 });
  });
});
