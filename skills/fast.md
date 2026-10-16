---
name: gantry:fast
description: 已内部化 · light 管线由 CLI `--tier light` 直接进入
agent: planner
stage: change
requiresApproval: true
---

# /gantry:fast(内部化 · 2026-09-21)

> **状态**:此 skill 已从公开入口下沉为内部机制。light 管线由 CLI 直接进入：`gantry change --tier light --scope <p,...> "<描述>"`，**不经过 change 阶段**（无 PROPOSAL、无人工关卡）。renderer 不再产出 `.claude/skills/gantry-fast/`。
>
> 保留源文件是因为 STAGE_PHASE_MAP 仍把 `fast` 映射到 `F-fast` 阶段（`phases/F-fast.md`），老归档 change 与内部 phase 也可能引用此路径。

# /gantry:fast

light 管线的快捷入口等价于：

```bash
gantry change --tier light --scope <p,...> [--accept "<a;b>"] [--verify "<cmd>"] "<描述>"
```

## 执行协议

1. 确认当前没有活跃 change。
2. 运行上面的 `gantry change --tier light …`。CLI 预检失败（非 git 项目 / 描述命中红线 / 范围非法）时自动回落 `full@change`，此时按 full 流程走。
3. 进入 `light@fast` 后按 `phases/F-fast.md` 实施：只在 `light.json` 的 `intent.scope` 内改动，**不创建 PROPOSAL**，不停人工关卡。
4. 完成后运行 `gantry advance`（唯一出口门）：CLI 执行 verify + diff 守卫；全过则自动归档，命中则自动升档 `full@change`。

不支持强制绕过出口门（`--skip` 被拒绝）；范围扩大由守卫自动升档 `gantry pipeline full`，不手动加人工关卡。
