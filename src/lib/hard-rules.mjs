/**
 * hard-rules.mjs — Gantry 全局硬红线常量单点 (ADR-001 / ADR-006)
 *
 * 唯一权威来源: 任何"这次不能走 light / 需要升 full"的判定统一从此文件 import,禁重复定义。
 * 本文件吸收原 pipeline-policy.mjs#LIGHT_RISK_RULES 的 7 类风险 (DESIGN D10),
 * 并在执行期守卫与创建期预检间共享同一份 rule id 集合 (SPEC AC-12)。
 *
 * 纯函数纪律: 本文件所有导出均为无副作用纯数据 / 纯函数,不读文件、不碰 process。
 */

/**
 * 硬红线关键词: description 命中任一关键词即判定命中。
 *
 * 匹配语义 (DESIGN D10):
 * - 英文关键词按 `\b` 词边界、大小写不敏感匹配: `author` 不命中 `auth`,`tokenizer` 不命中 `token`。
 * - 中文关键词保持子串匹配 (中文无词边界)。
 *
 * ruleId 命名与 SPEC AC-2 对齐 (schema-change / auth-keyword / dep-change)。
 * 前 7 条为既有 ruleId,关键词集在 D10 下只增不减。
 */
export const HARD_RULE_KEYWORDS = [
  // schema-or-migration(D10 吸收)
  {
    ruleId: 'schema-change',
    keywords: ['schema', 'database', 'table', 'column', 'index', 'foreign key', '数据库', '数据表', '建表', '改表', '字段', '索引', '外键'],
  },
  { ruleId: 'migration-change', keywords: ['migrations', 'migration', 'migrate', '数据库迁移', '数据迁移', '迁移'] },
  { ruleId: 'auth-keyword', keywords: ['auth', '鉴权', '认证', '登录'] },
  { ruleId: 'permission-keyword', keywords: ['permission', '权限', '授权'] },
  { ruleId: 'crypto-keyword', keywords: ['crypto', '加密', '密码学'] },
  { ruleId: 'token-keyword', keywords: ['token', '令牌', '口令'] },
  { ruleId: 'secret-keyword', keywords: ['secret', '密钥', '密文', '凭证'] },
  // D10 新增类别
  {
    ruleId: 'contract-keyword',
    keywords: ['public api', 'public contract', 'api signature', 'grpc', 'graphql', 'openapi', '公共接口', '公共契约', '接口签名'],
  },
  {
    ruleId: 'cross-module-keyword',
    keywords: ['cross-module', 'cross module', 'multi-module', 'multi module', 'microservice', '跨模块', '多模块', '跨服务', '微服务'],
  },
  // 注: 不含裸词 `dependency` / `dependencies`,避免与既有 dep-change
  // (pkgJsonDepsDelta 非空)判据在 `add dependency` 这类描述上抢占 precedence。
  {
    ruleId: 'dependency-keyword',
    keywords: ['third-party', 'third party', 'package upgrade', '外部依赖', '依赖升级', '新增依赖', '第三方依赖'],
  },
  {
    ruleId: 'security-keyword',
    keywords: ['authentication', 'authorization', 'security', 'payment', '安全', '支付'],
  },
  {
    ruleId: 'concurrency-keyword',
    keywords: ['concurrency', 'concurrent', 'async', 'goroutine', 'thread', 'queue', 'scheduler', '并发', '异步', '协程', '线程', '队列', '定时任务'],
  },
  {
    ruleId: 'destructive-keyword',
    keywords: ['delete', 'remove', 'rename', 'breaking change', '删除', '移除', '重命名', '破坏性变更'],
  },
];

/**
 * 硬红线路径 glob: 变更文件路径命中任一 glob 即判定命中。
 * glob 语义对齐 minimatch 子集: `*` 不跨 `/`, `**` 跨 `/`, 其余元字符按字面转义。
 */
