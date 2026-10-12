#!/usr/bin/env node

const [nodeMajor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 18) {
  console.error('gantry requires Node.js >= 18 (current: ' + process.versions.node + ')');
  process.exit(2);
}

/**
 * gantry CLI — 阶段驱动编排器
 * 零依赖，纯 Node.js
 *
 * Usage: gantry <command> [options]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, readdirSync, rmSync, unlinkSync, renameSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  readState, writeState, updateState, transitionStage,
  readFence, writeFence, writeFenceBlockedReason,
} from './lib/state.mjs';
import { STAGES, getNextStage, checkGate, PHASE_FILES, countOpenQuestions, requiresApproval } from './lib/phases.mjs';
import { computeNextStep, WHITELIST } from './lib/loop.mjs';
import { checkLoopGuard } from './lib/loop-guard.mjs';
import {
  appendHealAttempt,
  readHealLog,
  shouldStopHealing,
} from './lib/self-heal.mjs';
import { PLANNING_DIR, SPECS_DIR, specsPath } from './lib/paths.mjs';
import { mergeSettingsJson, unmergeSettingsJson, readManaged, writeManaged } from './lib/settings-merge.mjs';
import { parseTasks, getProgress } from './lib/tasks.mjs';
import { runHook, listHooks, checkHook } from './lib/hooks.mjs';
import { writeContextPack, readContextPack, PACK_PATH } from './lib/context-pack.mjs';
import { getPreferredArtifactName, resolveArtifactPath } from './lib/artifacts.mjs';
import { readConfig } from './lib/config.mjs';
import { normalizePipeline } from './lib/pipeline-policy.mjs';
import { detectHardRuleHit } from './lib/hard-rules.mjs';
import { validateIntentScope } from './lib/light-guard.mjs';
import { upgradeToFull } from './lib/light-upgrade.mjs';
// light 入口 / 出口门的 IO 与编排（DESIGN D22 · REVIEW F-06）；cli.mjs 只留参数解析与调用
import {
  isGitRepo, writeLightEntry, renderTierDecision, runLightExitGate, resetStateToIdle, removeLightAnchor,
  resolveHeadSha,
  LIGHT_ANCHOR_FILE,
} from './lib/light-gate.mjs';
import { knowledge } from './commands/knowledge.mjs';
import { getEvents as frictionGetEvents, getScore as frictionGetScore } from './lib/friction.mjs';
import { proposeLearning } from './lib/curator.mjs';
import { write as writeLearning } from './lib/learnings/index.mjs';
import { validateLearningsConfig, ConfigError } from './lib/config-schema.mjs';
import { buildManagedEntries } from './lib/install-helpers.mjs';
import { extractProposalSummary, collectLessonsIds, appendChangelogLine } from './lib/archive-helpers.mjs';
import { createInterface } from 'node:readline/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const GANTRY_ROOT = resolve(__dirname, '..');

const SCAN_PATTERNS = [
  '.github/copilot-instructions.md',
];

const SECTION_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
];

const SECTION_BEGIN = '<!-- BEGIN gantry -->';
const SECTION_END = '<!-- END gantry -->';

const SCAN_DIRS = [
  ['.claude/commands', '.md'],
  ['.cursor/rules', '.mdc'],
  ['.github/prompts', '.prompt.md'],
  ['.gantry/core/agents', '.md'],
  ['.gantry/core/phases', '.md'],
];

const SKILL_DIRS = [
  '.agents/skills',
  '.claude/skills',
];


// --- 入口 ---

const [,, command, ...args] = process.argv;

const commands = {
  status, change, pipeline, auto, advance, context, done, hook, install, uninstall, archive, unarchive, metrics, version,
  help, knowledge, loop,
  'loop-next': loopNext,
  'heal': heal,
};

// IDE-only skills：AI 驱动的阶段 / 动作命令，只在 IDE 中以 /gantry-<name> 执行，
// 不是 CLI 子命令(CLI 只做机械操作)。用户误在 CLI 里敲这些时，给出精准引导，
// 而非笼统的「未知命令」——避免把人引向不存在的 gantry help 死路。
const IDE_ONLY_SKILLS = new Set([
  'next', 'exec', 'adjust', 'resume', 'review', 'health', 'debug', 'fast',
]);

function handleCliError(err) {
  if (err instanceof ConfigError) {
    for (const line of err.errors) console.error(line);
    console.error('修正后重试或删除该键');
    process.exit(1);
  }
  console.error(err.message || String(err));
  process.exit(1);
}

if (!command || command === '--help' || command === '-h') {
  help();
} else if (command === '--version' || command === '-v' || command === '-V') {
  version();
} else if (commands[command]) {
  try {
    // AC-1 fail-closed: 任一命令运行前先校验 learnings 配置, 未知 key 立即退出非零
    const _cfg = readConfig(process.cwd()).learnings;
    const _vr = validateLearningsConfig(_cfg);
    if (!_vr.ok) throw new ConfigError(_vr.errors);

    const _r = commands[command](args);
    if (_r && typeof _r.then === 'function') _r.catch(handleCliError);
  } catch (err) {
    handleCliError(err);
  }
} else if (IDE_ONLY_SKILLS.has(command)) {
  console.error(`\`${command}\` 是 IDE skill，不是 CLI 命令。`);
  console.error(`  请在 IDE(Claude Code 等)中运行: /gantry-${command}`);
  console.error(`  CLI 只负责状态机 / 安装 / 归档等机械操作，可用命令见: gantry help`);
  process.exit(1);
} else {
  console.error(`未知命令: ${command}\n运行 gantry help 查看可用命令`);
  process.exit(1);
}

// --- 命令实现 ---

/**
 * gantry status — 显示当前状态
 */
function status(args) {
  const projectRoot = process.cwd();
  const planningDir = join(projectRoot, PLANNING_DIR);

  if (!existsSync(planningDir)) {
    console.log('项目未初始化。运行 gantry install 开始。');
    return;
  }
  migrateLegacyPipelines(projectRoot);

  const state = readState(projectRoot);
  const json = args.includes('--json');

  if (json) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  const stageInfo = STAGES[state.currentStage];
  const lines = [
    ['管线', state.pipeline],
    ['阶段', `${state.currentStage}${stageInfo ? ` (${stageInfo.label})` : ''}`],
    ['Change', state.activeChange || '—'],
    ['Wave', state.currentWave ?? '—'],
    ['Task', state.currentTask ?? '—'],
    ['Agent', state.activeAgent ?? '—'],
    ['自主模式', state.autonomous ? 'ON' : 'OFF'],
  ];
  const contextSignal = formatContextSignal(state.contextUsage);
  if (contextSignal) {
    lines.push(['上下文', contextSignal]);
  }
  if (state.pauseReason) {
    lines.push(['暂停原因', state.pauseReason]);
  }
  printBox('gantry 状态', lines);

  // 当前阶段是否为固定人工确认关卡（非独立状态）
  const cfg = readConfig(projectRoot);
  if (state.currentStage !== 'idle'
      && requiresApproval(state.currentStage)) {
    console.log(`\n⏸  当前阶段 ${state.currentStage} 需人工确认：审阅本阶段产物后运行 /gantry-auto 继续（或 /gantry-next 单步）。`);
  }

  // 任务进度（dev 阶段且有 TASKS.md/TASK.md 时显示）
  if (state.activeChange && state.currentStage === 'dev') {
    const taskFile = resolveArtifactPath(join(projectRoot, SPECS_DIR, state.activeChange), 'tasks')?.path;
    if (taskFile && existsSync(taskFile)) {
      const tasks = parseTasks(taskFile);
      const prog = getProgress(tasks);
      if (prog.total > 0) {
        const bar = '█'.repeat(Math.round(prog.percent / 10)) + '░'.repeat(10 - Math.round(prog.percent / 10));
        console.log(`\n任务进度: [${bar}] ${prog.done}/${prog.total} (${prog.percent}%)`);
      }
    }
  }

  // 提示下一步
  if (state.currentStage === 'idle') {
    console.log(`\n下一步: gantry change "<描述>"`);
  } else {
    const nextSt = getNextStage(state.currentStage, {
      ...cfg,
      pipeline: state.pipeline,
    });
    if (nextSt) {
      console.log(`\n下一步: /gantry-next  →  执行 ${state.currentStage} 并推进到 ${nextSt}`);
    }
  }
}

function printBox(title, rows) {
  const labelWidth = Math.max(...rows.map(([label]) => displayWidth(label)));
  const contentLines = rows.map(([label, value]) => {
    const paddedLabel = padDisplay(label, labelWidth);
    return `${paddedLabel}: ${value}`;
  });
  const innerWidth = Math.max(displayWidth(title) + 2, ...contentLines.map(displayWidth));

  console.log(`┌─ ${title} ${'─'.repeat(Math.max(0, innerWidth - displayWidth(title) - 1))}┐`);
  for (const line of contentLines) {
    console.log(`│ ${padDisplay(line, innerWidth)} │`);
  }
  console.log(`└${'─'.repeat(innerWidth + 2)}┘`);
}

function padDisplay(text, width) {
  const value = String(text);
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)));
}

function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) {
    width += char.codePointAt(0) > 0xff ? 2 : 1;
  }
  return width;
}

function formatContextSignal(contextUsage = {}) {
  const tokens = contextUsage?.tokens;
  const windowPercent = contextUsage?.windowPercent;
  if (tokens == null && windowPercent == null) return null;

  const parts = [];
  if (tokens != null) parts.push(`${tokens} tokens`);
  if (windowPercent != null) parts.push(`${windowPercent}% window`);

  const shouldClear = (tokens != null && tokens > 200000) || (windowPercent != null && windowPercent > 85);
  return `${parts.join(' / ')}${shouldClear ? ' · 建议清窗' : ''}`;
}

/**
 * gantry change — 启动新变更
 *
 * 管线默认 full（ADR-006：创建期不再软打分，tier-router 已删除）。
 * --tier light 显式进入 light 无人工关卡入口（需 --scope）；
 * --tier <light|full> 覆写默认值，--pipeline 作为 deprecated alias（同取值），
 * --tier 与 --pipeline 同时给出时 --tier 优先。
 * light 入口预检（顺序）：非 git 项目 → 描述命中红线 → 意图范围非法。
 * 任一命中即回落 full@change，原因写入 EXECUTION 的 tier-decision 段。
 * --dry-run 只打印决策 JSON (tier/pipeline/code，回落时附加 reason)，不落 STATE、不建目录。
 */
