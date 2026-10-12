/**
 * light-gate.mjs — light 档的入口固化与出口门编排（DESIGN D22 · REVIEW F-06 的 IO 汇聚点）
 *
 * 由 src/cli.mjs 原样搬入（纯搬移，行为不变）。两类内容：
 *
 *   ① 入口：工作区 baseline 采集（collectBaseline）与 light.json / EXECUTION 意图头写入
 *      （writeLightEntry），外加入口预检用的 isGitRepo。
 *   ② 出口门：runLightExitGate（执行 verify → 采快照 → 跑守卫 → 升档 / 自动收尾），
 *      以及它依赖的 git name-status / untracked 解析（gitNameStatus / normalizeGitStatus /
 *      gitLsUntracked）、依赖增量探测（detectPkgJsonDepsDelta）、
 *      verify-log / diagnosis 解析（parseVerifyLog / latestDiagnosis）、
 *      verify 命令解析（resolveLightVerifyCommand）与 STATE 复位（resetStateToIdle）。
 *
 * IO 经可注入适配器（defaultIo）：
 *   { git(args, cwd) → {status, stdout}, readFile(path, encoding), exists(path),
 *     stat(path), now() }
 *   - 读探针（git / 文件读 / 存在性 / stat / 时钟）一律走适配器，单测可直接 stub；
 *   - 写（light.json / EXECUTION / STATE）仍用 node:fs：适配器只覆盖读侧，写的目标
 *     是真实项目目录，由端到端用例覆盖。
 *   - 适配器可省略，默认实现用 spawnSync / node:fs。
 *
 * 依赖方向：archiveChange 由 CLI 注入（归档编排属于 CLI 层），避免 light-gate ⇄ cli 循环依赖。
 */

import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { SPECS_DIR, PLANNING_DIR, specsPath } from './paths.mjs';
import { readFence, writeFence, writeState, updateState, recordLightVerify } from './state.mjs';
import { detectRedLines, isTestPath } from './hard-rules.mjs';
import { filterByBaseline, runLightGuard } from './light-guard.mjs';
import { upgradeToFull } from './light-upgrade.mjs';
import { writeContextPack } from './context-pack.mjs';
import { parseTestCommandsFromString } from './test-commands.mjs';
import { resolveArtifactPath, ARTIFACT_ALIASES } from './artifacts.mjs';

/**
 * 默认 IO 适配器：spawnSync / node:fs。
 * readFile(path) 返回 Buffer，readFile(path, 'utf-8') 返回字符串（与 readFileSync 一致）。
 */
export const defaultIo = {
  git(args, cwd) {
    const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
    return { status: r.status, stdout: String(r.stdout || '') };
  },
  readFile(path, encoding) {
    return readFileSync(path, encoding);
  },
  exists(path) {
    return existsSync(path);
  },
  stat(path) {
    return statSync(path);
  },
  now() {
    return Date.now();
  },
};

// --- light 入口（DESIGN D15；SPEC AC-3/AC-4/AC-5）---

/** 意图锚定文件相对路径（D17）。 */
export const LIGHT_ANCHOR_FILE = `${PLANNING_DIR}/light-anchor.json`;

/**
 * light.json 的规范化 sha256（稳定键序）—— 锚定值（D17）。
 * 对对象做递归键排序后再序列化，保证「写盘 / 重新解析」两次哈希一致。
 */
export function hashLightJson(lightJson) {
  return createHash('sha256').update(canonicalJson(lightJson)).digest('hex');
}

/** 递归稳定序列化：对象键按字典序排序，其余交给 JSON.stringify。 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 删除锚定文件（升档 / 收尾后清理），缺失不报错。 */
export function removeLightAnchor(projectRoot) {
  try {
    rmSync(join(projectRoot, LIGHT_ANCHOR_FILE), { force: true });
  } catch { /* 清理失败不影响主流程 */ }
}

/** `git rev-parse --is-inside-work-tree` → 是否 git 工作区；git 失败判为 false。 */
export function isGitRepo(projectRoot, io = defaultIo) {
  return io.git(['rev-parse', '--is-inside-work-tree'], projectRoot).status === 0;
}

/**
 * 解析当前 HEAD（D25 · F-14/N18）：`git rev-parse HEAD` → sha；仓库尚无提交 / git 失败
 * → null。入口把它写进 light.json.headSha（受 D17 锚定保护）；HEAD 无法解析时由 change()
 * 回落 full@change（reason `no-head-commit`）。
 */
export function resolveHeadSha(projectRoot, io = defaultIo) {
  const r = io.git(['rev-parse', 'HEAD'], projectRoot);
  if (r.status !== 0) return null;
  const sha = String(r.stdout || '').trim();
  return sha || null;
}

/**
 * HEAD 漂移检查（D25 · F-14/N18）：出口门在采快照前比对当前 HEAD 与入口记录的
 * light.json.headSha。三者任一成立即命中 `head-moved`（fail-closed）：
 *   - 记录缺失（legacy light.json 无 headSha，无可信基准）；
 *   - 当前 HEAD 无法解析；
 *   - 两者不一致（典型：light 期间 commit 了工作区改动，守卫采集面会归零）。
 * 不尝试用 `headSha..HEAD` 重算 diff —— 那会引入新的信任面（D25）。
 *
 * @returns {{ ruleId: string, files: string[], detail: string }|null}
 */
