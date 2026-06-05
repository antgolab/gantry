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
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readState, writeState, updateState, transitionStage, addCheckpoint as addCheckpointToState, logPhaseEvent, readTimeline } from './lib/state.mjs';
import { STAGES, PIPELINES, PHASE_FILES, STAGE_ARTIFACTS, checkGate, getNextStage, isValidTransition } from './lib/phases.mjs';
import { createCheckpoint, resolveCheckpoint, listCheckpoints, getPendingCheckpoint, shouldCheckpoint } from './lib/checkpoints.mjs';
import { parseTasks, groupWaves, getNextTask, getCurrentWave, allTasksDone, getProgress } from './lib/tasks.mjs';
import { runGate, writeGateResult } from './lib/gate.mjs';
import { route as routeIntent, checkUpgrade } from './lib/router.mjs';
import { buildPromptPackage, assembleWave } from './lib/executor.mjs';
import { selectModel, resolveModelId } from './lib/model-router.mjs';
import { runHook, listHooks } from './lib/hooks.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const GANTRY_ROOT = resolve(__dirname, '..');
const PLANNING_DIR = '.planning';

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
];

const SKILL_DIRS = [
  '.agents/skills',
];

const PATCH_FILE = 'PATCH.md';
const PATCH_STAGE_ITEMS = {
  requirement: 'REQUIREMENT.md',
  design: 'DESIGN.md',
  'ui-design': 'UI-DESIGN.md',
  task: 'TASK.md',
  dev: 'DEV',
  test: 'TEST.md',
  review: 'REVIEW.md',
  integration: 'UAT.md',
};
const PATCH_STAGE_ORDER = ['change', 'requirement', 'design', 'ui-design', 'task', 'dev', 'test', 'review', 'integration'];

// --- 入口 ---

const [,, command, ...args] = process.argv;

const commands = {
  init, status, change, next, exec, verify, review, ship,
  resume, auto, fast, scan, health, architect, knowledge,
  'check-req': checkReq, debug, doubt, finish, curator,
  roadmap, checkpoint, gate, route, snapshot, install, uninstall, version,
  adjust, revise, archive, unarchive,
  hook,
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
 * gantry init — 初始化 .planning/ 目录
 */
function init(args) {
  const projectRoot = process.cwd();
  const planningDir = join(projectRoot, PLANNING_DIR);

  if (existsSync(planningDir)) {
    console.log('.planning/ 已存在，跳过初始化');
    console.log(`当前状态: ${readState(projectRoot).currentStage}`);
    return;
  }

  // 解析选项
  const tool = getFlag(args, '--tool') || 'all';
  const pipeline = getFlag(args, '--pipeline') || 'full';

  // 创建目录结构
  mkdirSync(join(planningDir, 'checkpoints'), { recursive: true });

  // 写入 config.json
  const config = {
    pipeline,
    tool,
    stages: {
      change:       { enabled: true, checkpoint: 'human-verify' },
      requirement:  { enabled: true, checkpoint: 'human-verify' },
      design:       { enabled: true, checkpoint: 'human-verify' },
      'ui-design':  { enabled: 'auto', condition: 'frontend' },
      task:         { enabled: true, checkpoint: 'auto' },
      dev:          { enabled: true, checkpoint: 'per-wave' },
      test:         { enabled: true, checkpoint: 'auto' },
      review:       { enabled: true, checkpoint: 'human-verify' },
      integration:  { enabled: true, checkpoint: 'human-verify' },
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
    checkpoints: [],
    decisions: [],
  });

  // 写入 ROADMAP.md
  writeFileSync(join(planningDir, 'ROADMAP.md'), `# ROADMAP — 变更积压

## 活跃变更

（暂无）

## 积压队列

| 优先级 | Change | 状态 | 依赖 |
|--------|--------|------|------|

## 已完成

（暂无）
`, 'utf-8');

  console.log(`✓ .planning/ 初始化完成`);
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
  console.log(`┌─ gantry 状态 ─────────────────────`);
  console.log(`│ 管线:     ${state.pipeline}`);
  console.log(`│ 阶段:     ${state.currentStage}${stageInfo ? ` (${stageInfo.label})` : ''}`);
  console.log(`│ Change:   ${state.activeChange || '—'}`);
  console.log(`│ Wave:     ${state.currentWave ?? '—'}`);
  console.log(`│ Task:     ${state.currentTask ?? '—'}`);
  console.log(`│ Agent:    ${state.activeAgent ?? '—'}`);
  console.log(`│ 自主模式: ${state.autonomous ? 'ON' : 'OFF'}`);
  if (state.pauseReason) {
    console.log(`│ 暂停原因: ${state.pauseReason}`);
  }
  console.log(`└──────────────────────────────────────`);

  // 显示待处理 checkpoints
  const pending = state.checkpoints.filter(cp => cp.status === 'pending');
  if (pending.length > 0) {
    console.log(`\n待处理 Checkpoints:`);
    for (const cp of pending) {
      console.log(`  [${cp.id}] ${cp.stage} — ${cp.type}`);
    }
  }

  // 提示下一步
  if (state.currentStage === 'idle') {
    console.log(`\n下一步: gantry change "<描述>"`);
  } else {
    const next = getNextStage(state.currentStage, readConfig(projectRoot));
    if (next) {
      console.log(`\n下一步: gantry next → ${next}`);
    }
  }
}

/**
 * gantry change — 启动新变更
 */
function change(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);

  const description = args.filter(a => !a.startsWith('--')).join(' ');
  if (!description) {
    console.error('用法: gantry change "<变更描述>"');
    process.exit(1);
  }

  const state = readState(projectRoot);
  if (state.activeChange) {
    console.error(`已有活跃变更: ${state.activeChange}`);
    console.error('请先完成或归档当前变更 (gantry ship)');
    process.exit(1);
  }

  // 生成 change-id
  const changeId = slugify(description);
  const specsDir = join(projectRoot, '.specs', changeId);
  mkdirSync(specsDir, { recursive: true });

  // 更新状态
  updateState(projectRoot, {
    activeChange: changeId,
    currentStage: 'change',
    activeAgent: 'planner',
  });

  console.log(`✓ 变更已创建: ${changeId}`);
  console.log(`  工件目录: .specs/${changeId}/`);
  console.log(`  当前阶段: change (变更提案)`);
  console.log(`\n请执行阶段 0 (CHANGE):`);
  console.log(`  加载 phases/0-change.md 并产出 .specs/${changeId}/CHANGE.md`);
}

/**
 * gantry next — 推进到下一阶段
 */
function next(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);

  const state = readState(projectRoot);
  const config = readConfig(projectRoot);

  if (state.currentStage === 'idle') {
    console.error('当前无活跃变更。运行 gantry change 开始。');
    process.exit(1);
  }

  const nextStage = getNextStage(state.currentStage, config);
  if (!nextStage) {
    console.log('管线已完成。运行 gantry ship 归档。');
    return;
  }

  // 门禁检查
  const specsDir = join(projectRoot, '.specs', state.activeChange);
  const patchGate = checkPatchStageGate(specsDir, state.currentStage);
  if (!patchGate.passed) {
    console.error(`Patch 门禁未通过: ${patchGate.reason}`);
    console.error(`请先完成并勾选 .specs/${state.activeChange}/PATCH.md 中的 ${patchGate.item}`);
    process.exit(1);
  }

  const gate = checkGate(nextStage, specsDir, config, state);
  if (!gate.passed) {
    console.error(`门禁未通过: ${gate.reason}`);
    console.error(`请先完成当前阶段 (${state.currentStage}) 的产出工件`);
    process.exit(1);
  }

  // 转换
  transitionStage(projectRoot, state.currentStage, nextStage);
  const stageInfo = STAGES[nextStage];
  const phaseFile = PHASE_FILES[nextStage];

  console.log(`✓ 阶段推进: ${state.currentStage} → ${nextStage} (${stageInfo.label})`);
  console.log(`  阶段 prompt: phases/${phaseFile}`);
  console.log(`  Checkpoint: ${stageInfo.checkpoint}`);
}

