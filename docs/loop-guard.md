# gantry loop-guard · 上下文 / 步数熔断

> P2 交付、P4(2026-09-16)命令折叠后内联到 `gantry advance` 入口。
> 独立的 `gantry loop-guard` 子命令已删除,同名纯函数 `checkLoopGuard` 保留。
> 文档字段与代码一致来源于:
> `src/lib/loop-guard.mjs` / `src/cli.mjs` preAdvanceLoopGuard / `src/loop/loop.sh`

---

## 何时熔断

每次 `gantry advance` 入口先跑 `preAdvanceLoopGuard`(内联),按优先级判定:

| 优先级 | 触发条件 | reason |
|---|---|---|
| 1 | `state.contextUsage.windowPercent >= 阈值` | `context-window-exceeded` |
| 2 | `state.contextUsage.tokens > 阈值` | `context-tokens-exceeded` |
| 3 | `state.stagesRun >= state.maxStages` | `max-stages-exceeded` |
| — | driver 层:同 token 连续 ≥ `LOOP_STUCK_LIMIT` | shell 内 `exit 5` |

前三档触发时 `gantry advance` 直接:
- exit 2 —— driver 视其为**硬停**,不重试、原样透传,
  stderr 报 `✗ blocked: advance rc=2 phase=<phase> <advance 输出尾 3 行>`
- stderr `[advance warn] <reason>`
- 写 `fence.lastStageResult.blockedReason = 'loop-guard: <reason>'`(**不覆盖**已有非空值)

> 对照:advance 因**门禁未过**失败时是 `exit 1`,driver 会带诊断退避重试(见
> [`docs/loop.md`](loop.md) § 重试与自主决策)。熔断刻意不重试——它要的是人工介入,
> 而不是再跑一轮。

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
4. 重跑 `gantry loop <client>`(client ∈ `claude` | `codex`),或单跑 `gantry advance`

---

## 与 P1 loop-next 的关系图

```
┌─────────────────────────────────────────────────────────┐
│                    src/loop/loop.sh                      │
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
| `GANTRY_BIN` | `gantry`(测试指向 mock) | CLI 入口 |
| `GANTRY_LOOP_DISPATCHER` | `<包>/src/loop/dispatch-<client>.sh` | 覆盖 dispatcher 路径 |
| `GANTRY_LOOP_MAX_STEPS` | `40` | 步数上限 |
| `LOOP_STUCK_LIMIT` | `2` | stuck 阈值 |
| `GANTRY_LOOP_RETRIES` | `config.autonomous.maxRetries`(3) | 失败重试上限 |
| `GANTRY_LOOP_BACKOFF` | `1` | 退避基数秒(`0` = 不等待) |
| `GANTRY_LOOP_RETRY_CONTEXT` | 由 driver 导出,指向 `last-failure.txt` | 失败上下文,dispatcher 读它重新决策 |

---

## driver stdout 契约

`--quiet` 下每次 iteration 收尾一行摘要:

```
^step=\d+/\d+ stage=[a-z-?]+ token=[a-z-]+ dispatch=\d+ms advance=\d+ms rc=0$
```

默认(全显示)模式下每步不再是单行:

```
[loop] step=<n>/<max> stage=<s> token=<t> attempt=<k>     ← 派发前的头行
<dispatch stdout 流式转发>
[loop] step=<n>/<max> ok dispatch=<d>ms advance=<a>ms attempt=<k>
```

重试行(仅默认模式可见于 stdout,`--quiet` 时仍走 stderr):

```
[loop] ↻ retry <k>/<N> token=<t> <kind>-rc=<rc> backoff=<s>s
```

断言按模式取对应契约,不要跨模式匹配。