export function checkHeadMoved(projectRoot, lightJson, io = defaultIo) {
  const recorded = lightJson && typeof lightJson.headSha === 'string' && lightJson.headSha
    ? lightJson.headSha
    : null;
  const current = resolveHeadSha(projectRoot, io);
  if (recorded && current && recorded === current) return null;
  const detail = !recorded ? 'head-sha-missing' : (!current ? 'head-unresolvable' : 'head-moved');
  return { ruleId: 'head-moved', files: [], detail };
}

/**
 * 采集工作区基线：所有 dirty / untracked 文件 → { 相对路径: sha1 }。
 * 排除 .gantry/（框架自身产物）；删除或不可读的文件跳过。git 失败 → 该条命令返回空列表。
 */
export function collectBaseline(projectRoot, io = defaultIo) {
  const files = [
    ...gitLines(projectRoot, ['diff', '--name-only', 'HEAD'], io),
    ...gitLines(projectRoot, ['ls-files', '--others', '--exclude-standard'], io),
  ];
  const baseline = {};
  for (const rel of files) {
    if (rel.startsWith('.gantry/') || rel === '.gantry') continue;
    let content;
    try {
      content = io.readFile(join(projectRoot, rel));
    } catch {
      continue; // 已删除 / 不可读
    }
    baseline[rel] = createHash('sha1').update(content).digest('hex');
  }
  return baseline;
}

/**
 * 固化 light 意图：写 light.json（含 baseline 哈希）与 EXECUTION 的意图头视图。
 *
 * @param {string} projectRoot
 * @param {object} input
 * @param {string} input.changeId
 * @param {string} input.executionPath - EXECUTION.md 绝对路径（change 目录由调用方建好）
 * @param {{ goal: string, accept: string[], scope: string[], verify?: string }} input.intent
 * @param {object} [io]
 * @returns {object} 写盘的 lightJson（含 intent / baseline / createdAt）
 */
export function writeLightEntry(projectRoot, { changeId, executionPath, intent }, io = defaultIo) {
  const lightJson = {
    intent,
    baseline: collectBaseline(projectRoot, io),
    // D25：记录入口 HEAD，受 D17 锚定保护；出口门据此判 head-moved。
    headSha: resolveHeadSha(projectRoot, io),
    createdAt: new Date(io.now()).toISOString(),
  };
  writeFileSync(join(projectRoot, SPECS_DIR, changeId, 'light.json'), `${JSON.stringify(lightJson, null, 2)}\n`, 'utf-8');
  // D17：把 light.json 规范化内容的 sha256 锚定到独立文件。出口门先校验锚定，
  // 任何对 light.json 的改写（scope / verify / baseline）都会在这里被检出。
  const anchorDir = join(projectRoot, PLANNING_DIR);
  if (!existsSync(anchorDir)) mkdirSync(anchorDir, { recursive: true });
  writeFileSync(
    join(projectRoot, LIGHT_ANCHOR_FILE),
    `${JSON.stringify({ changeId, sha256: hashLightJson(lightJson), createdAt: lightJson.createdAt }, null, 2)}\n`,
    'utf-8',
  );
  writeFileSync(
    executionPath,
    `# EXECUTION: ${changeId}\n\n${renderLightIntent(lightJson)}\n\n${renderTierDecision({ tier: 'light', source: 'override' })}\n`,
    'utf-8',
  );
  return lightJson;
}

/**
 * 渲染 light 意图头（EXECUTION 顶部视图，3~5 行）。
 */
export function renderLightIntent(lightJson) {
  const { goal, accept, scope, verify } = lightJson.intent;
  const lines = [
    '## light-intent',
    `- 目标: ${goal}`,
    `- 验收线: ${accept.join('; ')}`,
    `- 允许改动范围: ${scope.join(', ')}`,
  ];
  if (verify) lines.push(`- verify: ${verify}`);
  return lines.join('\n');
}

/**
 * 渲染 tier-decision 段（无 score / hits / auto 行）。
 */
export function renderTierDecision({ tier, source, reason = null }) {
  const lines = ['## tier-decision', `tier: ${tier}`, `source: ${source}`];
  if (reason) lines.push(`reason: ${reason}`);
  return lines.join('\n');
}

// --- light 出口门（DESIGN D7/D8/D14；SPEC AC-6/7/8/11）---