/**
 * gantry exec — 执行任务
 */
function exec(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);

  const state = readState(projectRoot);
  if (state.currentStage !== 'dev') {
    console.error(`exec 仅在 dev 阶段可用（当前: ${state.currentStage}）`);
    process.exit(1);
  }

  const specsDir = join(projectRoot, '.specs', state.activeChange);
  const taskMdPath = join(specsDir, 'TASK.md');
  const tasks = parseTasks(taskMdPath);

  if (tasks.length === 0) {
    console.error('未找到任务。请确认 TASK.md 存在且格式正确。');
    process.exit(1);
  }

  const progress = getProgress(tasks);
  const waveMode = args.includes('--wave');
  const taskId = args.find(a => /^T\d+$/.test(a));

  if (taskId) {
    // 执行指定任务
    const task = tasks.find(t => t.id === taskId);
    if (!task) {
      console.error(`未找到任务: ${taskId}`);
      process.exit(1);
    }
    if (task.status === 'done') {
      console.log(`任务 ${taskId} 已完成，跳过。`);
      return;
    }
    updateState(projectRoot, { currentTask: taskId, activeAgent: 'executor' });
    printTaskExec(task, specsDir);
  } else if (waveMode) {
    // Wave 模式：生成 prompt 包
    const wave = getCurrentWave(tasks);
    const waveNum = groupWaves(tasks).indexOf(wave) + 1;
    updateState(projectRoot, { currentWave: waveNum, activeAgent: 'executor' });

    const packages = assembleWave(wave, { specsDir, projectRoot, stage: 'dev', pipeline: state.pipeline || 'standard' });

    console.log(`┌─ Wave ${waveNum} ─────────────────────`);
    console.log(`│ 任务数: ${wave.length} (并行: ${wave.filter(t => t.parallel).length})`);
    console.log(`│ 总进度: ${progress.done}/${progress.total} (${progress.percent}%)`);
    console.log(`└──────────────────────────────────────`);
    console.log('');
    for (const pkg of packages) {
      const modelId = resolveModelId(pkg.model, 'claude-code');
      console.log(`  [${pkg.taskId}] ${pkg.metadata.taskTitle}  model=${pkg.model}(${modelId})`);
      if (pkg.metadata.writeFiles.length > 0) {
        console.log(`         write: ${pkg.metadata.writeFiles.join(', ')}`);
      }
    }
    console.log(`\n每个任务使用 fresh context 执行 phases/4-dev.md`);
    if (args.includes('--json')) {
      console.log('\n' + JSON.stringify(packages, null, 2));
    }
  } else {
    // 默认：执行下一个待处理任务
    const task = getNextTask(tasks);
    if (!task) {
      console.log(`所有任务已完成 (${progress.done}/${progress.total})`);
      console.log('运行 gantry next 推进到 test 阶段');
      return;
    }
    updateState(projectRoot, { currentTask: task.id, activeAgent: 'executor' });
    printTaskExec(task, specsDir);
  }
}

/**
 * gantry verify — 运行验证
 */
function verify(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);

  const state = readState(projectRoot);
  const specsDir = join(projectRoot, '.specs', state.activeChange);
  const taskMdPath = join(specsDir, 'TASK.md');
  const tasks = parseTasks(taskMdPath);
  const verifyAll = args.includes('--all');

  if (verifyAll) {
    console.log('验证所有已完成任务的 verify 命令:');
    const doneTasks = tasks.filter(t => t.status === 'done' && t.verify);
    if (doneTasks.length === 0) {
      console.log('  无已完成任务或无 verify 命令');
      return;
    }
    for (const task of doneTasks) {
      console.log(`  [${task.id}] ${task.verify}`);
    }
  } else {
    const taskId = args.find(a => /^T\d+$/.test(a)) || state.currentTask;
    const task = tasks.find(t => t.id === taskId);
    if (!task) {
      console.error(`未找到任务: ${taskId || '(无当前任务)'}`);
      process.exit(1);
    }
    if (task.verify) {
      console.log(`验证 [${task.id}]: ${task.verify}`);
    } else {
      console.log(`任务 ${task.id} 无 verify 命令`);
    }
  }
}

/**
 * gantry review — 触发审查
 */
function review(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);

  const state = readState(projectRoot);
  const config = readConfig(projectRoot);

  if (state.currentStage !== 'review' && state.currentStage !== 'test') {
    // 允许从 test 或 review 阶段触发
    console.error(`review 在 test/review 阶段可用（当前: ${state.currentStage}）`);
    console.error('使用 gantry next 推进到 review 阶段');
    process.exit(1);
  }

  const crossModel = args.includes('--cross-model');
  updateState(projectRoot, { activeAgent: 'reviewer' });

  console.log(`┌─ 代码审查 ─────────────────────────`);
  console.log(`│ Change: ${state.activeChange}`);
  console.log(`│ 模式: ${crossModel ? '跨模型审查' : '标准双轮审查'}`);
  console.log(`│ 阶段 prompt: phases/6-review.md`);
  console.log(`└──────────────────────────────────────`);
  console.log(`\n产出: .specs/${state.activeChange}/REVIEW.md`);
  if (crossModel) {
    console.log('建议: 使用不同 AI 模型执行第二轮审查');
  }
}

/**
 * gantry ship — 完成 change 收尾并默认归档
 */
function ship(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);

  const state = readState(projectRoot);

  if (state.currentStage === 'idle') {
    console.error('无活跃变更可收尾');
    process.exit(1);
  }

  // 检查是否在 integration 阶段（或允许强制收尾）
  if (state.currentStage !== 'integration' && !args.includes('--force')) {
    console.log(`当前阶段: ${state.currentStage}`);
    console.log('通常在 integration 阶段执行 ship。');
    console.log('使用 --force 跳过剩余阶段直接收尾');
    return;
  }

  const finishedChange = state.activeChange;
  const shouldArchive = !args.includes('--no-archive');
  const specsDir = join(projectRoot, '.specs', finishedChange);
  const patchAudit = checkPatchClosure(specsDir);
  if (!patchAudit.passed && !args.includes('--force')) {
    console.error(`Patch 尚未闭环，不能 ship:`);
    for (const item of patchAudit.unchecked) console.error(`  ${item}`);
    console.error(`请先完成并勾选 .specs/${finishedChange}/PATCH.md，或使用 --force 强制收尾`);
    process.exit(1);
  }
  if (!patchAudit.passed && args.includes('--force')) {
    console.log(`⚠ Patch 未闭环，--force 强制收尾:`);
    for (const item of patchAudit.unchecked) console.log(`  ${item}`);
  } else {
    closePatchIfOpen(specsDir);
  }

  // 生命周期报告
  printLifecycleReport(projectRoot, finishedChange);

  let archiveResult = null;
  if (shouldArchive) {
    try {
      archiveResult = archiveChange(projectRoot, finishedChange, { keepHistory: false, quiet: true });
    } catch (error) {
      console.error(`归档失败，ship 未完成: ${error.message}`);
      process.exit(1);
    }
  }

  // 重置状态（包含修订字段）
  updateState(projectRoot, {
    activeChange: null,
    currentStage: 'idle',
    currentWave: null,
    currentTask: null,
    activeAgent: null,
    stagesRun: 0,
    retries: 0,
    pauseReason: null,
  });

  console.log(`\n✓ 变更已收尾: ${finishedChange}`);
  console.log(`  状态已重置为 idle`);
  if (archiveResult) {
    console.log(`  已归档到 .specs/_archive/${archiveResult.archiveName}/`);
  } else {
    console.log(`  已跳过归档（--no-archive）`);
    console.log(`  如需补归档: gantry archive ${finishedChange}`);
  }
  console.log(`下一步: gantry change "<新变更>" 或 gantry roadmap list`);
}

