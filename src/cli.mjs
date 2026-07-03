#!/usr/bin/env node

/**
 * gantry CLI — 阶段驱动编排器
 * 零依赖，纯 Node.js
 *
 * Usage: gantry <command> [options]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { readState, writeState, updateState, transitionStage, logPhaseEvent, readGateBypasses } from './lib/state.mjs';
import { STAGES, getNextStage, checkGate, PHASE_FILES } from './lib/phases.mjs';
import { PLANNING_DIR, SPECS_DIR, specsPath } from './lib/paths.mjs';
import { route, checkUpgrade, reroute } from './lib/router.mjs';
import { parseTasks, getProgress } from './lib/tasks.mjs';
import { runHook, listHooks } from './lib/hooks.mjs';
import { writeContextPack, readContextPack, PACK_PATH } from './lib/context-pack.mjs';
import { artifactCandidates, getPreferredArtifactName, resolveArtifactPath } from './lib/artifacts.mjs';
import { readConfig } from './lib/config.mjs';

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
  ['.gantry/core/phases', '.md'],
];

const SKILL_DIRS = [
  '.agents/skills',
  '.claude/skills',
];


// --- 入口 ---

const [,, command, ...args] = process.argv;

const commands = {
  init, status, change, auto, next, context, done, hook, install, uninstall, archive, unarchive, version,
  help,
};

if (!command || command === '--help' || command === '-h') {
  help();
} else if (command === '--version' || command === '-v' || command === '-V') {
  version();
} else if (commands[command]) {
  const _r = commands[command](args);
  if (_r && typeof _r.then === 'function') _r.catch(err => { console.error(err.message || String(err)); process.exit(1); });
} else {
  console.error(`未知命令: ${command}\n运行 gantry help 查看可用命令`);
  process.exit(1);
}

// --- 命令实现 ---

/**
 * gantry init — 初始化 .gantry/planning/ 目录
 */
