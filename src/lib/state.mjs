/**
 * state.mjs — STATE.md 读写 + 状态转换
 * 零依赖，纯 Node.js
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PLANNING_DIR, SPECS_DIR } from './paths.mjs';
import { getAgentForStage } from './agents.mjs';

const STATE_FILE = 'STATE.md';

// fence 段:STATE.md 内嵌的机器可读 JSON,供 loop-next / driver 消费。
// 与散文区严格解耦:散文区由 renderStateMd 生成,fence 追加在其后。
const FENCE_BEGIN = '<!-- BEGIN gantry:state -->';
const FENCE_END = '<!-- END gantry:state -->';
const FENCE_REGEX = /<!-- BEGIN gantry:state -->\s*```json\s*([\s\S]+?)\s*```\s*<!-- END gantry:state -->/;

/**
 * 默认 fence 对象(fence 缺失时的降级返回)。
 * 与散文区 defaultState() 无关——散文承载"当前阶段/管线"这类人读字段,
 * fence 承载 loop-next 决策所需的机器字段。
 */
export function defaultFence() {
  return {
    nextStep: null,
    lastStageResult: null,
    currentWave: null,
    previousWave: null,
    approvals: {},
  };
}

/**
 * 默认状态结构
 */
function defaultState() {
  return {
    pipeline: 'full',
    activeChange: null,
    currentStage: 'idle',
    currentWave: null,
    currentTask: null,
    activeAgent: null,
    autonomous: false,
    stagesRun: 0,
    maxStages: 3,
    retries: 0,
    maxRetries: 3,
    pauseReason: null,
    verifyFailCount: 0,
    contextUsage: {
      tokens: null,
      windowPercent: null,
    },
  };
}

/**
 * 存量 STATE 的 pipeline 归一化 (DESIGN D9)。
 *
 * 纯函数：不改 stage，不做 IO。hasLightJson 由调用方决定是否探测。
 *
 * 规则：
 *   - pipeline === 'full'                        → 原样，migrated=false
 *   - pipeline === 'light' 且 currentStage 为 'idle'，或为 'fast' 且 hasLightJson 为
 *     true                                        → 原样，migrated=false
 *   - pipeline === 'light' 的其他状态(change / fast 无 light.json / integration / dev…)
 *     ，以及 micro / standard / 任何未知值         → full，migrated=true
 *   - currentStage 永不改动
 *
 * @param {object} state - 解析出的状态对象
 * @param {object} [options]
 * @param {boolean} [options.hasLightJson=false] - 当前 activeChange 目录是否存在 light.json
 * @returns {{ state: object, migrated: boolean }}
 */
export function normalizeLegacyPipeline(state, { hasLightJson = false } = {}) {
  const pipeline = state?.pipeline;

  if (pipeline === 'full') return { state, migrated: false };

  if (pipeline === 'light') {
    const stage = state.currentStage;
    const valid = stage === 'idle' || (stage === 'fast' && hasLightJson === true);
    if (valid) return { state, migrated: false };
    return { state: { ...state, pipeline: 'full' }, migrated: true };
  }

  // micro / standard / undefined / 其他未知值 → full（容忍旧 STATE，不抛错）
  return { state: { ...state, pipeline: 'full' }, migrated: true };
}

/**
 * 记录 light 档 verify 结果 (DESIGN D8 · R2.5 自愈上限 3 次)。
 *
 * 语义：
 *   - pass → retries 归零，paused=false；
 *   - fail 且 diagnosis 为空或与 lastDiagnosis 去空白后相同 → 判为无效自愈，
 *     直接置 pauseReason='light-verify-no-new-diagnosis'，retries 不递增；
 *   - 否则 retries++；retries > maxRetries(default 3) 时置
 *     pauseReason='light-verify-failed'，paused=true。
 *
 * @param {object} state - 状态对象 (原地修改 retries / pauseReason)
 * @param {object} result
 * @param {boolean} result.pass - 本次 verify 是否通过
 * @param {string} [result.diagnosis] - 本次新增诊断文本
 * @param {string} [result.lastDiagnosis] - 上一条诊断文本
 * @returns {{ state: object, paused: boolean }}
 */
export function recordLightVerify(state, { pass, diagnosis, lastDiagnosis } = {}) {
  if (pass) {
    state.retries = 0;
    return { state, paused: false };
  }

  const current = String(diagnosis ?? '').trim();
  const previous = String(lastDiagnosis ?? '').trim();

  if (current === '' || current === previous) {
    state.pauseReason = 'light-verify-no-new-diagnosis';
    return { state, paused: true };
  }

  state.retries = (state.retries ?? 0) + 1;
  if (state.retries > (state.maxRetries ?? 3)) {
    state.pauseReason = 'light-verify-failed';
    return { state, paused: true };
  }
  return { state, paused: false };
}

