# gantry self-heal · DEV verify 失败重试记忆

> P3 交付,承接 P1 `loop-next` / P2 `loop-guard`。字段与代码单一来源:
> `src/lib/self-heal.mjs` / `src/cli.mjs` heal / acGate / `src/lib/phases.mjs` checkAcGate

---

## 何时触发

> P3 交付,承接 P1 `loop-next` / P2 `loop-guard`(P4 已折叠进 `gantry advance`)。
> 字段与代码单一来源:`src/lib/self-heal.mjs` / `src/cli.mjs` heal / `src/lib/phases.mjs` checkAcGate

DEV 阶段 verify 失败(R2.5 允许最多 3 次自愈)时,executor(自动化或人工)应显式调:

```bash
gantry heal <taskId> --reason "verify 失败:xxx" \
                     --command "node --test tests/foo.test.mjs" \
                     --stderr "AssertionError: expected 1 got 2"
```

- 成功记录 → stdout `recorded #<n>`,exit 0
- `<n>` 是该 taskId 已记录 attempt 数 + 1(从 1 起)

---

## EXECUTION.md `## Self-Heal Log` 段格式

self-heal 记录**只写** EXECUTION.md,追加到独立段 `## Self-Heal Log`:

```markdown
## Self-Heal Log

### T02 · attempt #1

- at: 2026-09-16T14:30:12.000Z
- reason: verify 失败:assertion mismatch
- command: `node --test tests/foo.test.mjs`
- stderr:
  ```
  AssertionError: expected 1 got 2
    at tests/foo.test.mjs:12
  ```

### T02 · attempt #2

- at: 2026-09-16T14:35:47.000Z
- reason: 修改断言方向后仍失败,fixture 数据问题
- command: `node --test tests/foo.test.mjs`
```

**约束**:
- 段标题 `## Self-Heal Log` 固定字面,`readHealLog` 靠此定位
- 子记录标题正则 `^### (\S+) · attempt #(\d+)$`,taskId 不允许空白 / `#` / 换行
- fields 顺序固定:`at → reason → command → stderr`
- `reason` 单行,超 200 字符截断加 `…`
- `stderr` 用三反引号 code fence 包裹,超 8KB 保留头 6KB + 尾 2KB + `[...truncated N bytes]`

---

## R2.5 上限落地 · gantry heal --check

R2.5 明文:"最多自愈 3 次,第 4 次仍失败才停下汇报"。P3 用一条查询命令落地:

```bash
gantry heal --check <taskId>
```

| 记录数 K | 输出 | exit | 副作用 |
|---|---|---|---|
| K < 3 | `ok · attempts=K/3` | 0 | 无 |
| K >= 3 | `blocked · attempts=K/3` | 2 | 写 `fence.lastStageResult.blockedReason = 'heal: limit exceeded task=<taskId>'` |

**fence 熔断契约**(与 loop-guard 内联熔断一致):
- 只写 `blockedReason` 为空的 fence;已有非空 → 不覆盖(单一职责:谁先熔断谁负责)
- 下一次 `loop-next` 自然返回 `blocked`(P1 判定序 step 1)

**注**:上限阈值 `3` 硬编码,不做运行时配置化——避免"调大就绕过"。测试中允许通过 `shouldStopHealing(log, taskId, limit)` 覆盖,仅供覆盖率场景。

---

## self-heal vs PATCH · 语义边界

| 维度 | PATCH | self-heal |
|---|---|---|
| 触发 | 需求 / AC / 边界变化 | dev verify 失败 |
| 载体 | `PATCH.md`(有 open/closed 状态) | `EXECUTION.md ## Self-Heal Log`(仅追加) |
| 生命周期 | 跨阶段(SPEC → DESIGN → TASK → DEV → TEST → REVIEW) | 单 task,单 change |
| 影响面 | 可能改 AC / 废 task / 加 task | 只是"重试记忆",不改任何契约 |
| 恢复 | patch 段勾选完成 | task 自身修复或 stopHealing 后人工介入 |

