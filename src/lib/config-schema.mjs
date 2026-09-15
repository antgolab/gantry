/**
 * config-schema.mjs — learnings 配置 schema 校验
 * 零依赖，纯 Node.js
 */

export const DEFAULT_LEARNINGS_CONFIG = {
  enabled: true,
  friction: {
    threshold: 5,
    weights: {
      verifyFail: 2,
      'sameFileEdit3+': 2,
      userManualOverride: 3,
      userInterrupt: 2,
      rollback: 3,
      aiSelfCorrect: 1,
    },
  },
  recall: {
    enabled: true,
    relevancePreCheck: 0.3,
  },
};

/**
 * 校验 learnings 配置,与默认值合并后返回 { ok, errors, merged }。
 * 合并仅覆盖已知三层结构(浅合并),不引入 deep-merge。
 * @param {object} [cfg] - 可能缺失字段的 learnings 配置
 * @returns {{ok: boolean, errors: string[], merged: object}}
 */
export function validateLearningsConfig(cfg = {}) {
  const errors = [];
  const src = (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) ? cfg : {};
  const merged = mergeWithDefaults(src);

  if (typeof merged.enabled !== 'boolean') {
    errors.push('learnings.enabled 必须为 boolean');
  }

  const { threshold } = merged.friction;
  if (typeof threshold !== 'number' || threshold < 0) {
    errors.push('learnings.friction.threshold 必须为 >= 0 的数字');
  }

  for (const [key, value] of Object.entries(merged.friction.weights)) {
    if (typeof value !== 'number' || value < 0) {
      errors.push(`learnings.friction.weights.${key} 必须为 >= 0 的数字`);
    }
  }

  if (typeof merged.recall.enabled !== 'boolean') {
    errors.push('learnings.recall.enabled 必须为 boolean');
  }

  const { relevancePreCheck } = merged.recall;
  if (typeof relevancePreCheck !== 'number' || relevancePreCheck < 0 || relevancePreCheck > 1) {
    errors.push('learnings.recall.relevancePreCheck 必须在 [0, 1] 区间内');
  }

  return { ok: errors.length === 0, errors, merged };
}

function mergeWithDefaults(src) {
  const d = DEFAULT_LEARNINGS_CONFIG;
  return {
    enabled: src.enabled ?? d.enabled,
    friction: {
      threshold: src.friction?.threshold ?? d.friction.threshold,
      weights: { ...d.friction.weights, ...(src.friction?.weights || {}) },
    },
    recall: {
      enabled: src.recall?.enabled ?? d.recall.enabled,
      relevancePreCheck: src.recall?.relevancePreCheck ?? d.recall.relevancePreCheck,
    },
  };
}
