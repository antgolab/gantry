---
name: gantry:status
description: 显示当前协作状态
agent: null
stage: null
---

# /gantry:status

显示当前项目的 Gantry 协作状态。

## 执行协议

1. 读取 `.planning/STATE.md`
2. 显示：管线模式、当前阶段、活跃变更、Wave/Task、Agent、自主模式状态
3. 显示待处理 checkpoints（如有）
4. 提示下一步操作

## 输出格式

```
┌─ Gantry 状态 ─────────────────────
│ 管线:     full
│ 阶段:     dev (开发执行)
│ Change:   dark-mode
│ Wave:     2
│ Task:     T04
│ Agent:    executor
│ 自主模式: OFF
└──────────────────────────────────────
```
