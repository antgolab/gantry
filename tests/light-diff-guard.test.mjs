/**
 * light-diff-guard.test.mjs — light 出口门纯函数用例
 *
 * 用例从 AC-5 / AC-9 / AC-10 / AC-11 派生(SPEC 原文 + DESIGN 设计期澄清),
 * 不依赖任何真实 IO:isTestPath / detectRedLines / hashOf 全部用 stub 注入。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateIntentScope,
  filterByBaseline,
  checkScope,
  detectTestWeakening,
  checkVerifyFresh,
  runLightGuard,
} from '../src/lib/light-guard.mjs';

// --- 注入 stub ---

// D12 通用测试路径模式
function isTestPath(path) {
  if (/(^|\/)(tests?|__tests__|spec)\//.test(path)) return true;
  if (/\.(test|spec)\./.test(path)) return true;
  if (/_test\.go$/.test(path)) return true;
  if (/(^|\/)test_.*\.py$/.test(path)) return true;
  return false;
}

function noRedLines() {
  return { hit: false, ruleIds: [], files: [] };
}

// 默认:任何路径哈希恒为 'h'
function hashOf() {
  return 'h';
}

/**
 * 构造一份「全干净」的 runLightGuard 输入,各用例按需覆写字段。
 */
function cleanInput(overrides = {}) {
  return {
    scope: ['src/lib/foo.mjs'],
    changedFiles: ['src/lib/foo.mjs'],
    baseline: {},
    hashOf,
    testEntries: [],
    verifyRecord: { pass: true, at: 1000 },
    maxMtime: 500,
    description: '',
    isTestPath,
    detectRedLines: noRedLines,
    ...overrides,
  };
}

// --- AC-5 · 意图范围必须合法 ---

describe('AC-5 · validateIntentScope', () => {
  it('合法范围:文件路径 / 目录 / 单段 * 通配都通过', () => {
    assert.deepEqual(validateIntentScope(['src/lib/foo.mjs']), { ok: true, reason: null });
    assert.deepEqual(validateIntentScope(['src/lib/']), { ok: true, reason: null });
    assert.deepEqual(validateIntentScope(['src/lib/*.mjs']), { ok: true, reason: null });
  });

  it('空范围 → intent-scope-invalid', () => {
    const res = validateIntentScope([]);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'intent-scope-invalid');
  });

  it('非数组 → intent-scope-invalid', () => {
    assert.equal(validateIntentScope(undefined).reason, 'intent-scope-invalid');
    assert.equal(validateIntentScope('src/lib/foo.mjs').reason, 'intent-scope-invalid');
  });

  it('含 ** → intent-scope-invalid', () => {
    assert.equal(validateIntentScope(['src/**/*.mjs']).reason, 'intent-scope-invalid');
  });

  it('含空项 / 绝对路径 / .. 段 → intent-scope-invalid', () => {
    assert.equal(validateIntentScope(['src/a.mjs', '']).reason, 'intent-scope-invalid');
    assert.equal(validateIntentScope(['/etc/passwd']).reason, 'intent-scope-invalid');
    assert.equal(validateIntentScope(['src/../secret.mjs']).reason, 'intent-scope-invalid');
    assert.equal(validateIntentScope(['..']).reason, 'intent-scope-invalid');
  });

  it('空范围经 runLightGuard → 命中 intent-scope-invalid', () => {
    const res = runLightGuard(cleanInput({ scope: [], changedFiles: [] }));
    assert.equal(res.passed, false);
    assert.ok(res.hits.some((h) => h.ruleId === 'intent-scope-invalid'));
  });

  it('** 范围经 runLightGuard → 命中 intent-scope-invalid', () => {
    const res = runLightGuard(cleanInput({ scope: ['src/**/*.mjs'] }));
    assert.equal(res.passed, false);
    assert.ok(res.hits.some((h) => h.ruleId === 'intent-scope-invalid'));
  });
});

// --- AC-9 · 越界修改 ---

