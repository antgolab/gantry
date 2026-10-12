/**
 * light-guard.mjs — light 出口门纯函数集
 *
 * 用途:对 light change 的真实 diff 做收尾前检查 —— 意图范围合法性 / 越界 / 红线 /
 * 测试弱化 / verify 证据新鲜度,任一命中即由调用方升级为 full。
 *
 * 约束:
 * - 纯函数,不做任何 IO。git 快照、文件哈希、红线判定、测试路径识别全部由调用方注入。
 * - 不 import hard-rules.mjs(红线定义唯一源在那边,但本模块只接收注入的 detectRedLines,
 *   避免与 hard-rules 的重构互相耦合)。
 * - fail-closed(D14):任一必需输入缺失/非法,或任一检查步骤抛异常,一律返回
 *   passed=false 且附带一条 `guard-error` 命中,绝不因环境问题放行。
 */

/**
 * 校验意图里的「允许改动范围」是否合法。
 * 合法项:相对文件路径、以 `/` 结尾的目录、单段 `*` 通配(如 `src/lib/*.mjs`)。
 * 非法:非数组、空数组、任一项为空、含 `**`、绝对路径(以 `/` 开头)、含 `..` 路径段。
 *
 * @param {unknown} scope
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function validateIntentScope(scope) {
  if (!Array.isArray(scope) || scope.length === 0) {
    return { ok: false, reason: 'intent-scope-invalid' };
  }
  for (const raw of scope) {
    if (typeof raw !== 'string') return { ok: false, reason: 'intent-scope-invalid' };
    const item = raw.trim();
    if (item === '') return { ok: false, reason: 'intent-scope-invalid' };
    if (item.includes('**')) return { ok: false, reason: 'intent-scope-invalid' };
    if (item.startsWith('/')) return { ok: false, reason: 'intent-scope-invalid' };
    if (item.split('/').some((seg) => seg === '..')) {
      return { ok: false, reason: 'intent-scope-invalid' };
    }
  }
  return { ok: true, reason: null };
}

/**
 * 从改动文件里剔除「基线中已存在、哈希未变、且 mtime 不晚于入口时刻」的文件 ——
 * 这些是本轮 light 开始前工作区里就有的零散改动,与本次无关。
 *
 * D17 收紧:剔除必须同时满足「哈希一致」与「mtime ≤ createdAt」。
 * 只按哈希剔除的话,执行者把 baseline 改写成当前文件哈希即可让越界文件消失
 * (F-01);mtime 判据独立于被审对象可写的 light.json,是第二道锚。
 * 任一判据缺失 / 读取失败一律保守地保留该文件(fail-closed)。
 *
 * @param {string[]} changedFiles
 * @param {Record<string, string>} baseline - { path: sha1 }
 * @param {(path: string) => string} hashOf
 * @param {number} [createdAt] - light 入口时刻(ms);非有限值时不做任何剔除
 * @param {(path: string) => number} [mtimeOf] - 文件 mtime(ms);缺失 / 抛错 → 保留
 * @returns {string[]} 保留的(真正属于本次的)改动文件
 */
export function filterByBaseline(changedFiles, baseline, hashOf, createdAt, mtimeOf) {
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  if (typeof hashOf !== 'function' || !isPlainObject(baseline)) return files.slice();

  const hasCreatedAt = Number.isFinite(createdAt);
  const canStat = typeof mtimeOf === 'function';

  const kept = [];
  for (const file of files) {
    if (!Object.prototype.hasOwnProperty.call(baseline, file)) {
      kept.push(file);
      continue;
    }
    let hash;
    try {
      hash = hashOf(file);
    } catch {
      // 哈希读取失败 → 无法证明与基线一致,按已改动处理(fail-closed)
      kept.push(file);
      continue;
    }
    if (hash !== baseline[file]) {
      kept.push(file);
      continue;
    }
    // 哈希一致 —— 还需 mtime ≤ createdAt 才允许剔除
    if (!hasCreatedAt || !canStat) {
      kept.push(file);
      continue;
    }
    let mtime;
    try {
      mtime = mtimeOf(file);
    } catch {
      kept.push(file);
      continue;
    }
    if (!Number.isFinite(mtime) || mtime > createdAt) kept.push(file);
  }
  return kept;
}

/**
 * 判断改动文件是否都落在意图声明的范围内。
 * 命中规则(满足其一即视为在范围内):
 * - 等于某个文件项
 * - 以某个目录项(`dir/`)开头 —— 目录即允许在其下新建文件
 * - 匹配某个 `*` 项,且 `*` 不跨 `/`(如 `src/lib/*.mjs` 不匹配 `src/lib/sub/a.mjs`)
 * `.gantry/` 下的文件始终豁免(框架自身产物)。
 *
 * @param {string[]} files
 * @param {string[]} scope
 * @returns {{ ok: boolean, outOfScope: string[] }}
 */
