/**
 * context-pack.mjs — Kernel ↔ AI client 通信契约
 *
 * 生成 .gantry/planning/context-pack.json,封装当前阶段所需的:
 *   - 加载顺序 (loadOrder)
 *   - 子检查触发器 (checklists)
 *   - LESSONS 命中条目
 *   - 重试历史
 *   - next 命令建议
 *
 * Schema 见 .gantry/specs/CONTEXT-PACK-SCHEMA.md。
 *
 * 核心原则:所有字段必须从确定性输入(state + 文件系统 + task 元数据)派生,
 * 禁止注入需要 AI 推理的字段。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PLANNING_DIR, SPECS_DIR, PHASES_DIR } from './paths.mjs';
import { readState } from './state.mjs';
import { parseTasks } from './tasks.mjs';
import { PIPELINES, PHASE_FILES, countOpenQuestions } from './phases.mjs';
import { getPreferredArtifactName, resolveArtifactPath } from './artifacts.mjs';
import { readConfig } from './config.mjs';

const SCHEMA_VERSION = 2;
const PACK_FILENAME = 'context-pack.json';

// === UI / Schema / Breaking-change 触发关键词 (机械化判定) ===
const UI_FILE_EXT = /\.(css|scss|sass|less|tsx|jsx|vue|svelte|html|astro)$/i;
const UI_KEYWORDS = ['button', '颜色', '字体', '卡片', '布局', '动画', '主题', 'theme', 'color', 'font', 'layout', 'animation', 'icon', 'modal', 'dialog'];
const SCHEMA_FILE_RE = /(models\/.*\.(py|ts|js)|.*Model\.(ts|js)|entity\/.*\.(java|ts)|.*\.entity\.(ts|js)|schema\.prisma|.*\.gorm\.go|migrations\/|db\/migrate\/|alembic\/|prisma\/migrations\/|.*\.sql$)/i;
const SCHEMA_KEYWORDS = ['新增表', '加字段', '改字段', '加索引', '加外键', '重命名表', '重命名列', '删表', '删列', 'add table', 'add column', 'alter column', 'add index', 'foreign key', 'rename table', 'rename column', 'drop table', 'drop column', 'migrate', 'migration'];
const BREAKING_KEYWORDS = ['删除', '删掉', '移除', 'delete', 'remove', 'rename', '重命名', '改签名', '改 api', 'breaking', 'public api', '导出'];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 关键词命中判定（止血 v2 缺陷一：子串误判）。
 * - 纯 ASCII 关键词(font/icon/public api…)用词边界匹配，避免 "confront"→font、"iconic"→icon 这类误报。
 * - 含中文的关键词(颜色/改 api…)用 includes——中文无词边界概念，\b 在中日韩字符间不生效。
 */
function matchesKeyword(text, keyword) {
  const lower = text.toLowerCase();
  const kw = keyword.toLowerCase();
  if (/[^\x00-\x7f]/.test(kw)) {
    return lower.includes(kw); // 含非 ASCII（中文）→ 子串匹配
  }
  return new RegExp(`\\b${escapeRegExp(kw)}\\b`).test(lower); // 纯 ASCII → 词边界
}

/**
 * 按关键词表把一段 action 文本分类为 UI / schema / breaking。
 * 导出供语料回归测试驱动——锁定"典型正例必中 + 已知误报不复发"，
 * 防止关键词表被后续改动悄悄退化。仅覆盖关键词维度（不含 write_files 后缀判定）。
 */
export function classifyAction(action = '') {
  return {
    ui: UI_KEYWORDS.some(k => matchesKeyword(action, k)),
    schema: SCHEMA_KEYWORDS.some(k => matchesKeyword(action, k)),
    breaking: BREAKING_KEYWORDS.some(k => matchesKeyword(action, k)),
  };
}

/**
 * 主入口:计算并写入 context-pack.json
 * @param {string} projectRoot
 * @param {object} [overrides] - 可覆盖的字段(如 taskId)
 * @returns {object} 已写入的 pack 对象
 */
export function writeContextPack(projectRoot, overrides = {}) {
  const pack = buildPack(projectRoot, overrides);
  const dir = join(projectRoot, PLANNING_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, PACK_FILENAME);
  writeFileSync(path, JSON.stringify(pack, null, 2) + '\n', 'utf-8');
  return pack;
}

