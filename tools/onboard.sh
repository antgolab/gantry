#!/usr/bin/env bash
# gantry onboard
# Usage: ./tools/onboard.sh --target <project-root> --tool <claude-code|cursor|codex|copilot>

set -euo pipefail

TARGET=""
TOOL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --tool) TOOL="$2"; shift 2 ;;
    -h|--help)
      cat <<EOF
gantry onboard

Copies dist/<tool>/* and team/*.md samples into <target-project>.

Usage:
  ./tools/onboard.sh --target ~/code/my-repo --tool claude-code
EOF
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$TARGET" || -z "$TOOL" ]]; then
  echo "missing --target or --tool (run with --help)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST="$ROOT/dist/$TOOL"
TEAM="$ROOT/team"

if [[ ! -d "$DIST" ]]; then
  echo "dist/$TOOL missing. run: node tools/build.mjs --tool $TOOL" >&2
  exit 1
fi
if [[ ! -d "$TARGET" ]]; then
  echo "target not found: $TARGET" >&2
  exit 1
fi

echo "[onboard] target=$TARGET tool=$TOOL"

# 1. dist/<tool>/* -> target
( cd "$DIST" && tar cf - . ) | ( cd "$TARGET" && tar xf - )
echo "[onboard] copied dist/$TOOL -> $TARGET"

# 2. team/*.md -> target/.gantry/specs/
mkdir -p "$TARGET/.gantry/specs"
for f in CONVENTIONS.md STATE.md LESSONS.md; do
  if [[ -f "$TEAM/$f" && ! -f "$TARGET/.gantry/specs/$f" ]]; then
    cp "$TEAM/$f" "$TARGET/.gantry/specs/$f"
    echo "[onboard] seeded $TARGET/.gantry/specs/$f"
  fi
done

# 3. STATE.md at repo root (if not exists)
if [[ ! -f "$TARGET/STATE.md" ]]; then
  cat > "$TARGET/STATE.md" <<'EOS'
# STATE

> 跨会话状态。AI 每次会话开始必读。

## 活跃 Change
无

## 当前阶段
无

## 当前 Task
无

## 中断任务
无

## 最近决策
- `YYYY-MM-DD`：初始化 gantry
EOS
  echo "[onboard] seeded $TARGET/STATE.md"
fi

echo "[onboard] done"
