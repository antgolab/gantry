#!/usr/bin/env bash
# Compatibility entry. All state, budget and process supervision live in Node.
set -euo pipefail
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/controller.mjs" "$@"
