/**
 * test-env-isolation.test.mjs — light 相关 CLI 测试不受开发者环境影响 (jev-redline-precheck T-FIX-01 · REVIEW F-01)
 *
 * 模拟一位已经按 docs/jev.md 开启 Jev 的维护者：全局 config 打开 jev.enabled，并设置了 key。
 * 在这样的环境里跑 5 个 light 相关测试文件，必须全部通过，且不向 Jev 发出任何请求。
 * Jev 指向本地 mock（任何请求都判为红线），不连接真实 api.typesafe.ai。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const LIGHT_CLI_TEST_FILES = [
  'tests/light-entry.test.mjs',
  'tests/light-loop.test.mjs',
  'tests/light-gate.test.mjs',
  'tests/light-archive-guard.test.mjs',
  'tests/pipeline-cli.test.mjs',
];

let server;
let baseURL;
let requests = 0;
let pollutedHome;

before(async () => {
  server = createServer((req, res) => {
    requests += 1;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'jev-1.13.0',
        answers: { risky: { type: 'noul', noul: 0.94 }, category: { type: 'choice', choice: 'concurrency' } },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;

  pollutedHome = mkdtempSync(join(tmpdir(), 'polluted-home-'));
  mkdirSync(join(pollutedHome, '.gantry'));
  writeFileSync(join(pollutedHome, '.gantry', 'config.json'), JSON.stringify({ jev: { enabled: true } }));
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  rmSync(pollutedHome, { recursive: true, force: true });
});

function runTests(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', ...LIGHT_CLI_TEST_FILES], { cwd: ROOT, env });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe('REVIEW F-01 · 开启 Jev 的开发者环境不影响 light 相关测试', () => {
  it('全局 jev.enabled=true + key 已设置 → 5 个文件全部通过，Jev 收到 0 个请求', { timeout: 240000 }, async () => {
    const env = {
      ...process.env,
      HOME: pollutedHome,
      TYPESAFE_API_KEY: 'fake-key-for-isolation-test',
      TYPESAFE_BASE_URL: baseURL,
    };
    // 外层 node --test 给子进程设置了 NODE_TEST_CONTEXT；嵌套运行时要去掉，否则内层 runner 不按独立运行处理
    delete env.NODE_TEST_CONTEXT;

    const { code, output } = await runTests(env);
    assert.equal(requests, 0, `Jev mock 收到 ${requests} 个请求，测试子进程继承了开发者环境`);
    assert.equal(code, 0, `测试未全部通过：\n${output.slice(-3000)}`);
  });
});
