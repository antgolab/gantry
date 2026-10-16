import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildManagedEntries } from '../src/lib/install-helpers.mjs';

describe('buildManagedEntries', () => {
  it('只有 addToAllow 时只拼 addToAllow', () => {
    assert.deepEqual(
      buildManagedEntries({ addToAllow: ['Bash(gantry *)'] }),
      { 'permissions.allow': ['Bash(gantry *)'] },
    );
  });

  it('同时有 addToAllow + legacyAliases 时按顺序拼接且不去重', () => {
    assert.deepEqual(
      buildManagedEntries({ addToAllow: ['Bash(gantry *)'], legacyAliases: ['Bash(gantry status *)'] }),
      { 'permissions.allow': ['Bash(gantry *)', 'Bash(gantry status *)'] },
    );
    // 不去重：重复条目原样保留，由调用方决定去重策略
    assert.deepEqual(
      buildManagedEntries({ addToAllow: ['x'], legacyAliases: ['x'] }),
      { 'permissions.allow': ['x', 'x'] },
    );
  });

  it('legacyAliases 为 undefined 或空数组时只返回 addToAllow', () => {
    assert.deepEqual(
      buildManagedEntries({ addToAllow: ['a'], legacyAliases: undefined }),
      { 'permissions.allow': ['a'] },
    );
    assert.deepEqual(
      buildManagedEntries({ addToAllow: ['a'], legacyAliases: [] }),
      { 'permissions.allow': ['a'] },
    );
  });

  it('addToAllow 为空数组时返回空的 permissions.allow', () => {
    assert.deepEqual(
      buildManagedEntries({ addToAllow: [] }),
      { 'permissions.allow': [] },
    );
  });
});
