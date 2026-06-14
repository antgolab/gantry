/**
 * verify-evidence.mjs — 推测性语言检测 + 验证证据检查
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SPECULATIVE_PATTERNS = [
  /should (pass|work|be fine|be ok)/i,
  /probably (works|passes|fine|ok|correct)/i,
  /looks (good|correct|right|fine)/i,
  /I (think|believe|assume) (it|this|that) (works|passes|is correct)/i,
  /likely (works|passes|correct)/i,
  /seems? (to work|correct|fine|right)/i,
  /基本没问题/,
  /应该(可以|没问题|能)/,
  /看起来(良好|没问题|正确|可以)/,
  /大概(没问题|可以|行)/,
  /估计(能|可以|没问题)/,
];

const EVIDENCE_PATTERNS = [
  /^\$ .+/m,
  /^\$\s+.+/m,
  /^>.+/m,
  /PASS(ED)?|FAIL(ED)?|✓|✗|OK/,
  /exit code:?\s*\d+/i,
  /\d+ (passing|passed|tests? passed)/i,
  /\d+ (failing|failed|tests? failed)/i,
  /Error:|TypeError:|ReferenceError:/,
  /assert(ion)?/i,
  /test result/i,
];

/**
 * 检查任务的验证证据是否充分
 * @param {object} task - 任务对象 { id, verify, body }
 * @param {string} specsDir - .gantry/specs/<change-id>/ 目录路径
 * @returns {{ passed: boolean, issues: string[] }}
 */
export function checkEvidence(task, specsDir) {
  const issues = [];

  const artifacts = collectArtifacts(task, specsDir);

  if (artifacts.length === 0) {
    issues.push(`No verification artifacts found for ${task.id}`);
    return { passed: false, issues };
  }

  const combined = artifacts.join('\n');

  // Check for speculative language
  const speculative = detectSpeculative(combined);
  if (speculative.length > 0) {
    for (const match of speculative) {
      issues.push(`Speculative language detected: "${match}"`);
    }
  }

  // Check for evidence presence
  const hasEvidence = EVIDENCE_PATTERNS.some(p => p.test(combined));
  if (!hasEvidence) {
    issues.push('No concrete verification evidence found (command output, test results, or exit codes)');
  }

  return {
    passed: issues.length === 0,
    issues,
  };
}

/**
 * 单独检测推测性语言（可用于实时检查）
 * @param {string} text - 待检查文本
 * @returns {string[]} 匹配到的推测性表达
 */
export function detectSpeculative(text) {
  const matches = [];
  for (const pattern of SPECULATIVE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      matches.push(match[0]);
    }
  }
  return matches;
}

// --- 内部辅助 ---

function collectArtifacts(task, specsDir) {
  const artifacts = [];

  // 1. Task's own verify field
  if (task.verify) {
    artifacts.push(task.verify);
  }

  // 2. SUMMARY file in specs dir
  if (specsDir) {
    const summaryPath = join(specsDir, 'SUMMARY.md');
    if (existsSync(summaryPath)) {
      artifacts.push(readFileSync(summaryPath, 'utf-8'));
    }

    // 3. Task-specific summary
    const taskSummary = join(specsDir, `${task.id}-SUMMARY.md`);
    if (existsSync(taskSummary)) {
      artifacts.push(readFileSync(taskSummary, 'utf-8'));
    }

    // 4. Check for verify-* files
    if (existsSync(specsDir)) {
      try {
        const files = readdirSync(specsDir);
        for (const f of files) {
          if (f.startsWith('verify-') || f.includes(task.id.toLowerCase())) {
            const content = readFileSync(join(specsDir, f), 'utf-8');
            artifacts.push(content);
          }
        }
      } catch {
        // Directory read failed — not critical
      }
    }
  }

  // 5. Task body may contain inline evidence
  if (task.body) {
    artifacts.push(task.body);
  }

  return artifacts;
}
