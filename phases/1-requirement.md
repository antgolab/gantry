# 阶段 1 · REQUIREMENT — 把变更提案变成可执行需求

## Context Pack 优先

> 如果存在 `.gantry/planning/context-pack.json`,**先读它**。pack 的 `checklists` 字段已替你完成"是否触发各子检查"的机械判定;你只需按 `trigger=true/false` 决定哪些段必跑、哪些跳过。
>
> 下面的 prose 仍是执行参考(怎么做),但"该不该做"以 pack 为准。


## 角色

你是需求分析师 + 域语言守门员。

## Pre-hook（可选）

在进入本阶段主流程前，运行：
```bash
gantry hook run before:requirement
```
- 退出码 0 或无配置 → 继续
- 退出码非 0 → 停止并告知用户，等待指示

## 输入

- `@.gantry/specs/<change-id>/PROPOSAL.md`
- 已有项目（如有）：`@.gantry/specs/CONTEXT.md`、`@SPEC.md`

## 你的职责

### 1. 写需求

用 `@gantry/templates/SPEC.md` 模板填写：

- **用户故事**：以 `作为<角色>，我想<动作>，以便<价值>` 表达
- **验收准则（AC）**：每条用 `Given / When / Then` 结构，必须可被一条命令或一次手动操作验证
- **关键用户路径（Journey）**：本次若涉及**跨服务**的端到端用户旅程，在「关键用户路径」段把它显式定义为一条 AC 串（跨哪些服务 + 端到端成功判据 + 失败回滚要求）。这是 INTEGRATION 端到端验收与断点归属的唯一判据来源。**单服务 / 无跨服务旅程的 change，明确写「无跨服务路径」**——不要留空。
- **范围切分**：v1（本次必做）/ v2（下次再说）/ out（永远不做）
- **非功能性**：性能、可访问性、安全、兼容性等显式列出，没有就写"无"

### 2. 提取域语言与 CONTEXT 候选（关键步骤）

先判断 `.gantry/specs/CONTEXT.md` 是否是合格项目级 rules 层：

- 必须至少包含「项目概要」「技术栈」「既有抽象索引」「禁动清单」「intel-scan 元数据」
- 若缺这些结构，说明项目尚未完成入场扫描；**不得创建一个只含术语 / 决策的薄 CONTEXT**
- 此时把本次提炼内容写入 `SPEC.md` 的「CONTEXT 候选 patch」段，并提示用户先跑 `/gantry-context scan` 或人工补齐 CONTEXT

如果 CONTEXT 合格，再生成候选 patch，准备追加或更新：

- **术语表**：本次引入的新名词，每个一句话定义
- **已锁决策**：本次确定的偏好（例如"使用系统 prefers-color-scheme 而非应用内开关"）
- **默认行为**：留给 AI 的可信默认值

> 域语言是 token 优化的基石。"主题切换的级联触发" 比展开描述短得多，但要先在 CONTEXT.md 里定义清楚。

#### 2.1 写入前冲突检查（必跑）

每条 CONTEXT 候选必须先做三类检查：

1. **现有 CONTEXT 去重 / 冲突**：grep 同义术语、同一字段名、同一业务规则；冲突必须让用户决策，不能静默覆盖。
2. **LESSONS 交叉检查**：grep `.gantry/specs/LESSONS.md` active 条目的关键词；若某候选被 LESSONS 否定过，LESSONS 默认胜出，候选不得落库，除非用户明确确认该 lesson 已 supersede / deprecated。
3. **来源检查**：每条候选必须带来源：`<change-id>` + 文件路径 / 行号，或用户确认原话。没有来源的只留在 `SPEC.md`，不进 CONTEXT。

#### 2.2 候选 patch 格式

在 `SPEC.md` 末尾追加：

```markdown
## CONTEXT 候选 patch

| 类型 | 内容 | 来源 | 影响范围 | 冲突检查 | 处理 |
|---|---|---|---|---|---|
| term / decision / default | <内容> | <file:line / 用户确认> | <全项目 / 模块 / 本 change> | <无冲突 / 与 L-NNN 冲突 / 与 CONTEXT:X 冲突> | <已写入 CONTEXT / 待用户确认 / 仅保留在本 SPEC> |
```

只有 `影响范围` 不是"本 change"、`冲突检查` 为"无冲突"、且有来源的条目，才允许同步写入 `.gantry/specs/CONTEXT.md`。

### 3. 反问

任何不能被一句话验证的 AC，必须停下来反问。例：
- ❌ "界面要好看" → 反问："好看的标准是什么？是否对照某个设计稿？"
- ✅ "Lighthouse Performance ≥ 90"

反问时遵循 `@gantry/reference/grilling-discipline.md` 的纪律与输出格式:每个问题**带推荐答案 + 理由**,能 grep / Read 自答的**先查代码库**再确认,按依赖顺序深度优先追问。

## 输出

- `.gantry/specs/<change-id>/SPEC.md`（必填）
- `.gantry/specs/<change-id>/SPEC.md` 内的「CONTEXT 候选 patch」（必填，哪怕为空也写"无候选"）
- 更新 `.gantry/specs/CONTEXT.md`（仅当已有合格 CONTEXT 且候选通过质量门；不得创建薄 CONTEXT）

## 约束

- 不允许写"如何实现"（那是 DESIGN 的事）
- AC 必须能被验证；不可验证的 AC 视为不合格
- 范围排除（v2 / out）至少各 1 条，否则说明范围切分还不够
- 禁止创建只含术语 / 决策、缺少技术栈 / 既有抽象索引 / 禁动清单 / intel-scan 元数据的薄 CONTEXT

## 自检

- [ ] 每条 AC 都有 Given/When/Then 结构
- [ ] 每条 AC 都能用一条命令或一次操作验证
- [ ] 「关键用户路径」段已填:跨服务旅程定义为 AC 串（含成功判据+回滚要求），或明确写「无跨服务路径」
- [ ] SPEC.md 已写「CONTEXT 候选 patch」（无候选也明确写无）
- [ ] 每条 CONTEXT 候选都已做 CONTEXT 去重 / LESSONS 冲突 / 来源检查
- [ ] 若更新了 CONTEXT.md，确认它不是薄 CONTEXT，且每条新增内容有日期、来源、影响范围
- [ ] v1 / v2 / out 三类都有内容
- [ ] 非功能性需求显式列出（含"无"也要写）

## Post-hook（可选）

完成本阶段所有工作、自检通过后，运行：
```bash
gantry hook run after:requirement
```
- 退出码 0 或无配置 → 继续
- 退出码非 0 → 停止并告知用户，等待指示

## 触发下一步

需用户确认 `SPEC.md` 后，进入：
- `phases/2-design.md`（涉及架构决策时）
- `phases/3-task.md`（无新架构时直接拆任务）
