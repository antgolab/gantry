---
name: gantry:fast
description: 已内部化 · light 挡位由 /gantry-change 或 /gantry-auto 内部判定
agent: planner
stage: change
requiresApproval: true
---

# /gantry:fast(内部化 · 2026-09-21)

> **状态**:此 skill 已从公开入口下沉为内部机制。用户想走 light 管线,直接 `/gantry-change --pipeline light "<描述>"` 或让 `/gantry-auto` 内部判定即可,不必手动敲 fast。
>
> 保留源文件是因为 CLI 的 `--pipeline light` 分支仍需加载 Planner agent + F-fast phase;老归档 change 与内部 phase 也可能引用此路径。renderer 不再产出 `.claude/skills/gantry-fast/`。

# /gantry:fast

`/gantry:fast "<描述>"` 是正式 light 管线的快捷入口，等价于：

```bash
gantry change --pipeline light "<描述>"
```

## 执行协议

1. 确认当前没有活跃 change。
2. 调用 `gantry change --pipeline light`；CLI 风险预检失败时停止并建议 full。
3. 按 change 阶段完成反问，产出包含 `uiImpact` 的 `PROPOSAL.md`。
4. 停在 Change 人工确认关卡。
5. 用户确认后由 `/gantry-next` 推进到 `fast`。
6. fast 产出 `EXECUTION.md` 和 verify 证据，再进入 Integration。

不支持强制绕过 light 资格；范围扩大时运行 `gantry pipeline full`。