/**
 * gantry resume — 从 checkpoint 恢复
 */
function resume(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);

  const checkpointId = args[0];
  const state = readState(projectRoot);

  if (checkpointId) {
    // 解决指定 checkpoint
    const result = resolveCheckpoint(projectRoot, checkpointId, 'resumed');
    if (result.error) {
      console.error(result.error);
      process.exit(1);
    }
    console.log(`✓ Checkpoint ${checkpointId} 已解决`);
    console.log(`  阶段: ${result.stage}`);
    console.log(`  可继续: gantry next`);
  } else {
    // 显示 pending checkpoints
    const pending = listCheckpoints(projectRoot, 'pending');
    if (pending.length === 0) {
      console.log('无待处理 checkpoint。');
      if (state.pauseReason) {
        console.log(`暂停原因: ${state.pauseReason}`);
      }
      return;
    }

    console.log('待处理 Checkpoints:');
    for (const cp of pending) {
      console.log(`  [${cp.id}] ${cp.stage} — ${cp.type}`);
      console.log(`    ${cp.prompt}`);
      if (cp.artifacts.length > 0) {
        console.log(`    工件: ${cp.artifacts.join(', ')}`);
      }
    }
    console.log(`\n解决: gantry resume <checkpoint-id>`);
  }
}

/**
 * gantry auto — 自主模式
 */
function auto(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);

  const state = readState(projectRoot);
  const config = readConfig(projectRoot);
  const maxStages = parseInt(getFlag(args, '--stages')) || config.autonomous?.maxStagesPerRun || 3;
  const trustMode = args.includes('--trust') || args.includes('--full');

  if (state.currentStage === 'idle' && !state.activeChange) {
    console.error('无活跃变更。先运行 gantry change 开始。');
    process.exit(1);
  }

  const effectiveMax = trustMode ? 99 : maxStages;
  updateState(projectRoot, { autonomous: true, maxStages: effectiveMax, stagesRun: 0 });

  console.log(`┌─ 自主模式启动 ─────────────────────`);
  console.log(`│ Change: ${state.activeChange}`);
  console.log(`│ 起始阶段: ${state.currentStage}`);
  console.log(`│ 模式: ${trustMode ? '全信任（跳过所有 checkpoint）' : `标准（最多 ${maxStages} 阶段）`}`);
  console.log(`│ 暂停条件: ${trustMode ? '仅门禁阻塞' : 'human-verify checkpoint / 门禁阻塞'}`);
  console.log(`└──────────────────────────────────────`);

  // 自动推进循环
  let stagesRun = 0;
  let currentState = readState(projectRoot);

  while (stagesRun < effectiveMax) {
    const nextStage = getNextStage(currentState.currentStage, config);
    if (!nextStage) {
      console.log(`\n✓ 管线完成。共推进 ${stagesRun} 个阶段。`);
      updateState(projectRoot, { autonomous: false, pauseReason: null });
      break;
    }

    // 门禁检查
    const specsDir = join(projectRoot, '.specs', currentState.activeChange);
    const gate = checkGate(nextStage, specsDir, config, currentState);
    if (!gate.passed) {
      console.log(`\n⚠ 门禁阻塞 @ ${nextStage}: ${gate.reason}`);
      notify('gantry', `门禁阻塞: ${gate.reason}`);
      updateState(projectRoot, { pauseReason: 'gate-blocked' });
      break;
    }
    if (gate.skipReason) {
      console.log(`  ↷ 跳过 ${nextStage}（${gate.skipReason}）`);
      transitionStage(projectRoot, currentState.currentStage, nextStage);
      stagesRun++;
      updateState(projectRoot, { stagesRun });
      currentState = readState(projectRoot);
      continue;
    }

    // Checkpoint 检查（trust 模式跳过）
    const stageDef = STAGES[nextStage];
    if (!trustMode && stageDef?.checkpoint === 'human-verify') {
      const cp = createCheckpoint(projectRoot, {
        changeId: currentState.activeChange,
        stage: nextStage,
        type: 'human-verify',
        prompt: `自主模式暂停: 阶段 ${nextStage} 需要人工确认`,
        artifacts: [STAGE_ARTIFACTS[nextStage] || ''],
      });
      addCheckpointToState(projectRoot, {
        id: cp.id, stage: nextStage, type: 'human-verify',
        status: 'pending', created: cp.createdAt.slice(0, 10),
      });
      console.log(`\n⏸ Checkpoint: ${nextStage} 需要人工确认 [${cp.id}]`);
      notify('gantry', `阶段 ${nextStage} 需要人工确认`);
      updateState(projectRoot, { pauseReason: 'checkpoint-pause' });
      break;
    }

    // 推进
    transitionStage(projectRoot, currentState.currentStage, nextStage);
    stagesRun++;
    console.log(`  → ${nextStage} (${stageDef?.label})`);
    updateState(projectRoot, { stagesRun });
    currentState = readState(projectRoot);
  }

  if (stagesRun >= effectiveMax && !trustMode) {
    console.log(`\n已达最大推进数 (${maxStages})。运行 gantry auto 继续。`);
    updateState(projectRoot, { pauseReason: 'max-stages-reached' });
  }
}

/**
 * gantry fast — 快速路径
 */
function fast(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);

  const description = args.filter(a => !a.startsWith('--')).join(' ');
  if (!description) {
    console.error('用法: gantry fast "<简短描述>"');
    process.exit(1);
  }

  const state = readState(projectRoot);
  if (state.activeChange) {
    console.error(`已有活跃变更: ${state.activeChange}`);
    console.error('fast 路径需要无活跃变更。先 ship 或归档当前变更。');
    process.exit(1);
  }

  const changeId = `fast-${slugify(description)}`;
  const specsDir = join(projectRoot, '.specs', changeId);
  mkdirSync(specsDir, { recursive: true });

  updateState(projectRoot, {
    pipeline: 'fast',
    activeChange: changeId,
    currentStage: 'dev',
    activeAgent: 'executor',
  });

  console.log(`✓ 快速路径启动: ${changeId}`);
  console.log(`  管线: fast (change → dev → review)`);
  console.log(`  当前阶段: dev`);
  console.log(`  阶段 prompt: phases/F-fast.md`);
  console.log(`\n完成后运行 gantry next 进入 review`);
}

/**
 * gantry scan — 情报扫描
 */
function scan(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);
  updateState(projectRoot, { activeAgent: 'researcher' });
  console.log(`情报扫描 (I-intel-scan)`);
  console.log(`  阶段 prompt: phases/I-intel-scan.md`);
  console.log(`  产出: CONTEXT.md (项目规则层)`);
  console.log(`\n此为横向命令，不影响当前管线进度。`);
}

/**
 * gantry health — 健康检查
 */
function health(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);
  updateState(projectRoot, { activeAgent: 'curator' });
  console.log(`健康检查 (M-health)`);
  console.log(`  阶段 prompt: phases/M-health.md`);
  console.log(`  产出: HEALTH.md (技术债务诊断)`);
  console.log(`\n此为横向命令，不影响当前管线进度。`);
}

/**
 * gantry architect — 架构阶段
 */
