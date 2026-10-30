#!/usr/bin/env bash
# Single invocation adapter. The Node supervisor owns retries and verification.
set -euo pipefail
PHASE="${1:?用法: $0 <phase> [task-id] [--pack path]}"
shift
TASK_ID="${GANTRY_RALPH_TASK_ID:-}"
PACK_FILE=""
while (($#)); do
  case "$1" in
    --pack) [[ $# -ge 2 ]] || { echo '--pack 缺少路径' >&2; exit 64; }; PACK_FILE="$2"; shift 2 ;;
    -*) echo "未知参数: $1" >&2; exit 64 ;;
    *) [[ -z "${TASK_ID}" || "${TASK_ID}" == "$1" ]] || { echo 'task-id 不一致' >&2; exit 64; }; TASK_ID="$1"; shift ;;
  esac
done
PROJECT_ROOT="${PROJECT_ROOT:-$(pwd)}"
case "${PHASE}" in
  change) FILE=0-change.md ;;
  requirement) FILE=1-requirement.md ;;
  design) FILE=2-design.md ;;
  task) FILE=3-task.md ;;
  dev) FILE=4-dev.md ;;
  test) FILE=5-test.md ;;
  review) FILE=6-review.md ;;
  integration) FILE=7-integration.md ;;
  fast) FILE=F-fast.md ;;
  *) echo "未知 phase: ${PHASE}" >&2; exit 64 ;;
esac
PHASE_FILE="$PROJECT_ROOT/.gantry/core/phases/$FILE"
[[ -f "$PHASE_FILE" ]] || { echo "phase 文件缺失: $PHASE_FILE" >&2; exit 64; }
PACK_FILE="${PACK_FILE:-$PROJECT_ROOT/.gantry/planning/context-pack.json}"
[[ -f "${PACK_FILE}" ]] || { echo "context-pack 缺失" >&2; exit 64; }
if [[ "${PHASE}" == dev && -z "${TASK_ID}" ]]; then
  echo 'DEV 必须指定单个 task-id' >&2; exit 64
fi
# Mechanical identity check precedes the client. The prompt is not the guard.
node - "${PACK_FILE}" "${PHASE}" "${TASK_ID}" <<'NODE'
const fs = require('node:fs');
const [file, phase, task] = process.argv.slice(2);
try {
  const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (pack.stage !== phase || (pack.taskId ?? '') !== task ||
      (process.env.GANTRY_RALPH_ATTEMPT_ID && pack.attemptId !== process.env.GANTRY_RALPH_ATTEMPT_ID)) {
    throw new Error('context-pack identity mismatch');
  }
} catch (error) { console.error(error.message); process.exit(64); }
NODE
PROMPT="执行 Gantry 当前阶段 ${PHASE}；当前 task=${TASK_ID}。
先读取 ${PACK_FILE}，按 loadOrder 加载约束；此文件是本次尝试的冻结输入。
必须核对 pack.stage=${PHASE}、pack.taskId=${TASK_ID}（非DEV应为空）与 STATE 的 change/stage；pack.attemptId须与环境GANTRY_RALPH_ATTEMPT_ID一致（若有）。
DEV只执行此task的一次候选编码；读取其 execution/<task>.json 与 PROGRESS 的失败诊断，采用有证据差异的修复方案。遵守 read_files/write_files；必要时写当前task的PROGRESS。
禁止更改TASKS状态、验收contract、execution控制JSON、STATE、锁；禁止调用gantry done/dispatch/advance/approve/archive；禁止commit；禁止启动逃逸进程组的后台写者。
阶段工件或候选代码写完即返回；外层控制器独立运行验收并决定完成。遇到人工关卡或需求歧义记录阻塞，不能自行批准。
不要输出思考过程；输出实际改动、验证结果与阻塞事实。
阶段协议：
$(cat "$PHASE_FILE")"
exec claude -p "$PROMPT" \
  --dangerously-skip-permissions \
  --output-format text