async function change(args, opts = {}) {
  const projectRoot = process.cwd();
  const isDryRun = args.includes('--dry-run');

  // 提取描述：跳过 --flag 及其值（含 light 入口参数）
  const description = stripFlags(
    args,
    ['--pipeline', '--tool', '--id', '--tier', '--scope', '--accept', '--verify'],
  ).join(' ');
  if (!description) {
    console.error('用法: gantry change "<变更描述>"');
    process.exit(1);
  }

  // tier 覆写解析（纯参数校验，先于项目初始化）：--tier 优先于 deprecated --pipeline
  const rawTier = getFlag(args, '--tier');
  const rawPipeline = getFlag(args, '--pipeline');
  let tierOverride = null;
  if (rawTier != null) {
    tierOverride = normalizeTierValue(rawTier);
    if (!tierOverride) {
      console.error('无效的 --tier（可选 light|full）');
      process.exit(1);
    }
    if (rawPipeline != null) {
      console.error(`⚠ --tier 与 --pipeline 同时给出，--tier 优先，忽略 --pipeline ${rawPipeline}`);
    }
  } else if (rawPipeline != null) {
    tierOverride = normalizeTierValue(rawPipeline);
    if (!tierOverride) {
      console.error('无效的 --pipeline（可选 light|full，建议改用 --tier）');
      process.exit(1);
    }
  }

  if (!isDryRun) {
    ensureInit(projectRoot);

    const state = readState(projectRoot);
    if (state.activeChange) {
      console.error(`已有活跃变更: ${state.activeChange}`);
      console.error('请先完成或归档当前变更 (gantry archive)');
      process.exit(1);
    }

    // before:change hook — 触发点在状态写入前,失败即拒绝新建变更(退出 2)
    const cfg = readConfig(projectRoot);
    const hookResult = await runHook(cfg, 'before:change', projectRoot);
    if (!hookResult.ok) {
      console.error('✗ before:change hook 阻断,变更未创建');
      process.exit(2);
    }
  }

  // 默认 full；--tier light 显式进入 light 入口（CREATION 期只做描述/范围预检，不做软打分）
  const requestedTier = tierOverride ?? 'full';

  let lightFallbackReason = null;
  let scope = [];
  let accept = [];
  let verify = null;
  if (requestedTier === 'light') {
    scope = parseScopeArg(getFlag(args, '--scope'));
    accept = parseAcceptArg(getFlag(args, '--accept'), description);
    verify = getFlag(args, '--verify');

    // 预检顺序：非 git → 描述红线 → 意图范围 → HEAD 可解析（第一个失败即回落）
    if (!isGitRepo(projectRoot)) {
      lightFallbackReason = 'non-git';
    } else {
      const hit = detectHardRuleHit({ modifiedFiles: [], newFiles: [], pkgJsonDepsDelta: [] }, description);
      if (hit.hit) {
        lightFallbackReason = hit.ruleIds.join(', ');
      } else if (!validateIntentScope(scope).ok) {
        lightFallbackReason = 'intent-scope-invalid';
      } else if (!resolveHeadSha(projectRoot)) {
        // D25：仓库尚无提交 → HEAD 无法锚定，守卫采集面无基准可依，回落 full@change
        lightFallbackReason = 'no-head-commit';
      }
    }
  }

  const isLight = requestedTier === 'light' && !lightFallbackReason;
  const effectiveTier = isLight ? 'light' : 'full';
  const tierSource = isLight
    ? 'override'
    : (lightFallbackReason ? 'light-fallback' : (tierOverride ? 'override' : 'default'));

  if (isDryRun) {
    const result = { tier: effectiveTier, pipeline: effectiveTier, code: 'tier_dry_run' };
    if (lightFallbackReason) result.reason = lightFallbackReason;
    console.log(JSON.stringify(result));
    return;
  }

  // 生成 change-id
  const changeId = generateChangeId(description, projectRoot, getFlag(args, '--id'));
  const specsDir = join(projectRoot, SPECS_DIR, changeId);
  mkdirSync(specsDir, { recursive: true });
  const executionPath = join(specsDir, getPreferredArtifactName('execution'));

  // ── light 入口：固化意图 + 工作区基线，STATE 直接进 fast ──
  //    IO（baseline 采集、light.json / 意图头写入）在 light-gate（DESIGN D22）
  if (isLight) {
    writeLightEntry(projectRoot, {
      changeId,
      executionPath,
      intent: { goal: description, accept, scope, ...(verify ? { verify } : {}) },
    });

    updateState(projectRoot, {
      pipeline: 'light',
      activeChange: changeId,
      currentStage: 'fast',
      activeAgent: 'executor',
    });

    // 写一次 pack,让 skill 立刻有可消费的上下文
    try { writeContextPack(projectRoot); } catch { /* non-blocking */ }

    console.log(`✓ 变更已创建: ${changeId}`);
    console.log('  管线: light');
    console.log('  code: light_entered');
    console.log(`  意图: ${specsPath(changeId, 'light.json')}`);
    console.log(`  工件目录: ${specsPath(changeId)}/`);
    console.log('  当前阶段: fast (快速闭环)');
    console.log(`  上下文: ${PACK_PATH}`);
    console.log('\n请在声明的「允许改动范围」内实施改动，完成后运行:');
    console.log('  gantry advance');
    return;
  }

  // ── full（默认 / 显式覆写 / light 回落）──
  writeFileSync(
    executionPath,
    `# EXECUTION: ${changeId}\n\n${renderTierDecision({ tier: 'full', source: tierSource, reason: lightFallbackReason })}\n`,
    'utf-8',
  );

  updateState(projectRoot, {
    pipeline: 'full',
    activeChange: changeId,
    currentStage: 'change',
    activeAgent: 'planner',
  });

  try { writeContextPack(projectRoot); } catch { /* non-blocking */ }

  const code = lightFallbackReason
    ? 'light_fallback'
    : (tierOverride ? 'tier_override_recorded' : 'tier_decided');
  console.log(`✓ 变更已创建: ${changeId}`);
  if (lightFallbackReason) {
    console.log(`  ⚠ light 入口被拒绝（${lightFallbackReason}），已回落 full`);
  }
  console.log('  管线: full');
  console.log(`  code: ${code}`);
  console.log(`  工件目录: ${specsPath(changeId)}/`);
  console.log('  当前阶段: change (变更提案)');
  console.log(`  上下文: ${PACK_PATH}`);
  console.log(`\n请执行阶段 0 (CHANGE):`);
  console.log(`  加载 .gantry/core/phases/0-change.md 并产出 ${specsPath(changeId, getPreferredArtifactName('proposal'))}`);
}

/**
 * gantry loop-next — 只读:输出下一步白名单 token。
 *
 * pdlc S4 契约:stdout 恰好一行,匹配 ^(gantry-[a-z]+|done|blocked)$;
 *              stderr 空或仅 [loop-next warn] 前缀;
 *              exit 0 (推进 / done) / exit 2 (blocked)。
 *
 * 供 P2 driver 消费。本身不推进状态,不写任何文件。
 */
function loopNext() {
  const projectRoot = process.cwd();
  let state, fence;
  try {
    state = readState(projectRoot);
    fence = readFence(projectRoot);
  } catch (err) {
    process.stderr.write(`[loop-next warn] state 读取失败: ${err.message}\n`);
    process.stdout.write('blocked\n');
    process.exit(2);
  }

  // 合并散文区(pipeline/currentStage/currentWave)与 fence(nextStep/lastStageResult/previousWave)
  const merged = {
    pipeline: state.pipeline,
    currentStage: state.currentStage,
    currentWave: state.currentWave,
    previousWave: fence.previousWave,
    nextStep: fence.nextStep,
    lastStageResult: fence.lastStageResult,
  };

  const token = computeNextStep(merged);
  if (!WHITELIST.includes(token)) {
    process.stderr.write(`[loop-next warn] computeNextStep 输出非白名单: ${token}\n`);
    process.stdout.write('blocked\n');
    process.exit(2);
  }

  process.stdout.write(`${token}\n`);
  if (token === 'blocked') process.exit(2);
  process.exit(0);
}

/**
 * P4 命令折叠(2026-09-16):`loop-guard` 已合入 `advance` 入口;`ac-gate` 已完全删除,
 * AC 覆盖硬闸继续由 integration 门禁末端 `checkAcGate` 承担(src/lib/phases.mjs)。
 * 需要在 review 阶段自检 AC 覆盖 → 跑一次 `gantry advance` 直到 integration。
 *
 * 保留 `checkLoopGuard` / `checkAcCoverage` 纯函数,供 advance 与 phases 内联使用。
 */

/**
 * 在 advance 入口前置的上下文/步数熔断检查(原 gantry loop-guard 命令折叠而来)。
 *
 * 熔断契约(与旧命令一致):
 *   - stderr `[advance warn] <reason>`,exit 2
 *   - fence.lastStageResult.blockedReason 非覆盖式写入
 *
 * 未熔断 → 静默 return,advance 继续走门禁与阶段推进。
 */
function preAdvanceLoopGuard(projectRoot) {
  let state, config;
  try {
    state = readState(projectRoot);
    config = readConfig(projectRoot);
  } catch (err) {
    process.stderr.write(`[advance warn] loop-guard state 读取失败: ${err.message}\n`);
    process.exit(2);
  }
  const verdict = checkLoopGuard(state, config);
  if (!verdict.tripped) return;

  const reason = `loop-guard: ${verdict.reason}`;
  const r = writeFenceBlockedReason(projectRoot, reason);
  if (r.error) {
    process.stderr.write(`[advance warn] writeFence 失败: ${r.error}\n`);
  }
  process.stderr.write(`[advance warn] ${verdict.reason}\n`);
  process.exit(2);
}

/**
 * gantry heal <taskId> — 记录一次 dev verify 失败(SPEC AC-4)。
 * gantry heal --check <taskId> — 查询 R2.5 上限(SPEC AC-5)。
 *
 * 记录模式:
 *   heal <taskId> --reason X [--command Y] [--stderr Z|-]
 *   → stdout `recorded #<n>`, exit 0
 *
 * 查询模式(--check):
 *   heal --check <taskId>
 *   → K<3: stdout `ok · attempts=K/3`, exit 0
 *   → K>=3: stdout `blocked · attempts=K/3`, exit 2 + 写 fence.blockedReason(不覆盖)
 */
