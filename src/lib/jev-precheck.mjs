/**
 * jev-precheck.mjs — light 创建期入口的 Jev 语义红线预检 (jev-redline-precheck)
 *
 * 只升不降: Jev 判为红线 (noul ≥ 阈值) 时 light 回落 full@change;判为非红线或调用失败,
 * 一律维持关键词结果。结果单独记录,不进 hard-rules 的 ruleIds (SPEC AC-9)。
 *
 *   shouldUseJev(config, env)          — 开关 + 环境变量 key 前置判定 (DESIGN D2 / D8)
 *   runJevPrecheck(description, opts)  — 一次 HTTP 调用,永不抛错 (D3 / D4 / D6)
 *   renderJevLine(result)              — EXECUTION tier-decision 段的 `jev:` 行 (D7)
 *
 * 零依赖: 用 Node ≥18 全局 fetch + AbortController,不引 @typesafe-ai/sdk (D0 · 要 Node 20)。
 */

/** 固定模型版本 (D3): alias 背后的模型会在不改代码的情况下变化,阈值是在 1.13.0 上测的。 */
export const JEV_MODEL = 'jev-1.13.0';
export const JEV_THRESHOLD = 0.5;
export const JEV_TIMEOUT_MS = 3000;
export const JEV_DEFAULT_BASE_URL = 'https://api.typesafe.ai';

// 与对照实验脚本 (~/workspace/ai/jev-smoke/redline-eval.mjs) 逐字一致 (D4)。
// 改动任何措辞都要重跑对照实验,否则阈值 0.5 失去依据。
const RED_LINES = {
  schema: '数据库结构、表、字段、索引或数据迁移',
  auth: '登录、会话、身份认证、权限或访问控制',
  secret: '密码、密钥、令牌、签名、加密或凭证的存储与传递',
  contract: '对外接口、命令行参数、配置格式等公共契约的不兼容变化',
  dependency: '新增或升级第三方依赖',
  crossModule: '同时改动多个模块或服务',
  concurrency: '并发、异步、队列、调度、多进程共享状态或数据一致性',
  destructive: '删除、覆盖或批量改写用户数据与文件',
};

export const JEV_QUESTIONS = {
  risky: {
    type: 'noul',
    instructions: `这个变更描述是否涉及以下任一高风险领域：${Object.values(RED_LINES).join('；')}？`,
    criteria: {
      true: '涉及至少一个高风险领域，不应走无人工审核的快速通道',
      false: '只是文案、文档、测试、日志、展示等低风险改动',
    },
  },
  category: {
    type: 'choice',
    instructions: '这个变更最主要涉及哪个高风险领域？',
    criteria: { ...RED_LINES, none: '以上都不涉及' },
  },
};

/**
 * 判定本次是否调用 Jev。只有 `config.jev.enabled === true` 且环境变量 key 非空才调用。
 *
 * @param {object} config - readConfig 结果
 * @param {object} env - 通常为 process.env
 * @returns {{use: true, apiKey: string, baseURL: string} | {use: false, warn: string|null}}
 */
export function shouldUseJev(config, env = {}) {
  if (config?.jev?.enabled !== true) return { use: false, warn: null };

  const apiKey = String(env.TYPESAFE_API_KEY ?? '').trim();
  if (!apiKey) {
    return {
      use: false,
      warn: '⚠ jev.enabled=true 但未设置 TYPESAFE_API_KEY，本次只按关键词预检',
    };
  }

  const baseURL = String(env.TYPESAFE_BASE_URL ?? '').trim() || JEV_DEFAULT_BASE_URL;
  return { use: true, apiKey, baseURL };
}

/**
 * 调用一次 Jev。超时 / HTTP 非 2xx / 网络错误 / 响应缺字段都归为失败返回,不抛错、不重试。
 * 只外发变更描述 (SPEC AC-7);错误信息不含 apiKey。
 *
 * @param {string} description - 变更描述
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.baseURL
 * @param {Function} [opts.fetchImpl] - 测试注入;缺省全局 fetch
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<
 *   {ok: true, hit: boolean, p: number, category: string|null, model: string|null}
 *   | {ok: false, error: string}
 * >}
 */
export async function runJevPrecheck(description, { apiKey, baseURL, fetchImpl = globalThis.fetch, timeoutMs = JEV_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'network' };

  const url = `${String(baseURL).replace(/\/+$/, '')}/v1/systemone`;
  const body = JSON.stringify({
    model: JEV_MODEL,
    state: { change_description: String(description ?? '') },
    questions: JEV_QUESTIONS,
  });

  const controller = new AbortController();
  // 计时覆盖到读完响应体为止,慢速 body 也算超时
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      });
    } catch {
      return { ok: false, error: controller.signal.aborted ? 'timeout' : 'network' };
    }

    if (!res.ok) return { ok: false, error: `http ${res.status}` };

    let data;
    try {
      data = await res.json();
    } catch {
      return { ok: false, error: controller.signal.aborted ? 'timeout' : 'bad-response' };
    }

    const p = data?.answers?.risky?.noul;
    if (typeof p !== 'number' || !Number.isFinite(p)) return { ok: false, error: 'bad-response' };

    const category = data?.answers?.category?.choice;
    return {
      ok: true,
      hit: p >= JEV_THRESHOLD,
      p,
      category: typeof category === 'string' ? category : null,
      model: typeof data?.model === 'string' ? data.model : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 渲染 tier-decision 段的 jev 行。
 *   成功: `jev: p=0.94 category=concurrency model=jev-1.13.0`
 *   失败: `jev: error timeout`
 */
export function renderJevLine(result) {
  if (!result?.ok) return `jev: error ${result?.error ?? 'unknown'}`;
  return `jev: p=${result.p.toFixed(2)} category=${result.category ?? '-'} model=${result.model ?? '-'}`;
}
