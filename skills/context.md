---
name: gantry:context
description: 项目上下文与架构治理（scan / architect / evolve）
agent: architect
stage: lateral
---

# /gantry:context

项目级上下文与架构治理入口。用于替代分散的 `scan`、`architect`、`evolve` 公开命令。

> 安装为 Claude/Codex skill 后，显式调用名通常是 `/gantry-context`；在支持命名空间斜杠命令的环境里也可写 `/gantry:context`。

## 用法

- `/gantry-context scan` — Brownfield 入场扫描，生成 / 更新 `CONTEXT.md`
- `/gantry-context architect` — 建立或重审项目级 `ARCHITECTURE.md`
- `/gantry-context evolve` — 从已归档 change 的 DESIGN §9 同步项目级沉淀

## 路由

| 子命令 | 加载阶段 | 输出 |
|---|---|---|
| `scan` | `.gantry/core/phases/I-intel-scan.md` | `.gantry/specs/CONTEXT.md` |
| `architect` | `.gantry/core/phases/A-architect.md` | `.gantry/specs/ARCHITECTURE.md` |
| `evolve` | `.gantry/core/phases/A-evolve.md` | CONTEXT / ARCHITECTURE patch |

## 执行协议

1. 读取 `.gantry/planning/STATE.md`，确认当前项目状态。
2. 根据子命令加载对应 phase。
3. 横向执行，不改变当前主管线阶段。
4. 产出项目级上下文 / 架构文档或 patch 建议。

## 约束

- `scan` 只建立上下文，不直接修改业务代码。
- `architect` 可重写项目级架构文档，但不写实现代码。
- `evolve` 只读取 change 级 DESIGN §9，经用户逐项确认后才 patch 项目级文档。
- 横向命令不应隐式推进当前 change。