function heal(args) {
  const projectRoot = process.cwd();
  const parsed = parseHealArgs(args);
  const state = safeReadState(projectRoot);
  if (!state?.activeChange) {
    process.stderr.write('[heal] no active change\n');
    process.exit(1);
  }
  const execPath = resolveArtifactPath(
    join(projectRoot, SPECS_DIR, state.activeChange),
    'execution',
  )?.path;
  if (!execPath || !existsSync(execPath)) {
    process.stderr.write('[heal] execution file missing\n');
    process.exit(1);
  }

  if (parsed.check) {
    const log = readHealLog(execPath);
    const { stop, count, limit } = shouldStopHealing(log, parsed.taskId);
    if (!stop) {
      process.stdout.write(`ok · attempts=${count}/${limit}\n`);
      process.exit(0);
    }
    // 熔断:写 fence.blockedReason(不覆盖非空,与 loop-guard 一致)。
    // T-FIX-03:走 writeFenceBlockedReason helper,消除与 loop-guard 的重复。
    const r = writeFenceBlockedReason(
      projectRoot,
      `heal: limit exceeded task=${parsed.taskId}`,
    );
    if (r.error) {
      process.stderr.write(`[heal warn] writeFence 失败: ${r.error}\n`);
    }
    process.stderr.write(`[heal] limit exceeded, task=${parsed.taskId}\n`);
    process.stdout.write(`blocked · attempts=${count}/${limit}\n`);
    process.exit(2);
  }

  if (!parsed.reason) {
    process.stderr.write('[heal] --reason required\n');
    process.exit(1);
  }

  let stderrText = parsed.stderr;
  if (stderrText === '-') {
    try { stderrText = readFileSync(0, 'utf-8'); }
    catch { stderrText = ''; }
  }

  try {
    const n = appendHealAttempt(execPath, {
      taskId: parsed.taskId,
      reason: parsed.reason,
      command: parsed.command,
      stderr: stderrText,
    });
    process.stdout.write(`recorded #${n}\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`[heal] ${err.message}\n`);
    process.exit(1);
  }
}

function parseHealArgs(args) {
  const out = { taskId: null, reason: null, command: null, stderr: null, check: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--check') out.check = true;
    else if (a === '--reason') out.reason = args[++i];
    else if (a === '--command') out.command = args[++i];
    else if (a === '--stderr') out.stderr = args[++i];
    else if (!a.startsWith('--') && out.taskId == null) out.taskId = a;
  }
  if (!out.taskId) {
    process.stderr.write('[heal] taskId required\n');
    process.exit(1);
  }
  return out;
}

function safeReadState(root) {
  try { return readState(root); } catch { return null; }
}

// ac-gate CLI 已删除(2026-09-16 P4 命令折叠):
// AC 覆盖硬闸由 integration 门禁末端 checkAcGate 承担(src/lib/phases.mjs)。
// 手动自检可直接 `gantry advance` 到 integration 观察门禁结果。

/**
 * gantry pipeline full — 显式将当前 light change 提升为 full（AC-13）。
 *
 * light 单向升档：任意 light 阶段都可升到 full@change，工作区代码原样保留，
 * 落一份 PROPOSAL 初稿交 full 的 change 硬锁接管。已是 full 或没有活跃 change
 * 时非零退出；`pipeline light` 是禁止的降档方向。
 */
function pipeline(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);
  const target = args[0];

  if (target === 'light') {
    console.error('不支持降档 (full → light)');
    process.exit(1);
  }
  if (target !== 'full') {
    console.error('用法: gantry pipeline full（light → full 单向升档）');
    process.exit(1);
  }

  const state = readState(projectRoot);
  if (!state.activeChange) {
    console.error('当前没有活跃 change');
    process.exit(1);
  }
  if (state.pipeline === 'full') {
    console.error(`当前 pipeline 已是 full，无需提升`);
    process.exit(1);
  }

  let result;
  try {
    result = upgradeToFull(projectRoot, { source: 'manual', hits: [] });
  } catch (err) {
    console.error(`升档失败: ${err.message}`);
    process.exit(1);
  }

  try { writeContextPack(projectRoot); } catch { /* non-blocking */ }
  // 与自动升档路径一致：升档后清理意图锚定，避免残留锚定干扰后续 change。
  removeLightAnchor(projectRoot);

  console.log('✓ pipeline: light → full');
  console.log(`  PROPOSAL 初稿: ${result.proposalPath}`);
  console.log(`  当前状态: full@change`);
}














/**
 * gantry advance — 内部机械推进一个阶段
 *
 * 设计原则：CLI 只做机械检查，阶段产物由 /gantry-next 这类 AI skill 生成。
 * 多阶段自主推进由 gantry auto 独占；advance 只推进一步即停。
 *
 *   gantry advance               推进一步
 *   gantry advance --skip        跳过当前门禁（每次都要显式）
 *
 * 核心闭环：
 *   resolve pipeline → checkGate → transitionStage
 *   失败 → retries+=1，连续 > maxRetries 拒推
 *   --skip → 不阻塞
 */
async function advance(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);

  // 命令折叠(2026-09-16):原 gantry loop-guard 内联到 advance 入口。
  // 上下文 / 步数熔断时:exit 2 + 写 fence.blockedReason(非覆盖)。
  preAdvanceLoopGuard(projectRoot);

  // advance 是「机械推进」入口：推进一步即停。多阶段自主推进用 gantry auto。
  const isSkip = args.includes('--skip');
  const result = await nextOnce(projectRoot, { isSkip });
  if (result.stop && result.exitCode) process.exit(result.exitCode);
  if (result.reachedEnd) {
    console.log(`  管线已到达 ${result.reachedEnd}`);
  }
}

/**
 * gantry auto
 *   按 autonomous.maxStagesPerRun 自动推进,遇门禁阻塞或终态即停。
 *   单次推进步数由配置 autonomous.maxStagesPerRun 决定(不接受命令行覆盖)。
 */
async function auto(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);

  const config = readConfig(projectRoot);
  const state = readState(projectRoot);

  if (args.includes('--trust')) {
    console.error('--trust 已移除：Change、Design、Integration 人工确认不可绕过');
    process.exit(1);
  }
  const maxStages = getConfiguredMaxStages(config, state.maxStages || 3);
  const maxSteps = maxStages;

  updateState(projectRoot, {
    autonomous: true,
    stagesRun: 0,
    maxStages,
    pauseReason: null,
  });

  console.log(`自主模式: 最多推进 ${maxStages} 个阶段`);

  for (let step = 0; step < maxSteps; step++) {
    const result = await nextOnce(projectRoot);
    if (result.stop) {
      console.log(`  自动推进在 ${step}/${maxSteps} 步停止`);
      if (result.exitCode) process.exit(result.exitCode);
      return;
    }
    if (result.reachedEnd) {
      console.log(`  管线已到达 ${result.reachedEnd}`);
      return;
    }
    updateState(projectRoot, { stagesRun: step + 1, maxStages });
    if (result.pausedForApproval) {
      console.log(`⏸  已进入 ${result.pausedForApproval}（需人工确认）。审阅后运行 /gantry-auto 继续（或 /gantry-next 单步）。`);
      return;
    }
  }

  console.log(`  已达到本次自动推进上限: ${maxStages}`);
}

/**
 * 单步推进。返回 { stop, reachedEnd, exitCode }
 */
async function nextOnce(projectRoot, { isSkip = false } = {}) {
  const state = readState(projectRoot);

  if (state.currentStage === 'idle') {
    console.log('当前无活跃变更。运行 gantry change "<描述>" 开始。');
    return { stop: true };
  }
  if (state.currentStage === 'integration') {
    console.log('已在 integration 阶段。运行 gantry archive 完成变更。');
    return { reachedEnd: 'integration' };
  }

  // light@fast 走独立的出口门（DESIGN D7/D8/D14；SPEC AC-6/7/8/11）：
  // 不经过 full 的阶段图与 change/design/integration 硬锁，由 CLI 执行 verify
  // + diff 守卫，全通过自动收尾，命中自动升档。readState 已保证 light@fast
  // 必然持有 light.json（否则归一化为 full）。
  if (state.pipeline === 'light' && state.currentStage === 'fast') {
    return await runLightExitGate(projectRoot, state, { isSkip, archiveChange });
  }

  const config = readConfig(projectRoot);
  const specsDir = join(projectRoot, SPECS_DIR, state.activeChange);
  const effectiveConfig = {
    ...config,
    pipeline: state.pipeline || config.pipeline,
  };
  const nextStage = getNextStage(state.currentStage, effectiveConfig);
  if (!nextStage) {
    return { reachedEnd: state.currentStage };
  }

  // === Gate ===
  // T-FIX-02(REVIEW Round 2 · R2):显式传 projectRoot,integration ac-gate
  // 不再用 `../../..` 反推;测试路径不受影响(缺省沿 SPECS_DIR 语义反推)。
  const gateResult = checkGate(nextStage, specsDir, effectiveConfig, state, projectRoot);

  if (!gateResult.passed) {
    if (gateResult.hard) {
      updateState(projectRoot, { pauseReason: gateResult.reason });
      console.error(`✗ ${gateResult.reason}`);
      return { stop: true, exitCode: 1 };
    }
    const newRetries = state.retries + 1;
    updateState(projectRoot, { retries: newRetries, pauseReason: gateResult.reason });

    if (isSkip) {
      console.log(`⚠  跳过门禁: ${gateResult.reason}`);
    } else if (newRetries > state.maxRetries) {
      console.error(`✗ 门禁连续失败 ${state.retries} 次（上限 ${state.maxRetries}）`);
      console.error(`  原因: ${gateResult.reason}`);
      const hint = gateRecoveryHint(gateResult.reason);
      if (hint) console.error(hint);
      console.error(`  修复后重试，或让 /gantry-next 调用 gantry advance --skip 显式跳过`);
      return { stop: true, exitCode: 1 };
    } else {
      console.error(`✗ 门禁未通过 [${newRetries}/${state.maxRetries}]: ${gateResult.reason}`);
      const hint = gateRecoveryHint(gateResult.reason);
      if (hint) console.error(hint);
      return { stop: true, exitCode: 1 };
    }
  }

  // before:dev hook — 门禁已过、状态还未推进时触发。失败即拒绝进入 dev(退出 2)
  if (nextStage === 'dev') {
    const hookResult = await runHook(effectiveConfig, 'before:dev', projectRoot);
    if (!hookResult.ok) {
      updateState(projectRoot, { pauseReason: 'before:dev hook failed' });
      console.error('✗ before:dev hook 阻断,未进入 dev 阶段');
      return { stop: true, exitCode: 2 };
    }
  }

  transitionStage(projectRoot, state.currentStage, nextStage);

  // 推进成功后,刷新 context-pack.json 给 AI client 消费
  try {
    writeContextPack(projectRoot);
  } catch (e) {
    // 不阻塞主流程,但警告
    console.error(`  ⚠  context-pack 刷新失败: ${e.message}`);
  }

  if (gateResult.skipReason) {
    console.log(`  ⚠  ${gateResult.skipReason}`);
  }

  const phaseFile = PHASE_FILES[nextStage];
  console.log(`✓ ${state.currentStage} → ${nextStage}`);
  if (phaseFile) {
    console.log(`  执行: .gantry/core/phases/${phaseFile}`);
  }
  console.log(`  上下文: ${PACK_PATH}`);

  // 人工确认关卡（派生策略，非独立状态）：
  // 进入 Change / Design / Integration 后，把控制权交还给人。
  // 人审阅后再执行 /gantry-next 继续。
  // 单步 gantry advance 不受影响——它推进这一步后本就停下等下一次调用。
  // specsDir 已在函数首部由 state.activeChange 派生;change 关卡的内容驱动
  // hard-lock 通过 requiresApproval 读该目录下的 PROPOSAL。
  if (requiresApproval(nextStage, specsDir)) {
    return { stop: false, pausedForApproval: nextStage };
  }
  return { stop: false };
}

/**
 * 针对特定门禁失败原因，给出可操作的补救指引。
 * 未决问题阻断时，明确告诉用户怎么回到 change 反问。
 */
function gateRecoveryHint(reason) {
  if (reason && /unresolved question/.test(reason)) {
    return [
      `  → 当前仍在 change 阶段（未推进）。回到反问澄清：`,
      `     1. 运行 /gantry-change（或让 agent 按 0-change.md 继续）逐条反问用户`,
      `     2. 把答案并入 PROPOSAL 正文，将「## 待澄清问题」段改为「无」`,
      `     3. 再次运行 /gantry-next 推进到 requirement`,
    ].join('\n');
  }
  return null;
}