/**
 * 读取项目状态（含存量 pipeline 归一化，DESIGN D9 / AC-14）。
 *
 * 归一化只做内存态：readState 不写回 STATE.md（持久化由 gantry migrate 之类
 * 的显式命令负责）。
 *
 * @param {string} projectRoot - 项目根目录
 * @returns {object} 解析并归一化后的状态对象
 */
export function readState(projectRoot) {
  const statePath = join(projectRoot, PLANNING_DIR, STATE_FILE);
  const parsed = existsSync(statePath)
    ? parseStateMd(readFileSync(statePath, 'utf-8'))
    : defaultState();

  // R4：只在 pipeline=light 且 stage=fast 且已知 activeChange 时才碰文件系统，
  // 其余路径保持纯解析行为不变。
  const needsLightJsonCheck = parsed.pipeline === 'light'
    && parsed.currentStage === 'fast'
    && Boolean(parsed.activeChange);
  const hasLightJson = needsLightJsonCheck
    ? existsSync(join(projectRoot, SPECS_DIR, parsed.activeChange, 'light.json'))
    : false;

  const { state, migrated } = normalizeLegacyPipeline(parsed, { hasLightJson });

  if (migrated) {
    console.error(`↑ pipeline 迁移: ${parsed.pipeline}@${parsed.currentStage} → full@${state.currentStage}`);
  }

  return state;
}

/**
 * 写入项目状态
 * @param {string} projectRoot - 项目根目录
 * @param {object} state - 状态对象
 */
export function writeState(projectRoot, state) {
  const planningDir = join(projectRoot, PLANNING_DIR);
  if (!existsSync(planningDir)) {
    mkdirSync(planningDir, { recursive: true });
  }

  const previousPath = join(planningDir, STATE_FILE);
  const previous = existsSync(previousPath) ? parseStateMd(readFileSync(previousPath, 'utf8')) : null;
  const fence = previous && previous.activeChange !== state.activeChange ? defaultFence() : readFence(projectRoot);
  const content = renderStateMd(state) + `\n${FENCE_BEGIN}\n\`\`\`json\n${JSON.stringify(fence, null, 2)}\n\`\`\`\n${FENCE_END}\n`;
  const statePath = join(planningDir, STATE_FILE);
  const tempPath = `${statePath}.tmp-${process.pid}`;
  writeFileSync(tempPath, content, 'utf-8');
  renameSync(tempPath, statePath);
}

/**
 * 原子更新状态字段
 */
export function updateState(projectRoot, updates) {
  const state = readState(projectRoot);
  Object.assign(state, updates);
  writeState(projectRoot, state);
  return state;
}

/**
 * 记录阶段转换
 *
 * state-must-advance 断言(loop 收敛的编译期兜底):
 *   同一 stage 传参一律视为 bug 并 throw,唯一例外是 DEV 内 wave 推进
 *   (currentStage === 'dev' && from === to === 'dev' && currentWave 变化)。
 *
 *   这条断言让"跑起来但原地打转"变得不可能——比外层 stuck-stop 更早失败。
 */
export function transitionStage(projectRoot, fromStage, toStage) {
  if (fromStage === toStage) {
    const cur = readState(projectRoot);
    // previousWave 只在 fence 里持久化——散文区是给人读的,不承载这种机器旁路字段
    const fence = readFence(projectRoot);
    const isDevWaveAdvance = toStage === 'dev'
      && cur.currentStage === 'dev'
      && cur.currentWave != null
      && fence.previousWave != null
      && cur.currentWave !== fence.previousWave;
    if (!isDevWaveAdvance) {
      throw new Error(
        `[state-must-advance] transitionStage 未真实推进: ${fromStage} → ${toStage} `
        + `(currentStage=${cur.currentStage}, currentWave=${cur.currentWave}, fence.previousWave=${fence.previousWave}). `
        + `同 stage 前进除 dev wave 推进外一律视为 bug。`
      );
    }
  }
  const updated = updateState(projectRoot, {
    currentStage: toStage,
    activeAgent: getAgentForStage(toStage),
    currentWave: null,
    currentTask: null,
    retries: 0,
    pauseReason: null,
  });
  if (fromStage !== toStage) {
    const fence = readFence(projectRoot);
    writeFence(projectRoot, { ...fence, nextStep: null, lastStageResult: null, currentWave: null, previousWave: null });
  }
  return updated;
}

// --- fence 读写(机器可读区,供 loop-next / driver 消费)---