describe('AC-9 · checkScope', () => {
  it('范围外文件被列出', () => {
    const res = checkScope(['src/lib/foo.mjs', 'src/cli.mjs'], ['src/lib/foo.mjs']);
    assert.equal(res.ok, false);
    assert.deepEqual(res.outOfScope, ['src/cli.mjs']);
  });

  it('目录范围允许其下新建文件', () => {
    const res = checkScope(['src/lib/foo.mjs', 'src/lib/new-file.mjs'], ['src/lib/']);
    assert.equal(res.ok, true);
    assert.deepEqual(res.outOfScope, []);
  });

  it('.gantry/ 始终豁免', () => {
    const res = checkScope(['.gantry/specs/x/EXECUTION.md'], ['src/lib/foo.mjs']);
    assert.equal(res.ok, true);
  });

  it('单段 * 匹配文件名但不跨 /', () => {
    assert.equal(checkScope(['src/lib/a.mjs'], ['src/lib/*.mjs']).ok, true);
    const nested = checkScope(['src/lib/sub/a.mjs'], ['src/lib/*.mjs']);
    assert.equal(nested.ok, false);
    assert.deepEqual(nested.outOfScope, ['src/lib/sub/a.mjs']);
  });

  it('越界经 runLightGuard → 命中 out-of-scope 且带上文件', () => {
    const res = runLightGuard(cleanInput({
      scope: ['src/lib/foo.mjs'],
      changedFiles: ['src/lib/foo.mjs', 'src/cli.mjs'],
    }));
    assert.equal(res.passed, false);
    const hit = res.hits.find((h) => h.ruleId === 'out-of-scope');
    assert.ok(hit);
    assert.deepEqual(hit.files, ['src/cli.mjs']);
  });
});

// --- AC-10 · 测试弱化 ---

describe('AC-10 · detectTestWeakening', () => {
  const threeAsserts = 'it("a", () => { assert.ok(1); assert.equal(1, 1); expect(2).toBe(2); });';

  it('删除测试文件 → 命中', () => {
    const res = detectTestWeakening(
      [{ path: 'tests/a.test.mjs', status: 'D', before: threeAsserts, after: null }],
      isTestPath,
    );
    assert.equal(res.hit, true);
    assert.deepEqual(res.files, ['tests/a.test.mjs']);
  });

  it('修改测试文件且断言数净减少 → 命中', () => {
    const before = 'it("a", () => { assert.ok(1); }); it("b", () => { assert.ok(2); });';
    const after = 'it("a", () => { assert.ok(1); });';
    const res = detectTestWeakening(
      [{ path: 'tests/a.test.mjs', status: 'M', before, after }],
      isTestPath,
    );
    assert.equal(res.hit, true);
    assert.deepEqual(res.files, ['tests/a.test.mjs']);
  });

  it('新增断言 → 不命中', () => {
    const before = 'it("a", () => { assert.ok(1); });';
    const after = 'it("a", () => { assert.ok(1); assert.equal(1, 1); }); it("b", () => {});';
    const res = detectTestWeakening(
      [{ path: 'tests/a.test.mjs', status: 'M', before, after }],
      isTestPath,
    );
    assert.equal(res.hit, false);
    assert.deepEqual(res.files, []);
  });

  it('新增测试文件 → 不命中', () => {
    const res = detectTestWeakening(
      [{ path: 'tests/new.test.mjs', status: 'A', before: null, after: '' }],
      isTestPath,
    );
    assert.equal(res.hit, false);
  });

  it('非测试文件被删除 → 不算测试弱化', () => {
    const res = detectTestWeakening(
      [{ path: 'src/lib/foo.mjs', status: 'D', before: threeAsserts, after: null }],
      isTestPath,
    );
    assert.equal(res.hit, false);
  });

  it('测试弱化经 runLightGuard → 命中 test-weakened', () => {
    const res = runLightGuard(cleanInput({
      testEntries: [{ path: 'tests/a.test.mjs', status: 'D', before: threeAsserts, after: null }],
    }));
    assert.equal(res.passed, false);
    const hit = res.hits.find((h) => h.ruleId === 'test-weakened');
    assert.ok(hit);
    assert.deepEqual(hit.files, ['tests/a.test.mjs']);
  });
});

// --- AC-11 · verify 证据新鲜度 ---

describe('AC-11 · checkVerifyFresh', () => {
  it('证据早于最后一次改动 → ok=false', () => {
    assert.deepEqual(checkVerifyFresh({ pass: true, at: 100 }, 200), { ok: false });
  });

  it('证据不早于最后一次改动 → ok=true', () => {
    assert.deepEqual(checkVerifyFresh({ pass: true, at: 200 }, 200), { ok: true });
    assert.deepEqual(checkVerifyFresh({ pass: true, at: 300 }, 200), { ok: true });
  });

  it('verify 失败 → ok=false', () => {
    assert.deepEqual(checkVerifyFresh({ pass: false, at: 300 }, 200), { ok: false });
  });

  it('无记录 → ok=false', () => {
    assert.deepEqual(checkVerifyFresh(null, 200), { ok: false });
    assert.deepEqual(checkVerifyFresh(undefined, 200), { ok: false });
  });

  it('陈旧证据经 runLightGuard → 命中 stale-verify', () => {
    const res = runLightGuard(cleanInput({
      verifyRecord: { pass: true, at: 100 },
      maxMtime: 200,
    }));
    assert.equal(res.passed, false);
    assert.ok(res.hits.some((h) => h.ruleId === 'stale-verify'));
  });
});