function init(args) {
  const projectRoot = process.cwd();
  const planningDir = join(projectRoot, PLANNING_DIR);

  if (existsSync(planningDir)) {
    console.log(`${PLANNING_DIR}/ 已存在，跳过初始化`);
    console.log(`当前状态: ${readState(projectRoot).currentStage}`);
    return;
  }

  // 解析选项
  const tool = getFlag(args, '--tool') || 'all';
  const pipeline = getFlag(args, '--pipeline') || 'full';

  // 创建目录结构
  mkdirSync(planningDir, { recursive: true });

  // 写入 config.json
  const config = {
    pipeline,
    tool,
    stages: {
      change:       { enabled: true, checkpoint: 'approval' },
      requirement:  { enabled: true, checkpoint: 'approval' },
      design:       { enabled: true, checkpoint: 'approval' },
      'ui-design':  { enabled: 'auto', condition: 'frontend' },
      task:         { enabled: true, checkpoint: 'auto' },
      dev:          { enabled: true, checkpoint: null },
      test:         { enabled: true, checkpoint: 'auto' },
      review:       { enabled: true, checkpoint: 'approval' },
      integration:  { enabled: true, checkpoint: 'approval' },
    },
    agents: {
      primary: tool === 'all' ? 'claude-code' : tool,
      crossModel: true,
    },
    autonomous: {
      maxStagesPerRun: 3,
      pauseOnCheckpoint: true,
      maxRetries: 3,
    },
    hooks: {},
  };
  writeFileSync(join(planningDir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');

  // 写入初始 STATE.md
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

  // 写入 ROADMAP.md 已移除 — 当前没有任何命令读取它。Loop engineering 原则：
  // 工件必须有消费者，否则只是装饰。需要变更积压视图时，扫描 .gantry/specs/_archive/ 目录。

  console.log(`✓ ${PLANNING_DIR}/ 初始化完成`);
  console.log(`  管线: ${pipeline}`);
  console.log(`  工具: ${tool}`);
  console.log(`  配置: ${join(PLANNING_DIR, 'config.json')}`);
  console.log(`\n下一步: gantry change "<描述你的变更>"`);
}

/**
 * gantry status — 显示当前状态
 */
function status(args) {
  const projectRoot = process.cwd();
  const planningDir = join(projectRoot, PLANNING_DIR);

  if (!existsSync(planningDir)) {
    console.log('项目未初始化。运行 gantry init 开始。');
    return;
  }

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

  // 当前阶段是否为 approval 关卡（从 currentStage + config 派生，非独立状态）
  const cfg = readConfig(projectRoot);
  if (state.currentStage !== 'idle'
      && cfg?.stages?.[state.currentStage]?.checkpoint === 'approval') {
    console.log(`\n⏸  当前阶段 ${state.currentStage} 需人工确认：审阅本阶段产物后运行 gantry next 推进。`);
  }

  // 门禁绕过留痕（兑现 --skip 的"已写入 timeline"承诺，消费者=事后排查者）
  if (state.activeChange) {
    const bypasses = readGateBypasses(projectRoot, state.activeChange);
    if (bypasses.length > 0) {
      console.log(`\n⚠  本 change 有 ${bypasses.length} 次门禁绕过记录:`);
      for (const b of bypasses) {
        console.log(`   [${(b.ts || '').slice(0, 10)}] → ${b.stage}: ${b.reason}`);
      }
    }
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
    const nextSt = getNextStage(state.currentStage, { ...cfg, pipeline: state.pipeline });
    if (nextSt) {
      console.log(`\n下一步: gantry next  →  ${nextSt}`);
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
 */
function change(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);

  // 提取描述：跳过 --flag 及其值
  const description = stripFlags(args, ['--pipeline', '--tool']).join(' ');
  if (!description) {
    console.error('用法: gantry change "<变更描述>"');
    process.exit(1);
  }

  const state = readState(projectRoot);
  if (state.activeChange) {
    console.error(`已有活跃变更: ${state.activeChange}`);
    console.error('请先完成或归档当前变更 (gantry archive)');
    process.exit(1);
  }

  // 智能路由：意图识别 → 管线深度选择
  const flagPipeline = getFlag(args, '--pipeline');
  let pipeline = flagPipeline || 'full';
  let routeInfo = null;
  if (!flagPipeline) {
    routeInfo = route(description, { projectRoot });
    pipeline = routeInfo.pipeline;
  }

  // 生成 change-id
  const changeId = slugify(description);
  const specsDir = join(projectRoot, SPECS_DIR, changeId);
  mkdirSync(specsDir, { recursive: true });

  // 更新状态
  updateState(projectRoot, {
    pipeline,
    activeChange: changeId,
    currentStage: 'change',
    activeAgent: 'planner',
  });

  // 写一次 pack,让 skill 立刻有可消费的上下文
  try { writeContextPack(projectRoot); } catch { /* non-blocking */ }

  console.log(`✓ 变更已创建: ${changeId}`);
  if (routeInfo) {
    console.log(`  路由: ${routeInfo.scale} → ${pipeline} (${routeInfo.rationale})`);
  }
  console.log(`  管线: ${pipeline}`);
  console.log(`  工件目录: ${specsPath(changeId)}/`);
  console.log(`  当前阶段: change (变更提案)`);
  console.log(`  上下文: ${PACK_PATH}`);
  console.log(`\n请执行阶段 0 (CHANGE):`);
  console.log(`  加载 .gantry/core/phases/0-change.md 并产出 ${specsPath(changeId, getPreferredArtifactName('proposal'))}`);
}














/**
 * gantry next — 手动单步推进一个阶段
 *
 * 设计原则：CLI 只做机械检查，人工守护交给 AI skill（如 /gantry:auto）
 * 多阶段自主推进由 gantry auto 独占；next 只推进一步即停，职责唯一。
 *
 *   gantry next                  推进一步
 *   gantry next --skip           跳过当前门禁（写 timeline 留痕，每次都要显式）
 *
 * 核心闭环：
 *   reroute → checkGate → transitionStage
 *   失败 → retries+=1，连续 > maxRetries 拒推
 *   --skip → 不阻塞，但 type=gate-bypass 写入 timeline.jsonl
 */
function next(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);

  // next 是「手动单步」入口：推进一步即停。多阶段自主推进用 gantry auto。
  const isSkip = args.includes('--skip');
  const result = nextOnce(projectRoot, { isSkip });
  if (result.stop && result.exitCode) process.exit(result.exitCode);
  if (result.reachedEnd) {
    console.log(`  管线已到达 ${result.reachedEnd}`);
  }
}

/**
 * gantry auto [--stages N] [--trust]
 *   按 autonomous.maxStagesPerRun 自动推进,遇门禁阻塞或终态即停。
 */
function auto(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);

  const config = readConfig(projectRoot);
  const state = readState(projectRoot);
  const stagesFlag = parseStagesFlag(args);
  if (stagesFlag.error) {
    console.error(stagesFlag.error);
    process.exit(1);
  }

  const trust = args.includes('--trust');
  const maxStages = stagesFlag.value ?? getConfiguredMaxStages(config, state.maxStages || 3);
  const maxSteps = trust ? 50 : maxStages;

  updateState(projectRoot, {
    autonomous: true,
    stagesRun: 0,
    maxStages,
    pauseReason: null,
  });

  if (trust) {
    console.log(`自主模式: trust (配置上限 ${maxStages}, 本次按管线终态推进)`);
  } else {
    console.log(`自主模式: 最多推进 ${maxStages} 个阶段`);
  }

  for (let step = 0; step < maxSteps; step++) {
    const result = nextOnce(projectRoot);
    if (result.stop) {
      console.log(`  自动推进在 ${step}/${trust ? '∞' : maxSteps} 步停止`);
      if (result.exitCode) process.exit(result.exitCode);
      return;
    }
    if (result.reachedEnd) {
      console.log(`  管线已到达 ${result.reachedEnd}`);
      return;
    }
    updateState(projectRoot, { stagesRun: step + 1, maxStages });
    if (result.pausedForApproval) {
      console.log(`⏸  已进入 ${result.pausedForApproval}（需人工确认）。审阅后运行 gantry next 继续。`);
      return;
    }
  }

  if (!trust) {
    console.log(`  已达到本次自动推进上限: ${maxStages}`);
  }
}

/**
 * 单步推进。返回 { stop, reachedEnd, exitCode }
 */
function nextOnce(projectRoot, { isSkip = false } = {}) {
  const state = readState(projectRoot);

  if (state.currentStage === 'idle') {
    console.log('当前无活跃变更。运行 gantry change "<描述>" 开始。');
    return { stop: true };
  }
  if (state.currentStage === 'integration') {
    console.log('已在 integration 阶段。运行 gantry archive 完成变更。');
    return { reachedEnd: 'integration' };
  }

  const config = readConfig(projectRoot);
  const effectiveConfig = { ...config, pipeline: state.pipeline || config.pipeline };
  const nextStage = getNextStage(state.currentStage, effectiveConfig);
  if (!nextStage) {
    return { reachedEnd: state.currentStage };
  }

  const specsDir = join(projectRoot, SPECS_DIR, state.activeChange);

  // === Reroute：基于累积工件重新评估 pipeline ===
  const rerouteResult = runReroute(specsDir, state);
  if (rerouteResult.shouldUpgrade) {
    updateState(projectRoot, { pipeline: rerouteResult.newPipeline });
    logPhaseEvent(projectRoot, {
      type: 'pipeline-upgrade',
      from: state.pipeline,
      to: rerouteResult.newPipeline,
      reason: rerouteResult.reason,
      stage: state.currentStage,
    });
    console.log(`↑ 管线升级: ${state.pipeline} → ${rerouteResult.newPipeline}`);
    console.log(`  原因: ${rerouteResult.reason}`);
  }

  // === Gate ===
  const gateResult = checkGate(nextStage, specsDir, effectiveConfig, state);

  if (!gateResult.passed) {
    const newRetries = state.retries + 1;
    updateState(projectRoot, { retries: newRetries, pauseReason: gateResult.reason });

    if (isSkip) {
      logPhaseEvent(projectRoot, {
        type: 'gate-bypass',
        changeId: state.activeChange,
        stage: nextStage,
        reason: gateResult.reason,
      });
      console.log(`⚠  跳过门禁: ${gateResult.reason}`);
      console.log(`  已写入 ${PLANNING_DIR}/timeline.jsonl`);
    } else if (newRetries > state.maxRetries) {
      console.error(`✗ 门禁连续失败 ${state.retries} 次（上限 ${state.maxRetries}）`);
      console.error(`  原因: ${gateResult.reason}`);
      const hint = gateRecoveryHint(gateResult.reason);
      if (hint) console.error(hint);
      console.error(`  修复后重试，或用 gantry next --skip 显式跳过`);
      return { stop: true, exitCode: 1 };
    } else {
      console.error(`✗ 门禁未通过 [${newRetries}/${state.maxRetries}]: ${gateResult.reason}`);
      const hint = gateRecoveryHint(gateResult.reason);
      if (hint) console.error(hint);
      return { stop: true, exitCode: 1 };
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

  // Approval checkpoint（派生策略，非独立状态）：
  // 若刚进入的阶段配了 checkpoint=approval，自动推进到此为止，把控制权交还给人。
  // "停下来"就是 checkpoint 本身；人审阅后再敲一次 gantry next 即 resolve。
  // 单步 gantry next 不受影响——它推进这一步后本就停下等下一次调用。
  if (effectiveConfig?.stages?.[nextStage]?.checkpoint === 'approval') {
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
      `     3. 再次运行 gantry next 推进到 requirement`,
    ].join('\n');
  }
  return null;
}


function parseStagesFlag(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--stages' || arg === '--max-stages') {
      const parsed = parsePositiveInt(args[i + 1]);
      if (!parsed) return { error: `${arg} 需要正整数，例如: gantry auto ${arg} 5` };
      return { value: parsed };
    }
    const m = arg.match(/^--(?:stages|max-stages)=(.+)$/);
    if (m) {
      const parsed = parsePositiveInt(m[1]);
      if (!parsed) return { error: `${arg.split('=')[0]} 需要正整数` };
      return { value: parsed };
    }
  }
  return { value: null };
}

function parsePositiveInt(value) {
  if (!/^\d+$/.test(String(value ?? ''))) return null;
  const parsed = parseInt(value, 10);
  return parsed > 0 ? parsed : null;
}

function getConfiguredMaxStages(config = {}, fallback = 3) {
  const configured = Number(config?.autonomous?.maxStagesPerRun);
  return Number.isInteger(configured) && configured > 0 ? configured : fallback;
}

/**
 * 收集 reroute 的输入信号：累积工件文本 + 任务数
 */
function runReroute(specsDir, state) {
  if (!existsSync(specsDir)) return { shouldUpgrade: false };

  const artifactFiles = [
    ...artifactCandidates('proposal'),
    ...artifactCandidates('spec'),
    'DESIGN.md',
    ...artifactCandidates('tasks'),
  ];
  let artifactsText = '';
  for (const name of artifactFiles) {
    const p = join(specsDir, name);
    if (existsSync(p)) {
      try { artifactsText += '\n' + readFileSync(p, 'utf-8').slice(0, 8000); }
      catch { /* skip */ }
    }
  }

  let taskCount = 0;
  const taskFile = resolveArtifactPath(specsDir, 'tasks')?.path;
  if (taskFile && existsSync(taskFile)) {
    taskCount = parseTasks(taskFile).length;
  }

  return reroute(state.pipeline, { artifactsText, taskCount });
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

  logPhaseEvent(projectRoot, { type: 'task-done', taskId, changeId });

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
      return;
    }
    for (const key of keys) {
      const def = hooks[key];
      const cmd = typeof def === 'string' ? def : def.cmd;
      console.log(`  ${key.padEnd(22)} → ${cmd}`);
    }
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
 * gantry install [--tool T] [--init] [-g|--global]
 */
async function install(args) {
  const projectRoot = process.cwd();
  const globalMode = args.includes('-g') || args.includes('--global');
  const requestedTool = getFlag(args, '--tool');
  const installTools = resolveInstallTools(requestedTool, globalMode ? null : projectRoot, { globalMode });
  const doInit = args.includes('--init');

  const validTools = ['claude', 'cursor', 'codex', 'copilot', 'all'];
  if (installTools.length === 0) {
    console.error(`未知工具: ${requestedTool}\n可用: ${validTools.join(', ')}`);
    process.exit(1);
  }
  if (globalMode && doInit) {
    console.error('--init 仅支持本地项目安装，不能与 -g/--global 同时使用');
    process.exit(1);
  }

  const { loadCore, loadCommands, loadAgents } = await import('../tools/lib/loader.mjs');
  const core = loadCore(GANTRY_ROOT);
  const cmds = loadCommands(join(GANTRY_ROOT, 'skills'));
  const agents = loadAgents(join(GANTRY_ROOT, 'src', 'agents'));

  let total = 0;
  for (const installTool of installTools) {
    const renderer = await import(`../tools/renderers/${installTool.renderer}.mjs`);
    const files = renderer.render(core, cmds, agents);
    const target = globalMode ? globalInstallRoot(installTool.name) : projectRoot;

    // Copy phase source files to .gantry/core/phases/ (local install only)
    if (!globalMode) {
      for (const [fileName, content] of Object.entries(core.phases)) {
        files[`.gantry/core/phases/${fileName}`] = content;
      }
    }

    let count = 0;
    for (const [relPath, content] of Object.entries(files)) {
      const outputPath = globalMode ? globalRelPath(installTool.name, relPath) : relPath;
      const full = join(target, outputPath);
      mkdirSync(dirname(full), { recursive: true });
      if (SECTION_FILES.includes(relPath)) {
        injectSection(full, content);
      } else {
        const skipBanner = isPromptEntry(relPath);
        const finalContent = skipBanner
          ? content
          : insertBanner(content, bannerFor(installTool.name, relPath, content));
        writeFileSync(full, finalContent);
      }
      count++;
    }

    total += count;
    console.log(`✓ gantry 已安装`);
    console.log(`  工具: ${installTool.name}${globalMode ? ' (global)' : ''}`);
    console.log(`  目录: ${target}`);
    console.log(`  文件: ${count} 个`);
  }

  if (doInit) {
    const planningDir = join(projectRoot, PLANNING_DIR);
    if (!existsSync(planningDir)) {
      init([]);
    } else {
      console.log(`  ${PLANNING_DIR}/ 已存在，跳过初始化`);
    }
  }

  if (installTools.length > 1) {
    console.log(`  总文件: ${total} 个`);
  }
  console.log(`\n卸载: gantry uninstall${globalMode ? ' -g' : ''}`);
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


















function archiveChange(projectRoot, changeId, { keepHistory = false, quiet = false } = {}) {
  const sourceDir = join(projectRoot, SPECS_DIR, changeId);
  if (!existsSync(sourceDir)) {
    throw new Error(`未找到 change 目录: ${sourceDir}`);
  }

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
 * gantry archive — 收尾并归档当前 change
 */
function archive(args) {
  const positional = args.filter(a => !a.startsWith('--'));
  if (positional.length > 0) {
    console.error('用法: gantry archive [--force] [--keep-history]');
    process.exit(1);
  }

  const projectRoot = process.cwd();
  ensureInit(projectRoot);

  const state = readState(projectRoot);

  if (state.currentStage === 'idle') {
    console.error('无活跃变更可收尾');
    process.exit(1);
  }

  if (state.currentStage !== 'integration' && !args.includes('--force')) {
    console.log(`当前阶段: ${state.currentStage}`);
    console.log('通常在 integration 阶段执行 archive。');
    console.log('使用 --force 跳过剩余阶段直接收尾');
    return;
  }

  const finishedChange = state.activeChange;

  let archiveResult;
  try {
    archiveResult = archiveChange(projectRoot, finishedChange, {
      keepHistory: args.includes('--keep-history'),
      quiet: true,
    });
  } catch (error) {
    console.error(`归档失败: ${error.message}`);
    process.exit(1);
  }

  updateState(projectRoot, {
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

  console.log(`✓ 变更已收尾: ${finishedChange}`);
  console.log(`  状态已重置为 idle`);
  console.log(`  已归档到 ${specsPath('_archive', archiveResult.archiveName)}/`);
  console.log(`  恢复: gantry unarchive ${finishedChange}`);
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
  if (!existsSync(targetDir)) {
    cpSync(sourceDir, targetDir, { recursive: true });
  }

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
 * gantry version — 显示版本号
 */
function version() {
  const pkg = JSON.parse(readFileSync(join(GANTRY_ROOT, 'package.json'), 'utf-8'));
  console.log(`gantry v${pkg.version}`);
}

function help() {
  console.log(`gantry — 阶段驱动编排器

用法: gantry <command> [options]

核心流程（日常按此循环）:
  init                初始化 .gantry/planning/ 目录
    --tool <T>          IDE 工具: claude|cursor|codex|copilot|all（默认 all）
    --pipeline <P>      管线深度: full|standard|light（默认 full）

  change "<描述>"     开始新变更（自动路由管线深度）

  next                手动单步推进一个阶段（内含门禁）
    --skip              跳过当前门禁（写 timeline 留痕，每次需显式）

  auto                自动多阶段推进，遇门禁失败 / approval 关卡 / 终态即停
    --stages <N>        本次最多推进 N 个阶段（默认取 config）
    --trust             推进到管线终态为止（上限 50 步）

  status              查看当前状态、待确认关卡、门禁绕过记录
    --json              输出 JSON 格式

  archive             收尾并归档当前 change（仅 integration 阶段可用）
    --force             跳过阶段检查强制收尾
    --keep-history      保留旧归档，新归档加版本后缀

安装 / 分发:
  install             安装 gantry 到当前项目
    --tool <T>          claude|cursor|codex|copilot（默认自动检测）
    --init              同时初始化 .gantry/planning/
    -g, --global        安装到各工具全局目录（默认安装全部工具）

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

  hook run <event>    执行已配置的阶段 hook（before:dev / after:test 等）
  hook list           列出全部已配置的 hook

  unarchive <id>      从归档恢复并重新激活 change
    --from <name>       指定归档版本名（默认同 change-id）

  version             显示版本号
  help                显示本帮助`);
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
  if (existsSync(planningDir)) {
    rmSync(planningDir, { recursive: true, force: true });
    console.log(`  删除: ${PLANNING_DIR}/`);
  }
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
    console.error('项目未初始化。运行 gantry init 开始。');
    process.exit(1);
  }
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





function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w一-鿿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
