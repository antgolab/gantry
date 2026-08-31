---
name: gantry:exec
description: 执行当前任务（wave 并行）
agent: executor
stage: dev
---

# /gantry:exec

执行 `TASKS.md` 中的任务。支持单任务执行，以及一个 wave 子 Agent 内的顺序多任务执行。

## 用法

- `/gantry:exec` — 执行下一个待处理任务
- `/gantry:exec T03` — 执行指定任务
- `/gantry:exec --wave` — 顺序执行当前 wave 的 pending tasks

## 执行协议（pack-driven · 推荐）

1. 每个 task 开始前跑 `gantry context dev --task <id>`；即使同属一个 wave 也必须刷新，不得沿用上一 task 的 pack
2. 读 `.gantry/planning/context-pack.json`,严格按其指示办事:
   - **loadOrder**: 顺序加载列出的文件(phase prompt / 制品 / context-doc / LESSONS)
   - **checklists**: `trigger=true` 必须执行,`trigger=false` 必须跳过(reason 字段说明原因)
   - **lessons**: 实现前 grep 命中条目,确认本次方案与之差异
   - **next.onSuccess**: 任务完成后必须执行(DEV worker 默认为 `gantry done <task-id>`，不得自行推进阶段)
3. 完成后跑 `gantry done <task-id>` 标记 task done + 更新 `EXECUTION.md`；wave 内再进入下一个 task
4. 单独调用 `/gantry-exec` 时，全部 task done 后由当前编排器跑 `gantry advance`；由 `/gantry-auto` 创建的 worker 必须停止并把控制权交还 auto orchestrator

## Agent 指令

你是 **Executor（执行者）** 角色。严格遵守:
- 只在 task.write_files 范围内写代码
- TDD: 先写测试 → 实现 → 通过
- 提交前 diff 边界 verify(R6.5)
- 原子提交(R4.1 格式)
- 不读 pack 不动手:`.gantry/planning/context-pack.json` 是 kernel 给的施工单,不是建议
- wave 内任一 task 失败立即停止，不跳过失败任务继续后续任务
