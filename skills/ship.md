---
name: gantry:ship
description: 完成 change 收尾（阶段 7 后；默认归档）
agent: integrator
stage: integration
checkpoint: human-verify
---

# /gantry:ship

执行 change 收尾：UAT 通过后重置 STATE，并默认复制归档到 `.specs/_archive/<change-id>/`。如需保留旧行为，使用 `--no-archive`。

## 执行协议

1. 确认当前阶段为 integration（或 --force 跳过）
2. 分配 Integrator agent
3. 加载 `phases/7-integration.md`
4. 执行 UAT（按 AC 逐条验证）
5. 如果通过：复制 `.specs/<change-id>/` 到 `.specs/_archive/<change-id>/`，保留源目录
6. 如果失败：创建修复任务，回退到 dev（≤ 3 轮）
7. 提名 LESSONS 条目
8. 输出生命周期报告
9. 重置 STATE 为 idle；如果传 `--no-archive`，只收尾并提示可补归档