function getConfiguredMaxStages(config = {}, fallback = 3) {
  const configured = Number(config?.autonomous?.maxStagesPerRun);
  return Number.isInteger(configured) && configured > 0 ? configured : fallback;
}

/**
 * gantry context [stage] [--task T03] [--json]
 *   生成 / 重写 .gantry/planning/context-pack.json
 *
 * 不带参数时按当前 STATE 阶段生成。可显式指定 stage 与 task。
 * --json 把 pack 内容打到 stdout(供 CI / 调试)。
 */
function context(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);
  const overrides = {};

  // 解析 --task / --stage / --json
  const cleaned = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--task' || a === '-t') { overrides.taskId = args[++i]; continue; }
    if (a === '--stage' || a === '-s') { overrides.stage = args[++i]; continue; }
    if (a === '--json') { overrides._json = true; continue; }
    cleaned.push(a);
  }
  // 第一个位置参数当 stage(向后兼容 `gantry context dev`)
  if (cleaned[0] && !overrides.stage) overrides.stage = cleaned[0];
  if (cleaned[1] && !overrides.taskId) overrides.taskId = cleaned[1];

  const wantJson = overrides._json;
  delete overrides._json;

  const pack = writeContextPack(projectRoot, overrides);
  if (wantJson) {
    console.log(JSON.stringify(pack, null, 2));
    return;
  }
  console.log(`✓ context pack 已写入: ${PACK_PATH}`);
  console.log(`  stage:    ${pack.stage}`);
  if (pack.changeId) console.log(`  change:   ${pack.changeId}`);
  if (pack.taskId)  console.log(`  task:     ${pack.taskId}`);
  console.log(`  loadOrder: ${pack.loadOrder.length} 项`);
  console.log(`  checklists: ${pack.checklists.filter(c => c.trigger).length} 触发 / ${pack.checklists.length} 总`);
  if (pack.lessons.length) console.log(`  lessons:  ${pack.lessons.length} 条命中`);
}


/**
 * gantry done <task-id>
 *   标记 task 完成 + 在 EXECUTION.md 不存在时落模板骨架。
 *   不写"实际内容"——那是 AI 的事;CLI 只做机械操作。
 */
function done(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);
  const state = readState(projectRoot);

  const taskId = args.find(a => !a.startsWith('-'));
  if (!taskId) {
    console.error('用法: gantry done <task-id>');
    process.exit(1);
  }
  const changeId = state.activeChange;
  if (!changeId) {
    console.error('当前无活跃 change');
    process.exit(1);
  }
  const taskResolved = resolveArtifactPath(join(projectRoot, SPECS_DIR, changeId), 'tasks');
  const taskFile = taskResolved?.path;
  if (!taskFile || !existsSync(taskFile)) {
    console.error(`${getPreferredArtifactName('tasks')} 不存在: ${specsPath(changeId, getPreferredArtifactName('tasks'))}`);
    process.exit(1);
  }

  const content = readFileSync(taskFile, 'utf-8');
  const taskRe = new RegExp(`(<task\\s+[^>]*id="${taskId}"[^>]*?)(\\sstatus="[^"]*")?(\\s*>)`, 'g');
  let matched = false;
  const updated = content.replace(taskRe, (full, head, _statusAttr, tail) => {
    matched = true;
    return `${head} status="done"${tail}`;
  });
  if (!matched) {
    console.error(`task ${taskId} 未在 ${taskResolved.name} 中找到`);
    process.exit(1);
  }
  writeFileSync(taskFile, updated, 'utf-8');

  const executionPath = join(projectRoot, specsPath(changeId, getPreferredArtifactName('execution')));
  if (!existsSync(executionPath)) {
    const skeleton = `# EXECUTION: ${changeId}

> 变更级执行日志。默认不再为每个 task 自动生成单独 SUMMARY。

## Entries

### ${taskId}

- status: done
- completed_at: ${new Date().toISOString()}
- summary: TODO
- verify: TODO
- evidence: TODO
`;
    writeFileSync(executionPath, skeleton, 'utf-8');
  } else {
    const existing = readFileSync(executionPath, 'utf-8');
    if (!existing.includes(`### ${taskId}`)) {
      writeFileSync(executionPath, `${existing.trimEnd()}\n\n### ${taskId}\n\n- status: done\n- completed_at: ${new Date().toISOString()}\n- summary: TODO\n- verify: TODO\n- evidence: TODO\n`, 'utf-8');
    }
  }

  console.log(`✓ task ${taskId} 已标记完成`);
  console.log(`  EXECUTION: ${specsPath(changeId, getPreferredArtifactName('execution'))}`);
}

/**
 * gantry hook run <event> — 执行已配置的阶段 hook
 * gantry hook list         — 列出全部已配置的 hook
 *
 * 在 phases/*.md 里被引用 18 次（before:dev / after:integration 等），
 * 接通 lib/hooks.mjs 已实现的 runHook()。无配置则静默成功（exit 0）。
 */
async function hook(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);
  const config = readConfig(projectRoot);

  const sub = args[0];
  if (sub === 'list') {
    const hooks = listHooks(config);
    const keys = Object.keys(hooks);
    if (keys.length === 0) {
      console.log('未配置任何 hook');
      console.log(`  在 ${PLANNING_DIR}/config.json 的 hooks 字段添加，例如:`);
      console.log(`  "hooks": { "before:dev": "npm run lint" }`);
      console.log(`  支持事件: before:change / after:change / before:dev / after:integration`);
      return;
    }
    let hasError = false;
    for (const key of keys) {
      const def = hooks[key];
      const cmd = typeof def === 'string' ? def : def.cmd;
      const check = checkHook(def, projectRoot);
      // ✓ 校验通过 / ✗ 配置有问题(阻塞)/ ⚠ 无法离线校验,运行时才知(pending)
      let mark = '✓';
      let suffix = '';
      if (!check.ok) {
        mark = '✗';
        suffix = ` (${check.reason})`;
        hasError = true;
      } else if (check.pending) {
        mark = '⚠';
        suffix = ` (${check.type},运行时校验)`;
      } else {
        suffix = ` (${check.type})`;
      }
      console.log(`  ${mark} ${key.padEnd(22)} → ${cmd}${suffix}`);
    }
    if (hasError) process.exit(1);
    return;
  }

  if (sub !== 'run') {
    console.error('用法: gantry hook run <event>  |  gantry hook list');
    console.error('  事件示例: before:dev, after:test, before:integration');
    process.exit(1);
  }

  const event = args[1];
  if (!event) {
    console.error('缺少事件名: gantry hook run <event>');
    process.exit(1);
  }

  const result = await runHook(config, event, projectRoot);
  if (result.skipped) {
    // 无配置静默通过：phases/*.md 的语义就是 "退出码 0 或无配置 → 继续"
    return;
  }
  if (!result.ok) {
    process.exit(1);
  }
}

/**
 * gantry install [--tool T] [-g|--global]
 */
async function install(args) {
  const projectRoot = process.cwd();
  const globalMode = args.includes('-g') || args.includes('--global');
  const requestedTool = getFlag(args, '--tool');
  const installTools = resolveInstallTools(requestedTool, globalMode ? null : projectRoot, { globalMode });

  const validTools = ['claude', 'cursor', 'codex', 'copilot', 'all'];
  if (installTools.length === 0) {
    console.error(`未知工具: ${requestedTool}\n可用: ${validTools.join(', ')}`);
    process.exit(1);
  }

  let initResult = null;
  if (!globalMode) {
    initResult = initializeProject(projectRoot, {
      pipeline: normalizePipeline(getFlag(args, '--pipeline') || 'full'),
      tool: requestedTool === 'all' ? 'all' : installTools.length === 1 ? installTools[0].name : 'all',
      primaryAgent: installTools.length === 1 ? installTools[0].name : 'all',
    });
  }

  const result = await installToolsToTarget({
    projectRoot,
    installTools,
    globalMode,
  });

  for (const item of result.items) {
    console.log(`✓ gantry 已安装`);
    console.log(`  工具: ${item.tool}${globalMode ? ' (global)' : ''}`);
    console.log(`  目录: ${item.target}`);
    console.log(`  文件: ${item.count} 个`);
  }
  if (initResult?.created) {
    console.log(`  初始化: ${PLANNING_DIR}/`);
  } else if (initResult && !initResult.created) {
    console.log(`  状态: ${PLANNING_DIR}/ 已存在，保留当前状态`);
  }
  if (result.items.length > 1) console.log(`  总文件: ${result.total} 个`);
  if (!globalMode) {
    console.log(`\n下一步: gantry change "<描述你的变更>"`);
  }
  console.log(`\n卸载: gantry uninstall${globalMode ? ' -g' : ''}`);
}

