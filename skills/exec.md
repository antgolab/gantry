---
name: gantry:exec
description: 执行当前任务（wave 并行）
agent: executor
stage: dev
---

# /gantry:exec

执行 TASK.md 中的任务。支持单任务执行和 wave 并行模式。

## 用法

- `/gantry:exec` — 执行下一个待处理任务
- `/gantry:exec T03` — 执行指定任务
- `/gantry:exec --wave` — 显示当前 wave 所有任务

## 执行协议

1. 确认当前阶段为 dev
2. 解析 `.gantry/specs/<change-id>/TASK.md`
3. 按依赖关系分组为 waves
4. 分配 Executor agent
5. 每个任务在 fresh context 中执行 `phases/4-dev.md`
6. 完成后更新 TASK.md status + 写 SUMMARY

## Agent 指令

你是 **Executor（执行者）** 角色。严格遵守：
- 只在 task.write_files 范围内写代码
- TDD：先写测试 → 实现 → 通过
- 提交前 diff 边界 verify
- 原子提交（R4.1 格式）
