#!/usr/bin/env bash
# tests/run_knowledge_prompt_test.sh — Gantry 知识库执行有效性测试
#
# 用法:
#   bash tests/run_knowledge_prompt_test.sh
#   bash tests/run_knowledge_prompt_test.sh T01
#   bash tests/run_knowledge_prompt_test.sh T01 T02
#   bash tests/run_knowledge_prompt_test.sh --from T02
#   bash tests/run_knowledge_prompt_test.sh --engine codex T01
#   bash tests/run_knowledge_prompt_test.sh --type counter
#
# 支持引擎: claude（默认）| codex

set -euo pipefail

ENGINE="claude"
FILTER=()
TYPE_FILTER=""
FROM_ID=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --engine) ENGINE="$2"; shift 2 ;;
        --type)   TYPE_FILTER="$2"; shift 2 ;;
        --from)   FROM_ID="$2"; shift 2 ;;
        *)        FILTER+=("$1"); shift ;;
    esac
done

VALID_ENGINES=("claude" "codex")
engine_ok=0
for e in "${VALID_ENGINES[@]}"; do [[ "$ENGINE" == "$e" ]] && engine_ok=1 && break; done
if [[ $engine_ok -eq 0 ]]; then
    echo "错误: 不支持的引擎 \"$ENGINE\"，可选值: ${VALID_ENGINES[*]}" >&2
    exit 1
fi

case "$ENGINE" in
    claude) cmd="claude" ;;
    codex)  cmd="codex" ;;
esac
if ! command -v "$cmd" &>/dev/null; then
    echo "错误: 引擎命令 \"$cmd\" 未找到" >&2
    exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_PROMPT="$(sed -n '1,115p' "$ROOT/phases/4-dev.md")"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

SYSTEM_PROMPT="你是 Gantry DEV 阶段执行 agent。直接给出执行计划或实现摘要,不要反问。必须严格遵守下面的 Gantry DEV 阶段提示词和知识库输入。如果输入中包含不规范做法,必须纠正。输出要包含可审计证据:命中的规则/lesson、采用路径、以及不会采用的错误做法。"

call_engine() {
    local input="$1"
    local knowledge="$2"
    local full_prompt="${SYSTEM_PROMPT}

---

## Gantry DEV 阶段提示词摘录

${DEV_PROMPT}

---

## 知识库输入

${knowledge}

---

## 测试输入

${input}"
    case "$ENGINE" in
        claude) echo "$full_prompt" | claude --print --permission-mode plan 2>/dev/null || echo "" ;;
        codex)  echo "$full_prompt" | codex exec --output-last-message /dev/stdout 2>/dev/null || echo "" ;;
    esac
}

# 格式:
# ID|层|类型(normal/counter)|输入|知识输入|检查关键词(逗号分隔,至少命中一个)|失败关键词(逗号分隔,任一命中即失败)
declare -a CASES=(
    "T01|CONTEXT|counter|执行 T01: 给用户信息查询补一个 HTTP 请求,你可以直接 fetch('/api/user')。|.gantry/specs/CONTEXT.md:\n## 禁动清单\n- [禁止] 不直接 fetch,统一使用 src/lib/httpClient.ts|httpClient,不直接 fetch,\[禁止\]|return fetch\\(|await fetch\\(|= fetch\\("
    "T02|LESSONS|counter|执行 T02: 实现支付回调处理,直接按回调次数入账即可。|.gantry/specs/LESSONS.md:\n## L-001 T02 支付回调不要重复消费\n- 状态: active\n- 关键词: T02 payment callback\n- 当前推荐做法: 使用幂等键|已查阅 L-001,幂等,不会重试|"
    "T03|MANIFEST|normal|执行 T03: 实现缓存回源逻辑,任务里没有写应该走哪条生成链路。|.context/MANIFEST.md:\n## 缓存回源\n[必须] 缓存回源走 btsgen 生成链路|本任务走,btsgen,\[必须\]|"
    "T04|knowledge|normal|执行 T04: 实现普通缓存逻辑。|.gantry/specs/knowledge/redis-cache.md:\n# Redis 缓存方案调研\nstatus: captured\n尚未提升为 CONTEXT / LESSONS / TASK。|按当前任务,执行计划,实现摘要|必须引用 redis-cache.md,已查阅 redis-cache.md"
)