function architect(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);
  updateState(projectRoot, { activeAgent: 'architect' });
  console.log(`架构阶段 (A-architect)`);
  console.log(`  阶段 prompt: phases/A-architect.md`);
  console.log(`  产出: ARCHITECTURE.md (项目架构)`);
  console.log(`\n此为横向命令，不影响当前管线进度。`);
}

/**
 * gantry knowledge — 知识捕获
 */
function knowledge(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);
  const topic = args.filter(a => !a.startsWith('--')).join(' ') || '(未指定)';
  updateState(projectRoot, { activeAgent: 'researcher' });
  console.log(`知识捕获 (K-knowledge)`);
  console.log(`  主题: ${topic}`);
  console.log(`  阶段 prompt: phases/K-knowledge.md`);
  console.log(`  产出: knowledge/<topic>.md`);
  console.log(`\n此为横向命令，不影响当前管线进度。`);
}

/**
 * gantry check-req — 产品需求门禁
 */
function checkReq(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);
  const target = args.filter(a => !a.startsWith('--'))[0];
  const state = readState(projectRoot);
  const file = target || (state.activeChange ? `.specs/${state.activeChange}/CHANGE.md` : null);
  updateState(projectRoot, { activeAgent: 'reviewer' });
  console.log(`产品需求门禁 (check-req)`);
  if (file) console.log(`  目标文件: ${file}`);
  console.log(`  skill prompt: commands/check-req.md`);
  console.log(`  产出: 六维产品门禁报告 (PASS / COND / FAIL)`);
  console.log(`\n在 IDE 中运行 /gantry:check-req 执行完整门禁检查。`);
}

/**
 * gantry debug — 系统化调试（四阶段协议）
 */
function debug(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);
  const symptom = args.filter(a => !a.startsWith('--')).join(' ') || '(未指定症状)';
  updateState(projectRoot, { activeAgent: 'executor' });
  console.log(`系统化调试 (debug)`);
  console.log(`  症状: ${symptom}`);
  console.log(`  skill prompt: commands/debug.md`);
  console.log(`  协议: 四阶段（调查 → 假设 → 修复 → 验证）`);
  console.log(`\n在 IDE 中运行 /gantry:debug 执行完整调试协议。`);
}

/**
 * gantry doubt — 对抗性审查
 */
function doubt(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);
  updateState(projectRoot, { activeAgent: 'reviewer' });
  console.log(`对抗性审查 (doubt)`);
  console.log(`  skill prompt: commands/doubt.md`);
  console.log(`  协议: 最多 3 轮，禁止修复方在调查阶段给结论`);
  console.log(`\n在 IDE 中运行 /gantry:doubt 触发对抗性审查。`);
}

/**
 * gantry finish — 完成分支（验证 + git 工作流）
 */
function finish(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);
  const mode = args.includes('--pr') ? 'PR' : args.includes('--merge') ? 'merge' : '(自动检测)';
  updateState(projectRoot, { activeAgent: 'integrator' });
  console.log(`完成分支 (finish)`);
  console.log(`  模式: ${mode}`);
  console.log(`  skill prompt: commands/finish.md`);
  console.log(`  步骤: 验证 → 检测环境 → merge / PR / cleanup`);
  console.log(`\n在 IDE 中运行 /gantry:finish 执行完整 git 工作流。`);
}

/**
 * gantry curator — 知识库维护 + 团队健康巡检
 */
function curator(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);
  const quarterly = args.includes('--quarterly');
  const solo = args.includes('--solo');
  updateState(projectRoot, { activeAgent: 'curator' });
  const mode = quarterly ? '季度深度 review' : solo ? 'Solo 月度' : '月度标准';
  console.log(`知识库维护 + 团队健康巡检 (curator)`);
  console.log(`  模式: ${mode}`);
  console.log(`  skill prompt: commands/curator.md`);
  console.log(`  完整协议: phases/C-curator.md`);
  console.log(`\n步骤:`);
  console.log(`  1. gantry metrics --since "1 month ago"`);
  console.log(`  2. 整理 .specs/LESSONS.md（合入待审 / 状态迁移）`);
  console.log(`  3. 整理 .specs/knowledge/*.md（状态升级 / 过期检测）`);
  if (!solo) console.log(`  4. fast: 占比跟进（> 35% 时诊断）`);
  console.log(`  ${solo ? '4' : '5'}. CONTEXT / CONVENTIONS 同步检查`);
  if (quarterly) {
    console.log(`  6. [季度] CONVENTIONS 漂移检测`);
    console.log(`  7. [季度] 规则 retro（RULES.md R1~R8）`);
    console.log(`  8. [季度] LESSONS 全量健康检查`);
  }
  console.log(`\n在 IDE 中运行 /gantry:curator 执行完整巡检协议。`);
}

/**
 * gantry roadmap — 积压管理
 */
function roadmap(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);

  const subcommand = args[0] || 'list';
  const roadmapPath = join(projectRoot, PLANNING_DIR, 'ROADMAP.md');

  if (subcommand === 'list') {
    if (existsSync(roadmapPath)) {
      console.log(readFileSync(roadmapPath, 'utf-8'));
    } else {
      console.log('ROADMAP.md 不存在。运行 gantry init 初始化。');
    }
  } else if (subcommand === 'add') {
    const desc = args.slice(1).join(' ');
    if (!desc) {
      console.error('用法: gantry roadmap add "<变更描述>"');
      process.exit(1);
    }
    // 追加到 ROADMAP.md 积压队列
    if (existsSync(roadmapPath)) {
      let content = readFileSync(roadmapPath, 'utf-8');
      const row = `| P3 | ${slugify(desc)} | backlog | — |\n`;
      content = content.replace(/(## 积压队列\n\n\|[^\n]+\n\|[^\n]+\n)/, `$1${row}`);
      writeFileSync(roadmapPath, content, 'utf-8');
      console.log(`✓ 已添加到积压: ${desc}`);
    }
  } else {
    console.log(`未知子命令: ${subcommand}。可用: list, add, prioritize`);
  }
}

/**
 * gantry checkpoint — Checkpoint 管理
 */
function checkpoint(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);

  const subcommand = args[0] || 'list';

  if (subcommand === 'list') {
    const all = listCheckpoints(projectRoot);
    if (all.length === 0) {
      console.log('无 checkpoint 记录。');
      return;
    }
    console.log('Checkpoints:');
    for (const cp of all) {
      const icon = cp.status === 'pending' ? '○' : '●';
      console.log(`  ${icon} [${cp.id}] ${cp.stage} — ${cp.type} (${cp.status})`);
    }
  } else if (subcommand === 'resolve') {
    const id = args[1];
    if (!id) {
      console.error('用法: gantry checkpoint resolve <id>');
      process.exit(1);
    }
    const result = resolveCheckpoint(projectRoot, id, 'manually resolved');
    if (result.error) {
      console.error(result.error);
      process.exit(1);
    }
    console.log(`✓ Checkpoint ${id} 已解决`);
  } else {
    console.log(`未知子命令: ${subcommand}。可用: list, resolve`);
  }
}

/**
 * gantry gate <taskId> [--force] [--pipeline light|standard|full]
 */
