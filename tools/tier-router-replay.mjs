#!/usr/bin/env node
/**
 * tier-router-replay.mjs — 归档回放验证脚本 (质量门 AC-11)
 *
 * 扫描 --archives 目录下所有归档 change,用 decideTier 静态重放历史判定,
 * 计算一致率 (硬红线 100% / 软打分 ≥80% 分解)。低于 --min-accuracy 时非 0 退出。
 *
 * 用法:
 *   node tools/tier-router-replay.mjs --archives .gantry/specs/_archive [--min-accuracy 0.85] [--tune-suggest]
 *   node tools/tier-router-replay.mjs --seed-fixture .gantry/specs/small-team-mode/seed-fixture.jsonl [--min-accuracy 0.85]
 *
 * --seed-fixture <path>: 从 JSONL 固化样本判定 (取代归档回放,二者同给时 fixture 优先)。
 *   每行一个 JSON: {"description": "...", "filesChanged": [...], "newFiles": [...], "deps": [...],
 *                    "tierOverride": "...", "expectedTier": "micro|light|full", "expectedHits": [...]}
 *   其中 filesChanged 为数组(映射 modifiedFiles,也可直接给完整 fsSnapshot 对象),
 *   newFiles / deps / tierOverride / expectedHits 均可选。
 *
 * 同时可 import 复用纯函数:
 *   import { runReplay } from './tools/tier-router-replay.mjs';
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decideTier } from '../src/lib/tier-router.mjs';

const DEFAULT_ARCHIVES = '.gantry/specs/_archive';
const DEFAULT_MIN_ACCURACY = 0.85;

/**
 * 归档回放主函数 (纯函数,不碰 process、不决定退出码)。
 *
 * @param {object} opts
 * @param {string} opts.archivesDir - 归档目录 (每子目录为一个 change)
 * @param {number} [opts.minAccuracy=0.85] - 一致率红线,低于则 code=replay_below_threshold
 * @param {boolean} [opts.tuneSuggest=false] - 是否生成权重调整建议 (不改配置)
 * @param {object|function} [opts.fsSnapshot] - 额外 opt: 桩化 fsSnapshot;
 *        传入函数时以 ({ changeId, description, actualTier }) 为参逐 case 求值;
 *        传入对象时对所有 case 复用;缺省用空 snapshot。
 * @returns {{ code: string, total: number, correct: number, accuracy: number,
 *            hardRuleAccuracy: number, softScoreAccuracy: number,
 *            cases: Array<object>, skipped: Array<object>, suggestions: Array<string> }}
 */
export function runReplay({ archivesDir, minAccuracy = DEFAULT_MIN_ACCURACY, tuneSuggest = false, fsSnapshot, seedFixture } = {}) {
  if (seedFixture) {
    return runSeedFixtureReplay({ seedFixture, minAccuracy, tuneSuggest });
  }

  const cases = [];
  const skipped = [];

  for (const dir of listChangeDirs(archivesDir)) {
    const changeId = basename(dir);
    const proposalText = readIfExists(join(dir, 'PROPOSAL.md'));
    const executionText = readIfExists(join(dir, 'EXECUTION.md'));
    const stateText = readIfExists(join(dir, 'STATE.md'));

    const description = proposalText != null ? extractDescription(proposalText) : '';

    const actualTier = resolveActualTier(executionText, stateText);
    if (!actualTier) {
      skipped.push({ changeId, reason: 'missing-tier-decision' });
      continue;
    }

    const snapshot = resolveSnapshot(fsSnapshot, { changeId, description, actualTier });
    const predicted = decideTier(description, snapshot, {});
    const correct = predicted.tier === actualTier;

    cases.push({
      changeId,
      description,
      actualTier,
      predictedTier: predicted.tier,
      correct,
      hits: predicted.hits,
      score: predicted.score,
    });
  }

  const total = cases.length;
  const correct = cases.filter((c) => c.correct).length;
  const accuracy = total > 0 ? correct / total : 0;

  const hardCases = cases.filter((c) => isHardRuleHit(c.hits));
  const softCases = cases.filter((c) => !isHardRuleHit(c.hits));
  const hardRuleAccuracy = hardCases.length > 0
    ? hardCases.filter((c) => c.correct).length / hardCases.length
    : 1;
  const softScoreAccuracy = softCases.length > 0
    ? softCases.filter((c) => c.correct).length / softCases.length
    : 1;

  const code = total === 0
    ? 'replay_no_data'
    : accuracy >= minAccuracy
      ? 'replay_pass'
      : 'replay_below_threshold';

  const suggestions = tuneSuggest ? buildSuggestions(cases) : [];

  return { code, total, correct, accuracy, hardRuleAccuracy, softScoreAccuracy, cases, skipped, suggestions };
}