// --- 基线过滤(D6) ---

describe('基线过滤 · filterByBaseline', () => {
  it('基线中哈希未变的文件被剔除', () => {
    const kept = filterByBaseline(
      ['src/a.mjs', 'src/b.mjs'],
      { 'src/a.mjs': 'h' },
      (path) => (path === 'src/a.mjs' ? 'h' : 'x'),
    );
    assert.deepEqual(kept, ['src/b.mjs']);
  });

  it('基线中哈希已变的文件被保留', () => {
    const kept = filterByBaseline(['src/a.mjs'], { 'src/a.mjs': 'old' }, () => 'new');
    assert.deepEqual(kept, ['src/a.mjs']);
  });

  it('hashOf 抛异常时保留该文件', () => {
    const kept = filterByBaseline(
      ['src/a.mjs'],
      { 'src/a.mjs': 'h' },
      () => { throw new Error('EIO'); },
    );
    assert.deepEqual(kept, ['src/a.mjs']);
  });

  it('基线未变文件经 runLightGuard 不产生 out-of-scope', () => {
    const res = runLightGuard(cleanInput({
      scope: ['src/lib/foo.mjs'],
      changedFiles: ['src/lib/foo.mjs', 'docs/old.md'],
      baseline: { 'docs/old.md': 'h' },
      hashOf: () => 'h',
    }));
    assert.equal(res.passed, true);
    assert.deepEqual(res.hits, []);
  });
});

// --- 红线注入 ---

describe('红线注入 · runLightGuard', () => {
  it('每个 ruleId 各记一条命中', () => {
    const res = runLightGuard(cleanInput({
      detectRedLines: () => ({ hit: true, ruleIds: ['schema-change', 'dep-change'], files: ['schema/x.sql'] }),
    }));
    assert.equal(res.passed, false);
    assert.deepEqual(res.hits.map((h) => h.ruleId), ['schema-change', 'dep-change']);
    assert.deepEqual(res.hits[0].files, ['schema/x.sql']);
  });

  it('以 description="" 和注入快照调用 detectRedLines', () => {
    let captured;
    runLightGuard(cleanInput({
      changedFiles: ['src/lib/foo.mjs'],
      pkgJsonDepsDelta: ['left-pad'],
      detectRedLines: (snapshot, description) => {
        captured = { snapshot, description };
        return noRedLines();
      },
    }));
    assert.equal(captured.description, '');
    assert.deepEqual(captured.snapshot, {
      modifiedFiles: ['src/lib/foo.mjs'],
      newFiles: [],
      pkgJsonDepsDelta: ['left-pad'],
    });
  });
});

// --- fail-closed(D14) ---

describe('guard-error · fail-closed', () => {
  it('detectRedLines 抛异常 → guard-error', () => {
    const res = runLightGuard(cleanInput({
      detectRedLines: () => { throw new Error('git exploded'); },
    }));
    assert.equal(res.passed, false);
    assert.equal(res.hits.length, 1);
    assert.equal(res.hits[0].ruleId, 'guard-error');
    assert.match(res.hits[0].detail, /git exploded/);
  });

  it('isTestPath 缺失 → guard-error', () => {
    const input = cleanInput();
    delete input.isTestPath;
    const res = runLightGuard(input);
    assert.equal(res.passed, false);
    assert.equal(res.hits[0].ruleId, 'guard-error');
  });

  it('changedFiles / testEntries / baseline 非法 → guard-error', () => {
    assert.equal(runLightGuard(cleanInput({ changedFiles: undefined })).hits[0].ruleId, 'guard-error');
    assert.equal(runLightGuard(cleanInput({ testEntries: undefined })).hits[0].ruleId, 'guard-error');
    assert.equal(runLightGuard(cleanInput({ baseline: null })).hits[0].ruleId, 'guard-error');
  });
});

// --- 全干净 ---

describe('全干净输入', () => {
  it('passed=true 且 hits 为空', () => {
    const res = runLightGuard(cleanInput());
    assert.deepEqual(res, { passed: true, hits: [] });
  });
});