function gate(args) {
  const taskId = args.find(a => !a.startsWith('--'));
  if (!taskId) {
    console.error('用法: gantry gate <taskId> [--force] [--pipeline light|standard|full]');
    process.exit(1);
  }

  const force = args.includes('--force');
  const pipelineIdx = args.indexOf('--pipeline');
  const pipeline = pipelineIdx >= 0 ? args[pipelineIdx + 1] : 'standard';

  const projectRoot = process.cwd();
  const state = readState(projectRoot);
  if (!state || !state.activeChange) {
    console.error('错误: 未找到活跃变更。请先运行 gantry change');
    process.exit(1);
  }

  const specsDir = join(projectRoot, '.specs', state.activeChange);
  const taskMdPath = join(specsDir, 'TASK.md');

  // Get actual changed files from git
  let actualFiles = [];
  try {
    const diff = execSync('git diff --name-only HEAD', { encoding: 'utf-8' }).trim();
    if (diff) actualFiles = diff.split('\n');
  } catch {
    // git not available or not in repo — skip scope check
  }

  const result = runGate(taskId, specsDir, { force, pipeline, actualFiles });

  // Output
  console.log(`\n┌─ Gate Result ─────────────────────────`);
  console.log(`│ Task:     ${taskId}`);
  console.log(`│ Pipeline: ${pipeline}`);
  console.log(`│ Status:   ${result.passed ? '✓ PASSED' : '✗ FAILED'}${result.forced ? ' (FORCED)' : ''}`);
  console.log(`│ Time:     ${result.timestamp}`);

  for (const check of result.checks) {
    const icon = check.passed ? '✓' : '✗';
    console.log(`│ ${icon} ${check.gate}`);
    if (check.issues) {
      for (const issue of check.issues) {
        console.log(`│   → ${issue}`);
      }
    }
    if (check.violations && check.violations.length > 0) {
      for (const v of check.violations) {
        console.log(`│   → out of scope: ${v}`);
      }
    }
  }
  console.log(`└────────────────────────────────────────\n`);

  // Write result to TASK.md
  if (existsSync(taskMdPath)) {
    writeGateResult(taskMdPath, taskId, result);
  }

  process.exit(result.passed ? 0 : 1);
}

/**
 * gantry route "<intent>" — 智能路由
 */
function route(args) {
  const intent = args.join(' ');
  if (!intent) {
    console.error('用法: gantry route "<intent description>"');
    process.exit(1);
  }

  const projectRoot = process.cwd();
  const decision = routeIntent(intent, { projectRoot });

  console.log(`\n┌─ Route Decision ──────────────────────────`);
  console.log(`│ Intent:    ${intent}`);
  console.log(`│ Scale:     ${decision.scale}`);
  console.log(`│ Pipeline:  ${decision.pipeline}`);
  console.log(`│ Model:     ${decision.model}`);
  console.log(`│ Parallel:  ${decision.parallel ? 'yes' : 'no'}`);
  console.log(`│ Stages:    ${decision.stages.join(' → ')}`);
  console.log(`│ Rationale: ${decision.rationale}`);
  console.log(`└────────────────────────────────────────────\n`);
}

/**
 * gantry snapshot <task-id> [--step "desc"] [--next "desc"] [--interrupt --reason "desc"]
 */
function snapshot(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);

  const taskId = args.find(a => !a.startsWith('--'));
  if (!taskId) {
    console.error('用法: gantry snapshot <task-id> [--step "done"] [--next "todo"] [--interrupt --reason "why"]');
    process.exit(1);
  }

  const state = readState(projectRoot);
  const changeId = state.activeChange;
  if (!changeId) {
    console.error('无活跃 change，无法记录快照。');
    process.exit(1);
  }

  const isInterrupt = args.includes('--interrupt');
  const step = getFlag(args, '--step');
  const next = getFlag(args, '--next');
  const reason = getFlag(args, '--reason');

  const snapshotsDir = join(projectRoot, PLANNING_DIR, 'snapshots');
  if (!existsSync(snapshotsDir)) mkdirSync(snapshotsDir, { recursive: true });

  const snapshotFile = join(snapshotsDir, `${changeId}-${taskId}.json`);
  const existing = existsSync(snapshotFile)
    ? JSON.parse(readFileSync(snapshotFile, 'utf-8'))
    : { taskId, changeId, completedSteps: [], currentStep: null, modifiedFiles: [], createdAt: new Date().toISOString() };

  if (step) {
    if (!existing.completedSteps.includes(step)) {
      existing.completedSteps.push(step);
    }
  }
  if (next) {
    existing.currentStep = next;
  }

  // 记录 git 修改文件
  try {
    const diff = execSync('git diff --name-only HEAD', { encoding: 'utf-8', cwd: projectRoot }).trim();
    if (diff) existing.modifiedFiles = [...new Set([...existing.modifiedFiles, ...diff.split('\n')])];
  } catch { /* not a git repo or no changes */ }

  try {
    existing.gitRef = execSync('git rev-parse --short HEAD', { encoding: 'utf-8', cwd: projectRoot }).trim();
  } catch { /* ignore */ }

  existing.updatedAt = new Date().toISOString();

  if (isInterrupt) {
    existing.interrupted = true;
    existing.interruptReason = reason || 'session ended';
  }

  writeFileSync(snapshotFile, JSON.stringify(existing, null, 2), 'utf-8');

  // 同步更新 STATE.md
  updateState(projectRoot, { currentTask: taskId });

  if (isInterrupt) {
    console.log(`⏸ 快照已记录（中断）: ${changeId}/${taskId}`);
    console.log(`  原因: ${existing.interruptReason}`);
  } else {
    console.log(`✓ 快照已记录: ${changeId}/${taskId}`);
    if (step) console.log(`  完成: ${step}`);
    if (next) console.log(`  下一步: ${next}`);
  }
  console.log(`  文件: ${snapshotFile}`);
}

/**
 * gantry install [target] [--tool T] [--init]
 */
async function install(args) {
  const target = resolve(args.find(a => !a.startsWith('--')) || process.cwd());
  const requestedTool = getFlag(args, '--tool') || detectTool(target) || 'claude';
  const installTool = normalizeInstallTool(requestedTool);
  const doInit = args.includes('--init');

  const validTools = ['claude', 'cursor', 'codex', 'copilot'];
  if (!installTool) {
    console.error(`未知工具: ${requestedTool}\n可用: ${validTools.join(', ')}`);
    process.exit(1);
  }

  const { loadCore, loadCommands, loadAgents } = await import('../tools/lib/loader.mjs');
  const core = loadCore(GANTRY_ROOT);
  const cmds = loadCommands(join(GANTRY_ROOT, 'skills'));
  const agents = loadAgents(join(GANTRY_ROOT, 'src', 'agents'));

  const renderer = await import(`../tools/renderers/${installTool.renderer}.mjs`);
  const files = renderer.render(core, cmds, agents);

  let count = 0;
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(target, relPath);
    mkdirSync(dirname(full), { recursive: true });
    if (SECTION_FILES.includes(relPath)) {
      injectSection(full, content);
    } else {
      const skipBanner = relPath.startsWith('.claude/agents/') || relPath.startsWith('agents/');
      const finalContent = skipBanner
        ? content
        : insertBanner(content, bannerFor(installTool.name, relPath, content));
      writeFileSync(full, finalContent);
    }
    count++;
  }

  console.log(`✓ gantry 已安装到 ${target}`);
  console.log(`  工具: ${installTool.name}`);
  console.log(`  文件: ${count} 个`);

  if (doInit) {
    const planningDir = join(target, PLANNING_DIR);
    if (!existsSync(planningDir)) {
      const savedCwd = process.cwd();
      process.chdir(target);
      init([]);
      process.chdir(savedCwd);
    } else {
      console.log(`  .planning/ 已存在，跳过初始化`);
    }
  }

  console.log(`\n卸载: gantry uninstall ${target === process.cwd() ? '' : target}`);
}

/**
 * gantry uninstall [target] [--all]
 */
