/**
 * gate.mjs — 质量门禁编排器（组合 verify-evidence + scope-guard + failure-memory）
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkEvidence } from './verify-evidence.mjs';
import { checkScope } from './scope-guard.mjs';
import { queryBeforeWork, recordBypass } from './failure-memory.mjs';
import { parseTasks } from './tasks.mjs';

/**
 * 运行质量门禁检查
 * @param {string} taskId - 任务 ID
 * @param {string} specsDir - .gantry/specs/<change-id>/ 目录路径
 * @param {object} opts - { force?, pipeline?, actualFiles? }
 * @returns {{ passed: boolean, checks: object[], timestamp: string, forced: boolean }}
 */
export function runGate(taskId, specsDir, opts = {}) {
  const { force = false, pipeline = 'standard', actualFiles = [] } = opts;
  const timestamp = new Date().toISOString();

  const task = resolveTask(taskId, specsDir);
  if (!task) {
    return {
      passed: false,
      checks: [{ gate: 'resolve', passed: false, evidence: `Task ${taskId} not found` }],
      timestamp,
      forced: false,
    };
  }

  const checks = [];

  // Gate 1: Verify Evidence (all pipelines)
  const evidenceResult = checkEvidence(task, specsDir);
  checks.push({
    gate: 'verify-evidence',
    passed: evidenceResult.passed,
    issues: evidenceResult.issues,
  });

  // Gate 2: Scope Guard (all pipelines)
  const scopeResult = checkScope(task, actualFiles);
  checks.push({
    gate: 'scope-guard',
    passed: scopeResult.passed,
    violations: scopeResult.violations,
  });

  // Gate 3: Lessons Check (standard + full only)
  if (pipeline === 'standard' || pipeline === 'full') {
    const lessonsResult = queryBeforeWork(specsDir, task);
    const lessonsCheck = {
      gate: 'lessons-check',
      passed: true,
      hits: lessonsResult.hits.length,
    };
    if (lessonsResult.hits.length > 0) {
      lessonsCheck.context = lessonsResult.context;
    }
    checks.push(lessonsCheck);
  }

  const allPassed = checks.every(c => c.passed);

  // Force bypass
  if (!allPassed && force) {
    const failedGates = checks.filter(c => !c.passed).map(c => c.gate);
    recordBypass(specsDir, {
      taskId,
      reason: `Force bypass: ${failedGates.join(', ')} failed`,
      timestamp,
    });
    return { passed: true, checks, timestamp, forced: true };
  }

  return { passed: allPassed, checks, timestamp, forced: false };
}

/**
 * 将门禁结果写入 TASK.md 的对应任务块
 * @param {string} taskMdPath - TASK.md 文件路径
 * @param {string} taskId - 任务 ID
 * @param {object} result - runGate() 的返回值
 */
export function writeGateResult(taskMdPath, taskId, result) {
  if (!existsSync(taskMdPath)) return;

  let content = readFileSync(taskMdPath, 'utf-8');

  const gateXml = formatGateResult(result);

  // Find the task block and inject gate_result
  const taskPattern = new RegExp(
    `(<task\\s+[^>]*id="${taskId}"[^>]*>)([\\s\\S]*?)(</task>)`
  );
  const match = content.match(taskPattern);

  if (!match) return;

  let taskBody = match[2];

  // Remove existing gate_result if present
  taskBody = taskBody.replace(/<gate_result>[\s\S]*?<\/gate_result>\n?/g, '');

  // Append gate_result before closing tag
  taskBody = taskBody.trimEnd() + '\n' + gateXml + '\n';

  content = content.replace(taskPattern, `${match[1]}${taskBody}${match[3]}`);
  writeFileSync(taskMdPath, content, 'utf-8');
}

// --- 内部辅助 ---

function resolveTask(taskId, specsDir) {
  if (!specsDir) return null;

  const taskMdPath = join(specsDir, 'TASK.md');
  if (!existsSync(taskMdPath)) return null;

  const tasks = parseTasks(taskMdPath);
  return tasks.find(t => t.id === taskId) || null;
}

function formatGateResult(result) {
  const status = result.passed ? 'PASSED' : 'FAILED';
  const forced = result.forced ? ' (FORCED)' : '';
  const failedChecks = result.checks
    .filter(c => !c.passed)
    .map(c => {
      const detail = c.issues ? c.issues.join('; ') : c.violations ? c.violations.join(', ') : '';
      return `    - ${c.gate}: ${detail}`;
    })
    .join('\n');

  let xml = `<gate_result>\nstatus: ${status}${forced}\ntimestamp: ${result.timestamp}\n`;
  if (failedChecks) {
    xml += `violations:\n${failedChecks}\n`;
  }
  xml += '</gate_result>';
  return xml;
}