/**
 * seed-fixture 回放 (T-FIX-04): 从 JSONL 固化样本逐条用 decideTier 判定,
 * 对比 expectedTier 计算一致率。fixture 优先于 archives (二者同给时走 fixture)。
 *
 * @param {object} opts
 * @param {string} opts.seedFixture - JSONL 路径 (每行 {description, filesChanged?, expectedTier})
 * @param {number} opts.minAccuracy - 一致率红线,低于则 code=fixture_below_threshold
 * @param {boolean} opts.tuneSuggest - 是否生成权重建议
 * @returns {{ source: 'seed-fixture', code: string, total: number, correct: number,
 *            accuracy: number, hardRuleAccuracy: number, softScoreAccuracy: number,
 *            cases: Array<object>, skipped: Array<object>, suggestions: Array<string> }}
 */
function runSeedFixtureReplay({ seedFixture, minAccuracy, tuneSuggest }) {
  const cases = [];
  const skipped = [];
  const entries = readSeedFixture(seedFixture);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.__error) {
      skipped.push({ line: i + 1, reason: entry.__error });
      continue;
    }
    if (entry.description == null || entry.expectedTier == null) {
      skipped.push({ line: i + 1, reason: 'missing-description-or-expectedTier' });
      continue;
    }

    const snapshot = snapshotFromFixture(entry);
    const predicted = decideTier(entry.description, snapshot, {});
    const correct = predicted.tier === entry.expectedTier;

    cases.push({
      description: entry.description,
      expectedTier: entry.expectedTier,
      tierOverride: entry.tierOverride ?? null,
      predictedTier: predicted.tier,
      correct,
      hits: predicted.hits,
      score: predicted.score,
      expectedHits: entry.expectedHits ?? null,
    });
  }

  const total = cases.length;
  const correct = cases.filter((c) => c.correct).length;
  const accuracy = total > 0 ? correct / total : 0;

  const hardCases = cases.filter((c) => isHardRuleHit(c.hits));
  const softCases = cases.filter((c) => !isHardRuleHit(c.hits));
  const hardRuleAccuracy = hardCases.length > 0
    ? hardCases.filter((c) => c.correct).length / hardCases.length
    : 1;
  const softScoreAccuracy = softCases.length > 0
    ? softCases.filter((c) => c.correct).length / softCases.length
    : 1;

  const code = total === 0
    ? 'replay_no_data'
    : accuracy >= minAccuracy
      ? 'fixture_pass'
      : 'fixture_below_threshold';

  const suggestions = tuneSuggest ? buildSuggestions(cases) : [];

  return {
    source: 'seed-fixture',
    code,
    total,
    correct,
    accuracy,
    hardRuleAccuracy,
    softScoreAccuracy,
    cases,
    skipped,
    suggestions,
  };
}

/**
 * 读取 JSONL fixture: 每行一个 JSON 对象;空行忽略;非法行记入 skipped (__error 标记)。
 */
function readSeedFixture(seedFixture) {
  const text = readIfExists(seedFixture);
  if (text == null) return [];
  const entries = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      entries.push({ __error: 'invalid-json-line' });
    }
  }
  return entries;
}

/**
 * fixture 行 → fsSnapshot:
 *   filesChanged 为数组 → 映射 modifiedFiles (可选 newFiles / deps 补充其余字段);
 *   filesChanged 为对象 → 直接视为完整 fsSnapshot。
 */
function snapshotFromFixture(entry) {
  const { filesChanged } = entry;
  if (filesChanged && !Array.isArray(filesChanged)) {
    return {
      modifiedFiles: Array.isArray(filesChanged.modifiedFiles) ? filesChanged.modifiedFiles : [],
      newFiles: Array.isArray(filesChanged.newFiles) ? filesChanged.newFiles : [],
      pkgJsonDepsDelta: Array.isArray(filesChanged.pkgJsonDepsDelta) ? filesChanged.pkgJsonDepsDelta : [],
    };
  }
  return {
    modifiedFiles: Array.isArray(filesChanged) ? filesChanged : [],
    newFiles: Array.isArray(entry.newFiles) ? entry.newFiles : [],
    pkgJsonDepsDelta: Array.isArray(entry.deps) ? entry.deps : [],
  };
}

// --- 归档扫描 / 解析 ---

function listChangeDirs(archivesDir) {
  if (!archivesDir || !existsSync(archivesDir)) return [];
  try {
    return readdirSync(archivesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(archivesDir, e.name))
      .sort();
  } catch {
    return [];
  }
}