**代码层强隔离**:
- `src/lib/self-heal.mjs` 不 import `patch.mjs`,不读 `PATCH.md`
- 单测显式断言 `PATCH.md` 前后字节相等(SPEC AC-8)

---

## AC 覆盖硬闸(integration 门禁)

> P4(2026-09-16)命令折叠:独立的 `gantry ac-gate` CLI 已删除。
> AC 覆盖硬闸只由 integration 门禁末端触发,纯函数 `checkAcCoverage` 保留供门禁调用。

**触发时机**:
`checkGate('integration', ...)` 末端会自动调 `checkAcCoverage`,校验 SPEC 声明的 AC 编号是否全部被 `test-commands.yml` 的 `covers` 覆盖。

| 场景 | 门禁行为 |
|---|---|
| 全覆盖 | 门禁通过 |
| 有缺失 | 门禁 fail · reason: `ac-gate: missing AC-3, AC-5` |
| SPEC 无 AC 或 test-commands.yml 缺失 | 门禁通过 + skipReason |

**手动自检**:review 阶段直接跑 `gantry advance` 直到 integration,门禁失败即可看到缺失 AC 列表。

**fence 写入**:门禁 fail 时由 advance 已有失败路径写 `fence.blockedReason`(非覆盖)。

---

## 恢复步骤

### heal 达到 R2.5 上限

1. 检查 stderr:`[heal] limit exceeded, task=<taskId>`
2. 查看 EXECUTION.md `## Self-Heal Log` 段,读所有 attempt 的根因
3. 决定路径:
   - **代码问题** → 修复后清 fence.blockedReason,人工判断是否可以继续
   - **AC/需求问题** → 走 PATCH 流程(不是 self-heal 的职责)
   - **测试本身有 bug** → 修测试,不要弱化(R5.3 硬底线)
4. 清 fence:手动编辑 `.gantry/planning/STATE.md` fence JSON,`lastStageResult.blockedReason` 置 `null`
5. 继续 `gantry advance` 或 `bash .gantry/loop/loop.sh <client>`(client ∈ `claude` | `codex`)

### integration AC 覆盖门禁阻塞

1. 检查门禁 reason:`ac-gate: missing AC-X, AC-Y`
2. 到 `.gantry/loop/test-commands.yml` 里给某条命令的 `covers` 加上缺失 AC
3. 或者补齐一条 test 命令,例如 `integration: cmd: ...  covers: [AC-X, AC-Y]`
4. 再跑 `gantry advance` 进 integration

---

## 与 P1/P2/P4 契约的关系

```
        ┌────────────────────────────────────┐
        │       .gantry/loop/loop.sh          │
        └────────────────┬───────────────────┘
                         │
             ┌───────────┼───────────┬─────────┐
             ▼           ▼           ▼         ▼
          loop-next   advance      heal    (integration
          (P1)        (既有+P4      (P3)     门禁末端)
                       内联 guard)             checkAcGate
             │           │           │         (P3)
             ▼           ▼           ▼         │
       computeNext   preAdvance  appendHeal   checkAc
       Step          LoopGuard   Attempt      Coverage
                    +transition  (self-       (loop.mjs)
                     Stage        heal.mjs)
                                     heal.mjs)
    │          │         │        │         │
    └────┬─────┘         │        │         │
         ▼               │        │         │
   fence.blockedReason ◀─┴────────┴─────────┘
     (P1 定义,P2/P3 谁先熔断谁写)
```

**契约不变**:
- P1 `computeNextStep` 判定序不变
- P2 `checkLoopGuard` 契约不变(P4 折叠只改调用位置)
- P3 只新增 self-heal 段 + `heal` CLI + integration 门禁末端 check
- P4 收敛 CLI:删掉独立的 `loop-guard` / `ac-gate` 命令,合入 `advance` 与门禁
- fence.blockedReason 采取"先到先得,不覆盖"策略,三家共同遵守
