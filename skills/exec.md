---
name: gantry:exec
description: 已内部化 · dev 阶段由 /gantry-next / /gantry-auto 自动触发
agent: executor
stage: dev
---

# /gantry:exec（内部化 · 2026-09-21）

> **状态**:此 skill 已从公开入口下沉为内部机制。日常场景下由 `/gantry-next` 或 `/gantry-auto` 到 dev 阶段自动触发,用户无需直接敲。
>
> 保留源文件是因为 dev 阶段的执行协议仍需通过此 skill 加载 Executor agent + pack driven 协议;老归档 change 与内部 phase 也可能引用此路径。renderer 不再产出 `.claude/skills/gantry-exec/`。

# /gantry:exec

执行 `TASKS.md` 中的单个任务。同 wave 的多个 task 由编排器并发 fan-out，每个 task 一个 executor（见 `4-dev.md`「波次编排」）。

## 用法

- `/gantry:exec` — 执行下一个待处理任务
- `/gantry:exec T03` — 执行指定任务
- `/gantry:exec --wave` — 由当前会话充当编排器，按 `4-dev.md`「波次编排」并发 fan-out 当前 wave 的 pending tasks

## 执行协议（pack-driven · 推荐）

1. 每个 task 开始前跑 `gantry context dev --task <id>`；即使同属一个 wave 也必须刷新，不得沿用上一 task 的 pack。并发 fan-out 时由编排器串行生成（加 `--json`）并写进各 executor 的 prompt，executor 只认 prompt 里的 pack
2. 读 pack（单独执行时为 `.gantry/planning/context-pack.json`）,严格按其指示办事:
   - **loadOrder**: 顺序加载列出的文件(phase prompt / 制品 / context-doc / LESSONS)
   - **checklists**: `trigger=true` 必须执行,`trigger=false` 必须跳过(reason 字段说明原因)
   - **lessons**: 实现前 grep 命中条目,确认本次方案与之差异
   - **next.onSuccess**: 任务完成后必须执行(DEV worker 默认为 `gantry done <task-id>`，不得自行推进阶段)
3. 单独执行时，完成后跑 `gantry done <task-id>` 标记 task done + 更新 `EXECUTION.md`；并发 fan-out 的 executor 不跑 `gantry done`、不写 `TASKS.md` / `EXECUTION.md`，执行记录与微复盘写进返回报告，由编排器串行落盘
4. 单独调用 `/gantry-exec` 时，全部 task done 后由当前编排器跑 `gantry advance`；由 `/gantry-auto` 创建的 worker 必须停止并把控制权交还 auto orchestrator

## Agent 指令

你是 **Executor（执行者）** 角色。严格遵守:
- 只在 task.write_files 范围内写代码
- TDD: 先写测试 → 实现 → 通过
- 提交前 diff 边界 verify(R6.5)
- 不自行 commit(R4.1:DEV 末由编排器统一提交)
- 不读 pack 不动手:pack 是 kernel 给的施工单,不是建议
- task 失败立即停止并在返回报告里保留证据，不跳过失败继续