/**
 * 读取 context-pack.json (供测试 / debug 使用)
 */
export function readContextPack(projectRoot) {
  const path = join(projectRoot, PLANNING_DIR, PACK_FILENAME);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * 构造 pack 对象 (纯函数,不写盘)
 * @param {string} projectRoot
 * @param {object} overrides
 */
export function buildPack(projectRoot, overrides = {}) {
  const state = readState(projectRoot);
  const config = readConfig(projectRoot);
  const stage = overrides.stage || state.currentStage;
  const changeId = overrides.changeId || state.activeChange;
  const taskId = overrides.taskId !== undefined ? overrides.taskId : state.currentTask;
  const pipeline = overrides.pipeline || state.pipeline || 'full';

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    stage,
    changeId,
    pipeline,
    taskId,
    loadOrder: buildLoadOrder({ projectRoot, stage, changeId, taskId, pipeline, config }),
    checklists: buildChecklists({ projectRoot, stage, changeId, taskId }),
    lessons: stage === 'dev' ? grepLessons(projectRoot, taskId) : [],
    retryHistory: {
      count: state.retries || 0,
      lastFailure: state.pauseReason
        ? { at: null, reason: state.pauseReason }
        : null,
    },
    next: buildNextCommands(stage, taskId),
  };
}

// === loadOrder ===

function buildLoadOrder({ projectRoot, stage, changeId, taskId, pipeline, config }) {
  const items = [];
  const phaseFile = PHASE_FILES[stage];

  // 1. 主指令 phase prompt
  if (phaseFile) {
    items.push({
      path: `${PHASES_DIR}/${phaseFile}`,
      kind: 'phase-prompt',
      required: true,
    });
  }

  // 2. 上下文文档 (ai_context_doc 配置)
  const aiContextDoc = config?.ai_context_doc;
  if (aiContextDoc && aiContextDoc !== 'none') {
    const ctxPath = aiContextDoc === 'CONTEXT.md'
      ? `${SPECS_DIR}/CONTEXT.md`
      : aiContextDoc;
    if (existsSync(join(projectRoot, ctxPath))) {
      items.push({ path: ctxPath, kind: 'context-doc', required: false });
    } else {
      // fallback: AGENTS.md 或 CLAUDE.md 不存在时退到 CONTEXT.md
      const fallback = `${SPECS_DIR}/CONTEXT.md`;
      if (existsSync(join(projectRoot, fallback))) {
        items.push({ path: fallback, kind: 'context-doc', required: false, fallbackFor: ctxPath });
      }
    }
  } else if (aiContextDoc === undefined) {
    const ctxPath = `${SPECS_DIR}/CONTEXT.md`;
    if (existsSync(join(projectRoot, ctxPath))) {
      items.push({ path: ctxPath, kind: 'context-doc', required: false });
    }
  }

  // 3. 当前 change 的所有上游工件 (按 pipeline 截断)
  if (changeId && stage !== 'idle') {
    const upstreamArtifacts = getUpstreamArtifacts(stage, pipeline);
    for (const artifact of upstreamArtifacts) {
      const resolved = resolveArtifactPath(join(projectRoot, SPECS_DIR, changeId), artifact);
      if (resolved && existsSync(resolved.path)) {
        const path = `${SPECS_DIR}/${changeId}/${resolved.name}`;
        const item = { path, kind: 'artifact', required: true };
        // dev 阶段 DESIGN.md 指定 focus 段落
        if (stage === 'dev' && resolved.name === 'DESIGN.md') {
          item.focus = ['## 0. 技术栈选定', '## 0.5 既有架构对齐'];
        }
        items.push(item);
      }
    }
  }

  // 4. 中断恢复上下文
  if (changeId && taskId && stage === 'dev') {
    const progressPath = `${SPECS_DIR}/${changeId}/${taskId}-PROGRESS.md`;
    if (existsSync(join(projectRoot, progressPath))) {
      items.push({
        path: progressPath,
        kind: 'progress',
        required: true,
        focus: ['## 已排除的方案（反重复关键）', '## 当前正在做（清窗那一刻的状态）'],
      });
    }
  }

  // 5. LESSONS.md (dev 阶段必读)
  if (stage === 'dev') {
    const lessonsPath = `${SPECS_DIR}/LESSONS.md`;
    if (existsSync(join(projectRoot, lessonsPath))) {
      items.push({ path: lessonsPath, kind: 'lessons', required: false });
    }
  }

  return items;
}