function readIfExists(p) {
  try {
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  } catch {
    return null;
  }
}

/**
 * 实际 pipeline 解析: EXECUTION.md tier-decision 段 (override 优先于 auto),
 * 退化为 STATE.md 的 pipeline/模式/Pipeline 字段。
 */
function resolveActualTier(executionText, stateText) {
  const decision = parseTierDecision(executionText);
  if (decision) {
    return decision.override ?? decision.auto;
  }
  return extractPipelineField(stateText ?? '');
}

function parseTierDecision(text) {
  if (!text) return null;
  const section = extractSection(text, 'tier-decision');
  if (!section) return null;
  const autoMatch = section.match(/^auto:\s*(micro|light|full)\s*$/m);
  const overrideMatch = section.match(/^tier-override:.*?user requested\s+(micro|light|full)/m);
  return {
    auto: autoMatch ? autoMatch[1] : null,
    override: overrideMatch ? overrideMatch[1] : null,
  };
}

function extractPipelineField(text) {
  if (!text) return null;
  // 兼容 "pipeline: micro" / "Pipeline: full" / "- **模式**: `full`" / "- **Pipeline**: full"
  const m = text.match(/(?:-\s*\*\*)?(?:pipeline|Pipeline|模式)(?:\*\*)?\s*:\s*`?(micro|light|full)`?/);
  return m ? m[1] : null;
}

/**
 * 描述抽取: 优先 `## 需求描述` 段;退化为标题 (PROPOSAL: 后) + 首个正文段。
 */
function extractDescription(text) {
  const need = extractSection(text, '需求描述');
  if (need) return need;

  let title = '';
  const titleMatch = text.match(/^#\s+PROPOSAL:\s*(.+)$/m);
  if (titleMatch) title = titleMatch[1].trim();

  let firstPara = '';
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (/^#/.test(t)) continue;          // 标题
    if (/^-\s*\*\*/.test(t)) continue;   // 前置元数据列表项
    if (/^-{3,}/.test(t)) continue;      // 分隔线
    firstPara = t;
    break;
  }

  return [title, firstPara].filter(Boolean).join(' · ');
}

/**
 * 提取 `## <heading>` 段正文 (到下一个 `## ` 或 EOF 为止)。
 */
function extractSection(text, heading) {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, 'm');
  const m = text.match(re);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = rest.match(/^##\s+/m);
  const end = next ? next.index : rest.length;
  return rest.slice(0, end).trim();
}

function isHardRuleHit(hits) {
  return (hits ?? []).some((h) => !h.startsWith('soft:'));
}

function resolveSnapshot(fsSnapshot, ctx) {
  if (typeof fsSnapshot === 'function') {
    return fsSnapshot(ctx) ?? emptySnapshot();
  }
  if (fsSnapshot && typeof fsSnapshot === 'object') {
    return fsSnapshot;
  }
  return emptySnapshot();
}

function emptySnapshot() {
  return { modifiedFiles: [], newFiles: [], pkgJsonDepsDelta: [] };
}

// --- 权重建议 (只输出文本,不改配置) ---

function buildSuggestions(cases) {
  const wrong = cases.filter((c) => !c.correct);
  if (wrong.length === 0) {
    return ['全部命中,无需调整权重'];
  }

  const softCounts = {};
  for (const c of wrong) {
    for (const h of c.hits) {
      if (h.startsWith('soft:')) softCounts[h] = (softCounts[h] ?? 0) + 1;
    }
  }

  const ranked = Object.entries(softCounts).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) {
    return ['误判 case 无软信号命中,建议检查硬红线阈值与 fsSnapshot 近似误差,而非调整权重'];
  }

  const suggestions = [];
  const [topHit, topCount] = ranked[0];
  suggestions.push(`${topHit} 命中 ${topCount} 次但伴随误判 → 考虑降权 0.5`);
  if (ranked[1]) {
    suggestions.push(`${ranked[1][0]} 命中 ${ranked[1][1]} 次 → 评估是否降权`);
  }
  return suggestions;
}

// --- CLI 模式 ---

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[k] = true;
      else {
        out[k] = next;
        i++;
      }
    }
  }
  return out;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const archivesDir = args.archives || join(process.cwd(), DEFAULT_ARCHIVES);
  const minAccuracy = args['min-accuracy'] != null ? Number(args['min-accuracy']) : DEFAULT_MIN_ACCURACY;
  const tuneSuggest = args['tune-suggest'] === true;
  const seedFixture = args['seed-fixture'] || undefined;
  const result = runReplay({ archivesDir, minAccuracy, tuneSuggest, seedFixture });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.code === 'replay_pass' || result.code === 'fixture_pass' ? 0 : 1);
}