export const HARD_RULE_PATH_GLOBS = [
  { ruleId: 'schema-change', glob: 'schema/*' },
  { ruleId: 'migration-change', glob: 'migrations/*' },
  { ruleId: 'sql-change', glob: '**/*.sql' },
  { ruleId: 'schema-change', glob: 'prisma/*' },
  { ruleId: 'contract-change', glob: 'api/*.ts' },
  { ruleId: 'contract-change', glob: 'openapi.yaml' },
  { ruleId: 'contract-change', glob: 'proto/*' },
];

/**
 * 跨模块判定阈值: 非测试、非文档路径 (D11) 分布在 ≥ 该数量的顶层目录时判定为跨模块修改
 * (F-fast 红线「跨模块或跨服务修改」)。
 */
export const HARD_RULE_MODULE_COUNT_THRESHOLD = 3;

const CJK_RE = /[一-鿿]/;
const WORD_BOUNDARY_CACHE = new Map();

/**
 * 为单个关键词构造匹配器:
 * - 含中日韩字符 → 子串匹配 (`String#includes`)。
 * - 纯英文关键词 → `\b<keyword>\b` 大小写不敏感,元字符按字面转义。
 */
function keywordMatcher(keyword) {
  if (CJK_RE.test(keyword)) {
    return (text) => text.includes(keyword);
  }
  let re = WORD_BOUNDARY_CACHE.get(keyword);
  if (!re) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(`\\b${escaped}\\b`, 'i');
    WORD_BOUNDARY_CACHE.set(keyword, re);
  }
  return (text) => re.test(text);
}

const COMPILED_KEYWORD_RULES = HARD_RULE_KEYWORDS.map(({ ruleId, keywords }) => ({
  ruleId,
  matchers: keywords.map(keywordMatcher),
}));

/**
 * 测试文件识别 (DESIGN D12): 供硬红线跨模块判定与执行期守卫 (test-weakened) 复用。
 *
 * 命中任一即返回 true:
 * - 路径含 `(^|/)(tests?|__tests__|spec)/` 段;
 * - basename 含 `.test.` 或 `.spec.`;
 * - basename 以 `_test.go` 结尾;
 * - basename 以 `test_` 开头且以 `.py` 结尾。
 */