/**
 * 在 light@fast 上执行出口门。返回 { stop, exitCode? }，与 nextOnce 契约一致。
 *
 * 步骤：
 *   ① 拒绝 --skip（light 无人工关卡，门禁不可绕过）
 *   ② 读 light.json 并校验意图锚定（D17，篡改 ⇒ intent-tampered 升档）
 *   ③ 解析 verify 命令（intent.verify → test-commands.yml → 无 ⇒ guard-error 升档）
 *   ④ 执行 verify（startedAt 先于执行记录），写 EXECUTION `## verify-log`；
 *      FAIL → recordLightVerify 计数 / 暂停，exit 1，不归档不写 CHANGELOG
 *   ⑤ PASS → 清暂停 / 重试
 *   ⑥ HEAD 漂移与预置工件：HEAD ≠ light.json.headSha ⇒ head-moved（D25）；change 目录出现
 *      full 流水线工件 ⇒ forbidden-artifact（D20）—— 任一命中即升档
 *   ⑦ 采 diff 快照 + runLightGuard，写 `## guard-decision`
 *   ⑧ 命中 → upgradeToFull（仅 stale-verify 时回到 verify）；全通过 → 写 `## archive-trace`
 *      （D29）+ archiveChange + STATE 复位 idle
 *
 * @param {string} projectRoot
 * @param {object} state - readState 结果
 * @param {object} [options]
 * @param {boolean} [options.isSkip]
 * @param {object} [options.io] - IO 适配器（缺省 defaultIo）
 * @param {Function} [options.archiveChange] - CLI 注入的归档实现 (projectRoot, changeId, opts)
 */
export async function runLightExitGate(projectRoot, state, { isSkip = false, io = defaultIo, archiveChange } = {}) {
  const changeId = state.activeChange;
  const changeDir = join(projectRoot, SPECS_DIR, changeId);

  // ① --skip 对 light 无效
  if (isSkip) {
    console.error('✗ light 出口门不可跳过（--skip 对 light 无效）');
    return { stop: true, exitCode: 1 };
  }

  const lightJson = readLightJson(changeDir, io);

  // ② 意图锚定校验（D17）：在读取 intent.verify / scope / baseline 之前完成。
  // 锚定缺失 / 篡改一律 fail-closed 升档，不给被改写过的意图任何效力。
  const tamperHit = verifyLightAnchor(projectRoot, changeId, lightJson, io);
  if (tamperHit) return upgradeFromHits(projectRoot, [tamperHit]);

  const intent = (lightJson && lightJson.intent) || {};
  const baseline = (lightJson && lightJson.baseline) || {};
  const createdAtMs = Date.parse(lightJson.createdAt);

  // ③ verify 命令
  const verifyCmd = resolveLightVerifyCommand(projectRoot, intent, io);
  if (!verifyCmd) {
    // D7/D14：没有可执行的 verify 证据，不能放行 → guard-error 升档
    return upgradeFromHits(projectRoot, [
      { ruleId: 'guard-error', files: [], detail: 'no-verify-command' },
    ]);
  }

  // ④ 执行 verify（startedAt 先于执行记录：verify 若改写代码会让证据失效，AC-11）
  const startedAt = io.now();
  const run = spawnSync(verifyCmd, {
    shell: true, cwd: projectRoot, encoding: 'utf-8', timeout: 600000,
  });
  const exitCode = run.status === null ? 1 : run.status; // 超时 / 启动失败 → 视为失败
  const pass = exitCode === 0;
  printVerifyTail(run.stdout, run.stderr);

  // 失败分支：R2.5 自愈计数 / 暂停，永不归档
  if (!pass) {
    const executionText = readExecutionText(changeDir, io);
    const { failDiagnoses } = parseVerifyLog(executionText);
    const hasPreviousFail = failDiagnoses.length > 0;
    const diagnosis = hasPreviousFail ? latestDiagnosis(executionText) : 'first-failure';
    const lastDiagnosis = hasPreviousFail ? failDiagnoses[failDiagnoses.length - 1] : null;

    const { state: nextState, paused } = recordLightVerify(state, {
      pass: false, diagnosis, lastDiagnosis,
    });
    updateState(projectRoot, { retries: nextState.retries, pauseReason: nextState.pauseReason });

    appendExecutionBlock(changeDir, 'verify-log',
      `- ${new Date(startedAt).toISOString()} FAIL \`${verifyCmd}\` (exit ${exitCode}) diagnosis: ${diagnosis || '—'}`, io);

    const maxRetries = state.maxRetries ?? 3;
    if (paused) {
      console.error(`✗ light verify 持续失败，已暂停: ${nextState.pauseReason}`);
      console.error('  change 未归档、CHANGELOG 未写入。修复后运行 gantry pipeline full 升档，');
      console.error('  或在 EXECUTION.md 追加一条新的 `## diagnosis` 条目后重新运行 gantry advance。');
      return { stop: true, exitCode: 1 };
    }
    console.error(`✗ light verify 失败 [${nextState.retries}/${maxRetries}]: exit ${exitCode}`);
    console.error('  请在 EXECUTION.md 追加一条新的 `## diagnosis` 条目（文本须与上一条不同），');
    console.error('  修复后重新运行 gantry advance。');
    return { stop: true, exitCode: 1 };
  }

  // ⑤ PASS：清暂停/重试（recordLightVerify 在 pass 时不清 pauseReason，CLI 层显式清理）
  updateState(projectRoot, { retries: 0, pauseReason: null });
  appendExecutionBlock(changeDir, 'verify-log',
    `- ${new Date(startedAt).toISOString()} PASS \`${verifyCmd}\` (exit ${exitCode}) diagnosis: —`, io);

  // ⑥ HEAD 漂移（D25 · F-14/N18）+ 预置工件扫描（D20 · F-03）。
  //    head-moved 必须在采快照前判：light 期间 commit 会让「未提交 diff」采集面归零，
  //    否则守卫会在空集合上全通过。预置工件同样在跑守卫前扫（门禁只读规范名，预置文件会顶替升档初稿）。
  const forbiddenHits = forbiddenArtifactHits(changeDir);
  const headHit = checkHeadMoved(projectRoot, lightJson, io);
  if (headHit) return upgradeFromHits(projectRoot, [...forbiddenHits, headHit]);

  // ⑦ 采快照 + 守卫（任一 git 失败 ⇒ guard-error，fail-closed）
  let guardInput;
  try {
    guardInput = collectLightGuardInput(projectRoot, { intent, baseline, startedAt, createdAt: createdAtMs }, io);
  } catch (err) {
    return upgradeFromHits(projectRoot, [
      ...forbiddenHits,
      { ruleId: 'guard-error', files: [], detail: `snapshot: ${err.message}` },
    ]);
  }

  const guardResult = runLightGuard(guardInput);
  appendExecutionBlock(changeDir, 'guard-decision', renderGuardDecision(guardResult, io), io);

  // ⑧ 命中处理：预置工件 / 守卫命中合并，全部进入升档原因
  const hits = [...forbiddenHits, ...guardResult.hits];
  if (hits.length > 0) {
    // SPEC AC-11：缺 fresh verify 证据时门禁失败，循环回到 verify（不升档）
    const onlyStale = hits.every((h) => h.ruleId === 'stale-verify');
    if (onlyStale) {
      console.error('✗ 出口门失败：verify 证据不新鲜（代码在 verify 之后又被改写）');
      console.error('  请重新运行 gantry advance —— verify 必须晚于最后一次代码改动。');
      return { stop: true, exitCode: 1 };
    }
    return upgradeFromHits(projectRoot, hits);
  }

  // 全通过 → 自动收尾（全程无人工确认，AC-7）
  const files = filterByBaseline(
    guardInput.changedFiles, baseline, guardInput.hashOf, guardInput.createdAt, guardInput.mtimeOf,
  );
  const goal = typeof intent.goal === 'string' && intent.goal.trim() ? intent.goal.trim() : changeId;
  const shown = files.slice(0, 3).join(', ');
  const suffix = files.length > 3 ? ` (+${files.length - 3})` : '';
  const summary = files.length > 0 ? `${goal} · files: ${shown}${suffix}` : goal;

  if (typeof archiveChange !== 'function') {
    throw new Error('runLightExitGate: archiveChange 未注入（归档编排由 CLI 提供）');
  }
  // D29 · F-15：归档留痕 —— light.json 锚定值与 headSha 随目录一起归档，供事后比对。
  appendExecutionBlock(changeDir, 'archive-trace',
    `- light.json sha256: ${hashLightJson(lightJson)}\n- headSha: ${lightJson.headSha || '—'}\n- at: ${new Date(io.now()).toISOString()}`,
    io);
  await archiveChange(projectRoot, changeId, { summary });
  resetStateToIdle(projectRoot, state, { loopDone: true });
  removeLightAnchor(projectRoot);

  console.log(`✓ light 出口门通过，已自动收尾: ${changeId}`);
  console.log(`  已归档到 ${specsPath('_archive', changeId)}/`);
  console.log('  code: light_archived');
  return { stop: true };
}

