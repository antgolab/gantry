# gantry loop · 无人值守收敛引擎

> P1(`loop-next`)/ P2(driver + guard 内联)/ P3(`heal` + integration AC 硬闸)/ P4(命令折叠)已全部交付。
> P4(2026-09-16)将 `loop-guard` 折进 `advance` 入口、彻底删除 `ac-gate` CLI,AC 覆盖硬闸只由 integration 门禁触发。
> P5(2026-10-12)driver 输出默认全显示(`--quiet` 收敛)、CLI 透传参数、失败带诊断退避重试。
> 关联 change: `.gantry/specs/gantry-loop-pdlc-gantry-patch/`(P1)、`.gantry/specs/gantry-loop-p2-driver-guard/`(P2)、`.gantry/specs/gantry-loop-p3-heal-gate/`(P3)。

---

## 概念

`gantry loop` 借鉴 pdlc 的 loop 骨架(状态机是唯一真源 / 客观 check / 只前进),
落地到 gantry 的语义:

| pdlc 骨架 | gantry 实现 |
|---|---|
| STATE 是唯一真源 | `.gantry/planning/STATE.md`(散文区 + fence JSON) |
| 客观 check | `verify` 命令 + AC 编号覆盖校验 |
| 只前进 | `transitionStage` state-must-advance 断言 |
| 白名单单 token | `loop-next` 命令的 11 词表 |
| 两种 pipeline | full(8 阶段)/ light(fast 单阶段 · 无人工关卡闭环) |

---

## 用法

```bash
# 只读输出下一步 token,不改任何状态
gantry loop-next
# → stdout: 白名单 token 之一(如 "gantry-task" / "gantry-fast" / "done" / "blocked")
# → exit 0(推进 / done)或 exit 2(blocked)

# driver 消费示例(P2 + P4)
while true; do
  step=$(gantry loop-next)
  case "$step" in
    done) break ;;
    blocked) echo "需要人工介入"; exit 2 ;;
    gantry-*) gantry advance ;;   # advance 入口内联 loop-guard 熔断
  esac
done
```

### driver 入口(2026-10-12 起)

```bash
gantry loop claude              # 默认:全显示 + 流式转发 dispatch 输出
gantry loop claude --quiet      # 只打每步一行摘要,输出落日志
gantry loop codex -q            # 同上
gantry loop claude --verbose    # 兼容别名(默认行为已等同),接受但不改变行为
```

`gantry loop` 会把 client 之后的参数原样透传给 `src/loop/loop.sh`;
此前这些 flag 会被 CLI 静默丢弃。

---

## 白名单

`loop-next` 输出严格取自这 11 个 token:

- `gantry-change`
- `gantry-requirement`
- `gantry-design`
- `gantry-task`
- `gantry-dev`
- `gantry-test`
- `gantry-review`
- `gantry-integration`
- `gantry-fast` — light 管线的唯一阶段(fast)内部 token,不对应公开 skill;
  light@fast **未收敛**时 driver 拿到的就是它(D23)
- `done` — 已达 pipeline 收敛条件
- `blocked` — 需要人工介入

任何超出白名单的输出都会退化为 `blocked` + stderr warn。

### 收敛条件

`CONVERGE_CONDITIONS[pipeline]` 命中即输出 `done`(判定序第 2 步):

| pipeline | 收敛条件 |
|---|---|
| `full` | `currentStage === 'integration'` 且 `lastStageResult.ok === true` |
| `light` | `currentStage === 'fast'` 且 `lastStageResult.ok === true` |

light 只有 `fast` 一个阶段,没有独立收尾阶段:driver 在 `light@fast` 上反复消费
`gantry-fast`,直到出口门把 `lastStageResult.ok` 写为 true → 下一次 `loop-next`
输出 `done`。`lastStageResult.blockedReason` 非空时仍然优先输出 `blocked`。

---

## Fence 结构

`STATE.md` 末尾有机器可读区(散文区 + fence 双写):

```markdown
<!-- BEGIN gantry:state -->
​```json
{
  "nextStep": "gantry-test" | null,
  "lastStageResult": { "ok": true, "blockedReason": null } | null,
  "currentWave": 2 | null,
  "previousWave": 1 | null
}
​```
<!-- END gantry:state -->
```

字段语义:

| 字段 | 用途 |
|---|---|
| `nextStep` | 显式写死下一步(优先级低于 blockedReason,高于兜底推导) |
| `lastStageResult.ok` | 上一阶段 verify 是否通过 |
| `lastStageResult.blockedReason` | 非空则 `loop-next` 立即输出 `blocked` |
| `currentWave` / `previousWave` | dev 阶段 wave 推进例外的判定依据 |

读写通过 `readFence(root)` / `writeFence(root, obj)`,幂等且原子。

---

## 判定序

`computeNextStep(state)` 严格按 5 步走:

1. `lastStageResult.blockedReason` 非空 → `blocked`
2. `CONVERGE_CONDITIONS[pipeline]` 命中 → `done`
3. `state.nextStep` 在白名单 → 直接返回
4. 兜底:按 pipeline 顺序推导 `currentStage` 的后继(跳过 `ui-design` 条件阶段);
   `light@fast` 走到管线末位且未收敛时返回 `gantry-fast`(D23)
5. 上述都失败 → `blocked`

---

## 输出纪律与重试语义(2026-10-12)

### 输出

