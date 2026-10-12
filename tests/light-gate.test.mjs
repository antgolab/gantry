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
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
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
  findForbiddenArtifacts,
  isForbiddenArtifactName,
  checkHeadMoved,
  resolveHeadSha,
  parseRefsSnapshot,
  collectRefsSnapshot,
  diffRefs,
  checkRefsMoved,
  matchesRedLinePath,
  collectIgnoredRedLineBaseline,
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

  it('writeLightEntry 写 light.json（intent + baseline + headSha + refsSnapshot + createdAt）与意图头 EXECUTION', () => {
    const changeDir = join(tmpDir, '.gantry/specs/lg-entry');
    mkdirSync(changeDir, { recursive: true });
    const executionPath = join(changeDir, getPreferredArtifactName('execution'));
    const io = makeIo({
      // fixture 更新（D25）：入口现在锚定 HEAD，git stub 需让 rev-parse 返回 sha 才能断言 headSha
      // fixture 更新（D31）：入口还锚定 refs，stub 需给出 for-each-ref 输出，并含一条
      // refs/remotes/ 用来断言它被排除
      git: (args) => {
        if (args[0] === 'rev-parse') return { status: 0, stdout: 'cafe1234\n' };
        if (args[0] === 'for-each-ref') {
          return { status: 0, stdout: 'refs/heads/main cafe1234\nrefs/tags/v1 1111aaaa\nrefs/remotes/origin/main 2222bbbb\n' };
        }
        return { status: 0, stdout: '' };
      },
      now: () => Date.parse('2026-10-12T00:00:00.000Z'),
    });

    const lightJson = writeLightEntry(tmpDir, {
      changeId: 'lg-entry',
      executionPath,
      intent: { goal: '调整 foo', accept: ['a', 'b'], scope: ['src/lib/foo.mjs'], verify: 'npm test' },
    }, io);

    assert.equal(lightJson.createdAt, '2026-10-12T00:00:00.000Z');
    assert.deepEqual(lightJson.baseline, {});
    assert.equal(lightJson.headSha, 'cafe1234', 'D25：入口应锚定 HEAD');
    // D31：refsSnapshot 记录除 refs/remotes/ 外的全部 ref（键序字典序）
    assert.deepEqual(lightJson.refsSnapshot, {
      'refs/heads/main': 'cafe1234',
      'refs/tags/v1': '1111aaaa',
    });

    const parsed = JSON.parse(readFileSync(join(changeDir, 'light.json'), 'utf-8'));
    assert.equal(parsed.intent.goal, '调整 foo');
    assert.match(parsed.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(parsed.refsSnapshot, lightJson.refsSnapshot, 'refsSnapshot 应随 light.json 落盘');

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

describe('D25 · HEAD 锚定与漂移检查（F-14 / N18）', () => {
  it('resolveHeadSha：git 成功返回 trim 后的 sha；失败 / 空输出 → null', () => {
    assert.equal(resolveHeadSha('/p', makeIo({ git: () => ({ status: 0, stdout: 'abc\n' }) })), 'abc');
    assert.equal(resolveHeadSha('/p', makeIo({ git: () => ({ status: 128, stdout: '' }) })), null);
    assert.equal(resolveHeadSha('/p', makeIo({ git: () => ({ status: 0, stdout: '  \n' }) })), null);
  });

  it('checkHeadMoved：一致 → null；不一致 / 记录缺失 / 当前不可解析 → head-moved', () => {
    const io = makeIo({ git: () => ({ status: 0, stdout: 'sha1\n' }) });
    assert.equal(checkHeadMoved('/p', { headSha: 'sha1' }, io), null);

    const hit = checkHeadMoved('/p', { headSha: 'other' }, io);
    assert.equal(hit.ruleId, 'head-moved');
    assert.equal(hit.detail, 'head-moved');

    // legacy light.json（无 headSha）→ fail-closed
    assert.equal(checkHeadMoved('/p', {}, io).detail, 'head-sha-missing');

    const badIo = makeIo({ git: () => ({ status: 128, stdout: '' }) });
    assert.equal(checkHeadMoved('/p', { headSha: 'sha1' }, badIo).detail, 'head-unresolvable');
  });
});

describe('D31 · refs 快照（F-19 / F-2 / F-3）', () => {
  it('parseRefsSnapshot：解析 refname / objectname，跳过空行与字段不足的行', () => {
    const out = parseRefsSnapshot([
      'refs/heads/main aaaa',
      '',
      'no-sha-here',
      'refs/tags/v1 bbbb',
      '   ',
    ].join('\n'));
    assert.deepEqual(out, { 'refs/heads/main': 'aaaa', 'refs/tags/v1': 'bbbb' });
  });

  it('collectRefsSnapshot：排除 refs/remotes/，键序字典序；git 失败抛错', () => {
    const io = makeIo({
      git: () => ({ status: 0, stdout: 'refs/tags/v1 t1\nrefs/heads/main h1\nrefs/remotes/origin/main r1\nrefs/stash s1\n' }),
    });
    assert.deepEqual(collectRefsSnapshot('/p', io), {
      'refs/heads/main': 'h1',
      'refs/stash': 's1',
      'refs/tags/v1': 't1',
    });

    const badIo = makeIo({ git: () => ({ status: 128, stdout: '' }) });
    assert.throws(() => collectRefsSnapshot('/p', badIo), /git for-each-ref 失败 \(exit 128\)/);
  });

  it('diffRefs：added / removed / changed / identical 四种情形', () => {
    const base = { 'refs/heads/main': 'h1', 'refs/heads/old': 'o1' };
    assert.deepEqual(diffRefs(base, base), { added: [], removed: [], changed: [] });
    assert.deepEqual(diffRefs(base, { 'refs/heads/main': 'h1' }), {
      added: [], removed: ['refs/heads/old'], changed: [],
    });
    assert.deepEqual(diffRefs(base, { ...base, 'refs/tags/t1': 't' }), {
      added: ['refs/tags/t1'], removed: [], changed: [],
    });
    assert.deepEqual(diffRefs(base, { 'refs/heads/main': 'h2', 'refs/heads/old': 'o1' }), {
      added: [], removed: [], changed: ['refs/heads/main'],
    });
  });

  it('checkRefsMoved：一致 → null；新增 / 删除 / 变化 → refs-moved(detail 列 ref)', () => {
    const io = makeIo({ git: () => ({ status: 0, stdout: 'refs/heads/main h1\n' }) });
    assert.equal(checkRefsMoved('/p', { refsSnapshot: { 'refs/heads/main': 'h1' } }, io), null);

    const added = checkRefsMoved('/p', { refsSnapshot: {} }, io);
    assert.equal(added.ruleId, 'refs-moved');
    assert.match(added.detail, /added: refs\/heads\/main/);

    const removedIo = makeIo({ git: () => ({ status: 0, stdout: '' }) });
    const removed = checkRefsMoved('/p', { refsSnapshot: { 'refs/stash': 's1' } }, removedIo);
    assert.match(removed.detail, /removed: refs\/stash/);

    const changedIo = makeIo({ git: () => ({ status: 0, stdout: 'refs/heads/main h2\n' }) });
    const changed = checkRefsMoved('/p', { refsSnapshot: { 'refs/heads/main': 'h1' } }, changedIo);
    assert.match(changed.detail, /changed: refs\/heads\/main/);
  });

  it('缺 refsSnapshot（legacy light.json）→ refs-moved(refs-snapshot-missing)，fail-closed', () => {
    const io = makeIo({ git: () => ({ status: 0, stdout: 'refs/heads/main h1\n' }) });
    const hit = checkRefsMoved('/p', {}, io);
    assert.equal(hit.ruleId, 'refs-moved');
    assert.equal(hit.detail, 'refs-snapshot-missing');
  });

  it('git for-each-ref 失败 → checkRefsMoved 抛错（调用方转 guard-error）', () => {
    const io = makeIo({ git: () => ({ status: 1, stdout: '' }) });
    assert.throws(
      () => checkRefsMoved('/p', { refsSnapshot: { 'refs/heads/main': 'h1' } }, io),
      /git for-each-ref 失败 \(exit 1\)/,
    );
  });
});

describe('D32 · 被忽略红线文件基线（取代 D26 的 mtime 判据）', () => {
  // drop reason（本 describe 整体改写）：D26 用「mtime > createdAt」推断被忽略文件是否本次新增，
  // mtime 可被 `touch -t` 回拨（F-1）。D32 改为入口记录 {path: sha1} 基线、出口比对哈希，故原
  // 依赖 mtime 的 fixture / 断言按新语义重写（uvsn 未弱化：命中面与「不误报」两侧都保留并加强）。

  it('入口后新增的被忽略红线文件（migrations/001.sql）→ 红线命中；缓存 / 构建产物不误报', () => {
    const ignored = ['migrations/001.sql', '__pycache__/x.pyc', 'dist/a.js'];
    const io = makeIo({
      git(args) {
        if (args[0] === 'diff') return { status: 0, stdout: 'M\tsrc/lib/foo.mjs\n' };
        if (args[0] === 'ls-files' && args.includes('--ignored')) return { status: 0, stdout: `${ignored.join('\n')}\n` };
        return { status: 0, stdout: '' };
      },
    });
    const input = collectLightGuardInput('/p', {
      intent: { scope: ['src/lib/foo.mjs'], goal: 'g' },
      baseline: {},
      startedAt: 300,
      createdAt: 100,
      ignoredRedLineBaseline: {}, // 入口基线为空 → 入口后出现即算变化
    }, io);

    // 只喂红线：scope / changedFiles 不含被忽略文件
    assert.deepEqual(input.changedFiles, ['src/lib/foo.mjs']);
    const red = input.detectRedLines({ modifiedFiles: ['src/lib/foo.mjs'], newFiles: [], pkgJsonDepsDelta: [] }, '');
    assert.equal(red.hit, true);
    assert.ok(red.ruleIds.includes('migration-change') || red.ruleIds.includes('sql-change'));
    // 只有红线路径命中；缓存 / 构建产物不引入额外命中，也不触发跨模块
    assert.deepEqual([...red.files].sort(), ['migrations/001.sql']);
    assert.ok(!red.ruleIds.includes('cross-module-change'));
  });

  it('git ls-files --ignored 失败 → 抛错（转 guard-error，fail-closed）', () => {
    const io = makeIo({
      git(args) {
        if (args[0] === 'diff') return { status: 0, stdout: '' };
        if (args[0] === 'ls-files' && args.includes('--ignored')) return { status: 1, stdout: '' };
        return { status: 0, stdout: '' };
      },
    });
    assert.throws(
      () => collectLightGuardInput('/p', { intent: {}, baseline: {}, startedAt: 0, createdAt: 0 }, io),
      /--ignored 失败/,
    );
  });

  it('基线里已存在、哈希未变的被忽略红线文件不进红线输入（D32 取代「mtime ≤ createdAt」）', () => {
    const content = 'SELECT 1;\n';
    const io = makeIo({
      git(args) {
        if (args[0] === 'diff') return { status: 0, stdout: '' };
        if (args[0] === 'ls-files' && args.includes('--ignored')) return { status: 0, stdout: 'migrations/old.sql\n' };
        return { status: 0, stdout: '' };
      },
      readFile: () => content,
    });
    const input = collectLightGuardInput('/p', {
      intent: {},
      baseline: {},
      startedAt: 0,
      createdAt: 100,
      ignoredRedLineBaseline: { 'migrations/old.sql': sha1(content) },
    }, io);
    const red = input.detectRedLines({ modifiedFiles: [], newFiles: [], pkgJsonDepsDelta: [] }, '');
    assert.equal(red.hit, false);
  });

  it('基线里的被忽略红线文件哈希变化 → 红线命中', () => {
    const io = makeIo({
      git(args) {
        if (args[0] === 'diff') return { status: 0, stdout: '' };
        if (args[0] === 'ls-files' && args.includes('--ignored')) return { status: 0, stdout: 'migrations/old.sql\n' };
        return { status: 0, stdout: '' };
      },
      readFile: () => 'SELECT 2;\n', // 与基线哈希不同
    });
    const input = collectLightGuardInput('/p', {
      intent: {},
      baseline: {},
      startedAt: 0,
      ignoredRedLineBaseline: { 'migrations/old.sql': sha1('SELECT 1;\n') },
    }, io);
    const red = input.detectRedLines({ modifiedFiles: [], newFiles: [], pkgJsonDepsDelta: [] }, '');
    assert.equal(red.hit, true);
    assert.deepEqual([...red.files].sort(), ['migrations/old.sql']);
  });

  it('基线里的被忽略红线文件被删除 → 同样计为红线命中', () => {
    const io = makeIo({
      git(args) {
        if (args[0] === 'diff') return { status: 0, stdout: '' };
        if (args[0] === 'ls-files' && args.includes('--ignored')) return { status: 0, stdout: '' }; // 已删除
        return { status: 0, stdout: '' };
      },
    });
    const input = collectLightGuardInput('/p', {
      intent: {},
      baseline: {},
      startedAt: 0,
      ignoredRedLineBaseline: { 'migrations/gone.sql': 'deadbeef' },
    }, io);
    const red = input.detectRedLines({ modifiedFiles: [], newFiles: [], pkgJsonDepsDelta: [] }, '');
    assert.equal(red.hit, true);
    assert.deepEqual([...red.files].sort(), ['migrations/gone.sql']);
  });

  it('legacy light.json 缺 ignoredRedLineBaseline → 空基线 fail-closed（每个红线被忽略文件都算变化）', () => {
    const io = makeIo({
      git(args) {
        if (args[0] === 'diff') return { status: 0, stdout: '' };
        if (args[0] === 'ls-files' && args.includes('--ignored')) return { status: 0, stdout: 'migrations/001.sql\n' };
        return { status: 0, stdout: '' };
      },
    });
    // 不传 ignoredRedLineBaseline（undefined）→ 空基线
    const input = collectLightGuardInput('/p', { intent: {}, baseline: {}, startedAt: 0 }, io);
    const red = input.detectRedLines({ modifiedFiles: [], newFiles: [], pkgJsonDepsDelta: [] }, '');
    assert.equal(red.hit, true);
  });
});

describe('D32 · matchesRedLinePath / collectIgnoredRedLineBaseline', () => {
  it('matchesRedLinePath：命中红线路径 glob，非红线路径不命中', () => {
    assert.equal(matchesRedLinePath('migrations/001.sql'), true);
    assert.equal(matchesRedLinePath('db/x.sql'), true);
    assert.equal(matchesRedLinePath('schema/users.ts'), true);
    assert.equal(matchesRedLinePath('__pycache__/x.pyc'), false);
    assert.equal(matchesRedLinePath('dist/a.js'), false);
    assert.equal(matchesRedLinePath('node_modules/x/y.sql'), true, '纯路径判定不负责排除 node_modules（由列表层排除）');
  });

  it('collectIgnoredRedLineBaseline：只收红线路径，排除 node_modules/ 与 .gantry/；git 失败 → {}', () => {
    const io = makeIo({
      git: () => ({ status: 0, stdout: 'migrations/a.sql\nnode_modules/x/y.sql\ndist/a.js\n.gantry/specs/z.sql\n' }),
      readFile: () => 'x',
    });
    assert.deepEqual(collectIgnoredRedLineBaseline('/p', io), { 'migrations/a.sql': sha1('x') });

    const badIo = makeIo({ git: () => ({ status: 2, stdout: '' }) });
    assert.deepEqual(collectIgnoredRedLineBaseline('/p', badIo), {});
  });
});

describe('D27 · 基线存在性探测（未跟踪文件被删，N4）', () => {
  it('baseline 路径出口时不在磁盘、name-status 无 D 记录 → 补进 changedFiles', () => {
    const io = makeIo({
      git: () => ({ status: 0, stdout: '' }),
      exists: (p) => !p.endsWith('notes.txt'), // notes.txt 已删除
      stat: (p) => { if (p.endsWith('notes.txt')) throw new Error('ENOENT'); return { mtimeMs: 1 }; },
    });
    const input = collectLightGuardInput('/p', {
      intent: { scope: ['src/lib/foo.mjs'] },
      baseline: { 'notes.txt': 'deadbeef' },
      startedAt: 0,
    }, io);
    assert.ok(input.changedFiles.includes('notes.txt'), '已删除的基线文件应补进 changedFiles');
  });

  it('name-status 已记 D 的路径不重复添加', () => {
    const io = makeIo({
      git(args) {
        if (args[0] === 'diff') return { status: 0, stdout: 'D\tgone.mjs\n' };
        return { status: 0, stdout: '' };
      },
      exists: () => false,
      stat: () => { throw new Error('ENOENT'); },
    });
    const input = collectLightGuardInput('/p', { intent: {}, baseline: { 'gone.mjs': 'h' }, startedAt: 0 }, io);
    assert.deepEqual(input.changedFiles, ['gone.mjs']);
  });
});

describe('D34 · 基线回查：仍在磁盘、已从 name-status / untracked 双双消失的路径（B10b）', () => {
  // 场景：入口时就存在的未跟踪文件，入口后被写进 exclude / .gitignore 再改写 —— `git diff`
  // 与 `ls-files --others` 都看不到它，D27 的「已删除才补记录」探测不到这种越界改动。
  // D34 把「仍在磁盘」的 baseline 路径记为 M 候选，交给 filterByBaseline 判定。
  const gitStub = (diffStdout = '') => (args) => {
    if (args[0] === 'diff') return { status: 0, stdout: diffStdout };
    return { status: 0, stdout: '' }; // 含 ls-files（untracked / --ignored 均为空）
  };

  it('仍在磁盘、哈希与基线不同 → 计为 M 并被保留（参与 maxMtime，走范围检查）', () => {
    const io = makeIo({
      git: gitStub(),
      exists: () => true,
      readFile: () => Buffer.from('入口后改写的内容\n'),
      stat: () => ({ mtimeMs: 999 }),
    });
    const input = collectLightGuardInput('/p', {
      intent: { scope: ['src/'] },
      baseline: { 'other/note.txt': sha1('入口时的内容\n') },
      startedAt: 1000,
      createdAt: 500,
    }, io);

    assert.deepEqual(input.changedFiles, ['other/note.txt'], 'M 候选应进入 changedFiles');
    assert.equal(input.maxMtime, 999, '哈希与基线不同 → 不得被基线剔除');
  });

  it('仍在磁盘、哈希一致且 mtime ≤ createdAt → 仍被基线剔除（D34 不误报）', () => {
    const content = '入口时的内容\n';
    const io = makeIo({
      git: gitStub(),
      exists: () => true,
      readFile: () => Buffer.from(content),
      stat: () => ({ mtimeMs: 400 }),
    });
    const input = collectLightGuardInput('/p', {
      intent: { scope: ['src/'] },
      baseline: { 'other/note.txt': sha1(content) },
      startedAt: 1000,
      createdAt: 500,
    }, io);

    assert.ok(input.changedFiles.includes('other/note.txt'), 'M 候选在 changedFiles 里（剔除发生在守卫侧）');
    assert.equal(input.maxMtime, 0, '哈希一致 + mtime ≤ createdAt → 被 filterByBaseline 剔除');
  });

  it('已从磁盘消失的 baseline 路径仍计为 D（D27 行为不变，status 传到 testEntries）', () => {
    const io = makeIo({
      git: gitStub(),
      exists: () => false,
      readFile: () => Buffer.from('x'),
      stat: () => { throw new Error('ENOENT'); },
    });
    const input = collectLightGuardInput('/p', {
      intent: {},
      baseline: { 'tests/gone.test.mjs': 'deadbeef' },
      startedAt: 0,
    }, io);

    assert.ok(input.changedFiles.includes('tests/gone.test.mjs'));
    const entry = input.testEntries.find((e) => e.path === 'tests/gone.test.mjs');
    assert.equal(entry && entry.status, 'D');
  });
});

describe('D30 · findForbiddenArtifacts 名单派生自 ARTIFACT_ALIASES（F-16）', () => {
  it('别名 / 小写 / 后缀变体命中；EXECUTION.md 与其别名排除', () => {
    const dir = join(tmpDir, 'chg');
    mkdirSync(dir, { recursive: true });
    const names = [
      'CHANGE.md', 'proposal.md', 'SPEC.md', 'REQUIREMENT.md', 'DESIGN.upgrade.md',
      'TASKS.pre-light.2.md', 'TASK.md', 'TEST.md', 'REVIEW.md',
      'EXECUTION.md', 'SUMMARY.md', 'light.json', 'notes.txt',
    ];
    for (const n of names) writeFileSync(join(dir, n), 'x\n');

    assert.deepEqual(findForbiddenArtifacts(dir), [
      'CHANGE.md', 'DESIGN.upgrade.md', 'REQUIREMENT.md', 'REVIEW.md',
      'SPEC.md', 'TASK.md', 'TASKS.pre-light.2.md', 'TEST.md', 'proposal.md',
    ]);
  });

  it('symlink PROPOSAL.md 也命中（用 lstat / isSymbolicLink）', () => {
    // 单独目录：macOS 默认大小写不敏感，PROPOSAL.md 与上面的 proposal.md 会撞名
    const dir = join(tmpDir, 'chg-link');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'target.txt'), 'y\n');
    symlinkSync('target.txt', join(dir, 'PROPOSAL.md'));
    assert.deepEqual(findForbiddenArtifacts(dir), ['PROPOSAL.md']);
  });

  it('isForbiddenArtifactName：非 .md 不命中；大小写不敏感；EXECUTION / SUMMARY 排除', () => {
    assert.equal(isForbiddenArtifactName('proposal.md'), true);
    assert.equal(isForbiddenArtifactName('ProPoSaL.MD'), true);
    assert.equal(isForbiddenArtifactName('proposal.txt'), false);
    assert.equal(isForbiddenArtifactName('EXECUTION.md'), false);
    assert.equal(isForbiddenArtifactName('SUMMARY.md'), false);
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
    // drop reason：D25 之后出口门先做 head-moved 检查，D31 之后又加 refs-moved。旧 fixture 让
    // git 全失败 → headSha 为 null 且入口 refsSnapshot 落 null，出口会先命中 head-moved
    // (head-sha-missing) / refs-moved(refs-snapshot-missing) 而非快照 guard-error。
    // fixture 更新（D31）：让 rev-parse（锚定 HEAD）与 for-each-ref（锚定 refs）都成功、且出口
    // 复采一致，才能精确走到「diff / ls-files 失败 ⇒ 快照 guard-error」这条路径。
    const io = makeIo({
      git: (args) => {
        if (args[0] === 'rev-parse') return { status: 0, stdout: 'deadbeef\n' };
        if (args[0] === 'for-each-ref') return { status: 0, stdout: 'refs/heads/main deadbeef\n' };
        return { status: 1, stdout: '' };
      },
    });
    writeLightEntry(tmpDir, {
      changeId,
      executionPath: join(changeDir, getPreferredArtifactName('execution')),
      intent: { goal: '调整 foo', accept: ['a'], scope: ['src/lib/foo.mjs'], verify: 'node -e "process.exit(0)"' },
    }, io);
    updateState(tmpDir, {
      pipeline: 'light',
      activeChange: changeId,
      currentStage: 'fast',
      activeAgent: 'executor',
    });

    // 只有 diff / ls-files 失败；其余 IO 走真实实现（light.json / EXECUTION 都在真实临时目录里）
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
