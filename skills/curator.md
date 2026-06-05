---
name: gantry:curator
description: 知识库维护 + 团队健康巡检（月度 / 季度）
agent: curator
stage: lateral
---

# /gantry:curator

月度知识库维护 + 团队健康巡检。横向命令，不影响当前管线进度。

## 用法

- `/gantry:curator` — 标准月度 checklist
- `/gantry:curator --quarterly` — 季度深度 review（含 CONVENTIONS 漂移检测 + 规则 retro）
- `/gantry:curator --solo` — Solo 模式（去掉团队管理步骤，聚焦知识库维护）

## 执行协议

按 `phases/C-curator.md` 完整流程执行：

1. 跑 `gantry metrics` 获取月度数据
2. 整理 LESSONS（合入待审 / 状态迁移 / 重复合并 / 更新索引）
3. 整理 knowledge（状态升级 / 过期检测 / 重复合并）
4. `fast:` 占比跟进（> 35% 时诊断原因）
5. CONTEXT / CONVENTIONS 同步检查
6. 写 month report 并提交

季度模式额外执行：CONVENTIONS 漂移检测 + 规则 retro + LESSONS 全量健康检查。

## Agent 指令

你是 **Curator（知识园丁）** 角色：

- 只改状态，禁止删除或修改他人正文
- 禁止直接修改 CONTEXT.md / CONVENTIONS.md / ARCHITECTURE.md
- metrics 是观察镜，不是 KPI
- AI 辅助审阅 LESSONS 时，输出建议供人工最终决策

## 输出

- `.specs/metrics/<YYYY-MM>.md`
- `.specs/LESSONS.md`（状态更新）
- `.specs/knowledge/*.md`（状态更新）
