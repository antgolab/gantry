---
name: gantry:unarchive
description: 从 _archive 恢复 change 目录到 .specs/
agent: integrator
stage: lateral
---

# /gantry:unarchive

把 `.specs/_archive/<archive-name>/` 恢复到 `.specs/<change-id>/`。不切换 STATE。

## 用法

- `/gantry:unarchive <change-id>` — 默认从 `_archive/<change-id>/` 恢复
- `/gantry:unarchive <change-id> --from <archive-name>` — 指定具体归档（如 `<id>.v2`）

## 执行协议

调用 `gantry unarchive <change-id> [--from <name>]`。

CLI 行为：

1. 校验源归档存在 `.specs/_archive/<archive-name>/`
2. 校验目标 `.specs/<change-id>/` **不**存在（避免覆盖在用文件）
3. 复制源 → 目标
4. 不动 STATE

## 后续

恢复后 STATE 仍为 idle。要继续工作运行：

- `/gantry:adjust "<发生了什么>"` — 在活跃 change 中打开或追加 `PATCH.md`
- 手动用 `gantry status` + `gantry next` 推进（高级用法）

## 何时运行

- 想查看 / 复用已归档 change 的工件
- 误归档需回滚（搭配 `--from <name>.v2` 取特定版本）
- 跨项目移植 change 工件（先 unarchive，再人工拷贝到新项目）
