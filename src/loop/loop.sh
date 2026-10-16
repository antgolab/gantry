#!/usr/bin/env bash
# src/loop/loop.sh — 无监督 loop driver(headless AI 版)
#
# 位置说明(2026-10-12):driver 是**随包分发的代码**,不是用户项目的运行时产物,
# 因此放在 src/loop/ 而不是 .gantry/loop/。仓库内任何逻辑都不得依赖 .gantry/ 下的
# 文件——那里只放运行时产物(STATE.md / specs / 日志 / metrics)。
# 用户项目的 .gantry/loop/ 仅由本脚本运行期 mkdir 出来,用于落日志。
#
# 用法:
#   gantry loop <client> [--quiet]          ← 推荐入口(CLI 包装)
#   bash <包>/src/loop/loop.sh <client> [--quiet]
#   client ∈ claude | codex
#
# 骨架借鉴 pdlc-skills/adapters/codex-loop-run.sh:
#   1. 状态机是唯一真源,不信 client stdout
#   2. loop-next 单 token 白名单派发
#   3. 三档护栏:fail-stop / stuck-stop / max-steps
#
# 输出纪律(2026-10-12 起):
#   - 默认「全显示」:每步打印头行 + 流式转发 dispatch stdout/stderr
#   - --quiet:只打每步一行摘要,dispatch/advance 输出落日志
#   - --verbose:兼容别名——默认行为已等同,接受但不再改变行为
#   - 每步 append .gantry/loop/metrics.jsonl 供监控
#
# 重试与自主决策(2026-10-12):
#   - dispatch 失败 → 退避重试同 phase,上限 RETRY_LIMIT
#   - advance 失败 → 写失败上下文,带诊断重新 dispatch(让 client 重新决策)再 advance
#   - advance rc=2(loop-guard 熔断 / before:dev hook 阻断)属硬停,不重试,直接透传
#   - 失败上下文落 .gantry/loop/last-failure.txt,经 GANTRY_LOOP_RETRY_CONTEXT 传给
#     dispatcher —— 每次重试都带新诊断,不做盲重试(R2.5 精神)
#
# 退出码: 0=done  2=blocked  3=达步数上限  4=dispatch 失败  5=stuck  64=用法错

set -uo pipefail
trap '__loop_interrupt' INT

__loop_interrupt() {
  echo "⚠ interrupted" >&2
  exit 130
}

# ------- 用法解析 ---------------------------------------------------------------

usage() {
  cat <<'EOF' >&2
用法: gantry loop <client> [--quiet]
      (或 bash <包>/src/loop/loop.sh <client> [--quiet])
  client       claude | codex
  --quiet, -q  只打每步一行摘要,dispatch/advance 输出落日志
  --verbose,-v 兼容别名(默认已是全显示),接受但不改变行为

环境变量:
  GANTRY_BIN              CLI 入口,默认 gantry
  GANTRY_LOOP_MAX_STEPS   步数上限,默认 40
  LOOP_STUCK_LIMIT        同 token 连续次数上限,默认 2
  GANTRY_LOOP_RETRIES     失败重试上限,默认取 config.autonomous.maxRetries(3)
  GANTRY_LOOP_BACKOFF     退避基数秒,默认 1(0 = 不等待,测试用)
  GANTRY_LOOP_DISPATCHER  覆盖 dispatcher 路径
EOF
  exit "${1:-0}"
}

CLIENT=""
QUIET=0
for arg in "$@"; do
  case "$arg" in
    claude|codex) CLIENT="$arg" ;;
    --quiet|-q)   QUIET=1 ;;
    --verbose|-v) : ;;   # 兼容别名:默认已全显示,保留以免既有脚本报错
    -h|--help)    usage 0 ;;
    *) echo "错误: 未知参数 '$arg'" >&2; usage 64 ;;
  esac
done
[[ -n "$CLIENT" ]] || { echo "错误: 缺 client 参数(claude | codex)" >&2; usage 64; }

GANTRY_PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT_ROOT="$(pwd)"
export PROJECT_ROOT