export function isTestPath(path) {
  const p = String(path ?? '');
  if (/(^|\/)(tests?|__tests__|spec)\//.test(p)) return true;
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (base.includes('.test.') || base.includes('.spec.')) return true;
  if (base.endsWith('_test.go')) return true;
  if (base.startsWith('test_') && base.endsWith('.py')) return true;
  return false;
}

/**
 * 文档路径识别: `docs/` 前缀或 `*.md` 文件。跨模块判定排除 (D11)。
 */
function isDocPath(path) {
  const p = String(path ?? '');
  if (p.startsWith('docs/')) return true;
  if (p.endsWith('.md')) return true;
  return false;
}

/**
 * 检测 fsSnapshot + description 是否命中任一硬红线。
 * 纯函数,无副作用。
 *
 * 返回:
 * - `ruleId`: 首个命中的 rule id,precedence 为 关键词 → 路径 glob → 依赖增量 → 跨模块,
 *   与历史行为一致(兼容既有调用方)。
 * - `ruleIds`: 全部命中的 rule id (去重,保持上述 precedence 顺序)。
 * - `files`: 触发路径 glob / 跨模块规则的变更文件 (去重)。
 *
 * @param {object} fsSnapshot - { modifiedFiles: string[], newFiles: string[], pkgJsonDepsDelta: string[] }
 * @param {string} description - 变更描述
 * @returns {{ hit: boolean, ruleId: string|null, ruleIds: string[], files: string[] }}
 */
export function detectHardRuleHit(fsSnapshot, description) {
  const snapshot = normalizeSnapshot(fsSnapshot);
  const text = String(description ?? '');

  const ruleIds = [];
  const files = [];
  const addRule = (id) => { if (!ruleIds.includes(id)) ruleIds.push(id); };
  const addFile = (f) => { if (!files.includes(f)) files.push(f); };

  // 1. 关键词红线 (英文词边界 / 中文子串, D10)
  for (const { ruleId, matchers } of COMPILED_KEYWORD_RULES) {
    if (matchers.some((match) => match(text))) addRule(ruleId);
  }

  // 2. 路径 glob 红线
  const allFiles = [...snapshot.modifiedFiles, ...snapshot.newFiles];
  for (const { ruleId, glob } of HARD_RULE_PATH_GLOBS) {
    const re = globToRegExp(glob);
    const matched = allFiles.filter((file) => re.test(file));
    if (matched.length > 0) {
      addRule(ruleId);
      matched.forEach(addFile);
    }
  }

  // 3. 依赖增量红线
  if (snapshot.pkgJsonDepsDelta.length > 0) addRule('dep-change');

  // 4. 跨模块红线 (D11: 仅统计非测试、非文档路径)
  const codeFiles = snapshot.modifiedFiles.filter((file) => !isTestPath(file) && !isDocPath(file));
  if (distinctTopLevelDirs(codeFiles).length >= HARD_RULE_MODULE_COUNT_THRESHOLD) {
    addRule('cross-module-change');
    codeFiles.forEach(addFile);
  }

  return {
    hit: ruleIds.length > 0,
    ruleId: ruleIds.length > 0 ? ruleIds[0] : null,
    ruleIds,
    files,
  };
}

/**
 * `detectHardRuleHit` 的别名 (DESIGN D10 红线唯一源)。
 * 执行期守卫 (light-guard) 以「红线检测」语义调用同一函数。
 */
export function detectRedLines(fsSnapshot, description) {
  return detectHardRuleHit(fsSnapshot, description);
}

function normalizeSnapshot(fsSnapshot) {
  const s = fsSnapshot || {};
  return {
    modifiedFiles: Array.isArray(s.modifiedFiles) ? s.modifiedFiles : [],
    newFiles: Array.isArray(s.newFiles) ? s.newFiles : [],
    pkgJsonDepsDelta: Array.isArray(s.pkgJsonDepsDelta) ? s.pkgJsonDepsDelta : [],
  };
}

/**
 * 把 hard-rules 路径 glob 转成正则, 对齐 minimatch 子集:
 * - `*` 不跨 `/` → `[^/]*`
 * - `**` 跨 `/` → `.*`
 * - 夹在两个 `/` 之间的 `**` 允许 0 层目录, 译为可选跨路径段,
 *   因此 `src/**` 加 `*.mjs` 这类 glob 同时匹配 `src/foo.mjs` 与 `src/lib/nested/deep/foo.mjs`
 * - 其余正则元字符 (`.` / `+` / `?` / `^` / `$` / `{}` / `()` / `|` / `[]` / `\`) 全部按字面转义
 */
export function globToRegExp(glob) {
  // 先占位 `/**/`, 稍后译成"0 层或 ≥1 层目录"(minimatch: `a/**/b` 可匹配 `a/b`)
  let result = glob.replace(/\/\*\*\//g, '__SLASH_DBLSTAR__');

  // 转义除 `*` 之外的所有正则元字符
  result = result.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

  // `**` → 占位 → `.*` (跨 `/`); 剩余 `*` → `[^/]*` (不跨 `/`)
  result = result.replace(/\*\*/g, '__GLOB_DBLSTAR__');
  result = result.replace(/\*/g, '[^/]*');
  result = result.replace(/__GLOB_DBLSTAR__/g, '.*');

  // `/**/` → `(?:/.*/|/)`, 同时允许 0 层与 ≥1 层目录
  result = result.replace(/__SLASH_DBLSTAR__/g, '(?:/.*/|/)');

  return new RegExp(`^${result}$`);
}

function distinctTopLevelDirs(files) {
  const dirs = new Set();
  for (const file of files) {
    const idx = file.indexOf('/');
    dirs.add(idx === -1 ? '' : file.slice(0, idx));
  }
  return [...dirs];
}