function uninstall(args) {
  const target = resolve(args.find(a => !a.startsWith('--')) || process.cwd());
  const removeAll = args.includes('--all');

  const generated = findGeneratedFiles(target);

  let sectionCount = 0;
  for (const rel of SECTION_FILES) {
    const full = join(target, rel);
    if (removeSection(full)) sectionCount++;
  }

  if (generated.length === 0 && sectionCount === 0) {
    console.log('未找到 gantry 生成的文件。');
    if (removeAll) removePlanning(target);
    return;
  }

  for (const file of generated) {
    unlinkSync(file);
  }

  cleanEmptyDirs(target, [
    '.claude/commands',
    '.claude',
    '.cursor/rules',
    '.cursor',
    '.github/prompts',
    '.github',
  ]);
  cleanSkillDirs(target);

  console.log(`✓ 已卸载 gantry`);
  console.log(`  删除: ${generated.length} 个生成文件, ${sectionCount} 个注入段`);

  if (removeAll) {
    removePlanning(target);
  } else {
    const planningDir = join(target, PLANNING_DIR);
    if (existsSync(planningDir)) {
      console.log(`  保留: .planning/ (使用 --all 同时删除)`);
    }
  }
}

/**
 * gantry adjust "<发生了什么>" — 打开或追加当前 change 的 PATCH.md
 */
function adjust(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);

  const state = readState(projectRoot);
  if (!state.activeChange || state.currentStage === 'idle') {
    console.error('当前无活跃 change。运行 gantry change 开始。');
    process.exit(1);
  }

  const reason = args.filter(a => !a.startsWith('--')).join(' ');
  if (!reason) {
    console.error('用法: gantry adjust "<开发中发现的新情况>"');
    process.exit(1);
  }

  const specsDir = join(projectRoot, '.specs', state.activeChange);
  mkdirSync(specsDir, { recursive: true });

  const requiredItems = inferPatchItems(reason, state.currentStage);
  const patchResult = upsertPatch(specsDir, {
    changeId: state.activeChange,
    reason,
    startedFrom: state.currentStage,
    requiredItems,
  });

  const rewindStage = earliestStageForPatchItems(requiredItems);
  if (shouldRewindForPatch(state.currentStage, rewindStage)) {
    updateState(projectRoot, {
      currentStage: rewindStage,
      currentWave: null,
      currentTask: null,
      activeAgent: 'planner',
      retries: 0,
      pauseReason: null,
    });
  }

  console.log(`${patchResult.created ? '✓ 已创建 Patch' : '✓ 已追加 Patch'}`);
  console.log(`  Change: ${state.activeChange}`);
  console.log(`  记录: ${reason}`);
  console.log(`  必须更新: ${requiredItems.join(', ')}`);
  if (shouldRewindForPatch(state.currentStage, rewindStage)) {
    console.log(`  阶段回退: ${state.currentStage} → ${rewindStage}`);
  }
  console.log(`\n下一步: 更新 .specs/${state.activeChange}/PATCH.md 对应项，完成后勾选并 gantry next`);
}

/**
 * gantry revise — 兼容入口；持续修订主路径是 adjust/PATCH.md
 */
function revise(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);

  const positional = args.filter(a => !a.startsWith('--'));
  const state = readState(projectRoot);

  let changeId;
  let trigger;
  if (positional.length === 1) {
    if (!state.activeChange) {
      console.error('revise 已降级为 adjust 的兼容入口。');
      console.error('当前无活跃 change，请先 gantry change 或 gantry unarchive 后再 gantry adjust "<发生了什么>"');
      process.exit(1);
    }
    changeId = state.activeChange;
    trigger = positional[0];
  } else {
    changeId = positional[0];
    trigger = positional.slice(1).join(' ');
  }

  if (!changeId || !trigger) {
    console.error('用法: gantry revise [<当前活跃 change-id>] "<触发原因>"');
    console.error('  推荐使用: gantry adjust "<发生了什么>"');
    process.exit(1);
  }

  if (!state.activeChange || state.currentStage === 'idle') {
    console.error('revise 已降级为 adjust 的兼容入口。');
    console.error('当前无活跃 change，请先 gantry change 或 gantry unarchive 后再 gantry adjust "<发生了什么>"');
    process.exit(1);
  }

  if (state.activeChange !== changeId) {
    console.error(`revise 兼容入口只支持当前活跃 change: ${state.activeChange}`);
    console.error(`请对当前 change 使用: gantry adjust "${trigger}"`);
    process.exit(1);
  }

  console.log('revise 已兼容转为 adjust/PATCH.md 流程。');
  adjust([trigger]);
}

function inferPatchItems(reason, currentStage) {
  const text = reason.toLowerCase();
  const items = new Set();

  if (/(需求|产品|边界|验收|ac|用户可见|权限规则|状态流|异常口径|包含|不包含)/i.test(reason)) {
    addPatchCascade(items, 'REQUIREMENT.md');
  }
  if (/(设计|方案|技术|架构|性能|压测|不可行|异步|缓存|接口|数据模型|adr)/i.test(reason)) {
    addPatchCascade(items, 'DESIGN.md');
  }
  if (/(ui|交互|页面|视觉|按钮|弹窗|提示|布局|动效)/i.test(reason)) {
    addPatchCascade(items, 'UI-DESIGN.md');
  }
  if (/(任务|拆分|依赖|粒度|并行|冲突|task)/i.test(reason)) {
    addPatchCascade(items, 'TASK.md');
  }
  if (/(测试|覆盖|用例|回归|test|验证)/i.test(reason)) {
    items.add('TEST.md');
  }
  if (/(review|审查|复核)/i.test(reason)) {
    items.add('REVIEW.md');
  }

  if (items.size === 0) {
    addPatchCascade(items, PATCH_STAGE_ITEMS[currentStage] || 'DEV');
  }

  return [...items];
}

function addPatchCascade(items, startItem) {
  const cascades = {
    'REQUIREMENT.md': ['REQUIREMENT.md', 'TASK.md', 'DEV', 'TEST.md', 'UAT.md'],
    'DESIGN.md': ['DESIGN.md', 'TASK.md', 'DEV', 'TEST.md', 'REVIEW.md'],
    'UI-DESIGN.md': ['UI-DESIGN.md', 'TASK.md', 'DEV', 'TEST.md', 'UAT.md'],
    'TASK.md': ['TASK.md', 'DEV', 'TEST.md'],
    DEV: ['DEV', 'TEST.md'],
    'TEST.md': ['TEST.md'],
    'REVIEW.md': ['REVIEW.md'],
    'UAT.md': ['UAT.md'],
  };
  for (const item of cascades[startItem] || [startItem]) items.add(item);
}

function upsertPatch(specsDir, { changeId, reason, startedFrom, requiredItems }) {
  const path = join(specsDir, PATCH_FILE);
  const today = new Date().toISOString().slice(0, 10);

  if (!existsSync(path) || !isPatchOpen(readFileSync(path, 'utf-8'))) {
    writeFileSync(path, renderNewPatch({ changeId, reason, startedFrom, requiredItems, today }), 'utf-8');
    return { created: true };
  }

  const existing = readFileSync(path, 'utf-8');
  const withRecord = insertPatchRecord(existing, today, reason);
  const withItems = mergePatchItems(withRecord, requiredItems);
  writeFileSync(path, withItems, 'utf-8');
  return { created: false };
}

function renderNewPatch({ changeId, reason, startedFrom, requiredItems, today }) {
  const checklist = requiredItems.map(item => `- [ ] ${item}: 待更新`).join('\n');
  return `# PATCH — ${changeId}

## 状态

- status: open
- startedFrom: ${startedFrom}
- openedAt: ${today}

## 变更记录

- [${today}] ${reason}

## 必须更新

${checklist}

## 关闭条件

- [ ] 所有必须更新项已完成
- [ ] 所有新增/受影响 AC 有测试
- [ ] 所有废弃任务有 replacement 或 drop reason
- [ ] ship 前已复核
`;
}