DISPATCHER="${GANTRY_LOOP_DISPATCHER:-$GANTRY_PKG_DIR/src/loop/dispatch-${CLIENT}.sh}"
[[ -x "$DISPATCHER" ]] || { echo "错误: dispatcher 不存在或不可执行: $DISPATCHER" >&2; exit 64; }

GANTRY_BIN="${GANTRY_BIN:-gantry}"
MAX_STEPS="${GANTRY_LOOP_MAX_STEPS:-40}"
[[ "$MAX_STEPS" =~ ^[1-9][0-9]*$ ]] || { echo "错误: GANTRY_LOOP_MAX_STEPS 需正整数(得到 '$MAX_STEPS')" >&2; exit 64; }
STUCK_LIMIT="${LOOP_STUCK_LIMIT:-2}"
BACKOFF_BASE="${GANTRY_LOOP_BACKOFF:-1}"
[[ "$BACKOFF_BASE" =~ ^[0-9]+$ ]] || { echo "错误: GANTRY_LOOP_BACKOFF 需非负整数(得到 '$BACKOFF_BASE')" >&2; exit 64; }
BACKOFF_CAP=30

# 监控落地位置
LOOP_LOG_DIR="$PROJECT_ROOT/.gantry/loop"
METRICS_FILE="$LOOP_LOG_DIR/metrics.jsonl"
DISPATCH_LOG="$LOOP_LOG_DIR/last-dispatch.log"
ADVANCE_LOG="$LOOP_LOG_DIR/last-advance.log"
RETRY_CTX_FILE="$LOOP_LOG_DIR/last-failure.txt"
mkdir -p "$LOOP_LOG_DIR"

# 失败上下文出口:dispatcher 只在文件非空时读它。每步开始 rm,失败时写,
# 这样「有内容」就等价于「这是重试轮」。
export GANTRY_LOOP_RETRY_CONTEXT="$RETRY_CTX_FILE"

# ------- 工具函数 ---------------------------------------------------------------

now_ms() {
  # 优先 GNU date;macOS BSD date 无 %N,降级到秒级
  if date +%s%3N 2>/dev/null | grep -q '^[0-9]\+$'; then
    date +%s%3N
  else
    echo $(($(date +%s) * 1000))
  fi
}

