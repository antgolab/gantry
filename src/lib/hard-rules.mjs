/**
 * hard-rules.mjs — Gantry 全局硬红线常量单点 (ADR-001)
 *
 * 唯一权威来源: 任何"这次不能走 light / micro"的判定统一从此文件 import,禁重复定义。
 * 派生自 .gantry/core/phases/F-fast.md「不可进入 FAST 的变更」红线列表。
 *
 * 纯函数纪律: 本文件所有导出均为无副作用纯数据 / 纯函数,不读文件、不碰 process。
 */

/**
 * 硬红线关键词: description 命中任一关键词即判定命中。
 * ruleId 命名与 SPEC AC-2 对齐 (schema-change / auth-keyword / dep-change)。
 * 中英双语 (DESIGN R8): 英文为任务钦定关键词,中文为 F-fast 红线对应术语。
 */
export const HARD_RULE_KEYWORDS = [
  { ruleId: 'schema-change', keywords: ['schema', '数据库', '数据表', '建表', '改表'] },
  { ruleId: 'migration-change', keywords: ['migrations', 'migration', '数据库迁移', '数据迁移'] },
  { ruleId: 'auth-keyword', keywords: ['auth', '鉴权', '认证', '登录'] },
  { ruleId: 'permission-keyword', keywords: ['permission', '权限', '授权'] },
  { ruleId: 'crypto-keyword', keywords: ['crypto', '加密', '密码学'] },
  { ruleId: 'token-keyword', keywords: ['token', '令牌', '口令'] },
  { ruleId: 'secret-keyword', keywords: ['secret', '密钥', '密文', '凭证'] },
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
 * 跨模块判定阈值: modifiedFiles 分布在 ≥ 该数量的顶层目录时判定为跨模块修改
 * (F-fast 红线「跨模块或跨服务修改」)。
 */
export const HARD_RULE_MODULE_COUNT_THRESHOLD = 3;

/**
 * 检测 fsSnapshot + description 是否命中任一硬红线。
 * 纯函数,无副作用。
 *
 * @param {object} fsSnapshot - { modifiedFiles: string[], newFiles: string[], pkgJsonDepsDelta: string[] }
 * @param {string} description - 变更描述
 * @returns {{ hit: boolean, ruleId: string|null }}
 */
export function detectHardRuleHit(fsSnapshot, description) {
  const snapshot = normalizeSnapshot(fsSnapshot);
  const text = String(description ?? '').toLowerCase();

  const keywordHit = HARD_RULE_KEYWORDS.find(({ keywords }) =>
    keywords.some((kw) => text.includes(kw.toLowerCase())),
  );
  if (keywordHit) return { hit: true, ruleId: keywordHit.ruleId };

  const files = [...snapshot.modifiedFiles, ...snapshot.newFiles];
  const pathHit = HARD_RULE_PATH_GLOBS.find(({ glob }) => {
    const re = globToRegExp(glob);
    return files.some((file) => re.test(file));
  });
  if (pathHit) return { hit: true, ruleId: pathHit.ruleId };

  if (snapshot.pkgJsonDepsDelta.length > 0) {
    return { hit: true, ruleId: 'dep-change' };
  }

  if (distinctTopLevelDirs(snapshot.modifiedFiles).length >= HARD_RULE_MODULE_COUNT_THRESHOLD) {
    return { hit: true, ruleId: 'cross-module-change' };
  }

  return { hit: false, ruleId: null };
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
