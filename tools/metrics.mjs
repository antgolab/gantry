#!/usr/bin/env node
// gantry metrics — monthly adoption scan
// Usage:
//   node tools/metrics.mjs [--target <repo>] [--since "1 month ago"] [--out .gantry/specs/metrics]
// 产物: <out>/<YYYY-MM>.md
// 非 KPI · 非考核 · 只给 Curator 与团队 retro 用

import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const args = parseArgs(process.argv.slice(2));
const TARGET = resolve(args.target ?? '.');
const SINCE = args.since ?? '1 month ago';
const OUT_DIR = resolve(TARGET, args.out ?? '.gantry/specs/metrics');
const SPECS = resolve(TARGET, '.gantry/specs');

if (!existsSync(join(TARGET, '.git'))) {
  console.error(`[metrics] not a git repo: ${TARGET}`);
  process.exit(1);
}

console.log(`[metrics] target=${TARGET}`);
console.log(`[metrics] since=${SINCE}`);

const commits = loadCommits(TARGET, SINCE);
const changes = loadChanges(SPECS);
const knowledge = loadKnowledge(SPECS);
const lessons = loadLessons(SPECS);

const report = render({ commits, changes, knowledge, lessons, since: SINCE, target: TARGET });

mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().slice(0, 7); // YYYY-MM
const outPath = join(OUT_DIR, `${stamp}.md`);
writeFileSync(outPath, report);
console.log(`[metrics] wrote ${outPath}`);

// -----------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[k] = true;
      else { out[k] = next; i++; }
    }
  }
  return out;
}

function sh(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return '';
  }
}

function loadCommits(cwd, since) {
  // 分隔符用 -- 避免和 commit 内容冲突
  const fmt = '%H\t%an\t%ae\t%ai\t%s';
  const raw = sh(`git log --since='${since.replace(/'/g, "'\\''")}' --pretty='${fmt}'`, cwd);
  const rows = raw.split('\n').filter(Boolean).map((line) => {
    const [hash, author, email, iso, subject] = line.split('\t');
    return { hash, author, email, iso, subject };
  });
  return rows;
}

function loadChanges(specsRoot) {
  if (!existsSync(specsRoot)) return { active: [], archived: [] };
  const active = [];
  const archived = [];
  for (const name of readdirSync(specsRoot)) {
    const full = join(specsRoot, name);
    if (!statSync(full).isDirectory()) continue;
    if (name === '_archive' || name === 'archive') {
      for (const sub of readdirSync(full)) {
        const subFull = join(full, sub);
        if (statSync(subFull).isDirectory()) archived.push(inspectChange(subFull, sub));
      }
      continue;
    }
    if (['knowledge', 'health', 'metrics'].includes(name)) continue;
    active.push(inspectChange(full, name));
  }
  return { active, archived };
}

function inspectChange(dir, id) {
  const want = {
    PROPOSAL: ['PROPOSAL.md', 'CHANGE.md'],
    SPEC: ['SPEC.md', 'REQUIREMENT.md'],
    DESIGN: ['DESIGN.md'],
    TASKS: ['TASKS.md', 'TASK.md'],
    EXECUTION: ['EXECUTION.md', 'SUMMARY.md'],
    TEST: ['TEST.md'],
    REVIEW: ['REVIEW.md'],
  };
  const present = {};
  for (const [key, names] of Object.entries(want)) present[key] = names.some((f) => existsSync(join(dir, f)));
  return { id, present };
}

function loadKnowledge(specsRoot) {
  const dir = join(specsRoot, 'knowledge');
  if (!existsSync(dir)) return [];
  const rows = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const full = join(dir, name);
    const text = readFileSync(full, 'utf8');
    const fm = text.match(/^---\n([\s\S]+?)\n---/);
    const frontmatter = fm ? fm[1] : '';
    rows.push({
      name,
      date: (frontmatter.match(/^date:\s*(.+)$/m) ?? [])[1] ?? '',
      author: (frontmatter.match(/^author:\s*(.+)$/m) ?? [])[1] ?? '',
      status: (frontmatter.match(/^status:\s*(.+)$/m) ?? [])[1] ?? 'unknown',
    });
  }
  return rows;
}

