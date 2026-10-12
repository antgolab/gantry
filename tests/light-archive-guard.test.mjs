/**
 * light-archive-guard.test.mjs — `gantry archive` 拒绝未升档的 light change（B1 / B2 · D19）。
 *
 * 背景：archive() 原本只看 STATE.currentStage，于是有两条绕过路径——
 *   B1：`archive --force` 跳过阶段检查，light@fast 直接归档；
 *   B2：手改 STATE.md 的「当前阶段」为 integration（readState 把 light@integration
 *       归一化成 full@integration），再 `archive` 也被放行。
 * 新判据不看 STATE：change 目录有 light.json 且 EXECUTION 无 `## upgrade` 段 → 一律拒绝。
 *
 * 出口门内部的自动归档走 archiveChange（cli.mjs 注入给 runLightExitGate），不经过
 * archive()，因此下面的 AC-7 回归用例必须仍然绿。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.mjs');
let tmpDir;

const run = (args) =>
  execFileSync(process.execPath, [CLI, ...args], { cwd: tmpDir, encoding: 'utf-8', timeout: 30000 });

const runResult = (args) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd: tmpDir, encoding: 'utf-8', timeout: 30000 });

const statePath = () => join(tmpDir, '.gantry/planning/STATE.md');
const stateText = () => readFileSync(statePath(), 'utf-8');

function changeDir(id) {
  return join(tmpDir, '.gantry/specs', id);
}

function archived(id) {
  return existsSync(join(tmpDir, '.gantry/specs/_archive', id));
}

function changelog() {
  const p = join(tmpDir, '.gantry/specs/CHANGELOG.md');
  return existsSync(p) ? readFileSync(p, 'utf-8') : '';
}

/** 把 STATE.md 的「当前阶段」改成任意 stage —— 模拟 B2 的手工篡改。 */
function handEditStage(stage) {
  const next = stateText().replace(
    /(- \*\*当前阶段\*\*: `)[^`]*(`)/,
    `$1${stage}$2`,
  );
  writeFileSync(statePath(), next, 'utf-8');
}

function write(rel, content) {
  const abs = join(tmpDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function startLight(id, { scope = 'src/lib/foo.mjs', verify = 'node -e "process.exit(0)"' } = {}) {
  return run(['change', '--tier', 'light', '--scope', scope, '--verify', verify, '--id', id, '输出格式微调']);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'light-archive-guard-'));
  execFileSync('git', ['init', '-q'], { cwd: tmpDir });
  writeFileSync(join(tmpDir, 'README.md'), '# base\n');
  execFileSync('git', ['add', '.'], { cwd: tmpDir });
  execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: tmpDir });
  run(['install', '--tool', 'claude']);
});

afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe('B1 · light@fast 用 archive --force 绕过出口门被拒', () => {
  it('--force 不改判据：非零退出，change 目录原地不动，CHANGELOG 不写', () => {
    startLight('light-b1');
    assert.ok(existsSync(join(changeDir('light-b1'), 'light.json')), '前置：入口应写 light.json');

    const r = runResult(['archive', '--force']);

    assert.notEqual(r.status, 0, 'archive --force 必须非零退出');
    assert.match(r.stderr, /light change 只能经 gantry advance 出口门收尾/);
    assert.ok(existsSync(changeDir('light-b1')), 'change 目录应仍在原地');
    assert.equal(archived('light-b1'), false, '不得进入 _archive/');
    assert.equal(changelog(), '', '被拒时不得写 CHANGELOG');
    assert.match(stateText(), /当前阶段\*\*: `fast`/, 'STATE 不应被改动');
  });
});

describe('B2 · 手改 STATE 到 integration 后 archive 仍被拒', () => {
  it('判据取 light.json / EXECUTION，而非 STATE 的阶段值', () => {
    startLight('light-b2');
    handEditStage('integration');
    assert.match(stateText(), /当前阶段\*\*: `integration`/, '前置：STATE 已被手工改成 integration');

    const r = runResult(['archive']);

    assert.notEqual(r.status, 0, '手改 STATE 不能换来归档');
    assert.match(r.stderr, /light change 只能经 gantry advance 出口门收尾/);
    assert.ok(existsSync(changeDir('light-b2')), 'change 目录应仍在原地');
    assert.equal(archived('light-b2'), false);
    assert.equal(changelog(), '');
  });
});

describe('升档后的 change 按 full 规则归档', () => {
  it('light → pipeline full（写 `## upgrade`）后，archive --force 放行', () => {
    startLight('light-up');
    run(['pipeline', 'full']);

    const exec = readFileSync(join(changeDir('light-up'), 'EXECUTION.md'), 'utf-8');
    assert.match(exec, /^## upgrade$/m, '前置：升档应追加 `## upgrade` 段');

    const r = runResult(['archive', '--force']);

    assert.equal(r.status, 0, `升档后应可归档，stderr=${r.stderr}`);
    assert.equal(archived('light-up'), true);
    assert.match(changelog(), /light-up/, 'CHANGELOG 应记录本次归档');
  });
});

describe('回归 · full change 的 archive --force 行为不变', () => {
  it('普通 full change 仍能用 --force 直接收尾', () => {
    run(['change', '--id', 'full-1', 'fix: README typo']);

    const r = runResult(['archive', '--force']);

    assert.equal(r.status, 0, `full change 归档不应被新守卫波及，stderr=${r.stderr}`);
    assert.equal(archived('full-1'), true);
    assert.match(stateText(), /当前阶段\*\*: `idle`/, '归档后 STATE 复位 idle');
  });
});

describe('回归 · 出口门的自动归档不经 archive()，不受新守卫影响', () => {
  it('light@fast 全通过 → advance 仍自动收尾', () => {
    startLight('light-ok');
    write('src/lib/foo.mjs', 'export const a = 1;\n');

    const out = run(['advance']);

    assert.match(out, /code: light_archived/);
    assert.equal(archived('light-ok'), true, '出口门内部走 archiveChange，应照常归档');
    assert.match(stateText(), /当前阶段\*\*: `idle`/);
  });
});
