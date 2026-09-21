# gantry loop-guard · 上下文 / 步数熔断

> P2 交付、P4(2026-09-16)命令折叠后内联到 `gantry advance` 入口。
> 独立的 `gantry loop-guard` 子命令已删除,同名纯函数 `checkLoopGuard` 保留。
> 文档字段与代码一致来源于:
> `src/lib/loop-guard.mjs` / `src/cli.mjs` preAdvanceLoopGuard / `.gantry/loop/loop.sh`

---

## 何时熔断

每次 `gantry advance` 入口先跑 `preAdvanceLoopGuard`(内联),按优先级判定:

| 优先级 | 触发条件 | reason |
|---|---|---|
| 1 | `state.contextUsage.windowPercent >= 阈值` | `context-window-exceeded` |
| 2 | `state.contextUsage.tokens > 阈值` | `context-tokens-exceeded` |
| 3 | `state.stagesRun >= state.maxStages` | `max-stages-exceeded` |
| — | driver 层:同 token 连续 ≥ `LOOP_STUCK_LIMIT` | shell 内 `exit 3` |

前三档触发时 `gantry advance` 直接:
- exit 2(driver 透传:`[loop] advance failed rc=2`)
- stderr `[advance warn] <reason>`
- 写 `fence.lastStageResult.blockedReason = 'loop-guard: <reason>'`(**不覆盖**已有非空值)

stuck 是 shell 侧检测,不写 fence(driver 短命,人工重启更合适)。

---

## 阈值默认与调整

`.gantry/planning/config.json`:

```json
{
  "loopGuard": {
    "contextPercent": 85,
    "contextTokens": 200000,
    "stuckTolerance": 2
  }
}
```

缺省定义在 `src/lib/loop-guard.mjs` 的 `DEFAULT_THRESHOLDS`;缺 config 或缺 `loopGuard` 段时全部取缺省。

**stuckTolerance**:目前只是文档字段,shell 侧通过环境变量 `LOOP_STUCK_LIMIT` 生效——两者等价,后者优先。

---

## 恢复步骤

1. 检查 stderr / STATE.md 中的 `lastStageResult.blockedReason`,确认熔断原因
2. 处理根因:
   - **context 熔断**:清理会话上下文 / 拆分 change
   - **stagesRun 熔断**:确认阶段进度符合预期,必要时 `updateState` 重置 `stagesRun`
   - **stuck**:检查为何 `advance` 未推进 stage(通常是门禁未过)
3. 清 fence 的 blocked 状态:手动编辑 STATE.md 的 fence JSON,把 `lastStageResult.blockedReason` 置 `null`
4. 重跑 `bash .gantry/loop/loop.sh <client>`(client ∈ `claude` | `codex`),或单跑 `gantry advance`

---

## 与 P1 loop-next 的关系图

```
┌─────────────────────────────────────────────────────────┐
│                  .gantry/loop/loop.sh                    │
│  (bash driver, ADR-003:只调 gantry advance)             │
└───────────────────┬─────────────────────────────────────┘
                    │
             ┌──────┴──────┐
             ▼             ▼
          gantry        gantry
          loop-next     advance
          (P1)          (既有 CLI + P4 内联 guard)
             │             │
             │      ┌──────┴─────────────┐
             │      ▼                    ▼
             │   preAdvance         transitionStage
             │   LoopGuard          (state-must-advance)
             │   (P4 内联)
             ▼      │
     computeNextStep│
     (纯函数)        │
             │      ▼
             │   checkLoopGuard
             │   (纯函数)
             ▼      │
    fence.lastStageResult ◀───┘
    (P1 定义,advance 内联熔断时写 blockedReason)
```

**契约不变**:
- `loop-next` 输出格式 / exit code 与 P1 一致
- `computeNextStep` 判定序不变(P1 优先级:blockedReason → converge → nextStep → 兜底)
- advance 内联熔断写 blockedReason 之后,下一次 loop-next 会自然返回 `blocked`(P1 判定序 step 1)

---

## driver 环境变量

| 变量 | 缺省 | 说明 |
|---|---|---|
| `GANTRY_BIN` | `node <repo>/src/cli.mjs` | CLI 入口(测试用) |
| `LOOP_STUCK_LIMIT` | `2` | stuck 阈值 |

---

## driver stdout 契约(AC-6)

每次 iteration 首行必须匹配:

```
^\[loop\] step=\d+ stage=[a-z-]+ token=[a-z-]+$
```

其它输出(mock 日志 / advance 输出)允许透传但不参与断言。
