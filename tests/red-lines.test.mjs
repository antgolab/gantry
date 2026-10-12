import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectHardRuleHit,
  detectRedLines,
  isTestPath,
} from '../src/lib/hard-rules.mjs';

function snap({ modifiedFiles = ['src/foo.mjs'], newFiles = [], pkgJsonDepsDelta = [] } = {}) {
  return { modifiedFiles, newFiles, pkgJsonDepsDelta };
}

describe('D10 · 英文关键词词边界', () => {
  const negatives = [
    ['author', 'refactor the author module'],
    ['tokenizer', 'fix tokenizer bug'],
    ['authored', 'authored by team'],
    // D36: 原负例「permissions 不命中」已改为下方正例 —— 它锁住的正是复数漏判缺陷,
    // D10 的本意只是挡 author / tokenizer 这类子串误命中。
  ];
  for (const [kw, description] of negatives) {
    it(`"${kw}" 不命中 (${description})`, () => {
      const r = detectHardRuleHit({}, description);
      assert.equal(r.hit, false, `不应命中,实际 ruleIds=${JSON.stringify(r.ruleIds)}`);
    });
  }

  // D36 · 屈折形式(复数 / 过去式)照样命中
  const inflected = [
    ['update permissions', 'permission-keyword'],
    ['rotate secrets', 'secret-keyword'],
    ['add tokens', 'token-keyword'],
    ['drop tables', 'schema-change'],
    ['deleted old files', 'destructive-keyword'],
    ['removed endpoint', 'destructive-keyword'],
    ['renamed module', 'destructive-keyword'],
    // 归档 install-claude-code-claude-settings 的真实描述
    ['合并 Bash(gantry *) 到 permissions.allow', 'permission-keyword'],
  ];
  for (const [description, ruleId] of inflected) {
    it(`D36 · "${description}" → ${ruleId}`, () => {
      const r = detectHardRuleHit({}, description);
      assert.equal(r.hit, true, `未命中,实际 ruleIds=${JSON.stringify(r.ruleIds)}`);
      assert.ok(r.ruleIds.includes(ruleId), `ruleIds=${JSON.stringify(r.ruleIds)} 应包含 ${ruleId}`);
    });
  }

  it('"add auth logic" 命中 auth-keyword', () => {
    const r = detectHardRuleHit({}, 'add auth logic');
    assert.equal(r.hit, true);
    assert.ok(r.ruleIds.includes('auth-keyword'));
  });

  it('"add migrations script" 命中 migration-change', () => {
    const r = detectHardRuleHit({}, 'add migrations script');
    assert.ok(r.ruleIds.includes('migration-change'));
  });
});

describe('D10 · 新吸收类别 (英文 + 中文正例)', () => {
  const cases = [
    ['contract-keyword', 'grpc service refactor', '公共接口调整'],
    ['cross-module-keyword', 'cross-module refactor', '跨模块重构'],
    ['dependency-keyword', 'third-party library bump', '依赖升级'],
    ['security-keyword', 'authentication flow change', '支付逻辑调整'],
    ['concurrency-keyword', 'async worker tuning', '并发处理优化'],
    ['destructive-keyword', 'remove legacy code', '删除旧接口'],
  ];
  for (const [ruleId, en, zh] of cases) {
    it(`英文 "${en}" → ${ruleId}`, () => {
      const r = detectHardRuleHit({}, en);
      assert.equal(r.hit, true);
      assert.ok(r.ruleIds.includes(ruleId), `ruleIds=${JSON.stringify(r.ruleIds)}`);
    });
    it(`中文 "${zh}" → ${ruleId}`, () => {
      const r = detectHardRuleHit({}, zh);
      assert.equal(r.hit, true);
      assert.ok(r.ruleIds.includes(ruleId), `ruleIds=${JSON.stringify(r.ruleIds)}`);
    });
  }
});

describe('detectHardRuleHit · ruleIds 集合 / files', () => {
  it('ruleIds 收集多个命中且去重', () => {
    const r = detectHardRuleHit({}, '删除 schema 并加 auth');
    assert.equal(r.hit, true);
    assert.deepEqual(r.ruleIds, ['schema-change', 'auth-keyword', 'destructive-keyword']);
    assert.equal(r.ruleId, 'schema-change'); // precedence: 首个命中
  });

  it('路径命中时 files 填充触发文件', () => {
    const r = detectHardRuleHit(snap({ modifiedFiles: ['schema/user.ts'] }), 'tweak');
    assert.equal(r.hit, true);
    assert.ok(r.ruleIds.includes('schema-change'));
    assert.deepEqual(r.files, ['schema/user.ts']);
  });

  it('未命中时 files/ruleIds 为空', () => {
    const r = detectHardRuleHit(snap({ modifiedFiles: ['README.md'] }), 'fix typo');
    assert.deepEqual(r, { hit: false, ruleId: null, ruleIds: [], files: [] });
  });

  it('detectRedLines 是 detectHardRuleHit 的等价别名', () => {
    const a = detectHardRuleHit(snap({ modifiedFiles: ['schema/user.ts'] }), 'add auth');
    const b = detectRedLines(snap({ modifiedFiles: ['schema/user.ts'] }), 'add auth');
    assert.deepEqual(b, a);
  });
});