function initializeProject(projectRoot, { pipeline, tool, primaryAgent }) {
  const planningDir = join(projectRoot, PLANNING_DIR);
  const created = !existsSync(planningDir);

  installCorePhases(projectRoot);
  installCoreAgents(projectRoot);

  if (!created) {
    migrateLegacyPipelines(projectRoot);
    return { created };
  }

  mkdirSync(planningDir, { recursive: true });

  const config = {
    pipeline,
    tool,
    stages: {
      change:       { enabled: true, requiresApproval: true },
      requirement:  { enabled: true },
      design:       { enabled: true, requiresApproval: true },
      task:         { enabled: true },
      dev:          { enabled: true },
      fast:         { enabled: true },
      test:         { enabled: true },
      review:       { enabled: true },
      integration:  { enabled: true, requiresApproval: true },
    },
    agents: {
      primary: primaryAgent,
    },
    autonomous: {
      maxStagesPerRun: 3,
      maxRetries: 3,
    },
    hooks: {},
  };
  writeFileSync(join(planningDir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');

  writeState(projectRoot, {
    pipeline,
    activeChange: null,
    currentStage: 'idle',
    currentWave: null,
    currentTask: null,
    activeAgent: null,
    autonomous: false,
    stagesRun: 0,
    maxStages: config.autonomous.maxStagesPerRun,
    retries: 0,
    maxRetries: config.autonomous.maxRetries,
    pauseReason: null,
  });

  return { created, config };
}

async function installToolsToTarget({ projectRoot, installTools, globalMode }) {
  const { loadCore, loadCommands, loadAgents } = await import('../tools/lib/loader.mjs');
  const core = loadCore(GANTRY_ROOT);
  const cmds = loadCommands(join(GANTRY_ROOT, 'skills'));
  const agents = loadAgents(join(GANTRY_ROOT, 'src', 'agents'));

  const items = [];
  let total = 0;
  for (const installTool of installTools) {
    const renderer = await import(`../tools/renderers/${installTool.renderer}.mjs`);
    const files = renderer.render(core, cmds, agents);
    const target = globalMode ? globalInstallRoot(installTool.name) : projectRoot;
    if (!globalMode) { addCorePhaseFiles(files, core.phases); addCoreAgentFiles(files, agents); }
    let count = 0;
    for (const [relPath, content] of Object.entries(files)) {
      if (relPath.startsWith('__merge__/')) {
        const realRel = relPath.slice('__merge__/'.length);
        const settingsPath = join(target, globalMode ? globalRelPath(installTool.name, realRel) : realRel);
        mkdirSync(dirname(settingsPath), { recursive: true });
        const added = mergeSettingsJson(settingsPath, { 'permissions.allow': content.addToAllow });
        const sideFile = globalMode ? join(globalInstallRoot(installTool.name), 'gantry-managed-permissions.json') : join(projectRoot, PLANNING_DIR, 'managed-permissions.json');
        writeManaged(sideFile, buildManagedEntries(content));
        console.log(`  已合并 ${(added['permissions.allow'] || []).length} 条 permission 到 ${settingsPath}${globalMode ? '（影响所有 Claude Code 会话）' : ''}`);
        count++;
        continue;
      }
      const full = join(target, globalMode ? globalRelPath(installTool.name, relPath) : relPath);
      mkdirSync(dirname(full), { recursive: true });
      if (SECTION_FILES.includes(relPath)) {
        injectSection(full, content);
      } else {
        writeFileSync(full, isPromptEntry(relPath) ? content : insertBanner(content, bannerFor(installTool.name, relPath, content)));
      }
      count++;
    }

    total += count;
    items.push({ tool: installTool.name, target, count });
  }

  return { items, total };
}

function installCorePhases(projectRoot) {
  const files = {};
  for (const fileName of readdirSync(join(GANTRY_ROOT, 'phases'))) {
    if (!fileName.endsWith('.md')) continue;
    files[`.gantry/core/phases/${fileName}`] = readFileSync(join(GANTRY_ROOT, 'phases', fileName), 'utf-8');
  }

  for (const [relPath, content] of Object.entries(files)) {
    if (relPath.startsWith('__merge__/')) continue;
    const full = join(projectRoot, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, insertBanner(content, bannerFor('core', relPath, content)), 'utf-8');
  }
}

function installCoreAgents(projectRoot) {
  const files = {};
  for (const fileName of readdirSync(join(GANTRY_ROOT, 'src', 'agents'))) {
    if (!fileName.endsWith('.md')) continue;
    files[`.gantry/core/agents/${fileName}`] = readFileSync(join(GANTRY_ROOT, 'src', 'agents', fileName), 'utf-8');
  }

  for (const [relPath, content] of Object.entries(files)) {
    if (relPath.startsWith('__merge__/')) continue;
    const full = join(projectRoot, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, insertBanner(content, bannerFor('core', relPath, content)), 'utf-8');
  }
}

function addCorePhaseFiles(files, phases) {
  for (const [fileName, content] of Object.entries(phases)) {
    files[`.gantry/core/phases/${fileName}`] = content;
  }
}

function addCoreAgentFiles(files, agents) {
  for (const [agentName, content] of Object.entries(agents)) {
    files[`.gantry/core/agents/${agentName}.md`] = content;
  }
}

/**
 * gantry uninstall [--all] [-g|--global]
 */
function uninstall(args) {
  const projectRoot = process.cwd();
  const globalMode = args.includes('-g') || args.includes('--global');
  const requestedTool = getFlag(args, '--tool') || (globalMode ? 'all' : null);
  const installTools = globalMode ? resolveInstallTools(requestedTool, null) : [];
  const removeAll = args.includes('--all');

  if (globalMode && installTools.length === 0) {
    console.error(`未知工具: ${requestedTool}\n可用: claude, cursor, codex, copilot, all`);
    process.exit(1);
  }

  const targets = globalMode
    ? installTools.map(tool => ({ root: globalInstallRoot(tool.name), tool: tool.name }))
    : [{ root: projectRoot, tool: null }];

  let totalGenerated = 0;
  let totalSections = 0;
  let foundAny = false;

  for (const target of targets) {
    const generated = findGeneratedFiles(target.root, target.tool);

    let sectionCount = 0;
    for (const rel of SECTION_FILES) {
      const full = join(target.root, target.tool ? globalRelPath(target.tool, rel) : rel);
      if (removeSection(full)) sectionCount++;
    }

    // 合并回滚：仅 claude（或项目模式默认 claude）有 settings.json 合并
    if (target.tool === null || target.tool === 'claude') {
      const settingsPath = target.tool
        ? join(target.root, globalRelPath(target.tool, '.claude/settings.json'))
        : join(target.root, '.claude/settings.json');
      const sideFile = target.tool
        ? join(target.root, 'gantry-managed-permissions.json')
        : join(target.root, PLANNING_DIR, 'managed-permissions.json');
      const entries = readManaged(sideFile);
      unmergeSettingsJson(settingsPath, entries);
      if (existsSync(sideFile)) unlinkSync(sideFile);
    }

    if (generated.length > 0 || sectionCount > 0) foundAny = true;

    for (const file of generated) {
      unlinkSync(file);
    }

    cleanEmptyDirs(target.root, cleanupDirsForTool(target.tool));
    cleanSkillDirs(target.root);

    totalGenerated += generated.length;
    totalSections += sectionCount;
  }

  if (!foundAny) {
    console.log('未找到 gantry 生成的文件。');
    if (removeAll && !globalMode) removePlanning(projectRoot);
    return;
  }

  console.log(`✓ 已卸载 gantry`);
  console.log(`  删除: ${totalGenerated} 个生成文件, ${totalSections} 个注入段`);

  if (removeAll && !globalMode) {
    removePlanning(projectRoot);
  } else {
    const planningDir = join(projectRoot, PLANNING_DIR);
    if (!globalMode && existsSync(planningDir)) {
      console.log(`  保留: ${PLANNING_DIR}/ (使用 --all 同时删除)`);
    }
  }
}


















async function archiveChange(projectRoot, changeId, { keepHistory = false, quiet = false, summary: summaryOverride = '' } = {}) {
  const sourceDir = join(projectRoot, SPECS_DIR, changeId);
  if (!existsSync(sourceDir)) {
    throw new Error(`未找到 change 目录: ${sourceDir}`);
  }

  // CHANGELOG 写入 (T09): 必须在移动 change 目录之前完成, appendChangelogLine 抛错则整次归档中止。
  const proposalPath = join(sourceDir, getPreferredArtifactName('proposal'));
  const proposalContent = existsSync(proposalPath) ? readFileSync(proposalPath, 'utf8') : '';
  let summary = summaryOverride || extractProposalSummary(proposalContent);
  if (!summary) {
    summary = changeId;
    console.error('⚠ 摘要提取失败, 建议下次用 --summary 覆写');
  }
  const lessonsIds = await collectLessonsIds(join(projectRoot, '.gantry', 'learnings', 'team'), changeId);
  const changelogPath = join(projectRoot, SPECS_DIR, 'CHANGELOG.md');
  // 若尚未初始化 CHANGELOG,先写入标准表头骨架;父目录只读等真实故障会在此或 appendChangelogLine 抛错 (AC-7)。
  if (!existsSync(changelogPath)) {
    writeFileSync(changelogPath, '# CHANGELOG\n\n| 日期 | Change ID | 摘要 | PR | LESSONS |\n|---|---|---|---|---|\n');
  }
  await appendChangelogLine(changelogPath, {
    date: new Date().toISOString().slice(0, 10),
    id: changeId,
    summary,
    pr: '—',
    lessons: lessonsIds.length ? lessonsIds.join(', ') : '无',
  });
  console.log('已写入 CHANGELOG.md');

  const archiveBase = join(projectRoot, SPECS_DIR, '_archive');
  if (!existsSync(archiveBase)) mkdirSync(archiveBase, { recursive: true });

  let targetDir = join(archiveBase, changeId);
  if (keepHistory && existsSync(targetDir)) {
    let n = 2;
    while (existsSync(`${targetDir}.v${n}`)) n++;
    targetDir = `${targetDir}.v${n}`;
    if (!quiet) console.log(`  保留历史模式：归档为 ${changeId}.v${n}`);
  } else if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
    if (!quiet) console.log(`  覆盖现有归档: _archive/${changeId}/`);
  }

  cpSync(sourceDir, targetDir, { recursive: true });
  rmSync(sourceDir, { recursive: true, force: true });

  const archiveLogPath = join(targetDir, 'ARCHIVE.md');
  const ts = new Date().toISOString();
  const logLine = `- ${ts} — archived from ${specsPath(changeId)}/\n`;
  if (existsSync(archiveLogPath)) {
    const existing = readFileSync(archiveLogPath, 'utf-8');
    writeFileSync(archiveLogPath, existing + logLine, 'utf-8');
  } else {
    writeFileSync(archiveLogPath, `# Archive log\n\n${logLine}`, 'utf-8');
  }

  return {
    targetDir,
    archiveName: targetDir.slice(archiveBase.length + 1),
  };
}

/**
 * D19 / B1+B2 / D28：判定「未升档的 light change」——change 目录有 light.json 时，
 * 只有**同时**满足两点才算已升档（可归档）：
 *   ① EXECUTION.md 有 `## upgrade` 段（升档时会追加，见 light-upgrade.mjs）；
 *   ② `.gantry/planning/light-anchor.json` 不属于本 change（不存在，或 changeId ≠ 本 change）。
 * 单看 ① 不够（N5）：手写一行 `## upgrade` 就能伪造。真实升档——出口门自动升档
 * （light-gate.mjs）与手工 `gantry pipeline full`（cli.mjs pipeline）——都会调用
 * removeLightAnchor 清掉锚定，所以「锚定仍在」是伪造的第二个证据。锚定文件存在但
 * 不可解析 → fail-closed，判为未升档。
 * 不以 STATE 的 pipeline / stage 为判据：readState 会把「手改成 integration 的 light」
 * 归一化成 full@integration（B2），只看 STATE 会漏判。
 */
function isUnupgradedLightChange(changeDir, projectRoot, changeId) {
  if (!existsSync(join(changeDir, 'light.json'))) return false;
  const execution = resolveArtifactPath(changeDir, 'execution');
  const content = execution && existsSync(execution.path) ? readFileSync(execution.path, 'utf-8') : '';
  if (!/^##\s+upgrade\b/m.test(content)) return true;

  const anchorPath = join(projectRoot, LIGHT_ANCHOR_FILE);
  if (!existsSync(anchorPath)) return false;
  let anchor;
  try {
    anchor = JSON.parse(readFileSync(anchorPath, 'utf-8'));
  } catch {
    return true; // fail-closed：锚定不可解析
  }
  if (!anchor || typeof anchor !== 'object') return true;
  return anchor.changeId === changeId;
}

/**
 * gantry archive — 收尾并归档当前 change
 */
async function archive(args, opts = {}) {
  const positional = stripFlags(args, ['--summary']);
  if (positional.length > 0) {
    console.error('用法: gantry archive [--force] [--keep-history] [--skip-learning] [--summary <摘要>]');
    process.exit(1);
  }

  const projectRoot = process.cwd();
  ensureInit(projectRoot);

  const state = readState(projectRoot);

  if (state.currentStage === 'idle') {
    console.error('无活跃变更可收尾');
    process.exit(1);
  }

  const finishedChange = state.activeChange;

  // D19 / D28：light change 无人工关卡，收尾只能经 `gantry advance` 出口门（AC-7）。
  // 该检查先于 --force / 阶段判定，且不看 STATE 里的 stage，堵住 B1（--force）、
  // B2（手改 STATE 到 integration）与 N5（手写 `## upgrade`）三条绕过路径。出口门内部的
  // 自动归档直接调用 archiveChange（cli.mjs → runLightExitGate 注入），不经过本函数，故不受影响。
  if (isUnupgradedLightChange(join(projectRoot, SPECS_DIR, finishedChange), projectRoot, finishedChange)) {
    console.error('✗ light change 只能经 gantry advance 出口门收尾（archive 不适用，--force 也不放行）');
    process.exit(1);
  }

  if (state.currentStage !== 'integration' && !args.includes('--force')) {
    console.log(`当前阶段: ${state.currentStage}`);
    console.log('通常在 integration 阶段执行 archive。');
    console.log('使用 --force 跳过剩余阶段直接收尾');
    return;
  }

  const skipLearning = args.includes('--skip-learning');

  // friction 汇总 hook (T15): 采集必须在 archiveChange 移动 change 目录之前完成,否则 getEvents 读不到事件。
  let frictionEvents = null;
  if (!skipLearning) {
    const _lv = validateLearningsConfig(readConfig(projectRoot).learnings);
    if (!_lv.ok) throw new ConfigError(_lv.errors);
    const learningsCfg = _lv.merged;
    const { threshold, weights } = learningsCfg.friction;
    if (frictionGetScore(finishedChange, weights) >= threshold) {
      frictionEvents = frictionGetEvents(finishedChange);
    }
  }

  let archiveResult;
  try {
    archiveResult = await archiveChange(projectRoot, finishedChange, {
      keepHistory: args.includes('--keep-history'),
      summary: getFlag(args, '--summary'),
      quiet: true,
    });
  } catch (error) {
    console.error(`归档失败: ${error.message}`);
    process.exit(1);
  }

  resetStateToIdle(projectRoot, state);

  if (frictionEvents) {
    await summarizeFrictionLearning(projectRoot, finishedChange, frictionEvents, opts);
  }

  console.log(`✓ 变更已收尾: ${finishedChange}`);
  console.log(`  状态已重置为 idle`);
  console.log(`  已归档到 ${specsPath('_archive', archiveResult.archiveName)}/`);
  console.log(`  恢复: gantry unarchive ${finishedChange}`);
}

/**
 * friction 汇总 → 候选 learning → y/n/edit 决策 → 落盘 team/。
 * autoConfirmChoice 由 opts 或 GANTRY_AUTO_CONFIRM 环境变量注入(测试用),跳过 stdin 交互。
 */
async function summarizeFrictionLearning(projectRoot, changeId, events, opts) {
  const candidate = proposeLearning(changeId, events, {});
  const auto = opts.autoConfirmChoice ?? process.env.GANTRY_AUTO_CONFIRM;
  const choice = ['y', 'n', 'edit'].includes(auto) ? auto : await promptYNE(candidate);

  if (choice === 'y') {
    await writeLearning('team', candidate);
    console.log(`  学习已写入 .gantry/learnings/team/${candidate.id}.md`);
  } else if (choice === 'edit') {
    await editAndWriteLearning(projectRoot, candidate);
    console.log(`  学习已写入 .gantry/learnings/team/${candidate.id}.md`);
  } else {
    console.log(`  已跳过 friction 学习`);
  }
}

async function promptYNE(candidate) {
  console.log('\n检测到摩擦事件,生成 learning 候选:');
  console.log(`  id: ${candidate.id}`);
  console.log(`  标签: ${candidate.tags.join(', ')}`);
  console.log(candidate.body);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question('\n采纳为 team learning? [y/n/edit] ')).trim().toLowerCase();
      if (answer === 'y' || answer === 'n' || answer === 'edit') return answer;
      console.log('请输入 y / n / edit');
    }
  } finally {
    rl.close();
  }
}

