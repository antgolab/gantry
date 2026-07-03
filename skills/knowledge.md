---
name: gantry:knowledge
description: 知识捕获与知识库维护（capture / curate）
agent: researcher
stage: knowledge
---

# /gantry:knowledge

知识入口。用于捕获研究、POC、技术对比等非闭环知识，也用于月度/季度知识库维护。

> 安装为 Claude/Codex skill 后，显式调用名通常是 `/gantry-knowledge`；在支持命名空间斜杠命令的环境里也可写 `/gantry:knowledge`。

## 用法

- `/gantry-knowledge capture <topic>` — 捕获研究、POC、技术对比等非闭环知识
- `/gantry-knowledge curate` — 月度知识库维护 + 团队健康巡检
- `/gantry-knowledge curate --quarterly` — 季度深度 review（含 CONVENTIONS 漂移检测 + 规则 retro）
- `/gantry-knowledge curate --solo` — Solo 模式，聚焦知识库维护

## 执行协议

### capture

1. 分配 Researcher agent
2. 加载 `.gantry/core/phases/K-knowledge.md`
3. 产出 `.gantry/specs/knowledge/<topic>.md`

### curate

1. 分配 Curator agent
2. 加载 `.gantry/core/phases/C-curator.md`
3. 跑 `gantry metrics` 获取月度数据
4. 整理 LESSONS（合入待审 / 状态迁移 / 重复合并 / 更新索引）
5. 整理 knowledge（状态升级 / 过期检测 / 重复合并）
6. CONTEXT / CONVENTIONS 同步检查
7. 写 month report

季度模式额外执行：CONVENTIONS 漂移检测 + 规则 retro + LESSONS 全量健康检查。

横向命令，不影响主管线进度。

## 约束

- Curator 只改状态，禁止删除或修改他人正文。
- 禁止直接修改 CONTEXT.md / CONVENTIONS.md / ARCHITECTURE.md；需要项目级同步时走 `/gantry-context evolve`。
- metrics 是观察镜，不是 KPI。
