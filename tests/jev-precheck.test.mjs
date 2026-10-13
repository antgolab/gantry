/**
 * jev-precheck.test.mjs — light 入口 Jev 预检 CLI 端到端 (jev-redline-precheck T04)
 *
 * 覆盖 SPEC AC-1 ~ AC-8、AC-10，以及 DESIGN D11（dry-run）。
 * 网络行为全部打到测试进程内的 node:http mock（127.0.0.1:0），通过 TYPESAFE_BASE_URL 指向它，
 * 不连接真实 api.typesafe.ai。CLI 子进程必须用异步 spawn（DESIGN D10）：spawnSync 会阻塞
 * 本进程事件循环，mock 无法响应。
 * 每个用例用独立的 HOME，避免读到开发机的 ~/.gantry/config.json。
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState } from '../src/lib/state.mjs';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.mjs');
const KEY = 'sk-e2e-0123456789abcdef';
const SEMANTIC_DESC = '把订单状态的写入改成先发消息再落库';

let tmpDir;
let homeDir;

// ---------- mock Jev 服务 ----------

let server;
let baseURL;
let mode = 'miss';
let requests = [];

function jevAnswer(noul, choice) {
  return { model: 'jev-1.13.0', answers: { risky: { type: 'noul', noul }, category: { type: 'choice', choice } } };
}

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (mode === 'hit') return send(200, jevAnswer(0.94, 'concurrency'));
      if (mode === 'miss') return send(200, jevAnswer(0.12, 'none'));
      if (mode === 'slow') {
        const t = setTimeout(() => send(200, jevAnswer(0.94, 'concurrency')), 5000);
        res.on('close', () => clearTimeout(t));
        return undefined;
      }
      if (mode === 'http401') return send(401, { error: 'unauthorized' });
      if (mode === 'http500') return send(500, { error: 'boom' });
      return send(500, { error: `unknown mode ${mode}` });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

/** 申请一个端口后立即关掉，得到「连接被拒绝」的地址 */
async function closedPortURL() {
  const s = createServer();
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return `http://127.0.0.1:${port}`;
}

// ---------- CLI / 夹具 ----------

function baseEnv(extra = {}) {
  const env = { ...process.env, HOME: homeDir };
  for (const k of ['TYPESAFE_API_KEY', 'TYPESAFE_BASE_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    delete env[k];
  }
  return { ...env, ...extra };
}

/** 异步跑 CLI（D10），返回 { code, stdout, stderr, ms } */
function cli(args, env = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [CLI, ...args], { cwd: tmpDir, env: baseEnv(env) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - t0 }));
  });
}

function setup() {
  execFileSync('git', ['init', '-q'], { cwd: tmpDir });
  writeFileSync(join(tmpDir, 'README.md'), '# base\n');
  execFileSync('git', ['add', '.'], { cwd: tmpDir });
  execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: tmpDir });
  execFileSync(process.execPath, [CLI, 'install', '--tool', 'claude'], { cwd: tmpDir, env: baseEnv(), encoding: 'utf-8' });
}