describe('T-FIX-10 (B7) · 红线目录 glob 覆盖嵌套路径', () => {
  const nestedPositives = [
    ['migrations/2026/001.ts', 'migration-change'],
    ['prisma/sub/x.prisma', 'schema-change'],
    ['proto/v1/a.proto', 'contract-change'],
    ['api/v1/users.ts', 'contract-change'],
    // 根目录 .sql:`**/*.sql` 要求至少一个 `/`,由单独的 `*.sql` 覆盖
    ['001.sql', 'sql-change'],
  ];
  for (const [file, ruleId] of nestedPositives) {
    it(`嵌套路径 ${file} → ${ruleId}`, () => {
      const r = detectHardRuleHit(snap({ modifiedFiles: [file] }), 'chore');
      assert.equal(r.hit, true, `未命中,实际 ruleIds=${JSON.stringify(r.ruleIds)}`);
      assert.ok(
        r.ruleIds.includes(ruleId),
        `ruleIds=${JSON.stringify(r.ruleIds)} 应包含 ${ruleId}`,
      );
    });
  }

  // 锚定在 `dir/` 前缀,相似名的非红线路径不得被误伤。
  const lookalikes = ['src/migrations-helper.mjs', 'docs/schema.md'];
  for (const file of lookalikes) {
    it(`相似路径 ${file} 不命中 schema-change / migration-change`, () => {
      const r = detectHardRuleHit(snap({ modifiedFiles: [file] }), 'chore');
      assert.ok(!r.ruleIds.includes('schema-change'), `误命中 schema-change: ${JSON.stringify(r.ruleIds)}`);
      assert.ok(!r.ruleIds.includes('migration-change'), `误命中 migration-change: ${JSON.stringify(r.ruleIds)}`);
    });
  }
});

describe('D11 · 跨模块排除测试与文档路径', () => {
  it('代码 + 测试 + 文档三处 → 不命中跨模块', () => {
    const r = detectHardRuleHit(
      snap({ modifiedFiles: ['src/a.mjs', 'tests/a.test.mjs', 'docs/a.md'] }),
      'fix something',
    );
    assert.equal(r.hit, false, `ruleIds=${JSON.stringify(r.ruleIds)}`);
    assert.ok(!r.ruleIds.includes('cross-module-change'));
  });

  it('三个代码顶层目录 → 命中跨模块且 files 列出参与文件', () => {
    const r = detectHardRuleHit(
      snap({ modifiedFiles: ['src/a.mjs', 'lib/b.mjs', 'bin/c.mjs'] }),
      'fix something',
    );
    assert.equal(r.hit, true);
    assert.equal(r.ruleId, 'cross-module-change');
    assert.ok(r.ruleIds.includes('cross-module-change'));
    assert.deepEqual(r.files, ['src/a.mjs', 'lib/b.mjs', 'bin/c.mjs']);
  });

  it('两个代码目录 + 测试 + 文档 → 仅 2 个代码目录,不命中', () => {
    const r = detectHardRuleHit(
      snap({ modifiedFiles: ['src/a.mjs', 'lib/b.mjs', 'tests/a.test.mjs', 'docs/a.md'] }),
      'chore',
    );
    assert.equal(r.hit, false, `ruleIds=${JSON.stringify(r.ruleIds)}`);
  });
});

describe('D12 · isTestPath', () => {
  const positives = [
    'tests/a.mjs',
    'src/tests/a.mjs',
    'test/unit/a.mjs',
    '__tests__/a.js',
    'spec/foo.ts',
    'src/lib/a.test.mjs',
    'lib/b.spec.ts',
    'cmd/main_test.go',
    'test_foo.py',
    'pkg/test_bar.py',
  ];
  for (const p of positives) {
    it(`测试路径: ${p}`, () => assert.equal(isTestPath(p), true));
  }

  const negatives = [
    'src/a.mjs',
    'lib/index.js',
    'docs/a.md',
    'src/testlib.mjs',
    'src/testing/a.mjs',
    'src/mytest.go',
    'mytest_foo.py',
    'src/latest.mjs',
  ];
  for (const p of negatives) {
    it(`非测试路径: ${p}`, () => assert.equal(isTestPath(p), false));
  }
});

describe('AC-12 · 创建期与执行期关键词判定一致 (幂等)', () => {
  const descriptions = [
    'add auth logic',
    '删除 schema 并加 auth',
    'third-party library bump 与 依赖升级',
    'cross-module refactor',
  ];
  for (const description of descriptions) {
    it(`同一描述两次调用空快照 → 相同 ruleIds (${description})`, () => {
      const a = detectHardRuleHit({}, description);
      const b = detectHardRuleHit({}, description);
      assert.deepEqual(b.ruleIds, a.ruleIds);
      assert.deepEqual(b, a);
    });
  }
});
