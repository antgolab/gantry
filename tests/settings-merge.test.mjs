import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  mergeSettingsJson,
  unmergeSettingsJson,
  readManaged,
  writeManaged,
} from '../src/lib/settings-merge.mjs';

let tmpDir;

beforeEach(() => {
  tmpDir = join(import.meta.dirname, '..', '.test-tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

const settingsPath = () => join(tmpDir, '.claude', 'settings.json');
const sideFilePath = () => join(tmpDir, '.gantry', 'planning', 'managed-permissions.json');

describe('mergeSettingsJson', () => {
  it('无 settings.json 时创建并写入 permissions.allow（原子写，无 .tmp 残留）', () => {
    const path = settingsPath();
    const added = mergeSettingsJson(path, { 'permissions.allow': ['Bash(gantry *)'] });

    assert.deepEqual(added, { 'permissions.allow': ['Bash(gantry *)'] });
    assert.ok(existsSync(path), 'settings.json 应被创建');
    assert.ok(!existsSync(path + '.tmp'), 'rename 成功后不应残留 .tmp');
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(settings.permissions.allow, ['Bash(gantry *)']);
  });

  it('有文件但无 permissions.allow 字段时补齐并保留其它字段', () => {
    const path = settingsPath();
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    writeFileSync(path, JSON.stringify({
      model: 'opus',
      hooks: { PostToolUse: [{ matcher: 'Read', hooks: [] }] },
    }, null, 2));

    mergeSettingsJson(path, { 'permissions.allow': ['Bash(gantry *)'] });

    const settings = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(settings.model, 'opus');
    assert.deepEqual(settings.hooks, { PostToolUse: [{ matcher: 'Read', hooks: [] }] });
    assert.deepEqual(settings.permissions.allow, ['Bash(gantry *)']);
  });

  it('已有 allow 合并去重不覆盖顺序，deny/ask 保持不变', () => {
    const path = settingsPath();
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    writeFileSync(path, JSON.stringify({
      permissions: {
        allow: ['Bash(git *)', 'Bash(node *)'],
        deny: ['Read(**/secret/**)'],
        ask: ['WebSearch'],
      },
    }, null, 2));

    const added = mergeSettingsJson(path, { 'permissions.allow': ['Bash(gantry *)'] });

    assert.deepEqual(added, { 'permissions.allow': ['Bash(gantry *)'] });
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(settings.permissions.allow, ['Bash(git *)', 'Bash(node *)', 'Bash(gantry *)']);
    assert.deepEqual(settings.permissions.deny, ['Read(**/secret/**)']);
    assert.deepEqual(settings.permissions.ask, ['WebSearch']);
  });

  it('幂等：二次合并不重复', () => {
    const path = settingsPath();
    const first = mergeSettingsJson(path, { 'permissions.allow': ['Bash(gantry *)'] });
    const second = mergeSettingsJson(path, { 'permissions.allow': ['Bash(gantry *)'] });

    assert.deepEqual(first, { 'permissions.allow': ['Bash(gantry *)'] });
    assert.deepEqual(second, {});
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(settings.permissions.allow.filter(e => e === 'Bash(gantry *)').length, 1);
  });

  it('deny 冲突打印 stderr 警告但不影响写入', () => {
    const path = settingsPath();
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    writeFileSync(path, JSON.stringify({
      permissions: { deny: ['Bash(gantry *)'] },
    }, null, 2));

    const captured = [];
    const original = process.stderr.write;
    process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
    try {
      mergeSettingsJson(path, { 'permissions.allow': ['Bash(gantry *)'] });
    } finally {
      process.stderr.write = original;
    }

    assert.ok(captured.some(w => w.includes('deny')), '应打印 deny 冲突警告');
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(settings.permissions.allow, ['Bash(gantry *)']);
    assert.deepEqual(settings.permissions.deny, ['Bash(gantry *)']);
  });

  it('JSON.parse 失败 throw（D6）', () => {
    const path = settingsPath();
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    writeFileSync(path, '{ not valid json');

    assert.throws(() => mergeSettingsJson(path, { 'permissions.allow': ['Bash(gantry *)'] }));
  });
});

describe('unmergeSettingsJson', () => {
  it('正常反向删除保留用户手加条目', () => {
    const path = settingsPath();
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    writeFileSync(path, JSON.stringify({
      permissions: { allow: ['Bash(git *)', 'Bash(gantry *)'] },
    }, null, 2));

    unmergeSettingsJson(path, { 'permissions.allow': ['Bash(gantry *)'] });

    const settings = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(settings.permissions.allow, ['Bash(git *)']);
  });

  it('数组清空后保留空数组不删字段', () => {
    const path = settingsPath();
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    writeFileSync(path, JSON.stringify({
      permissions: { allow: ['Bash(gantry *)'], deny: [] },
    }, null, 2));

    unmergeSettingsJson(path, { 'permissions.allow': ['Bash(gantry *)'] });

    const settings = JSON.parse(readFileSync(path, 'utf8'));
    assert.ok('allow' in settings.permissions, 'allow 字段应保留');
    assert.deepEqual(settings.permissions.allow, []);
    assert.deepEqual(settings.permissions.deny, []);
  });

  it('AC-8 状态漂移静默跳过（登记条目已不存在）', () => {
    const path = settingsPath();
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    writeFileSync(path, JSON.stringify({
      permissions: { allow: ['Bash(git *)'] },
    }, null, 2));

    assert.doesNotThrow(() => unmergeSettingsJson(path, { 'permissions.allow': ['Bash(gantry *)'] }));
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(settings.permissions.allow, ['Bash(git *)']);
  });

  it('settings.json 不存在时静默返回不创建文件', () => {
    const path = settingsPath();
    assert.doesNotThrow(() => unmergeSettingsJson(path, { 'permissions.allow': ['Bash(gantry *)'] }));
    assert.ok(!existsSync(path), '不存在时不应创建 settings.json');
  });
});

describe('readManaged / writeManaged', () => {
  it('readManaged 文件不存在返回 {}', () => {
    assert.deepEqual(readManaged(sideFilePath()), {});
  });

  it('writeManaged 首次写 + 追加去重', () => {
    const side = sideFilePath();
    writeManaged(side, { 'permissions.allow': ['Bash(gantry *)'] });
    assert.deepEqual(JSON.parse(readFileSync(side, 'utf8')), { 'permissions.allow': ['Bash(gantry *)'] });
    assert.ok(!existsSync(side + '.tmp'), 'rename 成功后不应残留 .tmp');

    writeManaged(side, { 'permissions.allow': ['Bash(gantry *)', 'Bash(git *)'] });
    const managed = JSON.parse(readFileSync(side, 'utf8'));
    assert.deepEqual(managed['permissions.allow'], ['Bash(gantry *)', 'Bash(git *)']);
    assert.deepEqual(readManaged(side), { 'permissions.allow': ['Bash(gantry *)', 'Bash(git *)'] });
  });
});