function insertPatchRecord(content, today, reason) {
  const record = `- [${today}] ${reason}`;
  if (!content.includes('## 变更记录')) {
    return `${content.replace(/\n*$/, '\n\n')}## 变更记录\n\n${record}\n`;
  }
  return content.replace(/(## 变更记录\s*\n)([\s\S]*?)(?=\n## |\n?$)/, (_, header, body) => {
    const trimmed = body.trimEnd();
    return `${header}${trimmed ? `${trimmed}\n` : '\n'}${record}\n`;
  });
}

function mergePatchItems(content, requiredItems) {
  let updated = content;
  for (const item of requiredItems) {
    const escaped = escapeRegExp(item);
    if (new RegExp(`^- \\[[ xX]\\] ${escaped}:`, 'm').test(updated)) continue;
    updated = updated.replace(/(## 必须更新\s*\n)([\s\S]*?)(?=\n## |\n?$)/, (_, header, body) => {
      const trimmed = body.trimEnd();
      return `${header}${trimmed ? `${trimmed}\n` : '\n'}- [ ] ${item}: 待更新\n`;
    });
  }
  return updated;
}

function isPatchOpen(content) {
  return /^- status:\s*open\s*$/m.test(content);
}

function checkPatchStageGate(specsDir, currentStage) {
  const path = join(specsDir, PATCH_FILE);
  if (!existsSync(path)) return { passed: true };
  const content = readFileSync(path, 'utf-8');
  if (!isPatchOpen(content)) return { passed: true };

  const item = PATCH_STAGE_ITEMS[currentStage];
  if (!item || !hasPatchItem(content, item)) return { passed: true };
  if (isPatchItemChecked(content, item)) return { passed: true };
  return { passed: false, item, reason: `${item} 尚未关闭` };
}

function checkPatchClosure(specsDir) {
  const path = join(specsDir, PATCH_FILE);
  if (!existsSync(path)) return { passed: true, unchecked: [] };
  const content = readFileSync(path, 'utf-8');
  if (!isPatchOpen(content)) return { passed: true, unchecked: [] };

  const unchecked = content
    .split('\n')
    .filter(line => /^- \[ \] /.test(line));
  return { passed: unchecked.length === 0, unchecked };
}

function closePatchIfOpen(specsDir) {
  const path = join(specsDir, PATCH_FILE);
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf-8');
  if (!isPatchOpen(content)) return;
  writeFileSync(path, content.replace(/^- status:\s*open\s*$/m, '- status: closed'), 'utf-8');
}

function hasPatchItem(content, item) {
  return new RegExp(`^- \\[[ xX]\\] ${escapeRegExp(item)}:`, 'm').test(content);
}

function isPatchItemChecked(content, item) {
  return new RegExp(`^- \\[[xX]\\] ${escapeRegExp(item)}:`, 'm').test(content);
}

function earliestStageForPatchItems(items) {
  const itemStages = {
    'REQUIREMENT.md': 'requirement',
    'DESIGN.md': 'design',
    'UI-DESIGN.md': 'ui-design',
    'TASK.md': 'task',
    DEV: 'dev',
    'TEST.md': 'test',
    'REVIEW.md': 'review',
    'UAT.md': 'integration',
  };
  return items
    .map(item => itemStages[item])
    .filter(Boolean)
    .sort((a, b) => PATCH_STAGE_ORDER.indexOf(a) - PATCH_STAGE_ORDER.indexOf(b))[0] || 'dev';
}

