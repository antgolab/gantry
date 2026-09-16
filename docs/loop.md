# gantry loop · 无人值守收敛引擎

> **P1 范围仅覆盖 `loop-next` 只读命令**。driver / self-heal / guard 由后续 change 交付。
> 关联 change: `.gantry/specs/gantry-loop-pdlc-gantry-patch/`

---

## 概念

`gantry loop` 借鉴 pdlc 的 loop 骨架(状态机是唯一真源 / 客观 check / 只前进),
落地到 gantry 的语义:

| pdlc 骨架 | gantry 实现 |
|---|---|
| STATE 是唯一真源 | `.gantry/planning/STATE.md`(散文区 + fence JSON) |
| 客观 check | `verify` 命令 + AC 编号覆盖校验 |
| 只前进 | `transitionStage` state-must-advance 断言 |
| 白名单单 token | `loop-next` 命令的 10 词表 |
| 三种 pipeline | full(8 阶段)/ light(fast)/ micro(3 阶段) |

---

## 用法

```bash
# 只读输出下一步 token,不改任何状态
gantry loop-next
# → stdout: "gantry-task" / "done" / "blocked" 之一
# → exit 0(推进 / done)或 exit 2(blocked)

# driver 消费示例(P2 交付)
while true; do
  step=$(gantry loop-next)
  case "$step" in
    done) break ;;
    blocked) echo "需要人工介入"; exit 2 ;;
    gantry-*) /"$step" ;;   # 客户端 skill
  esac
done
```

---

## 白名单

`loop-next` 输出严格取自这 10 个 token:

- `gantry-change`
- `gantry-requirement`
- `gantry-design`
- `gantry-task`
- `gantry-dev`
- `gantry-test`
- `gantry-review`
- `gantry-integration`
- `done` — 已达 pipeline 收敛条件
- `blocked` — 需要人工介入

任何超出白名单的输出都会退化为 `blocked` + stderr warn。

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
4. 兜底:按 pipeline 顺序推导 `currentStage` 的后继(跳过 `ui-design` 条件阶段)
5. 上述都失败 → `blocked`

---

## state-must-advance 断言

`transitionStage(root, from, to)` 现在拒绝停留:

- `from === to` 一律抛错,**除非** dev 阶段且 `currentWave !== previousWave`
- 保证 loop 每一步都推进状态机,消除 pdlc 反模式"表面推进实际停留"

---

## P2 / P3 TODO

- ✅ **P2 · driver** — `.gantry/loop/loop.sh` 循环消费 `loop-next`,配合 `.gantry/loop/test-commands.yml` 定义 verify + covers
- ✅ **P2 · loop-guard** — 上下文 token / step 上限熔断,见 [docs/loop-guard.md](./loop-guard.md)
- ⏳ **P3 · EXECUTION.md self-heal 缓冲** — DEV 阶段验证失败时,自愈记录落 EXECUTION.md(不走 PATCH)
- ⏳ **P3 · AC 强校验闸** — integration 前 `checkAcCoverage` 必须全绿

P2 change: `.gantry/specs/gantry-loop-p2-driver/`(收尾后归档到 `_archive/`)。

---

## 相关文件

- `src/lib/loop.mjs` — 纯函数决策器
- `src/lib/state.mjs` — fence 读写 + state-must-advance
- `src/cli.mjs` — `loop-next` 子命令入口
- `tests/loop-*.test.mjs` — P1 全套单测 + CLI 集成测试
