---
name: gantry:unarchive
description: 从 _archive 恢复并重新激活 change
agent: integrator
stage: integration
---

# /gantry:unarchive

把 `.gantry/specs/_archive/<archive-name>/` 恢复到 `.gantry/specs/<change-id>/`，并把该 change 重新设为活跃状态。它是 `archive` 的反向生命周期动作。

## 用法

- `/gantry:unarchive <change-id>` — 默认从 `_archive/<change-id>/` 恢复
- `/gantry:unarchive <change-id> --from <archive-name>` — 指定具体归档（如 `<id>.v2`）

## 执行协议

调用 `gantry unarchive <change-id> [--from <name>]`。

CLI 行为：

1. 校验源归档存在 `.gantry/specs/_archive/<archive-name>/`
2. 校验当前 STATE 为 idle，避免覆盖正在进行的 change
3. 如果 `.gantry/specs/<change-id>/` 不存在，复制源 → 目标；如果已存在，只重新激活
4. 更新 STATE：`activeChange=<change-id>`，`currentStage=integration`，`activeAgent=integrator`

## 后续

恢复后可以：

- `/gantry:adjust "<发生了什么>"` — 继续修订该 change
- `/gantry:archive` — 再次收尾归档

## 何时运行

- 已归档需求需要重新打开
- 误归档后需要恢复为活跃需求
- 需要基于某个历史归档版本继续修订