// --- 预置 full 工件判定（D20 · F-03；D30 · F-16：名单派生自 artifacts.mjs）---

/**
 * 禁止清单的推导：light 期间 change 目录里出现 full 流水线工件一律视为
 * `forbidden-artifact` —— 门禁只读规范名（`resolveArtifactPath`），预置的同名文件会顶替升档初稿。
 *
 * 名字集合从 `ARTIFACT_ALIASES` 的 full 流水线键派生（proposal / spec / design / tasks /
 * test / review 及其别名，如 CHANGE.md / REQUIREMENT.md / TASK.md），不再本地硬编码第二份
 * 名单（F-16：旧的本地名单漏了别名与小写变体）。比较口径：basename 去扩展名后取第一段
 * （容忍 `.upgrade` / `.pre-light` / `.pre-light.2` 等后缀变体），大小写不敏感。
 * EXECUTION.md 及其别名（SUMMARY.md）不在派生键内 —— 它们是 light 自身产物，天然排除。
 */
const FORBIDDEN_ARTIFACT_KEYS = ['proposal', 'spec', 'design', 'tasks', 'test', 'review'];

function artifactStem(name) {
  return String(name).replace(/\.md$/i, '').split('.')[0].toUpperCase();
}

/** 禁止工件的 stem 集合（大小写不敏感比较，见上方推导说明）。 */
export const FORBIDDEN_ARTIFACT_STEMS = new Set(
  FORBIDDEN_ARTIFACT_KEYS.flatMap((key) => (ARTIFACT_ALIASES[key] || []).map(artifactStem)),
);

/** 名字是否命中禁止工件（仅 `.md`；大小写不敏感；容忍 `.upgrade` / `.pre-light[.N]` 后缀）。 */
export function isForbiddenArtifactName(name) {
  const n = String(name ?? '');
  if (!/\.md$/i.test(n)) return false;
  return FORBIDDEN_ARTIFACT_STEMS.has(artifactStem(n));
}