/**
 * 根据当前阶段和 pipeline,返回应该已存在的所有上游工件
 */
function getUpstreamArtifacts(stage, pipeline) {
  const stageArtifact = {
    change:       'proposal',
    requirement:  'spec',
    design:       'design',
    'ui-design':  'ui-design',
    task:         'tasks',
    dev:          null, // dev 不产新主工件,SUMMARY 是 per-task
    test:         'test',
    review:       'review',
    integration:  null,
  };

  const pipelineStages = PIPELINES[pipeline] || PIPELINES.full;
  const idx = pipelineStages.indexOf(stage);
  if (idx <= 0) return [];

  const upstream = [];
  for (let i = 0; i < idx; i++) {
    const a = stageArtifact[pipelineStages[i]];
    if (a) upstream.push(a);
  }
  return upstream;
}

// === checklists ===

function buildChecklists(ctx) {
  return withConfidence(buildChecklistsRaw(ctx));
}

/**
 * schema v2 非对称信任：每条 checklist 都要带 confidence。
 * - 未显式声明的一律 high（确定性判定：文件存在性 / 有无 action / 始终必跑）
 * - 仅关键词语义判定的 false 由各 builder 显式标 low（可能漏判，AI 应据完整上下文复核）
 * 语义：trigger=true 恒可信；confidence=low 的 false 允许 AI 上调为"跑"，但不允许把 true 下调为"跳过"。
 */
function withConfidence(checklists) {
  return checklists.map(c => ({ ...c, confidence: c.confidence || 'high' }));
}

function buildChecklistsRaw({ projectRoot, stage, changeId, taskId }) {
  if (stage === 'dev') {
    return buildDevChecklists({ projectRoot, changeId, taskId });
  }
  if (stage === 'change') {
    return buildChangeChecklists({ projectRoot, changeId });
  }
  if (stage === 'requirement') {
    return buildRequirementChecklists({ projectRoot, changeId });
  }
  if (stage === 'design') {
    return buildDesignChecklists({ projectRoot, changeId });
  }
  if (stage === 'ui-design') {
    return buildUiDesignChecklists({ projectRoot, changeId });
  }
  if (stage === 'task') {
    return buildTaskChecklists({ projectRoot, changeId });
  }
  if (stage === 'test') {
    return buildTestChecklists({ projectRoot, changeId });
  }
  if (stage === 'review') {
    return buildReviewChecklists({ projectRoot, changeId });
  }
  if (stage === 'integration') {
    return buildIntegrationChecklists({ projectRoot, changeId });
  }
  return [];
}

