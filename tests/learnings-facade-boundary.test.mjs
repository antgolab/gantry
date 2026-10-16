/**
 * learnings-facade-boundary.test.mjs — facade 边界静态守护 (T-FIX-08)
 *
 * 锁定 learnings/index.mjs 是唯一对外入口:
 *   - src/cli.mjs / src/commands/*.mjs / src/lib/context-pack.mjs
 *     的 import / export / dynamic-import 语句不得直接引用 learnings 内部子模块
 *     (bm25|store|frontmatter|migrator|maintainer).mjs,只允许 learnings/index.mjs。
 *   - learnings/index.mjs 自身可以 import 子模块(facade 内部白名单)。
 *
 * 实现:fs.readFileSync + 正则,零依赖(不引入 AST 解析器)。
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const FORBIDDEN_SUBMODULES = ['bm25', 'store', 'frontmatter', 'migrator', 'maintainer'];
const FORBIDDEN_RE = new RegExp(`learnings\\/(${FORBIDDEN_SUBMODULES.join('|')})\\.mjs`);
const FACADE_RE = /learnings\/index\.mjs/;

// 受守护的三类文件:cli / commands / context-pack。
function guardedFiles() {
  const commandsDir = join(ROOT, 'src', 'commands');
  const commands = readdirSync(commandsDir)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => join(commandsDir, f));
  return [
    join(ROOT, 'src', 'cli.mjs'),
    join(ROOT, 'src', 'lib', 'context-pack.mjs'),
    ...commands,
  ];
}

// 抽取文件中所有模块说明符(static import / export-from / dynamic import),零依赖。
function allSpecifiers(content) {
  const out = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(content))) out.push(m[1]);
  }
  return out;
}

test('cli / commands / context-pack 不得直接 import learnings 子模块(只能走 index facade)', () => {
  for (const file of guardedFiles()) {
    const rel = file.slice(ROOT.length + 1);
    const content = readFileSync(file, 'utf8');
    const specs = allSpecifiers(content).filter((s) => s.includes('learnings'));
    for (const spec of specs) {
      assert.ok(
        !FORBIDDEN_RE.test(spec),
        `${rel} 直接引用了 learnings 子模块: ${spec} —— 必须改为 learnings/index.mjs`,
      );
      assert.ok(FACADE_RE.test(spec), `${rel} 引用了 learnings 但非 facade: ${spec}`);
    }
  }
});

test('learnings/index.mjs 自身可以 import 内部子模块(facade 白名单)', () => {
  const indexPath = join(ROOT, 'src', 'lib', 'learnings', 'index.mjs');
  const content = readFileSync(indexPath, 'utf8');
  const specs = allSpecifiers(content);

  // facade 内部必须 re-export 各子模块的公开 API(相对路径 ./<子模块>.mjs)。
  assert.ok(specs.includes('./store.mjs'), 'index 应 re-export store.mjs');
  assert.ok(specs.includes('./frontmatter.mjs'), 'index 应 re-export frontmatter.mjs');
  assert.ok(specs.includes('./bm25.mjs'), 'index 应 re-export bm25.mjs');

  // facade 自身不得 import 自己(自引用)。
  assert.ok(specs.every((s) => !FACADE_RE.test(s)), 'index.mjs 不应 import 自身');
});