| 模式 | 每步输出 | dispatch / advance 输出 |
|---|---|---|
| 默认 | 头行 `[loop] step=N/MAX stage=.. token=.. attempt=K` + 步末摘要 | 流式转发到终端,同时落 `last-dispatch.log` / `last-advance.log` |
| `--quiet` / `-q` | 单行 `step=N/MAX stage=.. token=.. dispatch=..ms advance=..ms rc=0` | 只落日志,不转发 |

任一步循环 append 一行到 `.gantry/loop/metrics.jsonl`(含 `attempt` 字段),
用 `node <包>/src/loop/tail-metrics.mjs` 可实时查看。

### 重试与自主决策

不重试的**硬停**(确定性失败或需人工决策),直接透传退出码:

| 情形 | 退出码 |
|---|---|
| `loop-next` 返回 `blocked` | 2 |
| `advance rc=2`(loop-guard 熔断 / `before:dev` hook 阻断) | 2 |
| `dispatch rc=64`(未知 phase / phase 文件缺失等用法·配置错) | 64 |

可重试的两类失败:

| 失败 | 处理 |
|---|---|
| dispatch 非零且 rc≠64 | 退避后重跑同一 phase(纯重试) |
| advance 非零且 rc≠2 | 写失败上下文 → 带诊断重新 dispatch 同 phase → 再 advance(自愈) |

上限 `RETRY_LIMIT`:**`GANTRY_LOOP_RETRIES` 环境变量 > `config.autonomous.maxRetries` > 3**。
超限后 dispatch 走 `exit 4`,advance 透传其 rc。退避为指数 `1,2,4,…` 秒、封顶 30 秒,
基数可用 `GANTRY_LOOP_BACKOFF` 覆盖(测试传 `0` 免等待)。

**禁盲重试**:每次失败都会把诊断写进 `.gantry/loop/last-failure.txt`,driver 通过
`GANTRY_LOOP_RETRY_CONTEXT` 把它交给 `dispatch-<client>.sh`,后者拼进 prompt 要求
client「先诊断根因、不得重复上一轮做法」。每步开始删除该文件,所以「文件非空」就等价于
「这是重试轮」。与 R2.5「每次自愈都要有新诊断」同源。成功收尾后同样删除,不污染下一步。

---

## state-must-advance 断言

`transitionStage(root, from, to)` 现在拒绝停留:

- `from === to` 一律抛错,**除非** dev 阶段且 `currentWave !== previousWave`
- 保证 loop 每一步都推进状态机,消除 pdlc 反模式"表面推进实际停留"

---

## P2 / P3 / P4 已交付

- ✅ **P2 · driver** — `src/loop/loop.sh <client>`(经 `gantry loop` 调用)循环消费 `loop-next` + 派发到 `dispatch-<client>.sh`(claude / codex headless),配合**用户项目**的 `.gantry/loop/test-commands.yml` 定义 verify + covers
- ✅ **P2 · loop-guard** — 上下文 token / step 上限熔断,见 [docs/loop-guard.md](./loop-guard.md)(P4 已折入 `advance`)
- ✅ **P3 · EXECUTION.md self-heal 缓冲** — DEV 阶段 verify 失败,`gantry heal` 追加根因到 EXECUTION.md;`heal --check` 达 R2.5 上限时写 fence.blockedReason,见 [docs/self-heal.md](./self-heal.md)
- ✅ **P3 · AC 强校验闸** — integration 门禁末端 `checkAcCoverage` 硬闸,缺 AC 覆盖阻塞进 integration,见 [docs/self-heal.md](./self-heal.md)
- ✅ **P4 · 命令折叠**(2026-09-16)— `loop-guard` 折进 `advance` 入口、`ac-gate` CLI 删除,收敛为 `loop-next` / `advance` / `heal` 三条命令

P2 / P3 change 收尾后归档到 `.gantry/specs/_archive/`。

---

## 相关文件

- `src/loop/loop.sh` — driver(2026-10-12 从 `.gantry/loop/` 迁入)
- `src/loop/dispatch-{claude,codex}.sh` — headless 派发器
- `src/loop/tail-metrics.mjs` — 指标查看器
- `src/lib/loop.mjs` — 纯函数决策器
- `src/lib/state.mjs` — fence 读写 + state-must-advance
- `src/cli.mjs` — `loop` / `loop-next` 子命令入口
- `tests/loop-*.test.mjs` — 全套单测 + CLI 集成测试

### 为什么 driver 不在 `.gantry/` 里

`.gantry/` 是**运行时产物目录**(STATE.md / specs / learnings / 日志 / metrics),它被
gitignore,不随仓库分发。而 driver 是**随包分发的代码**,所以住在 `src/loop/`。

由此确立的规则:**本仓库的任何逻辑都不得依赖 `./.gantry/` 下的文件**——依赖它就会在
干净 checkout 上必然失败(CI 就是这么红的)。用户项目侧的 `<项目>/.gantry/**` 读写不受此限,
那正是运行时数据该待的地方。

| 东西 | 位置 | 性质 |
|---|---|---|
| `src/loop/*` | 仓库 `src/` | 分发的代码 → 必须 tracked |
| `<项目>/.gantry/loop/test-commands.yml` | 用户项目 | 项目侧配置。`install` 铺注释模板(源 `src/loop/test-commands.template.yml`),**不覆盖**已有文件;AC 硬闸 fail-closed,缺失/为空/漏覆盖都阻塞 integration |
| `<项目>/.gantry/loop/{metrics.jsonl,last-failure.txt,last-*.log}` | 用户项目 | driver 运行期 `mkdir -p` 自建 |