function buildDevChecklists({ projectRoot, changeId, taskId }) {
  if (!changeId || !taskId) {
    return [{
      id: 'task-not-selected',
      trigger: false,
      reason: 'taskId 未设置,请先指定 --task <id>',
    }];
  }

  const taskResolved = resolveArtifactPath(join(projectRoot, SPECS_DIR, changeId), 'tasks');
  const tasks = taskResolved && existsSync(taskResolved.path) ? parseTasks(taskResolved.path) : [];
  const task = tasks.find(t => t.id === taskId);

  if (!task) {
    return [{
      id: 'task-not-found',
      trigger: false,
      reason: `task ${taskId} 不在 ${getPreferredArtifactName('tasks')}（兼容旧 TASK.md）中`,
    }];
  }

  const action = (task.title || '') + ' ' + (task.body || '');
  const writeFiles = task.writeFiles || [];

  const checklists = [];

  // 1.4 沿用既有抽象 grep —— 只要有 action 就触发（确定性判定：有无 action 是事实 → 默认 high）
  checklists.push({
    id: '1.4-grep-abstractions',
    trigger: Boolean(action.trim()),
    ref: '.gantry/core/phases/4-dev.md#1.4',
    reason: action.trim() ? '任务有 action 字段,需先 grep 既有抽象' : 'task 无 action,跳过',
  });

  // 1.5 团队知识 + LESSONS（确定性判定：文件存在性是事实 → 默认 high）
  // 1.5 段现同时承载 1.5.1 团队约定（.context/MANIFEST.md）与 1.5.2 扫 LESSONS，
  // 两者任一存在即触发。只有 .context 没 LESSONS 的项目（如 vas）也能命中团队约定。
  const lessonsPath = join(projectRoot, SPECS_DIR, 'LESSONS.md');
  const manifestPath = join(projectRoot, '.context', 'MANIFEST.md');
  const hasLessons = existsSync(lessonsPath);
  const hasManifest = existsSync(manifestPath);
  const trigger15Reasons = [];
  if (hasManifest) trigger15Reasons.push('.context/MANIFEST.md 存在(团队约定)');
  if (hasLessons) trigger15Reasons.push('LESSONS.md 存在');
  checklists.push({
    id: '1.5-lessons-grep',
    trigger: hasLessons || hasManifest,
    ref: '.gantry/core/phases/4-dev.md#1.5',
    reason: trigger15Reasons.length ? trigger15Reasons.join(' + ') : '无 .context/MANIFEST.md 且无 LESSONS.md,跳过',
  });

  const kw = classifyAction(action);

  // 1.6 UI 任务（关键词/后缀判定：未命中可能漏 → false 标 low，AI 应复核；命中走默认 high）
  const uiTrigger = writeFiles.some(f => UI_FILE_EXT.test(f)) || kw.ui;
  checklists.push({
    id: '1.6-ui-task',
    trigger: uiTrigger,
    confidence: uiTrigger ? 'high' : 'low',
    ref: '.gantry/core/phases/4-dev.md#1.6',
    reason: uiTrigger
      ? `命中 UI 信号 (write_files 含 UI 后缀或 action 含 UI 关键词)`
      : 'task.write_files 中无 UI 后缀且 action 无 UI 关键词（关键词判定可能漏,AI 应据完整上下文复核）',
  });

  // 1.7 Schema 任务（关键词/路径判定：未命中可能漏 → false 标 low）
  const schemaTrigger = writeFiles.some(f => SCHEMA_FILE_RE.test(f)) || kw.schema;
  checklists.push({
    id: '1.7-schema',
    trigger: schemaTrigger,
    confidence: schemaTrigger ? 'high' : 'low',
    ref: '.gantry/core/phases/4-dev.md#1.7',
    reason: schemaTrigger
      ? '命中 schema 信号 (write_files 命中 ORM/migration 路径或 action 含 schema 关键词)'
      : 'task.action 无 schema 关键词且 write_files 不命中 ORM/migration 路径（关键词判定可能漏,AI 应据完整上下文复核）',
  });

  // 1.8 破坏性变更（纯关键词判定：未命中可能漏 → false 标 low）
  const breakingTrigger = kw.breaking;
  checklists.push({
    id: '1.8-breaking-change',
    trigger: breakingTrigger,
    confidence: breakingTrigger ? 'high' : 'low',
    ref: '.gantry/core/phases/4-dev.md#1.8',
    reason: breakingTrigger
      ? '命中破坏性变更关键词 (action 含 删除/重命名/改签名/改 API)'
      : 'task.action 无破坏性变更关键词（关键词判定可能漏,AI 应据完整上下文复核）',
  });

  return checklists;
}

function buildChangeChecklists({ projectRoot, changeId }) {
  const archPath = join(projectRoot, SPECS_DIR, 'ARCHITECTURE.md');
  const checklists = [
    {
      id: '0.4-architecture-detection',
      trigger: true,
      ref: '.gantry/core/phases/0-change.md#0.4',
      reason: '架构级变更检测必跑',
    },
    {
      id: '0.4-architecture-doc-exists',
      trigger: existsSync(archPath),
      ref: '.gantry/core/phases/0-change.md#0.4.3',
      reason: existsSync(archPath)
        ? 'ARCHITECTURE.md 存在,可参与决策'
        : 'ARCHITECTURE.md 不存在,选项 1 改为"首次建立"',
    },
  ];

  // 若 PROPOSAL 已生成但仍带未决问题:agent 上次跳过了反问门,被 next 阻断后退回 change。
  // 这条 trigger=true 的检查让重新进入 change 的 agent 立刻知道"继续反问、清空待澄清问题段"。
  if (changeId) {
    const proposalPath = resolveArtifactPath(join(projectRoot, SPECS_DIR, changeId), 'proposal')?.path;
    if (proposalPath && existsSync(proposalPath)) {
      const open = countOpenQuestions(readFileSync(proposalPath, 'utf-8'));
      if (open > 0) {
        checklists.push({
          id: '1-resolve-open-questions',
          trigger: true,
          ref: '.gantry/core/phases/0-change.md#1',
          reason: `PROPOSAL 仍有 ${open} 个未决问题,必须继续反问用户、拿到答案并清空「待澄清问题」段后才能推进`,
        });
      }
    }
  }

  return checklists;
}


