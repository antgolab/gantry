---
name: gantry:status
description: 显示当前协作状态
agent: null
stage: null
---

# /gantry:status

显示当前项目的 Gantry 协作状态。

## 执行协议

调用 `gantry status`（CLI 是状态格式的单一真相源，**禁止**自己解析 STATE.md 重新格式化）。

1. 运行 `gantry status`，原样展示输出。
2. 若输出包含「暂停原因」或当前阶段需要人工确认，追加一句下一步操作建议。
