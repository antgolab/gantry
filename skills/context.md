---
name: gantry:context
description: 项目上下文、架构治理与知识库（scan / architect / evolve / knowledge）
agent: architect
stage: lateral
---

# /gantry:context

项目级上下文、架构治理与知识库统一入口。用于替代分散的 `scan`、`architect`、`evolve`、`knowledge` 公开命令。

> 安装为 Claude/Codex skill 后，显式调用名通常是 `/gantry-context`；在支持命名空间斜杠命令的环境里也可写 `/gantry:context`。

## 用法

- `/gantry-context scan` — Brownfield 入场扫描，生成 / 更新 `CONTEXT.md`
- `/gantry-context architect` — 建立或重审项目级 `ARCHITECTURE.md`
- `/gantry-context evolve` — 从已归档 change 的 DESIGN §9 同步项目级沉淀
- `/gantry-context knowledge capture <topic>` — 捕获研究、POC、技术对比等非闭环知识
- `/gantry-context knowledge curate` — 月度知识库维护 + 团队健康巡检
- `/gantry-context knowledge curate --quarterly` — 季度深度 review（含 CONVENTIONS 漂移检测 + 规则 retro）
- `/gantry-context knowledge curate --solo` — Solo 模式，聚焦知识库维护

## 路由

| 子命令 | 加载阶段 | 输出 |
|---|---|---|
| `scan` | `.gantry/core/phases/I-intel-scan.md` | `.gantry/specs/CONTEXT.md` |
| `architect` | `.gantry/core/phases/A-architect.md` | `.gantry/specs/ARCHITECTURE.md` |
| `evolve` | `.gantry/core/phases/A-evolve.md` | CONTEXT / ARCHITECTURE patch |
| `knowledge capture` | `.gantry/core/phases/K-knowledge.md`（Researcher agent）| `.gantry/specs/knowledge/<topic>.md` |
| `knowledge curate` | `.gantry/core/phases/C-curator.md`（Curator agent）| LESSONS / knowledge 状态迁移 + month report |

## 执行协议

1. 读取 `.gantry/planning/STATE.md`，确认当前项目状态。
2. 根据子命令加载对应 phase 和 agent。
3. 横向执行，不改变当前主管线阶段。
4. 产出项目级上下文 / 架构文档 / 知识条目或 patch 建议。

### knowledge curate 额外流程

1. 跑 `gantry metrics` 获取月度数据。
2. 整理 LESSONS（合入待审 / 状态迁移 / 重复合并 / 更新索引）。
3. 整理 knowledge（状态升级 / 过期检测 / 重复合并）。
4. CONTEXT / CONVENTIONS 同步检查。
5. 写 month report。
6. 季度模式额外执行：CONVENTIONS 漂移检测 + 规则 retro + LESSONS 全量健康检查。

## 约束

- `scan` 只建立上下文，不直接修改业务代码。
- `architect` 可重写项目级架构文档，但不写实现代码。
- `evolve` 只读取 change 级 DESIGN §9，经用户逐项确认后才 patch 项目级文档。
- `knowledge curate`（Curator）只改状态，禁止删除或修改他人正文。
- `knowledge capture` / `curate` 禁止直接修改 CONTEXT.md / CONVENTIONS.md / ARCHITECTURE.md；需要项目级同步时走 `/gantry-context evolve`。
- 横向命令不应隐式推进当前 change。
- metrics 是观察镜，不是 KPI。