async function editAndWriteLearning(projectRoot, candidate) {
  const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
  const learningsDir = join(projectRoot, '.gantry', 'learnings');
  mkdirSync(learningsDir, { recursive: true });
  const draftPath = join(learningsDir, `.draft-${candidate.id}-${process.pid}.md`);
  writeFileSync(draftPath, candidate.body, 'utf-8');
  try {
    const r = spawnSync(editor, [draftPath], { stdio: 'inherit' });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`编辑器退出码 ${r.status}`);
    const editedBody = readFileSync(draftPath, 'utf-8');
    await writeLearning('team', { ...candidate, body: editedBody });
  } finally {
    if (existsSync(draftPath)) unlinkSync(draftPath);
  }
}

/**
 * gantry unarchive <change-id> [--from <archive-name>]
 * 恢复归档并重新激活 change（archive 的反向生命周期动作）
 */
function unarchive(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);

  const changeId = args.find(a => !a.startsWith('--'));
  if (!changeId) {
    console.error('用法: gantry unarchive <change-id> [--from <archive-name>]');
    process.exit(1);
  }
  const state = readState(projectRoot);
  if (state.activeChange || state.currentStage !== 'idle') {
    console.error(`已有活跃 change：${state.activeChange || '(未知)'}`);
    console.error('请先 archive 当前 change，再 unarchive 其他 change。');
    process.exit(1);
  }

  const fromName = getFlag(args, '--from') || changeId;
  const sourceDir = join(projectRoot, SPECS_DIR, '_archive', fromName);
  const targetDir = join(projectRoot, SPECS_DIR, changeId);

  if (!existsSync(sourceDir)) {
    console.error(`未找到归档: ${sourceDir}`);
    console.error(`提示: 用 ls ${specsPath('_archive')}/ 查看可用归档`);
    process.exit(1);
  }
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
  }
  cpSync(sourceDir, targetDir, { recursive: true });

  updateState(projectRoot, {
    activeChange: changeId,
    currentStage: 'integration',
    currentWave: null,
    currentTask: null,
    activeAgent: 'integrator',
    pauseReason: null,
  });

  console.log(`✓ 已恢复并重新激活: _archive/${fromName} → ${specsPath(changeId)}/`);
  console.log(`  当前阶段: integration`);
  console.log(`  如需再次收尾: gantry archive`);
}

/**
 * gantry metrics — 月度采纳巡检（转发到 tools/metrics.mjs）
 *   透传参数,如 --target <repo> --since "1 month ago" --out <dir>
 *   非 KPI · 非考核 · 给 Curator 月度 review / 团队 retro 用
 */