export function checkScope(files, scope) {
  const items = (Array.isArray(scope) ? scope : []).filter((s) => typeof s === 'string');
  const dirs = items.filter((i) => i.endsWith('/'));
  const globs = items.filter((i) => !i.endsWith('/') && i.includes('*'));
  const exacts = items.filter((i) => !i.endsWith('/') && !i.includes('*'));

  const outOfScope = [];
  for (const file of Array.isArray(files) ? files : []) {
    if (typeof file !== 'string' || file === '') {
      outOfScope.push(String(file));
      continue;
    }
    if (isGantryPath(file)) continue;
    if (exacts.includes(file)) continue;
    if (dirs.some((dir) => file.startsWith(dir))) continue;
    if (globs.some((glob) => scopeGlobToRegExp(glob).test(file))) continue;
    outOfScope.push(file);
  }
  return { ok: outOfScope.length === 0, outOfScope };
}

/**
 * 检测测试弱化(R5.3)。
 * 仅测试路径参与;命中条件:
 * - 测试文件被删除(status 'D')
 * - 测试文件被修改(status 'M')且断言 token 数**或**用例 token 数净减少(D21 · B8)
 * 新增文件(status 'A')与新增断言永远不算弱化。
 *
 * token 分两类分别计数(D21 · B8):把「断言 token」和「用例声明 token」合并计数时,
 * 用 2 个空 `test()` 顶替 2 个真实断言会让总数不变而漏判;分开统计后断言数 2 → 0 即命中。
 * - 断言 token:`assert` 词 / `assert.` / `expect(`
 * - 用例 token:`it(` / `test(`
 *
 * @param {Array<{ path: string, status: string, before: string|null, after: string|null }>} entries
 * @param {(path: string) => boolean} isTestPath
 * @returns {{ hit: boolean, files: string[] }}
 */
export function detectTestWeakening(entries, isTestPath) {
  if (typeof isTestPath !== 'function') {
    throw new TypeError('detectTestWeakening: isTestPath must be a function');
  }
  const list = Array.isArray(entries) ? entries : [];
  const files = new Set();
  for (const entry of list) {
    if (!entry || typeof entry.path !== 'string') continue;
    if (!isTestPath(entry.path)) continue;
    if (entry.status === 'D') {
      files.add(entry.path);
      continue;
    }
    if (entry.status !== 'M') continue;
    const assertionsDown = countAssertions(entry.after) < countAssertions(entry.before);
    const casesDown = countCases(entry.after) < countCases(entry.before);
    if (assertionsDown || casesDown) files.add(entry.path);
  }
  return { hit: files.size > 0, files: [...files] };
}

/**
 * 校验 verify 证据是否新鲜。
 * 仅当记录存在、pass 为 true、且时间戳不早于最后一次代码修改时才算通过。
 *
 * 口径(D24):verifyRecord 由 CLI 当场执行 verify 时合成(at = 启动时间),所以正常路径下恒新鲜;
 * 这一项实际探测的是「verify 命令是否改写了工作区」。maxMtime 只覆盖基线过滤后仍存在的文件,
 * 删除的文件不参与。
 *
 * @param {{ pass: boolean, at: number }|null|undefined} verifyRecord
 * @param {number} maxMtime - 本次改动文件的最大 mtime(ms)
 * @returns {{ ok: boolean }}
 */
export function checkVerifyFresh(verifyRecord, maxMtime) {
  if (!isPlainObject(verifyRecord)) return { ok: false };
  if (verifyRecord.pass !== true) return { ok: false };
  if (!Number.isFinite(verifyRecord.at)) return { ok: false };
  if (!Number.isFinite(maxMtime)) return { ok: false };
  return { ok: verifyRecord.at >= maxMtime };
}

