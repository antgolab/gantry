import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp } from '../src/lib/hard-rules.mjs';

function matches(glob, str) {
  return globToRegExp(glob).test(str);
}

describe('globToRegExp · minimatch 子集', () => {
  describe('AC-13 · 单星不跨斜杠', () => {
    it('src/*.mjs 不匹配 src/lib/foo.mjs', () => {
      assert.equal(matches('src/*.mjs', 'src/lib/foo.mjs'), false);
    });

    it('src/*.mjs 匹配 src/foo.mjs', () => {
      assert.equal(matches('src/*.mjs', 'src/foo.mjs'), true);
    });
  });

  describe('AC-14 · 双星跨斜杠 (src/**/*.mjs)', () => {
    it('匹配 src/foo.mjs (0 层目录)', () => {
      assert.equal(matches('src/**/*.mjs', 'src/foo.mjs'), true);
    });

    it('匹配 src/lib/foo.mjs (1 层目录)', () => {
      assert.equal(matches('src/**/*.mjs', 'src/lib/foo.mjs'), true);
    });

    it('匹配 src/lib/nested/deep/foo.mjs (多层目录)', () => {
      assert.equal(matches('src/**/*.mjs', 'src/lib/nested/deep/foo.mjs'), true);
    });

    it('不匹配 tests/foo.mjs', () => {
      assert.equal(matches('src/**/*.mjs', 'tests/foo.mjs'), false);
    });
  });

  describe('AC-15 · 其他元字符保持转义', () => {
    it('src/file.v1.mjs 不匹配 src/fileAv1.mjs (. 不通配)', () => {
      assert.equal(matches('src/file.v1.mjs', 'src/fileAv1.mjs'), false);
    });

    it('src/file.v1.mjs 匹配 src/file.v1.mjs', () => {
      assert.equal(matches('src/file.v1.mjs', 'src/file.v1.mjs'), true);
    });
  });

  describe('edge · 空 glob / 纯 ** / 多个 * 混用', () => {
    it('空 glob 只匹配空字符串', () => {
      assert.equal(matches('', ''), true);
      assert.equal(matches('', 'a'), false);
    });

    it('纯 ** 匹配任意路径 (含跨斜杠)', () => {
      assert.equal(matches('**', 'a/b/c.mjs'), true);
      assert.equal(matches('**', ''), true);
    });

    it('多个单星混用: src/*/*.mjs 只匹配一层目录', () => {
      assert.equal(matches('src/*/*.mjs', 'src/lib/foo.mjs'), true);
      assert.equal(matches('src/*/*.mjs', 'src/foo.mjs'), false);
      assert.equal(matches('src/*/*.mjs', 'src/lib/nested/foo.mjs'), false);
    });

    it('** 与 * 混用: src/**/file*.mjs 匹配 0 层与多层', () => {
      assert.equal(matches('src/**/file*.mjs', 'src/fileA.mjs'), true);
      assert.equal(matches('src/**/file*.mjs', 'src/lib/fileB.mjs'), true);
      assert.equal(matches('src/**/file*.mjs', 'src/a/b/fileC.mjs'), true);
      assert.equal(matches('src/**/file*.mjs', 'src/lib/nope.mjs'), false);
    });
  });
});