json_escape() {
  # 极简 JSON 字符串转义(只处理 \ 和 ")
  local s="${1:-}"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

emit_metric() {
  # emit_metric step stage token rc dispatch_ms advance_ms attempt
  local step="$1" stage="$2" token="$3" rc="$4" dms="$5" ams="$6" attempt="${7:-1}"
  printf '{"ts":"%s","step":%s,"stage":"%s","token":"%s","rc":%s,"dispatch_ms":%s,"advance_ms":%s,"attempt":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$step" "$(json_escape "$stage")" "$(json_escape "$token")" \
    "$rc" "$dms" "$ams" "$attempt" \
    >> "$METRICS_FILE"
}

# 一次 status --json 读回 currentStage + maxRetries,避免每步两次进程启动。
# 读失败不致命:stage 记 '?',maxRetries 回落到调用方的默认值。
STATUS_STAGE="?"
STATUS_MAX_RETRIES=""
read_status() {
  local json out
  json=$($GANTRY_BIN status --json 2>/dev/null || true)
  if [[ -z "$json" ]]; then
    STATUS_STAGE="?"
    STATUS_MAX_RETRIES=""
    return 0
  fi
  out=$(printf '%s' "$json" | node -e '
    let d="";process.stdin.on("data",c=>d+=c);
    process.stdin.on("end",()=>{
      try{
        const j=JSON.parse(d);
        process.stdout.write(String(j.currentStage ?? "?")+"\n");
        process.stdout.write(j.maxRetries == null ? "" : String(j.maxRetries));
      }catch{process.stdout.write("?\n\n")}
    });
  ' 2>/dev/null || true)
  STATUS_STAGE=$(printf '%s' "$out" | sed -n '1p')
  STATUS_MAX_RETRIES=$(printf '%s' "$out" | sed -n '2p')
  [[ -n "$STATUS_STAGE" ]] || STATUS_STAGE="?"
}

# 重试上限:显式 env > config.autonomous.maxRetries > 3
RETRY_LIMIT="${GANTRY_LOOP_RETRIES:-}"
if [[ -z "$RETRY_LIMIT" ]]; then
  read_status
  RETRY_LIMIT="${STATUS_MAX_RETRIES:-3}"
fi
[[ "$RETRY_LIMIT" =~ ^[0-9]+$ ]] || { echo "错误: GANTRY_LOOP_RETRIES 需非负整数(得到 '$RETRY_LIMIT')" >&2; exit 64; }

# 写失败上下文:dispatcher 经 GANTRY_LOOP_RETRY_CONTEXT 读它,据此重新决策。
write_failure_ctx() {
  local kind="$1" detail="$2"
  {
    printf '失败类型: %s\n' "$kind"
    printf '时间: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '%s\n' "$detail"
  } > "$RETRY_CTX_FILE"
}

# 指数退避 + 一行可见的重试日志(重试必须让人看见,不许静默)
backoff_and_log() {
  local attempt="$1" reason="$2"
  local secs=$(( BACKOFF_BASE << (attempt - 1) ))
  [[ "$secs" -gt "$BACKOFF_CAP" ]] && secs="$BACKOFF_CAP"
  echo "[loop] ↻ retry $attempt/$RETRY_LIMIT ${reason} backoff=${secs}s" >&2
  [[ "$secs" -gt 0 ]] && sleep "$secs"
  return 0
}

# ------- 主循环 -----------------------------------------------------------------

step=0
prev_token=""
stuck_count=0
loop_t0=$(now_ms)

echo "▶ loop client=$CLIENT max=$MAX_STEPS retries=$RETRY_LIMIT quiet=$QUIET cwd=$PROJECT_ROOT"

while true; do
  step=$((step + 1))

  if [[ $step -gt $MAX_STEPS ]]; then
    echo "⏱ max-steps ($MAX_STEPS)" >&2
    exit 3
  fi

  # 1. 读 token
  token=$($GANTRY_BIN loop-next 2>/tmp/gantry-loop-next.err || true)

  # 2. 读 stage(仅用于日志)
  read_status
  stage="$STATUS_STAGE"

  case "${token}" in
    done)
      emit_metric "$step" "$stage" "done" 0 0 0 1
      elapsed=$(( $(now_ms) - loop_t0 ))
      echo "✓ done (steps=$step elapsed=${elapsed}ms)"
      exit 0
      ;;
    blocked)
      reason=""
      [[ -s /tmp/gantry-loop-next.err ]] && reason=$(tr '\n' ' ' < /tmp/gantry-loop-next.err | sed 's/\[loop-next warn\] //g')
      emit_metric "$step" "$stage" "blocked" 2 0 0 1
      echo "✗ blocked stage=$stage${reason:+ reason=$reason}" >&2
      exit 2
      ;;
    gantry-*)
      # stuck 检测
      if [[ "${token}" = "${prev_token}" ]]; then
        stuck_count=$((stuck_count + 1))
        if [[ "${stuck_count}" -ge "${STUCK_LIMIT}" ]]; then
          emit_metric "$step" "$stage" "$token" 5 0 0 1
          echo "⚠ stuck token=$token ×$stuck_count" >&2
          exit 5
        fi
      else
        stuck_count=0
      fi
      prev_token="${token}"

      phase="${token#gantry-}"

      # 3. dispatch ⇄ advance,失败退避重试(带诊断,不盲重试)
      attempt=0
      dispatch_rc=0
      advance_rc=0
      dispatch_ms=0
      advance_ms=0
      rm -f "$RETRY_CTX_FILE"

      while :; do
        attempt=$((attempt + 1))

        if [[ "$QUIET" -eq 0 ]]; then
          printf '[loop] step=%d/%d stage=%s token=%s attempt=%d\n' \
            "$step" "$MAX_STEPS" "$stage" "$token" "$attempt"
        fi

        # --- 3a. dispatch ---
        t0=$(now_ms)
        if [[ "$QUIET" -eq 1 ]]; then
          "$DISPATCHER" "$phase" >"$DISPATCH_LOG" 2>&1
          dispatch_rc=$?
        else
          "$DISPATCHER" "$phase" 2>&1 | tee "$DISPATCH_LOG"
          dispatch_rc=${PIPESTATUS[0]}
        fi
        dispatch_ms=$(( $(now_ms) - t0 ))

        if [[ "$dispatch_rc" -ne 0 ]]; then
          # rc=64 是 dispatcher 的用法/配置错(未知 phase、phase 文件缺失),
          # 确定性失败——退避重试只会白等,属 R2.5 禁止的盲重试。直接停。
          if [[ "$dispatch_rc" -eq 64 ]]; then
            emit_metric "$step" "$stage" "$token" 64 "$dispatch_ms" 0 "$attempt"
            echo "✗ dispatch rc=64 phase=$phase 用法/配置错,不重试(见 $DISPATCH_LOG)" >&2
            exit 64
          fi
          if [[ "$attempt" -le "$RETRY_LIMIT" ]]; then
            write_failure_ctx "dispatch" "dispatch rc=$dispatch_rc phase=$phase attempt=$attempt
