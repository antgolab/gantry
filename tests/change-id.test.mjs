import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.mjs');

let tmpDir;

const run = (cmd, opts = {}) =>
  execSync(`node ${CLI} ${cmd}`, { encoding: 'utf-8', timeout: 15000, cwd: tmpDir, ...opts });

beforeEach(() => {
  tmpDir = join(import.meta.dirname, '..', '.test-tmp-change-id-' + Date.now());
  mkdirSync(tmpDir, { recursive: true });
  execSync(`node ${CLI} install --tool claude`, { cwd: tmpDir, encoding: 'utf-8' });
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe('change-id generation', () => {
  it('中文来源文件 prompt 通过 --id 提供英文业务主题,路径不进入 change-id', () => {
    const out = run('change --id member-first-purchase-points-once "根据 ~/Downloads/prd.md 创建需求：个人会员单年首购奖励积分由分期改一次性发放，并更新邀请方积分、收银台与裂变弹窗文案"');

    assert.ok(out.includes('变更已创建: member-first-purchase-points-once'));
    assert.ok(existsSync(join(tmpDir, '.gantry/specs', 'member-first-purchase-points-once')));
    assert.equal(existsSync(join(tmpDir, '.gantry/specs', '根据-downloads-prd-md-创建需求-个人会员单年首购奖励积分由分期')), false);
  });

  it('--id 显式覆盖自动生成的 change-id', () => {
    const out = run('change --id member-points-once "根据 ~/Downloads/prd.md 创建需求：个人会员单年首购奖励积分由分期改一次性发放"');

    assert.ok(out.includes('变更已创建: member-points-once'));
    assert.ok(existsSync(join(tmpDir, '.gantry/specs', 'member-points-once')));
  });

  it('change-id 限制为英文且最多 5 个词', () => {
    const out = run('change "add export orders with advanced filters and audit logging"');

    assert.ok(out.includes('变更已创建: add-export-orders-with-advanced'));
    assert.ok(existsSync(join(tmpDir, '.gantry/specs', 'add-export-orders-with-advanced')));
  });

  it('已存在 active/archive 同名 change-id 时自动追加序号', () => {
    run('change --id dark-mode "加个深色模式"');
    run('archive --force');

    const out = run('change --id dark-mode "加个深色模式"');

    assert.ok(out.includes('变更已创建: dark-mode-2'));
    assert.ok(existsSync(join(tmpDir, '.gantry/specs', 'dark-mode-2')));
  });
});
