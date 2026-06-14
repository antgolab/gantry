---
name: gantry:ship
description: archive 的兼容入口
agent: integrator
stage: integration
checkpoint: human-verify
---

# /gantry:ship

兼容旧命令。实际执行与 `/gantry:archive` 相同：完成当前 change 收尾、复制归档到 `.gantry/specs/_archive/<change-id>/`，然后重置 STATE 为 idle。

新流程优先使用 `/gantry:archive`。

## 执行协议

调用 `gantry ship [--force] [--keep-history]`，CLI 内部走 `archive` 同一套逻辑。
