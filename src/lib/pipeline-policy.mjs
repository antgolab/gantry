const VALID_PIPELINES = new Set(['full', 'light']);

const LIGHT_RISK_RULES = [
  ['schema-or-migration', /\b(schema|migration|migrate|database|table|column|index|foreign key)\b|数据库|数据表|迁移|字段|索引|外键/i],
  ['public-contract', /\b(public api|public contract|api signature|grpc|graphql|openapi)\b|公共接口|公共契约|接口签名/i],
  ['cross-module', /\b(cross[- ]module|multi[- ]module|microservice)\b|跨模块|多模块|跨服务|微服务/i],
  ['dependency', /\b(dependency|dependencies|package upgrade|third[- ]party)\b|依赖升级|新增依赖|第三方依赖/i],
  ['security', /\b(auth|authentication|authorization|permission|security|payment)\b|鉴权|认证|权限|安全|支付/i],
  ['concurrency', /\b(concurrency|concurrent|async|goroutine|thread|queue|scheduler)\b|并发|异步|协程|线程|队列|定时任务/i],
  ['destructive', /\b(delete|remove|rename|breaking change)\b|删除|移除|重命名|破坏性变更/i],
];

export function normalizePipeline(value) {
  const pipeline = value || 'full';
  if (pipeline === 'standard') return 'full';
  if (VALID_PIPELINES.has(pipeline)) return pipeline;
  throw new Error(`未知 pipeline: ${pipeline}（可用: full, light）`);
}

export function assessLightEligibility(text = '') {
  const risks = LIGHT_RISK_RULES
    .filter(([, pattern]) => pattern.test(String(text)))
    .map(([id]) => id);
  return { eligible: risks.length === 0, risks };
}

export function proposalHasUiImpact(text = '') {
  const content = String(text);
  return /(?:^|\n)\s*uiImpact\s*:\s*true\b/im.test(content)
    || /(?:^|\n)\s*-?\s*\*{0,2}UI\s*影响\*{0,2}\s*:\s*`?(?:是|true|yes)`?\s*$/im.test(content);
}