/**
 * light 出口门总入口:按顺序跑完所有检查并收集全部命中(fail-closed)。
 *
 * IO 全部注入:
 * - hashOf / isTestPath / detectRedLines 由调用方提供
 * - detectRedLines 以 `({ modifiedFiles, newFiles, pkgJsonDepsDelta }, '')` 调用;
 *   description 传空串,因为创建期已对描述做过红线预检,出口只需要看真实 diff
 *
 * @param {object} input
 * @param {string[]} input.scope
 * @param {string[]} input.changedFiles
 * @param {Record<string, string>} input.baseline
 * @param {(path: string) => string} input.hashOf
 * @param {number} [input.createdAt] - light 入口时刻(ms),基线剔除的 mtime 上界(D17)
 * @param {(path: string) => number} [input.mtimeOf] - 文件 mtime 探针(ms),由调用方注入
 * @param {Array<object>} input.testEntries
 * @param {{ pass: boolean, at: number }|null} input.verifyRecord
 * @param {number} input.maxMtime
 * @param {string} [input.description]
 * @param {string[]} [input.pkgJsonDepsDelta]
 * @param {(path: string) => boolean} input.isTestPath
 * @param {(snapshot: object, description: string) => { hit: boolean, ruleIds?: string[], ruleId?: string|null, files?: string[] }} input.detectRedLines
 * @returns {{ passed: boolean, hits: Array<{ ruleId: string, files: string[], detail?: string }> }}
 */
export function runLightGuard(input) {
  try {
    assertRequiredInputs(input);

    const hits = [];

    // ① 意图范围合法性
    const scopeResult = validateIntentScope(input.scope);
    if (!scopeResult.ok) {
      hits.push({ ruleId: 'intent-scope-invalid', files: [] });
    }

    // ② 扣除基线中哈希未变且 mtime ≤ createdAt 的文件(D17)
    const files = filterByBaseline(
      input.changedFiles, input.baseline, input.hashOf, input.createdAt, input.mtimeOf,
    );

    // ③ 越界检查
    const scopeCheck = checkScope(files, input.scope);
    if (!scopeCheck.ok) {
      hits.push({ ruleId: 'out-of-scope', files: scopeCheck.outOfScope });
    }

    // ④ 红线(注入;每个 ruleId 各记一条命中)
    const red = input.detectRedLines(
      {
        modifiedFiles: files,
        newFiles: [],
        pkgJsonDepsDelta: input.pkgJsonDepsDelta ?? [],
      },
      '',
    );
    if (red && red.hit) {
      const ruleIds = pickRuleIds(red);
      const redFiles = Array.isArray(red.files) ? red.files : [];
      for (const ruleId of ruleIds) hits.push({ ruleId, files: redFiles });
    }

    // ⑤ 测试弱化
    const weakened = detectTestWeakening(input.testEntries, input.isTestPath);
    if (weakened.hit) {
      hits.push({ ruleId: 'test-weakened', files: weakened.files });
    }

    // ⑥ verify 证据新鲜度
    const fresh = checkVerifyFresh(input.verifyRecord, input.maxMtime);
    if (!fresh.ok) {
      hits.push({ ruleId: 'stale-verify', files: [] });
    }

    return { passed: hits.length === 0, hits };
  } catch (err) {
    return {
      passed: false,
      hits: [{ ruleId: 'guard-error', files: [], detail: toMessage(err) }],
    };
  }
}

// --- 内部辅助 ---

function assertRequiredInputs(input) {
  if (!isPlainObject(input)) throw new Error('light-guard: input must be an object');
  for (const key of ['hashOf', 'isTestPath', 'detectRedLines']) {
    if (typeof input[key] !== 'function') {
      throw new Error(`light-guard: ${key} must be a function`);
    }
  }
  if (!Array.isArray(input.changedFiles)) {
    throw new Error('light-guard: changedFiles must be an array');
  }
  if (!Array.isArray(input.testEntries)) {
    throw new Error('light-guard: testEntries must be an array');
  }
  if (!isPlainObject(input.baseline)) {
    throw new Error('light-guard: baseline must be an object');
  }
}

function pickRuleIds(red) {
  if (Array.isArray(red.ruleIds) && red.ruleIds.length > 0) return red.ruleIds;
  if (typeof red.ruleId === 'string' && red.ruleId) return [red.ruleId];
  return ['red-line'];
}

// D21 · B8：断言 token 与用例 token 分开计
const ASSERT_TOKEN_RE = /(?:\bassert\b|\bexpect\s*\()/g;
const CASE_TOKEN_RE = /(?:\bit\s*\(|\btest\s*\()/g;

function countTokens(text, re) {
  if (typeof text !== 'string') return 0;
  const matched = text.match(re);
  return matched ? matched.length : 0;
}

function countAssertions(text) {
  return countTokens(text, ASSERT_TOKEN_RE);
}

function countCases(text) {
  return countTokens(text, CASE_TOKEN_RE);
}

function scopeGlobToRegExp(glob) {
  // 转义正则元字符(`*` 单独处理),`*` 不跨 `/`
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '[^/]*')}$`);
}

function isGantryPath(file) {
  return file === '.gantry' || file.startsWith('.gantry/');
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toMessage(err) {
  if (err && typeof err.message === 'string' && err.message) return err.message;
  return String(err);
}