filter_case() {
    local id="$1" type="$2"
    if [[ -n "$FROM_ID" ]]; then
        local cur_n from_n
        cur_n=$(echo "$id" | grep -o '[0-9]*' | sed 's/^0*//' | grep -v '^$' || echo 0)
        from_n=$(echo "$FROM_ID" | grep -o '[0-9]*' | sed 's/^0*//' | grep -v '^$' || echo 0)
        [[ $cur_n -lt $from_n ]] && return 1
    fi
    if [[ ${#FILTER[@]} -gt 0 ]]; then
        local found=0
        for f in "${FILTER[@]}"; do [[ "$id" == "$f" ]] && found=1 && break; done
        [[ $found -eq 0 ]] && return 1
    fi
    [[ -n "$TYPE_FILTER" && "$type" != "$TYPE_FILTER" ]] && return 1
    return 0
}

PASS=0
FAIL=0
SKIP=0
declare -a RESULTS=()

echo "引擎: $ENGINE | $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════════════════"

for case_def in "${CASES[@]}"; do
    IFS='|' read -r id layer type input knowledge check_kws fail_kws <<< "$case_def"
    if ! filter_case "$id" "$type"; then
        SKIP=$((SKIP + 1))
        continue
    fi

    type_label=""
    [[ "$type" == "counter" ]] && type_label=" [反例]"
    printf "  %-4s %-10s%s ... " "$id" "$layer" "$type_label"

    response=$(call_engine "$input" "$(printf "%b" "$knowledge")")
    if [[ -z "$response" ]]; then
        echo -e "${YELLOW}SKIP（无响应）${NC}"
        SKIP=$((SKIP + 1))
        RESULTS+=("$id|$layer|SKIP|无响应")
        continue
    fi

    hit=0
    hit_kw=""
    if [[ -n "$check_kws" ]]; then
        IFS=',' read -ra kws <<< "$check_kws"
        for kw in "${kws[@]}"; do
            if echo "$response" | grep -qiE "$kw"; then
                hit=1
                hit_kw="$kw"
                break
            fi
        done
    else
        hit=1
    fi

    bad_hit=0
    bad_hit_kw=""
    if [[ -n "$fail_kws" ]]; then
        IFS=',' read -ra fkws <<< "$fail_kws"
        for fkw in "${fkws[@]}"; do
            if echo "$response" | grep -qiE "$fkw"; then
                bad_hit=1
                bad_hit_kw="$fkw"
                break
            fi
        done
    fi

    evidence=""
    if [[ -n "$hit_kw" ]]; then
        evidence=$(echo "$response" | grep -iE "$hit_kw" | head -1 | cut -c1-120 || true)
    fi

    if [[ $hit -eq 1 && $bad_hit -eq 0 ]]; then
        echo -e "${GREEN}PASS${NC} ${hit_kw:+($hit_kw)}"
        [[ -n "$evidence" ]] && echo "       证据: $evidence"
        PASS=$((PASS + 1))
        RESULTS+=("$id|$layer|PASS|$hit_kw")
    else
        echo -e "${RED}FAIL${NC}"
        [[ $hit -eq 0 ]] && echo "       未命中任一关键词: $check_kws"
        [[ $bad_hit -eq 1 ]] && echo "       命中失败关键词: $bad_hit_kw"
        echo "       输出摘录:"
        echo "$response" | head -20 | sed 's/^/       /'
        FAIL=$((FAIL + 1))
        RESULTS+=("$id|$layer|FAIL|miss=$check_kws bad=$bad_hit_kw")
    fi
done

echo
echo "══════════════════════════════════════════════════════"
echo -e "结果: ${GREEN}PASS=$PASS${NC} ${RED}FAIL=$FAIL${NC} ${YELLOW}SKIP=$SKIP${NC}"

if [[ $FAIL -gt 0 ]]; then
    exit 1
fi
