/**
 * state.mjs — STATE.md 读写 + 状态转换
 * 零依赖，纯 Node.js
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { PLANNING_DIR } from './paths.mjs';
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
 * 归一化 pipeline 三值枚举 { micro, light, full }。
 *
 * - 合法值原样返回；
 * - 其他值 (undefined / 'standard' / 未知) 默认 'full'；
 * - 禁止 micro → full 回退 (ADR-001)。
 *
 * 注：本函数是 state 读取路径的本地定义。pipeline-policy.mjs 的 normalizePipeline
 * 仍为二值 (light/full, 未知抛错)，供 cli/config 使用；T08 边界纪律限定只改 state.mjs，
 * 故这里单独维护 state 侧的 micro 感知归一化，不污染 shared policy。
 */
export function normalizePipeline(value) {
  if (value === 'micro' || value === 'light' || value === 'full') return value;
  return 'full';
}

// pipeline audit：审查所有 `pipeline === 'light'` 判断点是否需要接纳 'micro'
// ---------------------------------------------------------------------------
// 1) src/lib/state.mjs (本文件 parseStateMd 的旧 light 兜底)：
//    → micro 不适用。原因：ADR-001 明确禁止 micro→full 回退，该兜底只服务旧 light
//      迁移（loop-engineering.test.mjs「旧 light 停在旧阶段时读取为 full」）。
// 2) src/lib/phases.mjs:93 (integration gate：pipeline==='light' ? execution : review)：
//    → micro 不适用。原因：micro 阶段图为 change→dev→done (DESIGN 2.4)，不含
//      integration 阶段；micro 的 verify 保护由本文件 recordVerifyResult 承担，
//      micro 阶段图扩容归 T10 (phases.mjs)，不在 T08 边界内。
// 3) src/cli.mjs:230 (`if (pipeline === 'light')`) 与 :1429 (legacy standard/light)：
//    → micro 不适用 / 待 CLI 任务审查。原因：CLI 层 pipeline 分支与 --tier 覆写归
//      T12 处理，T08 不触碰 cli.mjs。
// ---------------------------------------------------------------------------

/**
 * 记录 micro 档 verify 结果 (升档保护核心)。
 *
 * 控制流选择：返回 { state, exitCode } 而非抛异常 —— verify 失败是业务状态而非
 * 程序错误，用返回值承载 CLI 退出码，避免用异常做控制流。
 *
 * 语义：
 *   - 仅 state.pipeline === 'micro' 且 pass === false 时 verifyFailCount++；
 *   - 累计达 2 时置 state.pauseReason = 'micro-verify-failed-2x'，返回
 *     exitCode 'micro_verify_failed'；
 *   - 其他 pipeline (light/full) 或 pass===true 时 count 不动，exitCode 为 null。
 *
 * @param {object} state - 状态对象 (原地修改)
 * @param {boolean} pass - 本次 verify 是否通过
 * @returns {{ state: object, exitCode: string|null }}
 */
export function recordVerifyResult(state, pass) {
  if (state.pipeline !== 'micro' || pass !== false) {
    return { state, exitCode: null };
  }
  state.verifyFailCount = (state.verifyFailCount ?? 0) + 1;
  if (state.verifyFailCount >= 2) {
    state.pauseReason = 'micro-verify-failed-2x';
    return { state, exitCode: 'micro_verify_failed' };
  }
  return { state, exitCode: null };
}

/**
 * 读取项目状态
 * @param {string} projectRoot - 项目根目录
 * @returns {object} 解析后的状态对象
 */
export function readState(projectRoot) {
  const statePath = join(projectRoot, PLANNING_DIR, STATE_FILE);
  const state = existsSync(statePath)
    ? parseStateMd(readFileSync(statePath, 'utf-8'))
    : defaultState();
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

  const content = renderStateMd(state);
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
  return updateState(projectRoot, {
    currentStage: toStage,
    activeAgent: getAgentForStage(toStage),
    currentWave: null,
    currentTask: null,
    retries: 0,
    pauseReason: null,
  });
}

// --- fence 读写(机器可读区,供 loop-next / driver 消费)---

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

  state.pipeline = normalizePipeline(state.pipeline);
  // pipeline audit #1：旧 light 迁移兜底 —— 仅 light 停在非法阶段时回退 full；
  // micro 不在此列 (ADR-001 禁止 micro→full 回退)。
  if (state.pipeline === 'light' && !['change', 'fast', 'integration', 'idle'].includes(state.currentStage)) {
    state.pipeline = 'full';
  }

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
