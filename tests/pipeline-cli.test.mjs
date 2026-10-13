/**
 * pipeline-cli.test.mjs — `gantry pipeline` 升档命令（AC-13）+ change 默认档位（AC-1/AC-2）。
 *
 * 本文件在「light 取代 micro」重构（change light-replaces-micro）中重写。原 7 个
 * 用例全部断言旧 light（change→fast→integration）或 micro 流程，逐条处理如下：
 *
 *   ① 「change 无 --tier → micro」            drop — micro 档已删除；默认 full 由
 *                                              tests/cli-change-tier.test.mjs 覆盖（replacement AC-1 / AC-2）
 *   ② 「只有显式参数才创建 light change」      drop — light 入口参数校验由
 *                                              tests/light-entry.test.mjs 覆盖（replacement AC-3）
 *   ③ 「--tier light 覆写硬红线」              drop — 描述命中红线回落 full 由
 *                                              tests/light-entry.test.mjs 覆盖（replacement AC-4）
 *   ④ 「pipeline full 单向提升」               rewrite — 下方「AC-13」用例
 *   ⑤ 「fast 提升回 change 边界」              rewrite — 下方「AC-13」用例
 *   ⑥ 「light 完整执行 change→fast→integration」 drop — 旧 light 阶段流废弃；新出口门闭环由
 *                                              tests/light-loop.test.mjs 覆盖（replacement AC-7）
 *   ⑦ 「advance --skip 不能绕过」              rewrite — 下方「light 出口门不可跳过」用例
 *
 * 保留：旧 standard 配置迁移用例（与 tier 无关）。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliEnv } from './support/cli-env.mjs';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.mjs');
let tmpDir;

const run = (args) =>
  execFileSync(process.execPath, [CLI, ...args], { cwd: tmpDir, env: cliEnv(), encoding: 'utf-8', timeout: 20000 });

const runResult = (args) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd: tmpDir, env: cliEnv(), encoding: 'utf-8', timeout: 20000 });

function state() {
  return readFileSync(join(tmpDir, '.gantry/planning/STATE.md'), 'utf-8');
}

function startLight(id) {
  run(['change', '--tier', 'light', '--scope', 'src/lib/foo.mjs', '--id', id, '输出格式微调']);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'pipeline-cli-'));
  execFileSync('git', ['init', '-q'], { cwd: tmpDir });
  writeFileSync(join(tmpDir, 'README.md'), '# base\n');
  execFileSync('git', ['add', '.'], { cwd: tmpDir });
  execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: tmpDir });
  run(['install', '--tool', 'claude']);
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe('pipeline CLI（AC-13 · 手动升档 + 禁止降档）', () => {
  it('light@fast → pipeline full：升到 full@change 并落 PROPOSAL 初稿', () => {
    startLight('up-fast');
    const out = run(['pipeline', 'full']);

    assert.match(out, /pipeline: light → full/);
    assert.match(state(), /模式\*\*: `full`/);
    assert.match(state(), /当前阶段\*\*: `change`/);
    assert.ok(
      existsSync(join(tmpDir, '.gantry/specs/up-fast/PROPOSAL.md')),
      '升档应生成 PROPOSAL 初稿',
    );
  });

  it('pipeline full 后清理 .gantry/planning/light-anchor.json（与自动升档一致）', () => {
    startLight('anchor-clean');
    const anchor = join(tmpDir, '.gantry/planning/light-anchor.json');
    assert.ok(existsSync(anchor), 'light 入口应写锚定文件');

    run(['pipeline', 'full']);

    assert.ok(!existsSync(anchor), '手动升档应清理锚定文件');
  });

  it('pipeline light → 非零退出，提示不支持降档', () => {
    startLight('down-1');
    const r = runResult(['pipeline', 'light']);

    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /不支持降档/);
    assert.match(state(), /模式\*\*: `light`/, '拒绝后状态不变');
  });

  it('已是 full → 非零退出，提示已是 full', () => {
    run(['change', '--id', 'full-1', 'fix: README typo']); // 默认 full@change
    const r = runResult(['pipeline', 'full']);

    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /已是 full/);
  });

  it('没有活跃 change → 非零退出', () => {
    const r = runResult(['pipeline', 'full']);

    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /没有活跃 change/);
  });

  it('light 出口门不可跳过：advance --skip 非零退出且状态保持 light', () => {
    startLight('skip-1');
    const r = runResult(['advance', '--skip']);

    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /light 出口门不可跳过/);
    assert.match(state(), /模式\*\*: `light`/);
    assert.match(state(), /当前阶段\*\*: `fast`/);
  });
});

describe('pipeline CLI · 存量配置迁移（保留）', () => {
  it('首次命令把旧 standard 配置和状态一次性迁移为 full', () => {
    const configPath = join(tmpDir, '.gantry/planning/config.json');
    const statePath = join(tmpDir, '.gantry/planning/STATE.md');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.pipeline = 'standard';
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    writeFileSync(statePath, state().replace('`full`', '`standard`'));

    assert.match(run(['status']), /pipeline 迁移.*→ full/);
    assert.equal(JSON.parse(readFileSync(configPath, 'utf-8')).pipeline, 'full');
    assert.match(state(), /模式\*\*: `full`/);
  });
});
