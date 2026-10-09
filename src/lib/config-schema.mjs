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
 * learnings 子树已知 key 结构 (递归形式)。叶子为 true, 对象为下一层 schema。
 * friction.weights 在默认 key 基础上显式扩展 newFile / refactor 等用户可自定义项,
 * 其余陌生 key 一律 fail-closed。
 */
export const KNOWN_KEYS = {
  enabled: true,
  friction: {
    threshold: true,
    weights: {
      verifyFail: true,
      'sameFileEdit3+': true,
      userManualOverride: true,
      userInterrupt: true,
      rollback: true,
      aiSelfCorrect: true,
      newFile: true,
      refactor: true,
    },
  },
  recall: {
    enabled: true,
    relevancePreCheck: true,
  },
};

/**
 * ConfigError — learnings 配置非法时由调用方抛出的错误类型。
 * errors 数组携带具体 key 路径 (形如 `learnings.friction.weights.newfile 不是已知配置项`)。
 */
export class ConfigError extends Error {
  constructor(errors) {
    super(errors.join('\n'));
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

/**
 * 递归遍历 src, 将不在 schema 中的 key 累加到 errors。
 * @param {object} src - 待校验的 learnings 配置
 * @param {object} schema - KNOWN_KEYS 结构
 * @param {string} pathPrefix - 错误路径前缀 (默认 'learnings')
 * @returns {string[]} 未知 key 错误列表
 */
export function walkUnknownKeys(src, schema, pathPrefix = 'learnings') {
  const errors = [];
  const visit = (node, nodeSchema, prefix) => {
    for (const key of Object.keys(node)) {
      const path = `${prefix}.${key}`;
      if (!Object.prototype.hasOwnProperty.call(nodeSchema, key)) {
        errors.push(`${path} 不是已知配置项`);
        continue;
      }
      const childSchema = nodeSchema[key];
      const value = node[key];
      if (childSchema && typeof childSchema === 'object' && !Array.isArray(childSchema)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          visit(value, childSchema, path);
        }
      }
    }
  };
  visit(src, schema, pathPrefix);
  return errors;
}

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

  // 先跑 unknown-key fail-closed 校验 (AC-1/AC-2), 再跑数字/类型校验
  errors.push(...walkUnknownKeys(src, KNOWN_KEYS, 'learnings'));

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
