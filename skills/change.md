---
name: gantry:change
description: 启动新变更提案（阶段 0）
agent: planner
stage: change
requiresApproval: true
---

# /gantry:change

启动一个新的变更提案。将模糊想法转化为结构化的 `PROPOSAL.md`（兼容期接受 `CHANGE.md`）。

## 执行协议

1. 读取 `.gantry/planning/STATE.md`，确认无活跃 change
2. 接收用户描述（一句话需求）
3. 先从业务主题提炼英文小写 kebab-case change-id（2~5 个词，剥离输入来源 / 操作指令），再运行 `gantry change --id <id> "<描述>"`。默认 full；只有用户显式要求快速路径时才加 `--pipeline light`。
4. 读取 `.gantry/planning/context-pack.json`，按 `loadOrder` 加载 `.gantry/core/phases/0-change.md`
5. 执行 `.gantry/core/phases/0-change.md` 完整流程
6. **反问澄清（强制前置门）**：把"为什么/给谁/解决什么/何时算完"问到清楚，每轮最多 3 个问题，等用户回答。按 `@gantry/reference/grilling-discipline.md` 执行——每问**带推荐答案 + 理由**、能查代码的**先查代码库**再确认、按依赖顺序深度优先。**只要还有未澄清的点就继续问，不准提前产出 PROPOSAL。**
7. 产出 `.gantry/specs/<change-id>/PROPOSAL.md`（兼容期接受 `CHANGE.md`）。**`## 待澄清问题` 段必须为 `无`**——带未勾选项的 PROPOSAL 会被 `/gantry-next` 门禁阻断。
8. 更新 STATE.md（stage=change, agent=planner）
9. 停在人工确认关卡，等待用户审阅后继续

如果执行前 `.gantry/planning/context-pack.json` 不存在，不要判定为初始化不完整；先执行第 3 步让 CLI 创建它。若 `.gantry/core/phases/0-change.md` 不存在，运行 `gantry install` 补齐本地阶段协议。

## Agent 指令

你是 **Planner（规划者）** 角色。按 `.gantry/core/phases/0-change.md` 的完整流程执行：
- 二阶反问澄清——**反问是产出 PROPOSAL 之前不可跳过的门**
- 把疑问写进 PROPOSAL 不等于澄清；澄清 = 问到用户给出答案、结论并入正文
- 影响范围评估
- 自动生成 change-id

## 推进行为

`PROPOSAL.md` 完成后始终停在 Change 人工确认关卡，不执行 `next.onSuccess`。用户确认后由 `/gantry-next` 推进；full 进入 Requirement，light 进入 Fast。