/**
 * 写入 fence.lastStageResult.blockedReason,"谁先熔断谁负责"策略。
 *
 * T-FIX-03(REVIEW Round 2 · R3):抽出 loop-guard 与 heal --check 两处熔断
 * 路径共享的"已有非空 blockedReason 不覆盖"策略,避免概念级重复。
 *
 * @param {string} projectRoot
 * @param {string} reason - 熔断原因(将写到 fence.lastStageResult.blockedReason)
 * @param {object} [options]
 * @param {boolean} [options.overwrite=false] - true 时无条件覆盖,默认 false 只在
 *   已有值为空/null 时才写。
 * @returns {{ written: boolean, existing: string|null, error?: string }} 未写(已
 *   有非空)返回 written:false + existing;写成功 written:true;IO 异常返回
 *   written:false + error(不抛,由调用者决定是否 warn)。
 */
export function writeFenceBlockedReason(projectRoot, reason, options = {}) {
  const { overwrite = false } = options;
  try {
    const fence = readFence(projectRoot);
    const existing = fence.lastStageResult?.blockedReason ?? null;
    if (!overwrite && existing != null && existing !== '') {
      return { written: false, existing };
    }
    writeFence(projectRoot, {
      ...fence,
      lastStageResult: {
        ...(fence.lastStageResult ?? {}),
        ok: false,
        blockedReason: reason,
      },
    });
    return { written: true, existing };
  } catch (err) {
    return { written: false, existing: null, error: err.message };
  }
}


/**
 * 读取 STATE.md 尾部的 gantry:state JSON fence。
 *
 * fence 缺失或解析失败时降级返回 defaultFence(),不抛错——保证 loop-next
 * 在老 STATE.md 上仍能给出白名单 token。
 *
 * @param {string} projectRoot
 * @returns {object} fence 对象
 */
export function readFence(projectRoot) {
  const statePath = join(projectRoot, PLANNING_DIR, STATE_FILE);
  if (!existsSync(statePath)) return defaultFence();
  const content = readFileSync(statePath, 'utf-8');
  const match = content.match(FENCE_REGEX);
  if (!match) return defaultFence();
  try {
    const parsed = JSON.parse(match[1]);
    return { ...defaultFence(), ...parsed };
  } catch {
    return defaultFence();
  }
}

/**
 * 写入 fence 段。策略:保留散文区(renderStateMd 输出)不变,fence 在其后。
 *
 * 若 STATE.md 已有 fence,原地替换;否则追加。始终原子写。
 */
export function writeFence(projectRoot, fenceObj) {
  const planningDir = join(projectRoot, PLANNING_DIR);
  if (!existsSync(planningDir)) mkdirSync(planningDir, { recursive: true });
  const statePath = join(planningDir, STATE_FILE);

  const prose = existsSync(statePath)
    ? readFileSync(statePath, 'utf-8')
    : renderStateMd(defaultState());

  const fenceBlock = `${FENCE_BEGIN}\n\`\`\`json\n${JSON.stringify(fenceObj, null, 2)}\n\`\`\`\n${FENCE_END}\n`;

  let next;
  if (FENCE_REGEX.test(prose)) {
    // 替换整个 fence 块(BEGIN 到 END 之间连注释一并替换)
    next = prose.replace(
      /<!-- BEGIN gantry:state -->[\s\S]+?<!-- END gantry:state -->\n?/,
      fenceBlock,
    );
  } else {
    // 追加到末尾,前置一个空行分隔散文与 fence
    next = prose.trimEnd() + '\n\n' + fenceBlock;
  }

  const tempPath = `${statePath}.tmp-${process.pid}`;
  writeFileSync(tempPath, next, 'utf-8');
  renameSync(tempPath, statePath);
}

// --- 解析 / 渲染 ---