function metrics(args) {
  const script = join(GANTRY_ROOT, 'tools', 'metrics.mjs');
  if (!existsSync(script)) {
    console.error(`未找到 metrics 工具: ${script}`);
    process.exit(1);
  }
  const r = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

/**
 * gantry loop [claude|codex] — 无监督收敛 driver 的终端入口。
 *
 * 把 .gantry/loop/loop.sh 包成 subcommand:
 *   - 脚本从 gantry 包根(GANTRY_ROOT)读,不依赖用户项目有没有 loop.sh
 *   - 用户项目 cwd 由 spawn 的 cwd 透传;dispatcher 用环境变量 PROJECT_ROOT 读
 *   - 退出码原样透传(0=done / 2=blocked / 3=max-steps / 4=dispatch-fail / 5=stuck / 64=usage)
 *
 * 环境变量透传:GANTRY_BIN(默认 "gantry") / GANTRY_LOOP_MAX_STEPS / LOOP_STUCK_LIMIT /
 *              GANTRY_LOOP_DISPATCHER。
 */
function loop(args) {
  const client = args[0];
  if (!client || ['-h', '--help'].includes(client)) {
    console.log(`gantry loop <client> — 无监督收敛 driver

用法: gantry loop <client>
  client       claude | codex(明确指定,不做自动探测)

环境变量:
  GANTRY_BIN              CLI 入口,默认 "gantry"(全局可执行)
  GANTRY_LOOP_MAX_STEPS   步数上限,默认 40
  LOOP_STUCK_LIMIT        同 token 连续次数上限,默认 2

退出码: 0=done  2=blocked  3=达步数上限  4=dispatch 失败  5=stuck  64=用法错`);
    if (!client) process.exit(64);
    return;
  }

  const loopScript = join(GANTRY_ROOT, '.gantry', 'loop', 'loop.sh');
  if (!existsSync(loopScript)) {
    console.error(`未找到 loop 脚本: ${loopScript}`);
    console.error(`gantry 包安装不完整——请重装(npm i -g gantry)。`);
    process.exit(1);
  }

  const r = spawnSync('bash', [loopScript, client], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  if (r.error) {
    console.error(`启动 loop 失败: ${r.error.message}`);
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}

/**
 * gantry version — 显示版本号
 */
function version() {
  const pkg = JSON.parse(readFileSync(join(GANTRY_ROOT, 'package.json'), 'utf-8'));
  console.log(`gantry v${pkg.version}`);
}

function help(args = []) {
  if (args.includes('--all')) return helpAll();

  console.log(`gantry — 阶段驱动编排器

日常在 IDE 里用 skill 推进,CLI 只做机械操作:
  /gantry-change  /gantry-next  /gantry-archive  /gantry-auto  /gantry-review

人工敲的:
  install              初始化项目 / 全局安装
  status               查看当前状态       [--json]
  archive              归档当前变更
  hook <list|run>      查看 / 执行阶段 hook

自动化 / 脚本用:
  change "<描述>"      开新变更           [--tier light|full]
  pipeline full        将 light change 单向升档为 full
  advance              单步推进           [--skip]
  auto                 多阶段自动推进
  loop <claude|codex>  无监督收敛 driver(headless)
  loop-next            无监督 driver 消费的 token
  heal                 dev 阶段 self-heal

详细命令表: gantry help --all
文档 / 版本: docs/  |  gantry --version`);
}

function helpAll() {
  console.log(`gantry — 完整命令参考

用法: gantry <command> [options]

核心流程（日常按此循环）:
  install             初始化 / 同步 Gantry：状态目录 + 阶段协议 + 客户端命令集成
    --tool <T>          仅安装指定客户端命令集成: claude|cursor|codex|copilot|all（默认自动检测，无命中则 claude）
    --pipeline <P>      初始管线: full|light（默认 full）

  change "<描述>"     开始新变更（默认 full）
    --id <id>           显式指定 change-id（否则从业务主题自动生成）
    --tier <T>          显式指定管线: light|full（默认 full）
    --pipeline <T>      --tier 的 deprecated alias（同取值 light|full）
    --scope <paths>     light 入口: 允许改动的相对路径，逗号分隔（light 必填）
    --accept "<a;b>"    light 入口: 验收线，分号分隔（默认取描述）
    --verify "<cmd>"    light 入口: 出口门要执行的 verify 命令（可选）
  pipeline full       将当前活跃 change 从 light 单向提升为 full（任意 light 阶段可升；已是 full 报错）
  pipeline light      非零退出：不支持降档（full → light）
  /gantry-next        在客户端中执行当前阶段产物并推进（不是 CLI 命令）

  advance             单步推进（供 loop driver / 手动调用）
    --skip              跳过软门禁失败继续推进

  auto                自动多阶段推进（步数取 config.autonomous.maxStagesPerRun），遇门禁失败 / 人工确认关卡 / 终态即停

  loop <claude|codex> 无监督收敛 driver(headless)——包装 .gantry/loop/loop.sh
                      退出码: 0=done  2=blocked  3=max-steps  4=dispatch 失败  5=stuck  64=用法错
                      环境变量: GANTRY_BIN(默认 gantry) / GANTRY_LOOP_MAX_STEPS / LOOP_STUCK_LIMIT

  loop-next           只读输出下一步 loop token（供无监督 driver 消费）
                      白名单单 token,stdout 单行;exit 0=推进/done,exit 2=blocked

  heal                dev 阶段 verify 失败时的 self-heal 缓冲（R2.5 上限触发时写 fence.blockedReason）

  status              查看当前状态、待确认关卡
    --json              输出 JSON 格式

  archive             收尾并归档当前 change（仅 integration 阶段可用）
    --force             跳过阶段检查强制收尾
    --keep-history      保留旧归档，新归档加版本后缀
    --skip-learning     跳过 friction 汇总 learning 生成

安装 / 分发:
  install -g          安装 gantry 到各工具全局目录（不初始化当前项目）
    --tool <T>          claude|cursor|codex|copilot|all（默认 all）

  uninstall           卸载 gantry 生成的文件
    --tool <T>          claude|cursor|codex|copilot|all（配合 -g 使用）
    -g, --global        从各工具全局目录卸载
    --all               同时删除 .gantry/planning/ 目录

辅助 / 调试:
  context [stage] [task] 手动生成/刷新 context-pack.json（change/next 已自动刷新，此命令供调试）
    --task <id>         指定 task id (dev 阶段必需)
    --stage <s>         强制指定阶段 (默认从 STATE.md 读)
    --json              把 pack 内容直接打到 stdout

  done <task-id>      标记任务完成 + 落 EXECUTION.md 执行日志

  hook run <event>    执行已配置的阶段 hook（before:change / before:dev 等）
  hook list           列出全部已配置的 hook 及状态标记

  knowledge <sub>     non-change 知识库管理（研究、决策记录等）

  unarchive <id>      从归档恢复并重新激活 change
    --from <name>       指定归档版本名（默认同 change-id）

  metrics             月度采纳巡检（非 KPI，给 Curator / retro 用）
    --target <repo>     目标仓库（默认当前目录）
    --since <when>      扫描窗口（默认 "1 month ago"）
    --out <dir>         报告输出目录（默认 .gantry/specs/metrics）

  version             显示版本号
  help                显示简版帮助
  help --all          显示本完整表`);
}

// --- install/uninstall 辅助 ---

function detectTool(dir) {
  return detectTools(dir)[0] || null;
}

function detectTools(dir) {
  const tools = [];
  if (!dir) return tools;
  if (existsSync(join(dir, 'CLAUDE.md')) || existsSync(join(dir, '.claude'))) tools.push('claude');
  if (existsSync(join(dir, 'AGENTS.md')) || existsSync(join(dir, '.agents'))) tools.push('codex');
  if (existsSync(join(dir, '.cursor'))) tools.push('cursor');
  if (existsSync(join(dir, '.github', 'copilot-instructions.md')) || existsSync(join(dir, '.github', 'prompts'))) tools.push('copilot');
  return tools;
}

function normalizeInstallTool(tool) {
  if (tool === 'claude') return { name: 'claude', renderer: 'claude-code' };
  if (tool === 'claude-code') return { name: 'claude', renderer: 'claude-code' };
  if (['cursor', 'codex', 'copilot'].includes(tool)) return { name: tool, renderer: tool };
  return null;
}

function resolveInstallTools(requestedTool, detectDir, options = {}) {
  if (requestedTool === 'all') {
    return ['claude', 'cursor', 'codex', 'copilot'].map(normalizeInstallTool);
  }
  if (requestedTool) {
    const tool = normalizeInstallTool(requestedTool);
    return tool ? [tool] : [];
  }
  if (options.globalMode) {
    return ['claude', 'cursor', 'codex', 'copilot'].map(normalizeInstallTool);
  }
  const detected = detectTools(detectDir);
  const tools = detected.length > 0 ? detected : ['claude'];
  return tools.map(normalizeInstallTool).filter(Boolean);
}

function globalInstallRoot(tool) {
  const home = homedir();
  if (tool === 'claude') return join(home, '.claude');
  if (tool === 'codex') return join(home, '.codex');
  if (tool === 'cursor') return join(home, '.cursor');
  if (tool === 'copilot') return join(home, '.github');
  return home;
}

function globalRelPath(tool, relPath) {
  if (tool === 'claude') {
    if (relPath === 'CLAUDE.md') return 'CLAUDE.md';
    if (relPath.startsWith('.claude/')) return relPath.slice('.claude/'.length);
  }
  if (tool === 'codex') {
    if (relPath === 'AGENTS.md') return 'AGENTS.md';
    if (relPath.startsWith('.agents/')) return relPath.slice('.agents/'.length);
  }
  if (tool === 'cursor' && relPath.startsWith('.cursor/')) {
    return relPath.slice('.cursor/'.length);
  }
  if (tool === 'copilot' && relPath.startsWith('.github/')) {
    return relPath.slice('.github/'.length);
  }
  return relPath;
}

function findGeneratedFiles(dir, tool = null) {
  const found = [];
  for (const rel of SCAN_PATTERNS) {
    const full = join(dir, tool ? globalRelPath(tool, rel) : rel);
    if (existsSync(full) && isGenerated(full)) {
      found.push(full);
    }
  }
  for (const [subdir, ext] of SCAN_DIRS) {
    const abs = join(dir, tool ? globalRelPath(tool, subdir) : subdir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      if (!name.endsWith(ext)) continue;
      const full = join(abs, name);
      if (isGenerated(full) || isGantryPromptFile(full)) found.push(full);
    }
  }
  for (const subdir of SKILL_DIRS) {
    const abs = join(dir, tool ? globalRelPath(tool, subdir) : subdir);
    if (!existsSync(abs)) continue;
    for (const skillName of readdirSync(abs)) {
      const skillFile = join(abs, skillName, 'SKILL.md');
      if (existsSync(skillFile) && (isGenerated(skillFile) || isGantryPromptFile(skillFile))) found.push(skillFile);
    }
  }
  return found;
}

function cleanupDirsForTool(tool) {
  if (tool === 'claude') return ['skills'];
  if (tool === 'codex') return ['skills'];
  if (tool === 'cursor') return ['rules'];
  if (tool === 'copilot') return ['prompts'];
  return [
    '.claude/commands',
    '.claude/skills',
    '.claude',
    '.cursor/rules',
    '.cursor',
    '.github/prompts',
    '.github',
    '.gantry/core/agents',
    '.gantry/core/phases',
    '.gantry/core',
    '.gantry',
  ];
}

function isGenerated(filePath) {
  try {
    const fd = readFileSync(filePath, 'utf8');
    return fd.slice(0, 1024).includes('GENERATED by gantry');
  } catch {
    return false;
  }
}

function isGantryPromptFile(filePath) {
  try {
    const fd = readFileSync(filePath, 'utf8');
    const head = fd.slice(0, 2048);
    return /^name:\s*gantry[:_-]/m.test(head)
      || /^source:\s*phases\//m.test(head)
      || /^description:\s*gantry\s/m.test(head)
      || /^description:\s*gantry 阶段命令/m.test(head);
  } catch {
    return false;
  }
}

function bannerFor(tool, relPath, content) {
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 12);
  return `<!-- GENERATED by gantry · DO NOT EDIT · tool=${tool} · path=${relPath} · sha256=${hash} -->\n`;
}

function insertBanner(content, banner) {
  if (content.startsWith('---\n')) {
    const endIdx = content.indexOf('\n---\n', 4);
    if (endIdx !== -1) {
      const insertAt = endIdx + 5;
      return content.slice(0, insertAt) + banner + content.slice(insertAt);
    }
  }
  return banner + content;
}

function isPromptEntry(relPath) {
  // Only SECTION_FILES (CLAUDE.md, AGENTS.md) skip banners — they use injectSection.
  // All other files (skills, commands, phases) get banners for uninstall detection.
  return relPath === 'CLAUDE.md' || relPath === 'AGENTS.md';
}

function cleanEmptyDirs(base, relDirs) {
  for (const rel of relDirs) {
    const abs = join(base, rel);
    if (!existsSync(abs)) continue;
    try {
      const entries = readdirSync(abs);
      if (entries.length === 0) rmSync(abs, { recursive: true });
    } catch { /* not empty or already gone */ }
  }
}

function cleanSkillDirs(base) {
  for (const subdir of [...SKILL_DIRS, 'skills']) {
    const abs = join(base, subdir);
    if (!existsSync(abs)) continue;
    for (const skillName of readdirSync(abs)) {
      const skillDir = join(abs, skillName);
      try {
        const entries = readdirSync(skillDir);
        if (entries.length === 0) rmSync(skillDir, { recursive: true });
      } catch { /* skip */ }
    }
  }
  cleanEmptyDirs(base, ['.agents/skills', '.agents', '.claude/skills', '.claude', 'skills']);
}

function removePlanning(target) {
  const planningDir = join(target, PLANNING_DIR);
  if (!existsSync(planningDir)) return;
  // 软删：rename 到 .gantry/.trash/planning-<ts>/，避免 unlink 不可逆
  // 用户若反悔可直接 mv 回来；需要彻底清理再手动 rm .gantry/.trash
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const trashDir = join(target, '.gantry', '.trash');
  if (!existsSync(trashDir)) mkdirSync(trashDir, { recursive: true });
  const dest = join(trashDir, `planning-${ts}`);
  renameSync(planningDir, dest);
  console.log(`  软删: ${PLANNING_DIR}/ → .gantry/.trash/planning-${ts}/`);
  console.log(`  恢复: mv "${dest}" "${planningDir}"`);
}

function injectSection(filePath, content) {
  const block = `${SECTION_BEGIN}\n${content.trimEnd()}\n${SECTION_END}\n`;
  if (!existsSync(filePath)) {
    writeFileSync(filePath, block);
    return;
  }
  const existing = readFileSync(filePath, 'utf8');
  const beginIdx = existing.indexOf(SECTION_BEGIN);
  const endIdx = existing.indexOf(SECTION_END);
  if (beginIdx !== -1 && endIdx !== -1) {
    const before = existing.slice(0, beginIdx);
    const after = existing.slice(endIdx + SECTION_END.length + 1);
    writeFileSync(filePath, before + block + after);
  } else {
    const sep = existing.endsWith('\n') ? '\n' : '\n\n';
    writeFileSync(filePath, existing + sep + block);
  }
}

function removeSection(filePath) {
  if (!existsSync(filePath)) return false;
  const content = readFileSync(filePath, 'utf8');
  const beginIdx = content.indexOf(SECTION_BEGIN);
  const endIdx = content.indexOf(SECTION_END);
  if (beginIdx === -1 || endIdx === -1) return false;
  const before = content.slice(0, beginIdx);
  const after = content.slice(endIdx + SECTION_END.length + 1);
  const result = (before + after).replace(/\n{3,}$/, '\n');
  if (result.trim() === '') {
    unlinkSync(filePath);
  } else {
    writeFileSync(filePath, result);
  }
  return true;
}

// --- 工具函数 ---



function ensureInit(projectRoot) {
  if (!existsSync(join(projectRoot, PLANNING_DIR))) {
    console.error('项目未初始化。运行 gantry install 开始。');
    process.exit(1);
  }
  migrateLegacyPipelines(projectRoot);
}

function migrateLegacyPipelines(projectRoot) {
  const configPath = join(projectRoot, PLANNING_DIR, 'config.json');
  const statePath = join(projectRoot, PLANNING_DIR, 'STATE.md');
  let migrated = false;

  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (config.pipeline === 'standard') {
        config.pipeline = 'full';
        writeFileAtomic(configPath, JSON.stringify(config, null, 2));
        migrated = true;
      }
    } catch {
      // readConfig 会按既有容错策略处理损坏配置。
    }
  }

  if (existsSync(statePath)) {
    const raw = readFileSync(statePath, 'utf-8');
    const legacyStandard = /- \*\*模式\*\*:\s*`standard`/.test(raw);
    const legacyLight = /- \*\*模式\*\*:\s*`light`/.test(raw);
    const normalized = readState(projectRoot);
    if (legacyStandard || (legacyLight && normalized.pipeline === 'full')) {
      writeState(projectRoot, normalized);
      migrated = true;
    }
  }

  if (migrated) console.log('↑ pipeline 迁移: standard/旧 light → full');
}