$(tail -n 40 "$DISPATCH_LOG" 2>/dev/null)"
            backoff_and_log "$attempt" "token=$token dispatch-rc=$dispatch_rc"
            continue
          fi
          emit_metric "$step" "$stage" "$token" "$dispatch_rc" "$dispatch_ms" 0 "$attempt"
          echo "✗ dispatch rc=$dispatch_rc phase=$phase 重试 ${RETRY_LIMIT} 次仍失败(见 $DISPATCH_LOG)" >&2
          exit 4
        fi

        # --- 3b. advance 门禁 ---
        t0=$(now_ms)
        $GANTRY_BIN advance >"$ADVANCE_LOG" 2>&1
        advance_rc=$?
        advance_ms=$(( $(now_ms) - t0 ))
        [[ "$QUIET" -eq 0 ]] && cat "$ADVANCE_LOG"

        [[ "$advance_rc" -eq 0 ]] && break

        # rc=2 是硬停语义(loop-guard 熔断 / before:dev hook 阻断),重试无意义
        if [[ "$advance_rc" -eq 2 ]]; then
          emit_metric "$step" "$stage" "$token" 2 "$dispatch_ms" "$advance_ms" "$attempt"
          tail_msg=$(tail -n 3 "$ADVANCE_LOG" 2>/dev/null | tr '\n' ' ')
          echo "✗ blocked: advance rc=2 phase=$phase ${tail_msg}" >&2
          exit 2
        fi

        if [[ "$attempt" -le "$RETRY_LIMIT" ]]; then
          write_failure_ctx "advance" "advance rc=$advance_rc phase=$phase attempt=$attempt
$(tail -n 40 "$ADVANCE_LOG" 2>/dev/null)"
          backoff_and_log "$attempt" "token=$token advance-rc=$advance_rc"
          continue
        fi

        emit_metric "$step" "$stage" "$token" "$advance_rc" "$dispatch_ms" "$advance_ms" "$attempt"
        tail_msg=$(tail -n 3 "$ADVANCE_LOG" 2>/dev/null | tr '\n' ' ')
        echo "✗ advance rc=$advance_rc phase=$phase 重试 ${RETRY_LIMIT} 次仍失败 ${tail_msg}" >&2
        exit "$advance_rc"
      done

      rm -f "$RETRY_CTX_FILE"
      emit_metric "$step" "$stage" "$token" 0 "$dispatch_ms" "$advance_ms" "$attempt"
      if [[ "$QUIET" -eq 1 ]]; then
        printf 'step=%d/%d stage=%s token=%s dispatch=%dms advance=%dms rc=0\n' \
          "$step" "$MAX_STEPS" "$stage" "$phase" "$dispatch_ms" "$advance_ms"
      else
        printf '[loop] step=%d/%d ok dispatch=%dms advance=%dms attempt=%d\n' \
          "$step" "$MAX_STEPS" "$dispatch_ms" "$advance_ms" "$attempt"
      fi
      ;;
    *)
      emit_metric "$step" "$stage" "$token" 5 0 0 1
      echo "✗ 非法 token: $token" >&2
      exit 5
      ;;
  esac
done
