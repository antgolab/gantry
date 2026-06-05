/**
 * model-router.mjs — 任务复杂度 → 模型层级选择 + 自动升级
 */

/**
 * @typedef {'fast'|'standard'|'deep'} ModelTier
 *   fast: haiku 级别（快速查找、格式检查、简单生成）
 *   standard: sonnet 级别（标准实现、测试、review）
 *   deep: opus 级别（架构设计、复杂调试、安全审计）
 */

const STAGE_MODEL_MAP = {
  change: 'standard',
  requirement: 'standard',
  design: 'deep',
  'ui-design': 'deep',
  task: 'standard',
  dev: 'standard',
  test: 'standard',
  review: 'standard',
  integration: 'fast',
  scan: 'fast',
  health: 'fast',
  knowledge: 'fast',
  architect: 'deep',
  evolve: 'deep',
  fast: 'fast',
};

const COMPLEXITY_KEYWORDS = {
  deep: [
    'architect', 'design', 'security', 'audit', 'migration',
    'refactor major', 'performance', 'concurrency', 'distributed',
    '架构', '安全', '审计', '迁移', '性能', '并发',
  ],
  fast: [
    'typo', 'lint', 'format', 'rename', 'config', 'comment',
    'log', 'version bump', 'readme',
    '拼写', '格式', '重命名', '配置', '注释', '日志',
  ],
};

/**
 * 为任务选择模型层级
 * @param {object} task - { id, title, body, writeFiles }
 * @param {object} context - { stage, pipeline, retryCount }
 * @returns {{ tier: ModelTier, reason: string }}
 */
export function selectModel(task, context = {}) {
  const { stage, pipeline, retryCount = 0 } = context;

  // Auto-escalation on retry
  if (retryCount >= 2) {
    return { tier: 'deep', reason: 'auto-escalation after 2+ retries' };
  }

  // Stage-based default
  if (stage && STAGE_MODEL_MAP[stage]) {
    const stageTier = STAGE_MODEL_MAP[stage];
    if (stageTier === 'deep') {
      return { tier: 'deep', reason: `stage "${stage}" requires deep reasoning` };
    }
  }

  // Full pipeline always uses deep for design stages
  if (pipeline === 'full' && (stage === 'design' || stage === 'architect')) {
    return { tier: 'deep', reason: 'full pipeline design/architect stage' };
  }

  // Task content analysis
  const text = `${task.title || ''} ${task.body || ''}`.toLowerCase();

  for (const kw of COMPLEXITY_KEYWORDS.deep) {
    if (matchKeyword(text, kw.toLowerCase())) {
      return { tier: 'deep', reason: `keyword "${kw}" indicates high complexity` };
    }
  }

  for (const kw of COMPLEXITY_KEYWORDS.fast) {
    if (matchKeyword(text, kw.toLowerCase())) {
      return { tier: 'fast', reason: `keyword "${kw}" indicates low complexity` };
    }
  }

  // File count heuristic
  const fileCount = (task.writeFiles || []).length;
  if (fileCount > 8) {
    return { tier: 'deep', reason: `${fileCount} write_files indicates large scope` };
  }
  if (fileCount <= 1) {
    return { tier: 'fast', reason: 'single file change' };
  }

  return { tier: 'standard', reason: 'default for standard implementation' };
}

/**
 * 模型升级（重试时自动触发）
 * @param {ModelTier} current - 当前模型层级
 * @param {number} retryCount - 已重试次数
 * @returns {ModelTier}
 */
export function escalateModel(current, retryCount) {
  if (retryCount < 1) return current;
  if (current === 'fast') return 'standard';
  if (current === 'standard' && retryCount >= 2) return 'deep';
  return current;
}

/**
 * 将 tier 映射为 IDE 具体模型 ID
 * @param {ModelTier} tier
 * @param {string} ide - 'claude-code'|'cursor'|'codex'|'copilot'
 * @returns {string} 具体模型标识
 */
export function resolveModelId(tier, ide = 'claude-code') {
  const MODEL_MAP = {
    'claude-code': { fast: 'haiku', standard: 'sonnet', deep: 'opus' },
    'cursor': { fast: 'claude-haiku', standard: 'claude-sonnet', deep: 'claude-opus' },
    'codex': { fast: 'gpt-4o-mini', standard: 'gpt-4o', deep: 'o3' },
    'copilot': { fast: 'gpt-4o-mini', standard: 'gpt-4o', deep: 'gpt-4o' },
  };

  const map = MODEL_MAP[ide] || MODEL_MAP['claude-code'];
  return map[tier] || map['standard'];
}

// --- 内部辅助 ---

function matchKeyword(text, keyword) {
  // Word boundary match to avoid "log" matching "login"
  // For multi-word keywords, use simple includes
  if (keyword.includes(' ')) {
    return text.includes(keyword);
  }
  const regex = new RegExp(`\\b${escapeRegex(keyword)}\\b`);
  return regex.test(text);
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
