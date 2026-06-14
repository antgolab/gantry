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
import { readState, writeState, updateState } from './lib/state.mjs';
import { STAGES, getNextStage } from './lib/phases.mjs';
import { PLANNING_DIR, SPECS_DIR, specsPath } from './lib/paths.mjs';

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
  init, status, change, install, uninstall, archive, unarchive, version,
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
      console.log(`\n下一阶段: ${next}`);
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

  const description = args.filter(a => !a.startsWith('--')).join(' ');
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

  // 生成 change-id
  const changeId = slugify(description);
  const specsDir = join(projectRoot, SPECS_DIR, changeId);
  mkdirSync(specsDir, { recursive: true });

  // 更新状态
  updateState(projectRoot, {
    activeChange: changeId,
    currentStage: 'change',
    activeAgent: 'planner',
  });

  console.log(`✓ 变更已创建: ${changeId}`);
  console.log(`  工件目录: ${specsPath(changeId)}/`);
  console.log(`  当前阶段: change (变更提案)`);
  console.log(`\n请执行阶段 0 (CHANGE):`);
  console.log(`  加载 phases/0-change.md 并产出 ${specsPath(changeId, 'CHANGE.md')}`);
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

命令:
  init                初始化 .gantry/planning/ 目录
    --tool <T>          IDE 工具: claude|cursor|codex|copilot|all（默认 all）
    --pipeline <P>      管线深度: full|standard|light（默认 full）

  status              查看当前状态
    --json              输出 JSON 格式

  change "<描述>"     开始新变更（从描述生成 change-id）

  archive             收尾并归档当前 change（仅 integration 阶段可用）
    --force             跳过阶段检查强制收尾
    --keep-history      保留旧归档，新归档加版本后缀

  unarchive <id>      从归档恢复并重新激活 change
    --from <name>       指定归档版本名（默认同 change-id）

  install             安装 gantry 到当前项目
    --tool <T>          claude|cursor|codex|copilot（默认自动检测）
    --init              同时初始化 .gantry/planning/
    -g, --global        安装到各工具全局目录（默认安装全部工具）

  uninstall           卸载 gantry 生成的文件
    --tool <T>          claude|cursor|codex|copilot|all（配合 -g 使用）
    -g, --global        从各工具全局目录卸载
    --all               同时删除 .gantry/planning/ 目录

  version             显示版本号
  help                显示本帮助

详情: gantry <command> --help`);
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





function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w一-鿿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