function parseStateMd(content) {
  const state = defaultState();
  const lines = content.split('\n');

  for (const line of lines) {
    const kv = parseKvLine(line);
    if (!kv) continue;

    switch (kv.key) {
      case '模式': state.pipeline = kv.value; break;
      case '活跃 Change': state.activeChange = kv.value === '无' ? null : kv.value; break;
      case '当前阶段': state.currentStage = kv.value === 'idle' ? 'idle' : kv.value; break;
      case '当前 Wave': state.currentWave = kv.value === '—' ? null : parseInt(kv.value) || null; break;
      case '当前 Task': state.currentTask = kv.value === '—' ? null : kv.value; break;
      case '活跃 Agent': state.activeAgent = kv.value === '—' ? null : kv.value; break;
      case 'autonomous': state.autonomous = kv.value === 'true'; break;
      case '已执行阶段数': {
        // 支持 "3 / 5" 或 "3" 两种格式
        const m = String(kv.value).match(/^(\d+)\s*(?:\/\s*(\d+))?/);
        if (m) {
          state.stagesRun = parseInt(m[1], 10) || 0;
          if (m[2]) state.maxStages = parseInt(m[2], 10) || state.maxStages;
        }
        break;
      }
      case '重试计数': {
        const m = String(kv.value).match(/^(\d+)\s*(?:\/\s*(\d+))?/);
        if (m) {
          state.retries = parseInt(m[1], 10) || 0;
          if (m[2]) state.maxRetries = parseInt(m[2], 10) || state.maxRetries;
        }
        break;
      }
      case '暂停原因': state.pauseReason = kv.value === '—' ? null : kv.value; break;
      case '验证失败计数': state.verifyFailCount = parseInt(kv.value) || 0; break;
      case '上下文 token': state.contextUsage.tokens = kv.value === '—' ? null : parseInt(kv.value) || null; break;
      case '窗口使用率': state.contextUsage.windowPercent = kv.value === '—' ? null : parseFloat(kv.value) || null; break;
    }
  }

  // pipeline 保留原值，不做本地归一化：存量判定需要知道原值才能提示迁移
  // (micro / 旧 light 的区别只能在这里看到)。归一化统一在 readState 里由
  // normalizeLegacyPipeline 承担——它还需要探测 light.json，本函数不做 IO。
  return state;
}

function parseKvLine(line) {
  const match = line.match(/^-\s*\*\*(.+?)\*\*:\s*`?(.+?)`?\s*$/);
  if (match) return { key: match[1], value: match[2] };
  return null;
}

function renderStateMd(state) {
  const now = new Date().toISOString().slice(0, 10);

  return `# STATE — 项目协作状态

## Pipeline

- **模式**: \`${state.pipeline}\`
- **活跃 Change**: \`${state.activeChange || '无'}\`
- **当前阶段**: \`${state.currentStage}\`
- **当前 Wave**: \`${state.currentWave ?? '—'}\`
- **当前 Task**: \`${state.currentTask ?? '—'}\`
- **活跃 Agent**: \`${state.activeAgent ?? '—'}\`

## 自动模式状态

- **autonomous**: \`${state.autonomous}\`
- **已执行阶段数**: \`${state.stagesRun} / ${state.maxStages}\`
- **重试计数**: \`${state.retries} / ${state.maxRetries}\`
- **验证失败计数**: \`${state.verifyFailCount ?? 0}\`
- **暂停原因**: \`${state.pauseReason ?? '—'}\`
- **上下文 token**: \`${state.contextUsage?.tokens ?? '—'}\`
- **窗口使用率**: \`${state.contextUsage?.windowPercent ?? '—'}\`

---
_最后更新: ${now}_
`;
}

// Approval is a receipt for the reviewed bytes, never a permanent stage flag.
const APPROVAL_FILES = Object.freeze({
  change: ['PROPOSAL.md'],
  design: ['DESIGN.md', 'UI-DESIGN.md'],
  integration: ['UAT.md', 'JOURNEY-VERIFY.md', 'TEST.md', 'REVIEW.md', 'DESIGN.md', 'SPEC.md'],
});
export function approvalDigest(root, stage, changeId = readState(root).activeChange) {
  if (!changeId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(changeId) || !APPROVAL_FILES[stage]) {
    throw new Error('Invalid approval identity');
  }
  if (!existsSync(join(root, SPECS_DIR, changeId, APPROVAL_FILES[stage][0]))) {
    throw new Error(`Missing approval artifact for ${stage}`);
  }
  const hash = createHash('sha256').update(JSON.stringify({ stage, changeId }));
  let count = 0;
  for (const name of APPROVAL_FILES[stage]) {
    const path = join(root, SPECS_DIR, changeId, name);
    const content = existsSync(path) ? readFileSync(path) : null;
    hash.update(name).update('\0').update(content ?? '<missing>').update('\0');
    if (content?.length) count++;
  }
  if (!count) throw new Error(`No approval artifact for ${stage}`);
  return hash.digest('hex');
}
export function isStageApproved(root, stage, changeId = readState(root).activeChange) {
  try {
    return readFence(root).approvals?.[stage]?.digest === approvalDigest(root, stage, changeId)
      && readFence(root).approvals?.[stage]?.changeId === changeId;
  } catch { return false; }
}
export function approveStage(root, stage, changeId = readState(root).activeChange) {
  const state = readState(root);
  if (state.currentStage !== stage || state.activeChange !== changeId) throw new Error('Approval stage/change mismatch');
  const digest = approvalDigest(root, stage, changeId);
  const fence = readFence(root);
  const approval = { digest, changeId, at: new Date().toISOString() };
  writeFence(root, { ...fence, approvals: { ...fence.approvals, [stage]: approval } });
  return approval;
}
