/**
 * light-gate.test.mjs — src/lib/light-gate.mjs 的直接单测（T-FIX-07 · REVIEW F-06 / F-10）
 *
 * 覆盖范围：
 *   ① 适配器形状与「git 失败 → guard-error」的 fail-closed 路径（端到端，stub 掉 git）
 *   ② git name-status 解析（M / A / D，以及 R 行的**当前**行为 —— 改名被压成一条 M，
 *      旧路径丢失；这是 F-02，由 T-FIX-02 修，本任务的用例把它钉住并注明）
 *   ③ 依赖增量探测的当前判据（diff 文本里出现 `"dependencies"` 字面量 —— F-05，由 T-FIX-05 改）
 *   ④ 删除文件不参与 maxMtime（且不会让快照抛错）
 *   ⑤ verify-log / diagnosis 解析
 *   ⑥ F-10 端到端：正常 light 收尾不再打印假的「pipeline 迁移」提示
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState, updateState } from '../src/lib/state.mjs';
import { getPreferredArtifactName } from '../src/lib/artifacts.mjs';
import {
  defaultIo,
  collectBaseline,
  writeLightEntry,
  gitNameStatus,
  normalizeGitStatus,
  detectPkgJsonDepsDelta,
  collectLightGuardInput,
  parseVerifyLog,
  latestDiagnosis,
  resolveLightVerifyCommand,
  runLightExitGate,
  hashLightJson,
  verifyLightAnchor,
  readLightJson,
} from '../src/lib/light-gate.mjs';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.mjs');
const sha1 = (value) => createHash('sha1').update(value).digest('hex');
let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'light-gate-'));
});

afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * 以 defaultIo 为底，按需覆写单个方法的最小 stub 适配器。
 * readFile 遵守 defaultIo 契约：不给 encoding → Buffer，给 'utf-8' → 字符串。
 */
function makeIo(overrides = {}) {
  return { ...defaultIo, ...overrides };
}