// requirement 阶段
function buildRequirementChecklists({ projectRoot, changeId }) {
  if (!changeId) return [];
  const changePath = resolveArtifactPath(join(projectRoot, SPECS_DIR, changeId), 'proposal')?.path;
  const hasChange = Boolean(changePath && existsSync(changePath));
  return [
    {
      id: 'req-derive-from-change',
      trigger: hasChange,
      ref: '.gantry/core/phases/1-requirement.md',
      reason: hasChange ? 'PROPOSAL.md 存在,从其影响面派生 AC' : 'PROPOSAL/CHANGE 缺失,无法派生',
    },
    {
      id: 'req-ac-format',
      trigger: true,
      ref: '.gantry/core/phases/1-requirement.md',
      reason: 'AC 必须 Given/When/Then 格式',
    },
  ];
}

// design 阶段
function buildDesignChecklists({ projectRoot, changeId }) {
  if (!changeId) return [];
  const archPath = join(projectRoot, SPECS_DIR, 'ARCHITECTURE.md');
  return [
    {
      id: 'design-stack-selection',
      trigger: true,
      ref: '.gantry/core/phases/2-design.md#0',
      reason: '§ 0 技术栈选定必填',
    },
    {
      id: 'design-existing-arch-alignment',
      trigger: existsSync(archPath),
      ref: '.gantry/core/phases/2-design.md#0.5',
      reason: existsSync(archPath)
        ? 'ARCHITECTURE.md 存在,§ 0.5 既有架构对齐必跑'
        : 'ARCHITECTURE.md 不存在,§ 0.5 跳过',
    },
    {
      id: 'design-adr-needed',
      trigger: true,
      ref: '.gantry/core/phases/2-design.md',
      reason: '判断是否需要新 ADR;若有跨模块影响必加',
    },
    {
      id: 'design-section-9-evolution',
      trigger: true,
      ref: '.gantry/core/phases/2-design.md#9',
      reason: '§ 9 架构沉淀建议必填(空也要写明 N/A)',
    },
  ];
}

// ui-design 阶段
function buildUiDesignChecklists({ projectRoot, changeId }) {
  if (!changeId) return [];
  const designPath = join(projectRoot, SPECS_DIR, changeId, 'DESIGN.md');
  return [
    {
      id: 'ui-design-from-design',
      trigger: existsSync(designPath),
      ref: '.gantry/core/phases/2a-ui-design.md',
      reason: existsSync(designPath) ? 'DESIGN.md 存在,从其派生' : 'DESIGN.md 缺失',
    },
    {
      id: 'ui-design-tone-anchor',
      trigger: true,
      ref: '.gantry/core/phases/2a-ui-design.md',
      reason: 'PROPOSAL 中的视觉调性必须继承,不再让用户重选',
    },
    {
      id: 'ui-design-tokens-frontmatter',
      trigger: true,
      ref: '.gantry/core/phases/2a-ui-design.md',
      reason: 'frontmatter 必须含 colors / typography / spacing / radii / motion 五组 token',
    },
  ];
}

// task 阶段
function buildTaskChecklists({ projectRoot, changeId }) {
  if (!changeId) return [];
  return [
    {
      id: 'task-derive-from-design',
      trigger: true,
      ref: '.gantry/core/phases/3-task.md',
      reason: 'task 必须从 DESIGN/REQUIREMENT 派生,不允许凭空',
    },
    {
      id: 'task-atomic-with-verify',
      trigger: true,
      ref: '.gantry/core/phases/3-task.md',
      reason: '每个 <task> 必须含 verify + done,verify 可机器执行',
    },
    {
      id: 'task-write-files-explicit',
      trigger: true,
      ref: '.gantry/core/phases/3-task.md',
      reason: '必须显式声明 write_files 边界(R6.5 边界 verify 依赖此)',
    },
    {
      id: 'task-wave-grouping',
      trigger: true,
      ref: '.gantry/core/phases/3-task.md',
      reason: 'parallel=true 的任务可并行,需声明 depends 关系',
    },
  ];
}

