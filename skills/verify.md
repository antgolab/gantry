---
name: gantry:verify
description: 运行任务验证命令
agent: executor
stage: dev
---

# /gantry:verify

运行任务的 verify 命令，确认实现正确。

## 用法

- `/gantry:verify` — 验证当前任务
- `/gantry:verify T03` — 验证指定任务
- `/gantry:verify --all` — 验证所有已完成任务

## 执行协议

1. 读取 TASK.md 中对应任务的 verify 字段
2. 执行 verify 命令
3. 报告结果（通过/失败）
4. 如果失败：提示修复方向