/**
 * 扫描 change 目录（仅顶层条目）里的预置 full 工件，返回排序后的名字列表。
 * 文件与符号链接都算（F-16：旧的 `e.isFile()` 漏报 symlink PROPOSAL.md）；
 * 目录不存在 / 不可读 → 空列表（不误报）。
 */
export function findForbiddenArtifacts(changeDir) {
  let entries;
  try {
    entries = readdirSync(changeDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() || e.isSymbolicLink())
    .filter((e) => isForbiddenArtifactName(e.name))
    .map((e) => e.name)
    .sort();
}

/** 把预置工件列表折成 0 或 1 条 `forbidden-artifact` 命中（D20 · F-03）。 */
function forbiddenArtifactHits(changeDir) {
  const files = findForbiddenArtifacts(changeDir);
  if (files.length === 0) return [];
  return [{
    ruleId: 'forbidden-artifact',
    files,
    detail: 'light change 目录出现 full 流水线工件，无法确认 change 门禁读到的是升档初稿',
  }];
}

/**
 * 守卫命中 → 自动升档 full@change（D13），工作区不动。
 * 打印命中项、PROPOSAL 初稿路径与 code，返回 { stop: true }（exit 0）。
 */
export function upgradeFromHits(projectRoot, hits) {
  let result;
  try {
    result = upgradeToFull(projectRoot, { source: 'auto', hits });
  } catch (err) {
    console.error(`✗ light 升档失败: ${err.message}`);
    return { stop: true, exitCode: 1 };
  }
  try { writeContextPack(projectRoot); } catch { /* non-blocking */ }
  removeLightAnchor(projectRoot);

  console.log('↑ 守卫命中，light → full 自动升档');
  for (const h of hits) {
    const files = Array.isArray(h.files) && h.files.length ? `: ${h.files.join(', ')}` : '';
    const detail = h.detail ? ` (${h.detail})` : '';
    console.log(`  - ${h.ruleId}${files}${detail}`);
  }
  console.log(`  PROPOSAL 初稿: ${result.proposalPath}`);
  console.log('  当前状态: full@change（change 门禁等待人工确认）');
  console.log('  code: light_upgraded');
  return { stop: true };
}

/**
 * 采集 runLightGuard 的输入快照（IO 汇聚点）。
 *
 * - changedFiles = 全部脏/未跟踪文件（排除 .gantry/），并入「基线里出口时已被删除」的路径（D27）
 * - hashOf = 当前文件内容 sha1（不可读时抛错，由调用方转为 guard-error）
 * - createdAt / mtimeOf = 基线剔除的 mtime 上界与探针（D17）
 * - maxMtime = 基线过滤后仍存在的改动文件的最大 mtimeMs
 * - testEntries = 基线过滤后测试路径的 {path, status, before(=HEAD), after(=工作区)}
 * - pkgJsonDepsDelta = package.json 变更触及 dependencies/devDependencies 时为 ['dependencies']
 * - detectRedLines = 包一层：把入口后新出现、被 gitignore 覆盖的文件并入 newFiles（D26），
 *   使它们只参与红线路径检查，不进范围 / 测试弱化 / 新鲜度
 */
export function collectLightGuardInput(projectRoot, { intent, baseline, startedAt, createdAt }, io = defaultIo) {
  const statusMap = new Map();
  for (const e of gitNameStatus(projectRoot, io)) statusMap.set(e.path, e.status);
  for (const p of gitLsUntracked(projectRoot, io)) {
    if (!statusMap.has(p)) statusMap.set(p, 'A');
  }

  // D27 · N4：baseline 里的路径若在出口时已不在磁盘、且 name-status 未记为删除（未跟踪文件
  // 被删时 git diff 与 ls-files --others 都看不到），补一条 D 记录，照常走范围检查。
  for (const rel of Object.keys(baseline || {})) {
    if (statusMap.has(rel)) continue;
    if (rel === '.gantry' || rel.startsWith('.gantry/')) continue;
    let onDisk = true;
    try { onDisk = io.exists(join(projectRoot, rel)); } catch { onDisk = false; }
    if (!onDisk) statusMap.set(rel, 'D');
  }

  const all = [...statusMap.keys()].filter((p) => !(p === '.gantry' || p.startsWith('.gantry/')));
  const hashOf = (rel) => sha1File(join(projectRoot, rel), io);
  const mtimeOf = (rel) => io.stat(join(projectRoot, rel)).mtimeMs;

  const filtered = filterByBaseline(all, baseline, hashOf, createdAt, mtimeOf);

  let maxMtime = 0;
  for (const rel of filtered) {
    try {
      const st = io.stat(join(projectRoot, rel));
      maxMtime = Math.max(maxMtime, st.mtimeMs);
    } catch {
      // 已删除 / 不可读 → 不参与 mtime（仍作为改动文件由守卫判定）
    }
  }

  const testEntries = filtered.filter((rel) => isTestPath(rel)).map((rel) => ({
    path: rel,
    status: statusMap.get(rel) || 'M',
    before: gitShowHead(projectRoot, rel, io),
    after: readFileOrNull(join(projectRoot, rel), io),
  }));

  // D26 · F-14 第二实例：被 gitignore 覆盖、且入口后新出现的文件只送红线路径检查。
  const ignoredRedLineFiles = listIgnoredAfterEntry(projectRoot, createdAt, io);
  const detectRedLinesWithIgnored = (snapshot, description) => detectRedLines(
    {
      modifiedFiles: snapshot.modifiedFiles,
      // 并入 newFiles：只喂路径 glob（不影响 scope / test-weakening / maxMtime，也不计跨模块）
      newFiles: [...(snapshot.newFiles || []), ...ignoredRedLineFiles],
      pkgJsonDepsDelta: snapshot.pkgJsonDepsDelta,
    },
    description,
  );

  return {
    scope: Array.isArray(intent.scope) ? intent.scope : [],
    changedFiles: all,
    baseline,
    hashOf,
    createdAt,
    mtimeOf,
    testEntries,
    verifyRecord: { pass: true, at: startedAt },
    maxMtime,
    description: typeof intent.goal === 'string' ? intent.goal : '',
    isTestPath,
    detectRedLines: detectRedLinesWithIgnored,
    pkgJsonDepsDelta: detectPkgJsonDepsDelta(projectRoot, filtered, io),
  };
}

/** 读 light.json；缺失 / 非法 → null（不是错误）。 */
export function readLightJson(changeDir, io = defaultIo) {
  const p = join(changeDir, 'light.json');
  if (!io.exists(p)) return null;
  try {
    const parsed = JSON.parse(io.readFile(p, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 校验意图锚定（D17）。返回 null 表示锚定有效；否则返回一条 `intent-tampered`
 * 命中（fail-closed：缺失 / 不可解析 / changeId 不符 / sha256 不符都命中）。
 *
 * @param {string} projectRoot
 * @param {string} changeId - 当前活跃 change（锚定的 changeId 必须与之一致）
 * @param {object|null} lightJson - 当前 light.json 解析结果
 * @param {object} [io]
 * @returns {{ ruleId: string, files: string[], detail: string }|null}
 */
export function verifyLightAnchor(projectRoot, changeId, lightJson, io = defaultIo) {
  const p = join(projectRoot, LIGHT_ANCHOR_FILE);
  const hit = (detail) => ({ ruleId: 'intent-tampered', files: [], detail });
  if (!io.exists(p)) return hit('anchor-missing');
  let anchor;
  try {
    anchor = JSON.parse(io.readFile(p, 'utf-8'));
  } catch {
    return hit('anchor-unparsable');
  }
  if (!anchor || typeof anchor !== 'object') return hit('anchor-unparsable');
  if (anchor.changeId !== changeId) return hit('anchor-change-mismatch');
  if (!lightJson || typeof lightJson !== 'object') return hit('light-json-missing');
  if (anchor.sha256 !== hashLightJson(lightJson)) return hit('anchor-hash-mismatch');
  return null;
}

/**
 * 解析 light 出口门的 verify 命令：
 *   intent.verify → `.gantry/loop/test-commands.yml` 的全部 cmd（按定义顺序 && 串联）→ null
 */
export function resolveLightVerifyCommand(projectRoot, intent, io = defaultIo) {
  if (intent && typeof intent.verify === 'string' && intent.verify.trim()) {
    return intent.verify.trim();
  }
  const tcPath = join(projectRoot, '.gantry', 'loop', 'test-commands.yml');
  let parsed = null;
  try {
    if (io.exists(tcPath)) parsed = parseTestCommandsFromString(io.readFile(tcPath, 'utf-8'));
  } catch { parsed = null; }
  if (parsed && typeof parsed === 'object') {
    const cmds = Object.values(parsed)
      .map((e) => (e && typeof e.cmd === 'string' ? e.cmd.trim() : ''))
      .filter(Boolean);
    if (cmds.length > 0) return cmds.join(' && ');
  }
  return null;
}

/** 打印 verify 输出的末尾若干行。 */
export function printVerifyTail(stdout, stderr) {
  const text = `${stdout || ''}${stderr || ''}`.trimEnd();
  if (!text) return;
  const tail = text.split('\n').slice(-15);
  console.log('  ── verify 输出 ──');
  for (const line of tail) console.log(`  ${line}`);
}

/** 渲染 `## guard-decision` 段内容。 */
export function renderGuardDecision(guardResult, io = defaultIo) {
  const lines = [
    `- at: ${new Date(io.now()).toISOString()}`,
    '- checks: intent-scope-invalid, out-of-scope, red-lines, test-weakened, stale-verify',
  ];
  if (guardResult.passed) {
    lines.push('- result: passed');
  } else {
    lines.push('- result: hits');
    for (const h of guardResult.hits) {
      const files = Array.isArray(h.files) && h.files.length ? h.files.join(', ') : '—';
      const detail = h.detail ? ` (${h.detail})` : '';
      lines.push(`- hit: ${h.ruleId}: ${files}${detail}`);
    }
  }
  return lines.join('\n');
}

/** 向 change 的 EXECUTION.md 追加一段 `## <heading>` 块（文件缺失则创建）。 */
export function appendExecutionBlock(changeDir, heading, text, io = defaultIo) {
  const resolved = resolveArtifactPath(changeDir, 'execution');
  const path = resolved.path;
  const existing = io.exists(path) ? io.readFile(path, 'utf-8') : '';
  const block = `## ${heading}\n\n${text}\n`;
  const prefix = existing.trim() ? `${existing.replace(/\s*$/, '')}\n\n` : '';
  writeFileSync(path, `${prefix}${block}`, 'utf-8');
}

/** 读 EXECUTION.md 全文；缺失 → 空串。 */
export function readExecutionText(changeDir, io = defaultIo) {
  const resolved = resolveArtifactPath(changeDir, 'execution');
  if (!resolved || !io.exists(resolved.path)) return '';
  return io.readFile(resolved.path, 'utf-8');
}

/** 解析 verify-log：返回按出现顺序排列的 FAIL 行 diagnosis 文本。 */
export function parseVerifyLog(text) {
  const re = /^-\s+\S+\s+(PASS|FAIL)\s+`[^`]*`\s+\(exit\s+-?\d+\)\s+diagnosis:\s*(.*)$/;
  const failDiagnoses = [];
  for (const line of text.split('\n')) {
    const m = line.match(re);
    if (m && m[1] === 'FAIL') failDiagnoses.push(m[2].trim());
  }
  return { failDiagnoses };
}

/**
 * 取 EXECUTION `## diagnosis` 段内最新一条 `- <text>`。
 * 兼容两种写法：`## diagnosis` 后跟 `- text`，或 `## diagnosis: text` 行内承载。
 * 无视文本 → 返回空串（recordLightVerify 会判为无效自愈并暂停）。
 */
export function latestDiagnosis(text) {
  let inSection = false;
  let latest = '';
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const inline = line.match(/^##\s+diagnosis\s*[::]\s*(.+)$/);
    if (inline) { latest = inline[1].trim(); inSection = true; continue; }
    if (/^##\s/.test(line)) { inSection = /^##\s+diagnosis\s*$/.test(line); continue; }
    if (/^---\s*$/.test(line)) { inSection = false; continue; }
    if (!inSection) continue;
    const item = line.match(/^\s*-\s+(.+)$/);
    if (item) latest = item[1].trim();
  }
  return latest;
}

/**
 * `git diff --name-status --no-renames HEAD` → [{ status: 'A'|'M'|'D', path }]；git 失败抛错。
 *
 * D21 / F-02：关闭改名折叠（`--no-renames`），一次 `git mv` 表现为「旧路径 D + 新路径 A」，
 * 旧测试文件的删除因此对 detectTestWeakening 可见。解析层再兜底：即使 git 仍返回 R / C 行
 * （例如外部配置强制开启改名检测），也拆成同一形状 —— R 产「旧 D + 新 A」，C 只产「新 A」。
 */
export function gitNameStatus(projectRoot, io = defaultIo) {
  const r = io.git(['diff', '--name-status', '--no-renames', 'HEAD'], projectRoot);
  if (r.status !== 0) throw new Error(`git diff 失败 (exit ${r.status})`);
  const out = [];
  for (const line of String(r.stdout || '').split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const code = parts[0].charAt(0);
    if (code === 'R' || code === 'C') {
      // R100\told\tnew / C100\told\tnew
      const oldPath = parts[1];
      const newPath = parts[2];
      if (code === 'R' && oldPath) out.push({ status: 'D', path: oldPath });
      if (newPath) out.push({ status: 'A', path: newPath });
      continue;
    }
    const path = parts[parts.length - 1];
    out.push({ status: normalizeGitStatus(code), path });
  }
  return out;
}

export function normalizeGitStatus(code) {
  if (code === 'A' || code === 'C' || code === '?') return 'A';
  if (code === 'D') return 'D';
  return 'M';
}

/** `git ls-files --others --exclude-standard` → 未跟踪文件列表；git 失败抛错。 */
export function gitLsUntracked(projectRoot, io = defaultIo) {
  const r = io.git(['ls-files', '--others', '--exclude-standard'], projectRoot);
  if (r.status !== 0) throw new Error(`git ls-files 失败 (exit ${r.status})`);
  return String(r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * 列出「被 gitignore 覆盖、且在入口后新出现」的文件（D26 · F-14 第二实例）。
 * 排除 `node_modules/`（依赖变更已由 D21 结构化比对覆盖）与 `.gantry/`（框架自身产物），
 * 仅保留 mtime > createdAt 的条目。git 失败抛错（由调用方转为 guard-error，fail-closed）。
 */
function listIgnoredAfterEntry(projectRoot, createdAt, io) {
  const r = io.git(['ls-files', '--others', '--ignored', '--exclude-standard'], projectRoot);
  if (r.status !== 0) throw new Error(`git ls-files --ignored 失败 (exit ${r.status})`);
  const files = String(r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  return files.filter((p) => {
    if (p === '.gantry' || p.startsWith('.gantry/')) return false;
    if (/(^|\/)node_modules\//.test(p)) return false;
    if (!Number.isFinite(createdAt)) return false;
    try { return io.stat(join(projectRoot, p)).mtimeMs > createdAt; } catch { return false; }
  });
}

/**
 * 依赖增量红线（D21 · F-05）：对所有变更的 package.json（排除 node_modules/）
 * 做结构化比对 —— 解析 HEAD 版本（`git show HEAD:<path>`，不存在 → {}）与工作区版本
 * （已删除 → {}），逐一比较六类依赖字段的键与值（稳定 JSON 深比较）。
 * 任一字段有差异即返回 ['dependencies']。
 *
 * 取代旧的「diff 文本里出现 `"dependencies"` 字面量」判据：往长依赖表末尾追加一项时
 * 3 行上下文不含该字面量，会被静默放行（F-05 实证）。
 *
 * 解析失败抛错（由调用方 / runLightExitGate 转为 guard-error，fail-closed）。
 */
export const PKG_DEP_FIELDS = [
  'dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'overrides', 'resolutions',
];

export function detectPkgJsonDepsDelta(projectRoot, files, io = defaultIo) {
  const targets = (Array.isArray(files) ? files : [])
    .filter((p) => typeof p === 'string' && p !== '')
    .filter((p) => basename(p) === 'package.json')
    .filter((p) => !/(^|\/)node_modules\//.test(p));
  if (targets.length === 0) return [];

  for (const rel of targets) {
    const head = readPkgJsonAtHead(projectRoot, rel, io);
    const work = readPkgJsonWorktree(projectRoot, rel, io);
    for (const field of PKG_DEP_FIELDS) {
      if (canonicalJson(head[field]) !== canonicalJson(work[field])) return ['dependencies'];
    }
  }
  return [];
}

/** HEAD 版本 package.json；文件不在 HEAD 中 → {}；内容非法 JSON → 抛错。 */
function readPkgJsonAtHead(projectRoot, rel, io) {
  const r = io.git(['show', `HEAD:${rel}`], projectRoot);
  if (r.status !== 0) return {};
  return parsePkgJson(String(r.stdout || ''), `HEAD:${rel}`);
}

/** 工作区版本 package.json；文件缺失 / 已删除 → {}；内容非法 JSON → 抛错。 */
function readPkgJsonWorktree(projectRoot, rel, io) {
  let raw;
  try {
    raw = io.readFile(join(projectRoot, rel), 'utf-8');
  } catch {
    return {};
  }
  return parsePkgJson(raw, rel);
}

function parsePkgJson(raw, label) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`package.json 解析失败 (${label}): ${err.message}`);
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

/**
 * 复位 STATE 到 idle（archive 与 light 自动收尾共用）。
 * loopDone=true 时额外写 fence 让 loop-next 返回 'done'（D16 收敛信号）。
 *
 * F-10：整份写 STATE（writeState），不走 updateState → readState。light 自动收尾
 * 发生在 archiveChange 之后——change 目录（含 light.json）已经移走，此刻 readState
 * 会把 STATE 里的 light@fast 判为存量并打印一行假的「pipeline 迁移: light@fast →
 * full@fast」。state 由调用方在归档前读出，字段与磁盘一致，整份写入等价。
 *
 * @param {string} projectRoot
 * @param {object} state - 归档前读出的状态对象（提供 autonomous / maxStages / maxRetries 等字段）
 * @param {object} [options]
 * @param {boolean} [options.loopDone=false]
 */
export function resetStateToIdle(projectRoot, state, { loopDone = false } = {}) {
  writeState(projectRoot, {
    ...state,
    activeChange: null,
    currentStage: 'idle',
    currentWave: null,
    currentTask: null,
    activeAgent: null,
    stagesRun: 0,
    retries: 0,
    pauseReason: null,
    pipeline: 'full',
    contextUsage: { tokens: null, windowPercent: null },
  });

  if (loopDone) {
    // D16 期望 light@fast 收敛时 loop-next 返回 'done'，但 auto-archive 会把 STATE
    // 复位为 idle，收敛条件再也无法命中。这里显式写 fence（writeState 只写散文区，
    // 不保留 fence），让 driver 立刻看到 'done' 停下；下一次 gantry change 的
    // updateState 会重置 fence。
    const fence = readFence(projectRoot);
    writeFence(projectRoot, {
      ...fence,
      nextStep: 'done',
      lastStageResult: { ok: true, blockedReason: null },
    });
  }
}

// --- 内部辅助 ---

/** `git show HEAD:<path>` → 内容；文件在 HEAD 中不存在 → null。 */
function gitShowHead(projectRoot, rel, io) {
  const r = io.git(['show', `HEAD:${rel}`], projectRoot);
  return r.status === 0 ? String(r.stdout) : null;
}

/** 读文件内容；不可读 → null。 */
function readFileOrNull(abs, io) {
  try { return io.readFile(abs, 'utf-8'); } catch { return null; }
}

/** 文件内容 sha1；不可读抛错（由调用方处理）。 */
function sha1File(abs, io) {
  return createHash('sha1').update(io.readFile(abs)).digest('hex');
}

/** 运行 git 子命令并把 stdout 按行切分；git 失败 → 空列表。 */
function gitLines(projectRoot, args, io) {
  const r = io.git(args, projectRoot);
  if (r.status !== 0) return [];
  return String(r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
}