function writeFileAtomic(path, content) {
  const tempPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tempPath, content, 'utf-8');
  renameSync(tempPath, path);
}


function getFlag(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  return args[idx + 1] || null;
}

/**
 * 移除指定的 flag 及其后续值，返回剩余的位置参数
 *   stripFlags(['x', '--pipeline', 'light', 'y'], ['--pipeline']) → ['x', 'y']
 */
function stripFlags(args, flagsWithValue = []) {
  const skip = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (flagsWithValue.includes(arg)) {
      skip.add(i);
      if (i + 1 < args.length) skip.add(i + 1);
    } else if (arg.startsWith('--')) {
      // 无值 flag（如 --force）也跳过自身，但不吞下后面的位置参数
      skip.add(i);
    }
  }
  return args.filter((_, i) => !skip.has(i));
}





/**
 * 归一化 tier 覆写值 (light|full)，非法值返回 null。
 */
function normalizeTierValue(value) {
  if (value === 'light' || value === 'full') return value;
  return null;
}

/**
 * 解析 light 入口的 --scope 值（逗号分隔）为数组；缺省 → 空数组。
 * 空数组会由 validateIntentScope 判为 intent-scope-invalid。
 */
function parseScopeArg(raw) {
  if (raw == null) return [];
  return raw.split(',').map((s) => s.trim());
}

/**
 * 解析 --accept：分号分隔，去空；缺省或全空 → [description]。
 */
function parseAcceptArg(raw, description) {
  if (raw == null) return [description];
  const items = raw.split(';').map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : [description];
}

function generateChangeId(description, projectRoot, explicitId = null) {
  const source = explicitId || extractChangeSubject(description);
  const base = normalizeChangeId(source) || 'change';
  return uniqueChangeId(projectRoot, base);
}

function uniqueChangeId(projectRoot, baseId) {
  let candidate = baseId;
  let n = 2;
  while (changeIdExists(projectRoot, candidate)) {
    candidate = `${baseId}-${n}`;
    n++;
  }
  return candidate;
}

function changeIdExists(projectRoot, changeId) {
  return existsSync(join(projectRoot, SPECS_DIR, changeId))
    || existsSync(join(projectRoot, SPECS_DIR, '_archive', changeId));
}

function extractChangeSubject(description) {
  let subject = String(description || '').trim().replace(/\s+/g, ' ');

  subject = subject.replace(
    /^(?:根据|基于|参考|按照|依照)\s+\S+(?:\s*(?:创建|生成|编写|整理|输出|撰写))?(?:\s*(?:需求|spec|规格|变更|proposal))?\s*[：:,，]?\s*/i,
    '',
  );
  subject = subject.replace(
    /^(?:创建|生成|编写|整理|输出|撰写)(?:一个|一份)?(?:需求|spec|规格|变更|proposal)\s*[：:,，]?\s*/i,
    '',
  );
  subject = subject.replace(/^[~./\w-]+\.(?:md|markdown|txt|docx?|pdf)\s*[：:,，]?\s*/i, '');

  subject = subject
    .replace(/[，,；;。].*$/, '')
    .replace(/并(?:更新|修改|调整|补充|新增|优化).*/, '')
    .replace(/由[^，,；;。]+改(?:为)?/g, '')
    .replace(/从[^，,；;。]+改(?:为)?/g, '')
    .replace(/^(?:做|想做|加个?|新增|实现|设计|开发|修改|调整|优化)(?:一个|一份)?\s*/, '')
    .replace(/^\s*(?:将|把)\s*/, '')
    .trim();

  return subject || description;
}

function normalizeChangeId(text) {
  return limitSlugWords(slugifyEnglish(text), 5);
}

function slugifyEnglish(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function limitSlugWords(slug, maxWords) {
  const words = String(slug || '').split('-').filter(Boolean);
  return words.slice(0, maxWords).join('-');
}