function setJevConfig(jev) {
  const p = join(tmpDir, '.gantry', 'planning', 'config.json');
  const cfg = existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : {};
  if (jev === undefined) delete cfg.jev;
  else cfg.jev = jev;
  writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`, 'utf-8');
}

const withKey = (extra = {}) => ({ TYPESAFE_API_KEY: KEY, TYPESAFE_BASE_URL: baseURL, ...extra });

function lightArgs(id, desc = SEMANTIC_DESC, extra = []) {
  return ['change', '--tier', 'light', '--scope', 'src/order.mjs', '--id', id, ...extra, desc];
}

const execText = (id) => readFileSync(join(tmpDir, '.gantry', 'specs', id, 'EXECUTION.md'), 'utf-8');
const lightJsonPath = (id) => join(tmpDir, '.gantry', 'specs', id, 'light.json');
const stateText = () => readFileSync(join(tmpDir, '.gantry', 'planning', 'STATE.md'), 'utf-8');

function assertStage(pipeline, stage) {
  const st = readState(tmpDir);
  assert.equal(st.pipeline, pipeline);
  assert.equal(st.currentStage, stage);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'jev-precheck-'));
  homeDir = join(tmpDir, '.home');
  mkdirSync(homeDir);
  mode = 'miss';
  requests = [];
});

afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

// ---------- AC ----------

describe('AC-1 · 默认关闭时零外发', () => {
  for (const [label, jev] of [['无 jev 键', undefined], ['jev.enabled=false', { enabled: false }]]) {
    it(`${label} + key 已设置 → 0 请求，进入 light，无 jev 行`, async () => {
      setup();
      setJevConfig(jev);
      const r = await cli(lightArgs('ac1'), withKey());
      assert.equal(r.code, 0, r.stderr);
      assert.equal(requests.length, 0);
      assertStage('light', 'fast');
      assert.doesNotMatch(execText('ac1'), /^jev:/m);
    });
  }
});

describe('AC-2 · 开关打开但没有 key', () => {
  for (const [label, env] of [['未设置', {}], ['空字符串', { TYPESAFE_API_KEY: '' }], ['纯空白', { TYPESAFE_API_KEY: '   ' }]]) {
    it(`key ${label} → 0 请求，stderr 恰一行提示，只按关键词`, async () => {
      setup();
      setJevConfig({ enabled: true });
      const r = await cli(lightArgs('ac2'), { TYPESAFE_BASE_URL: baseURL, ...env });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(requests.length, 0);
      const lines = r.stderr.split('\n').filter((l) => l.trim());
      assert.equal(lines.length, 1, `stderr: ${r.stderr}`);
      assert.match(lines[0], /TYPESAFE_API_KEY/);
      assertStage('light', 'fast');
      assert.doesNotMatch(execText('ac2'), /^jev:/m);
    });
  }
});

describe('AC-3 · Jev 判为红线时回落 full', () => {
  it('noul ≥ 0.5 → full@change，无 light.json，EXECUTION 记录 jev 行与 reason', async () => {
    setup();
    setJevConfig({ enabled: true });
    mode = 'hit';
    const r = await cli(lightArgs('ac3'), withKey());
    assert.equal(r.code, 0, r.stderr);
    assert.equal(requests.length, 1);
    assertStage('full', 'change');
    assert.equal(existsSync(lightJsonPath('ac3')), false);
    const exec = execText('ac3');
    assert.match(exec, /^reason: jev-semantic$/m);
    assert.match(exec, /^jev: p=0\.94 category=concurrency model=jev-1\.13\.0$/m);
  });
});

describe('AC-4 · Jev 判为非红线时照常进入 light', () => {
  it('noul < 0.5 → light@fast，生成 light.json，EXECUTION 记录 jev 行', async () => {
    setup();
    setJevConfig({ enabled: true });
    mode = 'miss';
    const r = await cli(lightArgs('ac4'), withKey());
    assert.equal(r.code, 0, r.stderr);
    assert.equal(requests.length, 1);
    assertStage('light', 'fast');
    assert.ok(existsSync(lightJsonPath('ac4')));
    assert.match(execText('ac4'), /^jev: p=0\.12 category=none model=jev-1\.13\.0$/m);
  });
});

describe('AC-5 · 关键词已命中时不调用 Jev', () => {
  it('「新增数据库迁移」→ 0 请求，按关键词回落 full', async () => {
    setup();
    setJevConfig({ enabled: true });
    const r = await cli(lightArgs('ac5', '新增数据库迁移'), withKey());
    assert.equal(r.code, 0, r.stderr);
    assert.equal(requests.length, 0);
    assertStage('full', 'change');
    const exec = execText('ac5');
    assert.match(exec, /^reason: .*migration-change/m);
    assert.doesNotMatch(exec, /^jev:/m);
  });
});

describe('AC-6 · Jev 失败时退回关键词结果，不重试', () => {
  const cases = [
    ['timeout', 'slow', 'timeout'],
    ['HTTP 401', 'http401', 'http 401'],
    ['HTTP 500', 'http500', 'http 500'],
  ];
  for (const [label, m, error] of cases) {
    it(`${label} → 进入 light，jev: error ${error}，请求恰 1 次`, { timeout: 20000 }, async () => {
      setup();
      setJevConfig({ enabled: true });
      mode = m;
      const r = await cli(lightArgs('ac6'), withKey());
      assert.equal(r.code, 0, r.stderr);
      assert.equal(requests.length, 1);
      assertStage('light', 'fast');
      assert.match(execText('ac6'), new RegExp(`^jev: error ${error}$`, 'm'));
      assert.match(r.stderr, /已按关键词结果继续/);
      if (m === 'slow') assert.ok(r.ms < 5000, `入口耗时 ${r.ms}ms，应在 3s 超时 + 2s 余量内`);
    });
  }

  it('连接被拒绝 → 进入 light，jev: error network', async () => {
    setup();
    setJevConfig({ enabled: true });
    const r = await cli(lightArgs('ac6'), withKey({ TYPESAFE_BASE_URL: await closedPortURL() }));
    assert.equal(r.code, 0, r.stderr);
    assertStage('light', 'fast');
    assert.match(execText('ac6'), /^jev: error network$/m);
    assert.match(r.stderr, /已按关键词结果继续/);
  });
});

describe('AC-7 · 只外发变更描述，key 不落盘', () => {
  it('请求只含描述，Bearer 头取自环境变量；key 不出现在任何输出与文件', async () => {
    setup();
    setJevConfig({ enabled: true });
    mode = 'miss';
    const accept = 'ACCEPT-MARKER-1';
    const verify = 'node -e "VERIFY-MARKER-2"';
    const r = await cli(lightArgs('ac7', SEMANTIC_DESC, ['--accept', accept, '--verify', verify]), withKey());
    assert.equal(r.code, 0, r.stderr);

    assert.equal(requests.length, 1);
    const [req] = requests;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/systemone');
    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    const body = JSON.parse(req.body);
    assert.deepEqual(body.state, { change_description: SEMANTIC_DESC });
    for (const leaked of ['src/order.mjs', 'ACCEPT-MARKER-1', 'VERIFY-MARKER-2', KEY]) {
      assert.ok(!req.body.includes(leaked), `请求体不应包含 ${leaked}`);
    }

    const surfaces = {
      stdout: r.stdout,
      stderr: r.stderr,
      'EXECUTION.md': execText('ac7'),
      'light.json': readFileSync(lightJsonPath('ac7'), 'utf-8'),
      'STATE.md': stateText(),
    };
    for (const [name, text] of Object.entries(surfaces)) {
      assert.ok(!text.includes(KEY), `${name} 不应包含 key`);
    }
  });
});

describe('AC-8 · jev 配置 fail-closed（CLI 级）', () => {
  it('config 写 jev.apiKey → 任一命令非零退出并点名键路径', async () => {
    setup();
    setJevConfig({ enabled: true, apiKey: KEY });
    const r = await cli(['status']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /jev\.apiKey 不是已知配置项/);
  });
});

describe('AC-10 · Jev 只在 light 入口调用', () => {
  it('默认 full 的 gantry change → 0 请求', async () => {
    setup();
    setJevConfig({ enabled: true });
    mode = 'hit';
    const r = await cli(['change', '--id', 'ac10-full', SEMANTIC_DESC], withKey());
    assert.equal(r.code, 0, r.stderr);
    assert.equal(requests.length, 0);
    assertStage('full', 'change');
  });

  it('light 出口门 gantry advance → 0 请求', { timeout: 30000 }, async () => {
    setup();
    setJevConfig({ enabled: true });
    mode = 'miss';
    const entry = await cli(lightArgs('ac10-light', SEMANTIC_DESC, ['--verify', 'node -e "process.exit(0)"']), withKey());
    assert.equal(entry.code, 0, entry.stderr);
    assertStage('light', 'fast');
    requests = [];

    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    writeFileSync(join(tmpDir, 'src', 'order.mjs'), 'export const v = 1;\n');
    await cli(['advance'], withKey());
    assert.equal(requests.length, 0, '出口门不得发起网络请求');
  });
});

describe('D11 · --dry-run --tier light 走同一预检链', () => {
  it('命中时 JSON 含 tier=full、reason=jev-semantic 与 jev 字段', async () => {
    setup();
    setJevConfig({ enabled: true });
    mode = 'hit';
    const r = await cli(['change', '--dry-run', '--tier', 'light', '--scope', 'src/order.mjs', SEMANTIC_DESC], withKey());
    assert.equal(r.code, 0, r.stderr);
    assert.equal(requests.length, 1);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(out.tier, 'full');
    assert.equal(out.reason, 'jev-semantic');
    assert.equal(out.jev, 'jev: p=0.94 category=concurrency model=jev-1.13.0');
  });
});