function shouldRewindForPatch(currentStage, targetStage) {
  const currentIndex = PATCH_STAGE_ORDER.indexOf(currentStage);
  const targetIndex = PATCH_STAGE_ORDER.indexOf(targetStage);
  return currentIndex !== -1 && targetIndex !== -1 && targetIndex < currentIndex;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function archiveChange(projectRoot, changeId, { keepHistory = false, quiet = false } = {}) {
  const sourceDir = join(projectRoot, '.specs', changeId);
  if (!existsSync(sourceDir)) {
    throw new Error(`未找到 change 目录: ${sourceDir}`);
  }

  const archiveBase = join(projectRoot, '.specs', '_archive');
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
  const logLine = `- ${ts} — archived from .specs/${changeId}/\n`;
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
 * gantry archive <change-id> [--keep-history]
 * 归档维护命令
 */
function archive(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);

  const changeId = args.find(a => !a.startsWith('--'));
  if (!changeId) {
    console.error('用法: gantry archive <change-id> [--keep-history]');
    process.exit(1);
  }

  const keepHistory = args.includes('--keep-history');
  const state = readState(projectRoot);

  if (state.activeChange === changeId) {
    console.error(`不能归档活跃 change：${changeId}（先 gantry ship）`);
    process.exit(1);
  }

  let result;
  try {
    result = archiveChange(projectRoot, changeId, { keepHistory });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  console.log(`✓ 已归档: ${changeId} → .specs/_archive/${result.archiveName}/`);
  console.log(`  恢复: gantry unarchive ${changeId}`);
}

/**
 * gantry unarchive <change-id> [--from <archive-name>]
 * 把归档的 change 恢复到 .specs/<change-id>/，不切状态
 */
function unarchive(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);

  const changeId = args.find(a => !a.startsWith('--'));
  if (!changeId) {
    console.error('用法: gantry unarchive <change-id> [--from <archive-name>]');
    process.exit(1);
  }

  const fromName = getFlag(args, '--from') || changeId;
  const sourceDir = join(projectRoot, '.specs', '_archive', fromName);
  const targetDir = join(projectRoot, '.specs', changeId);

  if (!existsSync(sourceDir)) {
    console.error(`未找到归档: ${sourceDir}`);
    console.error('提示: 用 ls .specs/_archive/ 查看可用归档');
    process.exit(1);
  }
  if (existsSync(targetDir)) {
    console.error(`目标已存在: ${targetDir}（请先备份或删除）`);
    process.exit(1);
  }

  cpSync(sourceDir, targetDir, { recursive: true });
  console.log(`✓ 已恢复: _archive/${fromName} → .specs/${changeId}/`);
  console.log(`  注：未切换 STATE。需要继续工作请运行 gantry adjust 或手动调整 STATE。`);
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

阶段命令:
  init              初始化 .planning/ 目录
  status            查看当前状态
  change            开始新变更
  next              推进到下一阶段
  exec              执行任务（dev 阶段）
  verify            验证任务
  review            进入 review 阶段
  ship              收尾并归档

自主模式:
  auto              自主推进多个阶段
  fast              快速闭环（<50 行）
  resume            从中断点恢复

横向命令:
  scan              入场扫描
  health            代码库健康巡检
  architect         建立 ARCHITECTURE.md
  knowledge         知识沉淀
  curator           知识库维护

变更管理:
  adjust            调整当前变更
  revise            修订工件
  archive           归档变更
  unarchive         恢复归档
  checkpoint        管理 checkpoint
  snapshot          快照当前状态

Hook 管理:
  hook run <event>  运行指定 hook（如 before:dev / after:test）
  hook list         列出所有已配置 hook

其他:
  install           安装到项目
  uninstall         卸载
  roadmap           查看路线图
  gate              检查阶段门禁
  route             路由意图
  debug             调试模式
  doubt             疑问模式
  finish            收尾任务
  check-req         检查需求
  version           显示版本号
  help              显示本帮助

详情: gantry <command> --help`);
}

// --- install/uninstall 辅助 ---

function detectTool(dir) {
  if (existsSync(join(dir, '.cursor'))) return 'cursor';
  if (existsSync(join(dir, '.github', 'copilot-instructions.md'))) return 'copilot';
  if (existsSync(join(dir, 'AGENTS.md'))) return 'codex';
  if (existsSync(join(dir, 'CLAUDE.md')) || existsSync(join(dir, '.claude'))) return 'claude';
  return null;
}

function normalizeInstallTool(tool) {
  if (tool === 'claude') return { name: 'claude', renderer: 'claude-code' };
  if (tool === 'claude-code') return { name: 'claude', renderer: 'claude-code' };
  if (['cursor', 'codex', 'copilot'].includes(tool)) return { name: tool, renderer: tool };
  return null;
}

function findGeneratedFiles(dir) {
  const found = [];
  for (const rel of SCAN_PATTERNS) {
    const full = join(dir, rel);
    if (existsSync(full) && isGenerated(full)) {
      found.push(full);
    }
  }
  for (const [subdir, ext] of SCAN_DIRS) {
    const abs = join(dir, subdir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      if (!name.endsWith(ext)) continue;
      const full = join(abs, name);
      if (isGenerated(full)) found.push(full);
    }
  }
  for (const subdir of SKILL_DIRS) {
    const abs = join(dir, subdir);
    if (!existsSync(abs)) continue;
    for (const skillName of readdirSync(abs)) {
      const skillFile = join(abs, skillName, 'SKILL.md');
      if (existsSync(skillFile) && isGenerated(skillFile)) found.push(skillFile);
    }
  }
  return found;
}

function isGenerated(filePath) {
  try {
    const fd = readFileSync(filePath, 'utf8');
    return fd.slice(0, 1024).includes('GENERATED by gantry');
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
  for (const subdir of SKILL_DIRS) {
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
  cleanEmptyDirs(base, ['.agents/skills', '.agents']);
}

function removePlanning(target) {
  const planningDir = join(target, PLANNING_DIR);
  if (existsSync(planningDir)) {
    rmSync(planningDir, { recursive: true, force: true });
    console.log(`  删除: .planning/`);
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

function printTaskExec(task, specsDir) {
  const { tier, reason } = selectModel(task, { stage: 'dev' });
  const modelId = resolveModelId(tier, 'claude-code');

  console.log(`┌─ 执行任务 ─────────────────────────`);
  console.log(`│ ID:    ${task.id}`);
  console.log(`│ 标题:  ${task.title}`);
  console.log(`│ 模型:  ${tier} (${modelId}) — ${reason}`);
  console.log(`│ 并行:  ${task.parallel ? '是 [P]' : '否'}`);
  if (task.depends.length > 0) {
    console.log(`│ 依赖:  ${task.depends.join(', ')}`);
  }
  if (task.readFiles.length > 0) {
    console.log(`│ 读取:  ${task.readFiles.join(', ')}`);
  }
  if (task.writeFiles.length > 0) {
    console.log(`│ 写入:  ${task.writeFiles.join(', ')}`);
  }
  if (task.verify) {
    console.log(`│ 验证:  ${task.verify}`);
  }
  console.log(`└──────────────────────────────────────`);
  console.log(`\n阶段 prompt: phases/4-dev.md`);
  console.log(`产出: .specs/.../${task.id}-SUMMARY.md`);
}

/**
 * gantry hook — 管理和运行阶段 hook
 */
async function hook(args) {
  const projectRoot = process.cwd();
  ensureInit(projectRoot);
  const config = readConfig(projectRoot);
  const sub = args[0];

  if (sub === 'list') {
    const hooks = listHooks(config);
    const entries = Object.entries(hooks);
    if (entries.length === 0) {
      console.log('未配置任何 hook。在 .planning/config.json 的 "hooks" 字段中添加。');
      return;
    }
    console.log('已配置 hooks:');
    for (const [event, def] of entries) {
      const cmd = typeof def === 'string' ? def : def.cmd;
      console.log(`  ${event.padEnd(22)} ${cmd}`);
    }
    return;
  }

  if (sub === 'run') {
    const event = args[1];
    if (!event) {
      console.error('用法: gantry hook run <event>  例: gantry hook run before:dev');
      process.exit(1);
    }
    const result = await runHook(config, event, projectRoot);
    if (!result.ok && !result.skipped) process.exit(1);
    return;
  }

  console.error('用法: gantry hook run <event> | gantry hook list');
  process.exit(1);
}

function ensureInit(projectRoot) {
  if (!existsSync(join(projectRoot, PLANNING_DIR))) {
    console.error('项目未初始化。运行 gantry init 开始。');
    process.exit(1);
  }
}

function readConfig(projectRoot) {
  const globalPath = join(homedir(), '.gantry', 'config.json');
  const projectPath = join(projectRoot, PLANNING_DIR, 'config.json');
  const global = existsSync(globalPath) ? JSON.parse(readFileSync(globalPath, 'utf-8')) : {};
  const project = existsSync(projectPath) ? JSON.parse(readFileSync(projectPath, 'utf-8')) : {};
  return deepMerge(global, project);
}

function deepMerge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (override[key] && typeof override[key] === 'object' && !Array.isArray(override[key])
        && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      result[key] = deepMerge(base[key], override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

function getFlag(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  return args[idx + 1] || null;
}

function notify(title, message) {
  try {
    if (process.platform === 'darwin') {
      execSync(`osascript -e 'display notification "${message}" with title "${title}"'`);
    } else if (process.platform === 'linux') {
      execSync(`notify-send "${title}" "${message}"`);
    }
  } catch { /* notification is best-effort */ }
  process.stdout.write('\x07'); // terminal bell fallback
}

function printLifecycleReport(projectRoot, changeId) {
  const timeline = readTimeline(projectRoot);
  if (timeline.length === 0) return;

  const transitions = timeline.filter(e => e.type === 'transition');
  const phases = {};
  for (let i = 0; i < transitions.length; i++) {
    const t = transitions[i];
    const next = transitions[i + 1];
    const duration = next ? new Date(next.ts) - new Date(t.ts) : 0;
    if (!phases[t.to]) phases[t.to] = { count: 0, totalMs: 0 };
    phases[t.to].count++;
    phases[t.to].totalMs += duration;
  }

  // 快照和重试统计
  const snapshotsDir = join(projectRoot, PLANNING_DIR, 'snapshots');
  let snapshotCount = 0;
  if (existsSync(snapshotsDir)) {
    snapshotCount = readdirSync(snapshotsDir).filter(f => f.startsWith(changeId)).length;
  }

  const totalMs = transitions.length >= 2
    ? new Date(transitions[transitions.length - 1].ts) - new Date(transitions[0].ts)
    : 0;

  console.log(`\n┌─ 生命周期报告 ─────────────────────`);
  console.log(`│ Change: ${changeId}`);
  console.log(`│ 总耗时: ${formatDuration(totalMs)}`);
  console.log(`│ 阶段转换: ${transitions.length} 次`);
  console.log(`│ 快照记录: ${snapshotCount} 次`);
  console.log(`│`);
  console.log(`│ 各阶段耗时:`);
  for (const [phase, stats] of Object.entries(phases)) {
    console.log(`│   ${phase.padEnd(14)} ${formatDuration(stats.totalMs)}${stats.count > 1 ? ` (${stats.count}次)` : ''}`);
  }
  console.log(`│`);
  console.log(`│ 💡 经验提炼:`);
  console.log(`│   运行 /gantry:knowledge 将本次经验沉淀到 LESSONS.md`);
  console.log(`└──────────────────────────────────────`);
}

function formatDuration(ms) {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w一-鿿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
