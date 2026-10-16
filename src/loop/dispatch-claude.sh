#!/usr/bin/env bash
# dispatch-claude.sh — 把当前阶段派发给 headless `claude -p`
#
# 用法: dispatch-claude.sh <phase-short>
#   phase-short ∈ change|requirement|design|task|dev|test|review|integration
#
# 策略(对齐 pdlc adapters/codex-loop-run.sh):
#   - 一次调用 claude 一次,让它读 phase 文件并产出当前阶段产物
#   - --dangerously-skip-permissions 是 claude 唯一能吃掉全部权限询问的 flag
#   - 状态机是唯一真源:退回主循环后由 `gantry advance` 判护栏,不信 claude stdout
#   - prompt 加硬约束让 claude 停止复述协议/推理过程(2026-10-10)
#   - 重试轮次(2026-10-12):driver 设 GANTRY_LOOP_RETRY_CONTEXT 时把失败上下文
#     拼进 prompt,让 claude 据诊断重新决策,而非重复上一轮做法
#
# 退出码: 0=完成  非零=派发失败(主循环退避重试,超限才 fail-stop)

set -euo pipefail

PHASE="${1:?用法: $0 <phase-short>}"
PROJECT_ROOT="${PROJECT_ROOT:-$(pwd)}"

# 重试轮次:driver 在每次失败后写 last-failure.txt 并导出该路径。
# 非空即表示这是重试,必须带诊断重新决策(R2.5:禁盲重试)。
RETRY_NOTE=""
if [[ -n "${GANTRY_LOOP_RETRY_CONTEXT:-}" && -s "${GANTRY_LOOP_RETRY_CONTEXT}" ]]; then
  RETRY_NOTE="

⚠ 这是重试轮次(上一轮派发或门禁失败)。失败上下文如下:

--- 失败上下文开始 ---
$(cat "$GANTRY_LOOP_RETRY_CONTEXT")
--- 失败上下文结束 ---

要求:
- 先诊断根因,再产出修正后的产物;禁止重复上一轮的做法(盲重试)
- 若判断该失败无法自主修复,stdout 输出 1 行 \`error: <简短原因>\` 后退出非零"
fi

case "$PHASE" in
  change)       PHASE_FILE=".gantry/core/phases/0-change.md" ;;
  requirement)  PHASE_FILE=".gantry/core/phases/1-requirement.md" ;;
  design)       PHASE_FILE=".gantry/core/phases/2-design.md" ;;
  task)         PHASE_FILE=".gantry/core/phases/3-task.md" ;;
  dev)          PHASE_FILE=".gantry/core/phases/4-dev.md" ;;
  test)         PHASE_FILE=".gantry/core/phases/5-test.md" ;;
  review)       PHASE_FILE=".gantry/core/phases/6-review.md" ;;
  integration)  PHASE_FILE=".gantry/core/phases/7-integration.md" ;;
  *) echo "[dispatch-claude] 未知 phase: $PHASE" >&2; exit 64 ;;
esac

[[ -f "$PROJECT_ROOT/$PHASE_FILE" ]] || {
  echo "[dispatch-claude] phase 文件缺失: $PHASE_FILE" >&2
  exit 64
}

PROMPT="你正在无人值守 loop 中执行 gantry pipeline 的 [$PHASE] 阶段。

严格按下方 phase 协议产出本阶段产物到 .gantry/specs/<change-id>/,不询问、不停顿、不等待人工确认。

输出纪律(硬约束):
- 不复述 phase 协议内容
- 不输出中间推理/思考过程
- 不输出 TODO 列表、不汇报进度、不解释动机
- 产物写入文件后,stdout 只输出 1 行: \`written: <relative/paths/comma/separated>\`
- 异常或 blocked 时输出 1 行: \`error: <简短原因>\` 后退出非零

- 上下文包: .gantry/planning/context-pack.json
- 状态机: .gantry/planning/STATE.md
- Phase 协议(下方全文,即 $PHASE_FILE):

---
$(cat "$PROJECT_ROOT/$PHASE_FILE")
---

产物写完即结束,不要主动跑 \`gantry advance\`——外层 loop 会跑门禁。${RETRY_NOTE}"

exec claude -p "$PROMPT" \
  --dangerously-skip-permissions \
  --output-format text