function loadLessons(specsRoot) {
  const f = join(specsRoot, 'LESSONS.md');
  if (!existsSync(f)) return { active: 0, deprecated: 0, pending: 0 };
  const text = readFileSync(f, 'utf8');
  const active = (text.match(/状态[:：]\s*active/gi) ?? []).length;
  const deprecated = (text.match(/状态[:：]\s*(deprecated|superseded|stale)/gi) ?? []).length;
  const pendingSection = text.split(/##\s*待审/)[1] ?? '';
  const pending = (pendingSection.match(/^##\s+L-/gm) ?? []).length;
  return { active, deprecated, pending };
}

function render({ commits, changes, knowledge, lessons, since, target }) {
  const total = commits.length;
  const fast = commits.filter((c) => /^fast:/i.test(c.subject)).length;
  const feat = commits.filter((c) => /^feat\(/i.test(c.subject)).length;
  const fix = commits.filter((c) => /^fix\(/i.test(c.subject)).length;
  const docs = commits.filter((c) => /^docs/i.test(c.subject)).length;
  const other = total - fast - feat - fix - docs;

  const byAuthor = {};
  for (const c of commits) {
    byAuthor[c.author] ??= { total: 0, fast: 0 };
    byAuthor[c.author].total++;
    if (/^fast:/i.test(c.subject)) byAuthor[c.author].fast++;
  }

  const changeIds = [...changes.active, ...changes.archived];
  const coverage = { PROPOSAL: 0, SPEC: 0, DESIGN: 0, TASKS: 0, EXECUTION: 0, TEST: 0, REVIEW: 0 };
  for (const ch of changeIds) {
    for (const k of Object.keys(coverage)) if (ch.present[k]) coverage[k]++;
  }

  const fastRatio = total ? ((fast / total) * 100).toFixed(1) : '0.0';
  const fastWarn = Number(fastRatio) > 40 ? ' ⚠️ 过高 (>40%) · 疑似绕流程' : '';

  return `# gantry metrics · ${new Date().toISOString().slice(0, 10)}

> 非 KPI · 非考核 · 给 Curator 月度 review / 团队 retro 用。
> 扫描窗口：${since} → 现在
> 仓库：${target}

---

## 1. commit 分布

| 类型 | 数量 | 占比 |
|---|---|---|
| \`fast:\` | ${fast} | ${fastRatio}%${fastWarn} |
| \`feat(<id>):\` | ${feat} | ${pct(feat, total)}% |
| \`fix(<id>):\` | ${fix} | ${pct(fix, total)}% |
| \`docs:\` | ${docs} | ${pct(docs, total)}% |
| 其他 | ${other} | ${pct(other, total)}% |
| **合计** | **${total}** | 100% |

## 2. fast: commit 作者分布

| 作者 | 总 commit | fast: 数 | fast 占比 |
|---|---|---|---|
${Object.entries(byAuthor)
  .sort((a, b) => b[1].total - a[1].total)
  .map(([a, v]) => `| ${a} | ${v.total} | ${v.fast} | ${pct(v.fast, v.total)}% |`)
  .join('\n') || '| — | — | — | — |'}

> **关注信号**：单人 \`fast:\` 占比 > 50% 且总 commit ≥ 5 → 建议 1-on-1 了解是不是在绕流程。

## 3. 阶段产物覆盖率

扫 \`.gantry/specs/\` active + archive 所有 change（共 **${changeIds.length}** 个）。

| 阶段产物 | 产出数 | 覆盖率 |
|---|---|---|
| PROPOSAL.md（兼容 CHANGE.md） | ${coverage.PROPOSAL} | ${pct(coverage.PROPOSAL, changeIds.length)}% |
| SPEC.md（兼容 REQUIREMENT.md） | ${coverage.SPEC} | ${pct(coverage.SPEC, changeIds.length)}% |
| DESIGN.md | ${coverage.DESIGN} | ${pct(coverage.DESIGN, changeIds.length)}% |
| TASKS.md（兼容 TASK.md） | ${coverage.TASKS} | ${pct(coverage.TASKS, changeIds.length)}% |
| EXECUTION.md（兼容 SUMMARY.md） | ${coverage.EXECUTION} | ${pct(coverage.EXECUTION, changeIds.length)}% |
| TEST.md | ${coverage.TEST} | ${pct(coverage.TEST, changeIds.length)}% |
| REVIEW.md | ${coverage.REVIEW} | ${pct(coverage.REVIEW, changeIds.length)}% |

> **关注信号**：REVIEW.md 覆盖率 < 70% → review 阶段被系统性跳过。

## 4. 知识库（\`.gantry/specs/knowledge/\`）

- 条目总数：${knowledge.length}
- 近 30 天新增：${knowledge.filter((k) => withinDays(k.date, 30)).length}
- 按状态：${groupStatus(knowledge)}

按作者：

| 作者 | 条目数 |
|---|---|
${countBy(knowledge, 'author')
  .map(([a, n]) => `| ${a || '未知'} | ${n} |`)
  .join('\n') || '| — | — |'}

> **关注信号**：knowledge 条目总数 0 → 调研没有沉淀，下次同问题会重复查。

## 5. LESSONS

- active 条目：${lessons.active}
- deprecated / superseded / stale：${lessons.deprecated}
- 待审（INTEGRATION 提名未 Curator 合入）：${lessons.pending}

> **关注信号**：active = 0 且 archive ≥ 5 → 失败没被提名，下次同错重犯风险高。
> 待审 > 20 → Curator 月度 review 积压。

## 6. 建议行动（Curator 月度 review 时填）

- [ ] 有 ⚠️ 信号的指标逐条讨论
- [ ] LESSONS 待审条目合入 / 丢弃
- [ ] knowledge 超过 6 个月未引用的条目标 stale
- [ ] 报告归档，下月再跑

---

**使用说明**：本报告每月跑一次（建议每月 1 号）。
\`\`\`
node gantry/tools/metrics.mjs --target <your-repo>
\`\`\`

> 本工具是观察镜，不是考核表。指标异常不是"谁有错"，是"流程/工具可能有问题"的信号。
`;
}

function pct(n, total) {
  if (!total) return '0.0';
  return ((n / total) * 100).toFixed(1);
}

function withinDays(dateStr, days) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return false;
  return (Date.now() - d.getTime()) < days * 86400 * 1000;
}

function countBy(rows, key) {
  const m = {};
  for (const r of rows) m[r[key]] = (m[r[key]] ?? 0) + 1;
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}

function groupStatus(rows) {
  const m = {};
  for (const r of rows) m[r.status] = (m[r.status] ?? 0) + 1;
  return Object.entries(m).map(([k, v]) => `${k}=${v}`).join(' · ') || '无';
}