// test 阶段
function buildTestChecklists({ projectRoot, changeId }) {
  if (!changeId) return [];
  const reqPath = resolveArtifactPath(join(projectRoot, SPECS_DIR, changeId), 'spec')?.path;
  return [
    {
      id: 'test-derive-from-ac',
      trigger: existsSync(reqPath),
      ref: '.gantry/core/phases/5-test.md',
      reason: existsSync(reqPath)
        ? 'SPEC.md 中 AC 是测试唯一来源(R5.1)'
        : 'SPEC/REQUIREMENT 缺失,light 管线下从 PROPOSAL 推断',
    },
    {
      id: 'test-no-mock-bypass',
      trigger: true,
      ref: '.gantry/core/phases/5-test.md',
      reason: 'R5.2: 禁用 mock 屏蔽真实失败',
    },
    {
      id: 'test-evidence-output',
      trigger: true,
      ref: '.gantry/core/phases/5-test.md',
      reason: 'TEST.md 必含 verify 真实输出',
    },
  ];
}

// review 阶段
function buildReviewChecklists({ projectRoot, changeId }) {
  if (!changeId) return [];
  return [
    {
      id: 'review-r1-spec-vs-impl',
      trigger: true,
      ref: '.gantry/core/phases/6-review.md',
      reason: 'R1 轮: 校对 spec 与实现一致性',
    },
    {
      id: 'review-r2-code-quality',
      trigger: true,
      ref: '.gantry/core/phases/6-review.md',
      reason: 'R2 轮: 6 维代码质量',
    },
    {
      id: 'review-pass-or-fix-tasks',
      trigger: true,
      ref: '.gantry/core/phases/6-review.md',
      reason: 'REVIEW.md 必须明示 APPROVED 或开 fix-task(整合阶段门禁依赖)',
    },
  ];
}

// integration 阶段
function buildIntegrationChecklists({ projectRoot, changeId }) {
  if (!changeId) return [];
  return [
    {
      id: 'integration-uat',
      trigger: true,
      ref: '.gantry/core/phases/7-integration.md',
      reason: 'UAT.md 必填,记录上线 / 验收条件',
    },
    {
      id: 'integration-archive-ready',
      trigger: true,
      ref: '.gantry/core/phases/7-integration.md',
      reason: '收尾完成后跑 gantry archive 把 change 归档',
    },
  ];
}

// === lessons (dev 阶段) ===

function grepLessons(projectRoot, taskId) {
  const lessonsPath = join(projectRoot, SPECS_DIR, 'LESSONS.md');
  if (!existsSync(lessonsPath)) return [];

  const content = readFileSync(lessonsPath, 'utf-8');
  const blocks = content.split(/(?=^##\s+L-\d+)/m).filter(b => /^##\s+L-\d+/.test(b));
  if (blocks.length === 0) return [];

  // 取本任务相关关键词:taskId 本身 + change 相关词
  // (Kernel 不做 NLP,只做"如果 taskId 在文本里出现就算命中")
  const keywords = [];
  if (taskId) keywords.push(taskId);

  const lessons = [];
  for (const block of blocks) {
    const idMatch = block.match(/^##\s+(L-\d+)/m);
    if (!idMatch) continue;
    const id = idMatch[1];
    const statusMatch = block.match(/状态[::]\s*(\S+)/);
    const status = statusMatch ? statusMatch[1] : 'active';
    const summaryMatch = block.match(/^##\s+L-\d+\s+(.+)$/m);
    const summary = summaryMatch ? summaryMatch[1].trim() : '';

    if (status !== 'active') continue;

    const matchedKeywords = keywords.filter(k => block.includes(k));
    if (matchedKeywords.length > 0 || keywords.length === 0) {
      lessons.push({
        id, summary, status,
        matchedKeywords: matchedKeywords.length > 0 ? matchedKeywords : null,
      });
    }
  }

  return lessons;
}

// === next 命令 ===

function buildNextCommands(stage, taskId) {
  if (stage === 'dev' && taskId) {
    return {
      onSuccess: `gantry done ${taskId} && gantry next`,
      onFailure: 'gantry next --skip',
    };
  }
  if (stage === 'idle') {
    return {
      onSuccess: 'gantry change "<描述>"',
      onFailure: null,
    };
  }
  return {
    onSuccess: 'gantry next',
    onFailure: 'gantry next --skip',
  };
}


export const PACK_PATH = `${PLANNING_DIR}/${PACK_FILENAME}`;