/** 截获 console.log / console.error，供断言 CLI 卡片输出。 */
async function captureConsole(fn) {
  const lines = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

describe('IO 适配器形状', () => {
  it('defaultIo 暴露 git / readFile / exists / stat / now 五个读探针', () => {
    for (const key of ['git', 'readFile', 'exists', 'stat', 'now']) {
      assert.equal(typeof defaultIo[key], 'function', `defaultIo.${key} 应是函数`);
    }
  });

  it('git 返回 { status, stdout }，readFile 缺省返回 Buffer、带 encoding 返回字符串', () => {
    const r = defaultIo.git(['--version'], tmpDir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^git version/);

    writeFileSync(join(tmpDir, 'x.txt'), 'hello\n');
    assert.ok(Buffer.isBuffer(defaultIo.readFile(join(tmpDir, 'x.txt'))));
    assert.equal(defaultIo.readFile(join(tmpDir, 'x.txt'), 'utf-8'), 'hello\n');
    assert.equal(defaultIo.exists(join(tmpDir, 'x.txt')), true);
    assert.equal(typeof defaultIo.stat(join(tmpDir, 'x.txt')).mtimeMs, 'number');
    assert.equal(Number.isFinite(defaultIo.now()), true);
  });
});

describe('collectBaseline · 入口 IO（原 cli.mjs collectBaseline）', () => {
  it('dirty + untracked 入基线，.gantry/ 排除，删除/不可读跳过', () => {
    const contents = { 'a.mjs': 'a\n', 'notes.txt': 'n\n' };
    const io = makeIo({
      git(args) {
        if (args[0] === 'diff') return { status: 0, stdout: 'a.mjs\n.gantry/planning/STATE.md\ngone.mjs\n' };
        return { status: 0, stdout: 'notes.txt\n' };
      },
      readFile(path) {
        const rel = path.split('/').pop();
        if (!(rel in contents)) throw new Error('ENOENT');
        return Buffer.from(contents[rel]);
      },
    });

    assert.deepEqual(collectBaseline('/p', io), {
      'a.mjs': sha1('a\n'),
      'notes.txt': sha1('n\n'),
    });
  });

  it('git 失败 → 该条命令贡献空列表（不抛错）', () => {
    const io = makeIo({ git: () => ({ status: 128, stdout: '' }) });
    assert.deepEqual(collectBaseline('/p', io), {});
  });

  it('writeLightEntry 写 light.json（intent + baseline + createdAt）与意图头 EXECUTION', () => {
    const changeDir = join(tmpDir, '.gantry/specs/lg-entry');
    mkdirSync(changeDir, { recursive: true });
    const executionPath = join(changeDir, getPreferredArtifactName('execution'));
    const io = makeIo({ git: () => ({ status: 0, stdout: '' }), now: () => Date.parse('2026-10-12T00:00:00.000Z') });

    const lightJson = writeLightEntry(tmpDir, {
      changeId: 'lg-entry',
      executionPath,
      intent: { goal: '调整 foo', accept: ['a', 'b'], scope: ['src/lib/foo.mjs'], verify: 'npm test' },
    }, io);

    assert.equal(lightJson.createdAt, '2026-10-12T00:00:00.000Z');
    assert.deepEqual(lightJson.baseline, {});

    const parsed = JSON.parse(readFileSync(join(changeDir, 'light.json'), 'utf-8'));
    assert.equal(parsed.intent.goal, '调整 foo');
    assert.match(parsed.createdAt, /^\d{4}-\d{2}-\d{2}T/);

    const exec = readFileSync(executionPath, 'utf-8');
    assert.match(exec, /## light-intent/);
    assert.match(exec, /- verify: npm test/);
    assert.match(exec, /## tier-decision/);
    assert.match(exec, /tier: light/);

    // D17：入口把 light.json 规范化内容的 sha256 写进独立锚定文件
    const anchor = JSON.parse(readFileSync(join(tmpDir, '.gantry/planning/light-anchor.json'), 'utf-8'));
    assert.equal(anchor.changeId, 'lg-entry');
    assert.equal(anchor.createdAt, '2026-10-12T00:00:00.000Z');
    assert.equal(anchor.sha256, hashLightJson(parsed));
  });
});

describe('意图锚定 · verifyLightAnchor（D17）', () => {
  function entry() {
    const changeId = 'lg-anchor';
    const changeDir = join(tmpDir, '.gantry/specs', changeId);
    mkdirSync(changeDir, { recursive: true });
    writeLightEntry(tmpDir, {
      changeId,
      executionPath: join(changeDir, getPreferredArtifactName('execution')),
      intent: { goal: '调整 foo', accept: ['a'], scope: ['src/lib/foo.mjs'], verify: 'npm test' },
    }, makeIo({ git: () => ({ status: 0, stdout: '' }) }));
    return { changeId, changeDir };
  }

  it('锚定有效 → null', () => {
    const { changeId, changeDir } = entry();
    assert.equal(verifyLightAnchor(tmpDir, changeId, readLightJson(changeDir), defaultIo), null);
  });

  it('锚定文件缺失 → intent-tampered(anchor-missing)', () => {
    const { changeId, changeDir } = entry();
    rmSync(join(tmpDir, '.gantry/planning/light-anchor.json'));
    const hit = verifyLightAnchor(tmpDir, changeId, readLightJson(changeDir), defaultIo);
    assert.equal(hit.ruleId, 'intent-tampered');
    assert.equal(hit.detail, 'anchor-missing');
  });

  it('changeId 不符 → anchor-change-mismatch', () => {
    const { changeDir } = entry();
    const hit = verifyLightAnchor(tmpDir, 'other-change', readLightJson(changeDir), defaultIo);
    assert.equal(hit.detail, 'anchor-change-mismatch');
  });

  it('light.json 被改写（sha 不符）→ anchor-hash-mismatch', () => {
    const { changeId, changeDir } = entry();
    const p = join(changeDir, 'light.json');
    const mutated = JSON.parse(readFileSync(p, 'utf-8'));
    mutated.intent.scope = ['migrations/'];
    writeFileSync(p, JSON.stringify(mutated, null, 2), 'utf-8');
    const hit = verifyLightAnchor(tmpDir, changeId, readLightJson(changeDir), defaultIo);
    assert.equal(hit.detail, 'anchor-hash-mismatch');
  });

  it('锚定不可解析 → anchor-unparsable；light.json 缺失 → light-json-missing', () => {
    const { changeId, changeDir } = entry();
    writeFileSync(join(tmpDir, '.gantry/planning/light-anchor.json'), '{ not json', 'utf-8');
    assert.equal(verifyLightAnchor(tmpDir, changeId, readLightJson(changeDir), defaultIo).detail, 'anchor-unparsable');

    const { changeId: id2, changeDir: dir2 } = entry();
    rmSync(join(dir2, 'light.json'));
    assert.equal(verifyLightAnchor(tmpDir, id2, readLightJson(dir2), defaultIo).detail, 'light-json-missing');
  });

  it('hashLightJson 对键序稳定：同一对象不同插入序 → 同一哈希', () => {
    const a = { intent: { goal: 'g', scope: ['a'] }, baseline: { 'x.mjs': 'h' }, createdAt: 'T' };
    const b = { createdAt: 'T', baseline: { 'x.mjs': 'h' }, intent: { scope: ['a'], goal: 'g' } };
    assert.equal(hashLightJson(a), hashLightJson(b));
  });
});

describe('gitNameStatus · name-status 解析', () => {
  it('M / A / D 三类行解析为 {status, path}', () => {
    const io = makeIo({
      git: () => ({ status: 0, stdout: 'M\tsrc/a.mjs\nA\tsrc/b.mjs\nD\tsrc/gone.mjs\n' }),
    });
    assert.deepEqual(gitNameStatus('/p', io), [
      { status: 'M', path: 'src/a.mjs' },
      { status: 'A', path: 'src/b.mjs' },
      { status: 'D', path: 'src/gone.mjs' },
    ]);
  });

  it('R 行拆成「旧路径 D + 新路径 A」（T-FIX-02 · D21 改 --no-renames + 解析层兜底）', () => {
    // drop reason：原用例钉住 F-02 的缺陷行为（R 行只保留新路径、status 记为 M，旧测试
    // 文件的删除对 detectTestWeakening 不可见，一个 git mv 即绕过 AC-10）。T-FIX-02 后
    // 改名拆成 D + A，旧用例语义（旧路径丢失）已失效，替换为新语义。
    const io = makeIo({
      git: () => ({ status: 0, stdout: 'R100\ttests/a.test.mjs\tsrc/a.mjs\n' }),
    });
    assert.deepEqual(gitNameStatus('/p', io), [
      { status: 'D', path: 'tests/a.test.mjs' },
      { status: 'A', path: 'src/a.mjs' },
    ]);
  });

  it('gitNameStatus 以 --no-renames 调用 git（关闭改名折叠）', () => {
    let captured;
    const io = makeIo({ git: (args) => { captured = args; return { status: 0, stdout: '' }; } });
    gitNameStatus('/p', io);
    assert.ok(captured.includes('--no-renames'), `git 参数应含 --no-renames，实际: ${captured.join(' ')}`);
  });

  it('C（copy）与 ? 归一化为 A；空行 / 字段不足的行跳过', () => {
    const io = makeIo({
      git: () => ({ status: 0, stdout: 'C100\tsrc/a.mjs\tsrc/copy.mjs\n?\tnew.mjs\n\nBROKEN\n' }),
    });
    assert.deepEqual(gitNameStatus('/p', io), [
      { status: 'A', path: 'src/copy.mjs' },
      { status: 'A', path: 'new.mjs' },
    ]);
  });

  it('normalizeGitStatus：A/C/? → A，D → D，其余（含 R）→ M', () => {
    assert.equal(normalizeGitStatus('A'), 'A');
    assert.equal(normalizeGitStatus('C'), 'A');
    assert.equal(normalizeGitStatus('?'), 'A');
    assert.equal(normalizeGitStatus('D'), 'D');
    assert.equal(normalizeGitStatus('M'), 'M');
    assert.equal(normalizeGitStatus('R'), 'M');
  });

  it('git 失败 → 抛错（由调用方转 guard-error）', () => {
    const io = makeIo({ git: () => ({ status: 128, stdout: '' }) });
    assert.throws(() => gitNameStatus('/p', io), /git diff 失败 \(exit 128\)/);
  });
});

describe('detectPkgJsonDepsDelta · 依赖增量（T-FIX-05 · D21 结构化比对）', () => {
  /** 构造一个 io：git show 返回 headObj 的 JSON（null → 文件不在 HEAD），readFile 返回 workObj。 */
  function pkgIo(headObj, workObj) {
    return makeIo({
      git(args) {
        if (args[0] === 'show') {
          if (headObj === null) return { status: 128, stdout: '' };
          return { status: 0, stdout: JSON.stringify(headObj) };
        }
        return { status: 0, stdout: '' };
      },
      readFile() {
        if (workObj === null) throw new Error('ENOENT');
        return typeof workObj === 'string' ? workObj : JSON.stringify(workObj);
      },
    });
  }

  function longDeps(n) {
    const deps = {};
    for (let i = 1; i <= n; i += 1) deps[`pkg${i}`] = `^${i}.0.0`;
    return deps;
  }

  it('25 项依赖末尾追加一项 → [dependencies]（旧 diff 字面量判据会漏）', () => {
    const head = { dependencies: longDeps(25) };
    const work = { dependencies: { ...longDeps(25), 'left-pad': '^1.3.0' } };
    assert.deepEqual(detectPkgJsonDepsDelta('/p', ['package.json'], pkgIo(head, work)), ['dependencies']);
  });

  it('新增 peerDependencies → [dependencies]', () => {
    const head = { dependencies: longDeps(3) };
    const work = { dependencies: longDeps(3), peerDependencies: { react: '^18.0.0' } };
    assert.deepEqual(detectPkgJsonDepsDelta('/p', ['package.json'], pkgIo(head, work)), ['dependencies']);
  });

  it('新增子包 packages/foo/package.json 带 dependencies → [dependencies]（HEAD 缺失）', () => {
    const work = { name: 'foo', dependencies: { 'left-pad': '^1.0.0' } };
    assert.deepEqual(
      detectPkgJsonDepsDelta('/p', ['packages/foo/package.json'], pkgIo(null, work)),
      ['dependencies'],
    );
  });

  it('node_modules 下的 package.json 不参与', () => {
    let calls = 0;
    const io = makeIo({ git: () => { calls += 1; return { status: 0, stdout: '' }; } });
    assert.deepEqual(detectPkgJsonDepsDelta('/p', ['node_modules/x/package.json'], io), []);
    assert.equal(calls, 0);
  });

  it('只改 scripts / 版本字段不变 → 不误报', () => {
    const head = { scripts: { test: 'node --test' }, version: '1.0.0' };
    const work = { scripts: { test: 'node --test tests/*.test.mjs' }, version: '1.0.1' };
    assert.deepEqual(detectPkgJsonDepsDelta('/p', ['package.json'], pkgIo(head, work)), []);
  });

  it('依赖值变化（同键不同版本）→ [dependencies]', () => {
    const head = { dependencies: { left: '^1.0.0' } };
    const work = { dependencies: { left: '^2.0.0' } };
    assert.deepEqual(detectPkgJsonDepsDelta('/p', ['package.json'], pkgIo(head, work)), ['dependencies']);
  });

  it('package.json 未变更时不调用 git', () => {
    let calls = 0;
    const io = makeIo({ git: () => { calls += 1; return { status: 0, stdout: '' }; } });
    assert.deepEqual(detectPkgJsonDepsDelta('/p', ['src/a.mjs'], io), []);
    assert.equal(calls, 0);
  });

  it('工作区 JSON 非法 → 抛错（fail-closed）', () => {
    const io = pkgIo({ dependencies: {} }, 'not json {');
    assert.throws(() => detectPkgJsonDepsDelta('/p', ['package.json'], io), /package\.json 解析失败/);
  });

  it('HEAD JSON 非法 → 抛错（fail-closed）', () => {
    const io = makeIo({
      git: (args) => (args[0] === 'show' ? { status: 0, stdout: 'broken {' } : { status: 0, stdout: '' }),
      readFile: () => '{}',
    });
    assert.throws(() => detectPkgJsonDepsDelta('/p', ['package.json'], io), /package\.json 解析失败/);
  });

  it('已删除的 package.json（工作区缺失）→ 与 HEAD 相比有差异 → [dependencies]', () => {
    const head = { dependencies: { left: '^1.0.0' } };
    assert.deepEqual(detectPkgJsonDepsDelta('/p', ['package.json'], pkgIo(head, null)), ['dependencies']);
  });
});

describe('collectLightGuardInput · 快照', () => {
  it('删除的文件不进 maxMtime 且不抛错；仍留在 changedFiles 里交给守卫', () => {
    const io = makeIo({
      git(args) {
        if (args[0] === 'diff') return { status: 0, stdout: 'D\tsrc/gone.mjs\nM\tsrc/keep.mjs\n' };
        if (args[0] === 'ls-files') return { status: 0, stdout: '' };
        return { status: 0, stdout: '' };
      },
      stat(path) {
        if (path.endsWith('gone.mjs')) throw new Error('ENOENT: no such file');
        return { mtimeMs: 1234 };
      },
    });

    const input = collectLightGuardInput('/p', {
      intent: { scope: ['src/'], goal: '调整 foo' },
      baseline: {},
      startedAt: 5,
    }, io);

    assert.deepEqual(input.changedFiles, ['src/gone.mjs', 'src/keep.mjs']);
    assert.equal(input.maxMtime, 1234, '被删除的文件不应参与 maxMtime 计算');
    assert.deepEqual(input.verifyRecord, { pass: true, at: 5 });
    assert.deepEqual(input.testEntries, []);
    assert.deepEqual(input.pkgJsonDepsDelta, []);
    assert.equal(typeof input.hashOf, 'function');
  });

  it('.gantry/ 下的改动被排除；未跟踪文件按 A 记入', () => {
    const io = makeIo({
      git(args) {
        if (args[0] === 'diff') return { status: 0, stdout: 'M\t.gantry/specs/x/EXECUTION.md\n' };
        if (args[0] === 'ls-files') return { status: 0, stdout: 'src/new.mjs\n' };
        return { status: 0, stdout: '' };
      },
      stat: () => ({ mtimeMs: 1 }),
    });

    const input = collectLightGuardInput('/p', { intent: {}, baseline: {}, startedAt: 0 }, io);
    assert.deepEqual(input.changedFiles, ['src/new.mjs']);
  });

  it('git 失败 → 抛错（runLightExitGate 会转成 guard-error）', () => {
    const io = makeIo({ git: () => ({ status: 1, stdout: '' }) });
    assert.throws(
      () => collectLightGuardInput('/p', { intent: {}, baseline: {}, startedAt: 0 }, io),
      /git diff 失败 \(exit 1\)/,
    );
  });
});

describe('verify-log / diagnosis 解析', () => {
  const log = [
    '# EXECUTION: x',
    '',
    '## verify-log',
    '',
    '- 2026-10-12T00:00:00.000Z PASS `npm test` (exit 0) diagnosis: —',
    '- 2026-10-12T00:00:01.000Z FAIL `npm test` (exit 1) diagnosis: 诊断 A',
    '- 2026-10-12T00:00:02.000Z FAIL `npm test` (exit 130) diagnosis: 诊断 B',
    '随便一行不该被解析',
  ].join('\n');

  it('parseVerifyLog 只收 FAIL 行的 diagnosis，按出现顺序', () => {
    assert.deepEqual(parseVerifyLog(log), { failDiagnoses: ['诊断 A', '诊断 B'] });
    assert.deepEqual(parseVerifyLog(''), { failDiagnoses: [] });
  });

  it('latestDiagnosis 取 `## diagnosis` 段内最新一条 bullet', () => {
    assert.equal(latestDiagnosis('## diagnosis\n\n- 诊断 A\n- 诊断 B\n'), '诊断 B');
  });

  it('latestDiagnosis 兼容 `## diagnosis: 行内文本`', () => {
    assert.equal(latestDiagnosis('## diagnosis: 行内诊断\n'), '行内诊断');
  });

  it('latestDiagnosis：无 diagnosis 段 → 空串；`---` 结束段；后续 `##` 段切换出去', () => {
    assert.equal(latestDiagnosis('# EXECUTION: x\n\n## light-intent\n- 目标: y\n'), '');
    assert.equal(latestDiagnosis('## diagnosis\n\n- 诊断 A\n\n---\n\n- 诊断 B\n'), '诊断 A');
    assert.equal(latestDiagnosis('## diagnosis\n\n- 诊断 A\n\n## upgrade\n\n- 别的\n'), '诊断 A');
  });
});

describe('resolveLightVerifyCommand', () => {
  it('intent.verify 优先', () => {
    const io = makeIo({ exists: () => true, readFile: () => 'x: {cmd: nope}\n' });
    assert.equal(resolveLightVerifyCommand('/p', { verify: ' npm test ' }, io), 'npm test');
  });

  it('无 intent.verify 时回落 test-commands.yml 的全部 cmd（按定义顺序 && 串联）', () => {
    const yml = [
      'second:',
      '  cmd: npm run build',
      'third:',
      '  cmd: npm test',
    ].join('\n');
    const io = makeIo({ exists: (p) => p.endsWith('test-commands.yml'), readFile: () => yml });
    assert.equal(resolveLightVerifyCommand('/p', {}, io), 'npm run build && npm test');
  });

  it('两处都没有 → null（出口门判 guard-error）', () => {
    const io = makeIo({ exists: () => false });
    assert.equal(resolveLightVerifyCommand('/p', {}, io), null);
  });

  it('test-commands.yml 语法非法 → null（不抛错）', () => {
    const io = makeIo({
      exists: () => true,
      readFile: () => 'key: inline-value\n',
    });
    assert.equal(resolveLightVerifyCommand('/p', {}, io), null);
  });
});

describe('runLightExitGate · git 失败 ⇒ guard-error（fail-closed）', () => {
  it('快照失败时升档 full@change，PROPOSAL 记录 guard-error + 原始报错', async () => {
    const changeId = 'lg-gitfail';
    const changeDir = join(tmpDir, '.gantry/specs', changeId);
    mkdirSync(changeDir, { recursive: true });
    writeLightEntry(tmpDir, {
      changeId,
      executionPath: join(changeDir, getPreferredArtifactName('execution')),
      intent: { goal: '调整 foo', accept: ['a'], scope: ['src/lib/foo.mjs'], verify: 'node -e "process.exit(0)"' },
    });
    updateState(tmpDir, {
      pipeline: 'light',
      activeChange: changeId,
      currentStage: 'fast',
      activeAgent: 'executor',
    });

    // 只有 git 失败：其余 IO 走真实实现（light.json / EXECUTION 都在真实临时目录里）
    const io = makeIo({ git: () => ({ status: 1, stdout: '' }) });
    let archived = 0;
    const { result, lines } = await captureConsole(() => runLightExitGate(tmpDir, readState(tmpDir), {
      io,
      archiveChange: () => { archived++; },
    }));

    assert.equal(result.stop, true);
    assert.equal(archived, 0, 'guard-error 不应触发归档');
    assert.match(lines.join('\n'), /guard-error/);
    assert.match(lines.join('\n'), /snapshot: git diff 失败 \(exit 1\)/);
    assert.match(lines.join('\n'), /code: light_upgraded/);

    const st = readState(tmpDir);
    assert.equal(st.pipeline, 'full');
    assert.equal(st.currentStage, 'change');

    const proposal = readFileSync(join(changeDir, 'PROPOSAL.md'), 'utf-8');
    assert.match(proposal, /guard-error/);
    assert.match(proposal, /snapshot: git diff 失败 \(exit 1\)/);
  });

  it('无 verify 命令（intent 无 verify + 无 test-commands.yml）→ guard-error(no-verify-command)', async () => {
    const changeId = 'lg-noverify';
    const changeDir = join(tmpDir, '.gantry/specs', changeId);
    mkdirSync(changeDir, { recursive: true });
    writeLightEntry(tmpDir, {
      changeId,
      executionPath: join(changeDir, getPreferredArtifactName('execution')),
      intent: { goal: '调整 foo', accept: ['a'], scope: ['src/lib/foo.mjs'] },
    }, makeIo({ git: () => ({ status: 0, stdout: '' }) }));
    updateState(tmpDir, {
      pipeline: 'light',
      activeChange: changeId,
      currentStage: 'fast',
      activeAgent: 'executor',
    });

    const { result, lines } = await captureConsole(() => runLightExitGate(tmpDir, readState(tmpDir), {
      archiveChange: () => { throw new Error('不应归档'); },
    }));

    assert.equal(result.stop, true);
    assert.match(lines.join('\n'), /guard-error/);
    assert.match(lines.join('\n'), /no-verify-command/);
    assert.equal(readState(tmpDir).currentStage, 'change');
  });

  it('--skip 对 light 无效：非零退出且不碰任何 IO', async () => {
    const { result, lines } = await captureConsole(() => runLightExitGate(tmpDir, { activeChange: 'x' }, { isSkip: true }));
    assert.deepEqual(result, { stop: true, exitCode: 1 });
    assert.match(lines.join('\n'), /light 出口门不可跳过/);
  });
});

describe('F-10 · 正常 light 收尾不打印假的 pipeline 迁移提示', () => {
  function initGitRepo() {
    execFileSync('git', ['init', '-q'], { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'README.md'), '# base\n');
    execFileSync('git', ['add', '.'], { cwd: tmpDir });
    execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: tmpDir });
  }

  const runCli = (args) =>
    spawnSync(process.execPath, [CLI, ...args], { cwd: tmpDir, encoding: 'utf-8', timeout: 30000 });

  it('advance 收尾：code: light_archived，stderr/stdout 均无「pipeline 迁移」', () => {
    initGitRepo();
    runCli(['install', '--tool', 'claude']);
    runCli([
      'change', '--tier', 'light',
      '--scope', 'src/lib/foo.mjs',
      '--verify', 'node -e "process.exit(0)"',
      '--id', 'lg-close', '输出格式微调',
    ]);
    mkdirSync(join(tmpDir, 'src/lib'), { recursive: true });
    writeFileSync(join(tmpDir, 'src/lib/foo.mjs'), 'export const a = 1;\n');

    const r = runCli(['advance']);

    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_archived/);
    // 归档后 change 目录（含 light.json）已移走，复位 STATE 不能再走 readState 探测归一化
    assert.doesNotMatch(r.stderr, /pipeline 迁移/, '收尾不应输出迁移提示');
    assert.doesNotMatch(r.stdout, /pipeline 迁移/);
    assert.ok(existsSync(join(tmpDir, '.gantry/specs/_archive/lg-close')), '应收尾归档');

    const st = readState(tmpDir);
    assert.equal(st.currentStage, 'idle');
    assert.equal(st.activeChange, null);
    assert.equal(st.pipeline, 'full');

    // D16：收敛信号仍要写进 fence，loop 驱动停下
    const lp = runCli(['loop-next']);
    assert.equal(lp.stdout.trim(), 'done');
  });
});
