---
name: gantry:review
description: 审查入口（代码审查 / 产品需求门禁 / 对抗性审查）
agent: reviewer
stage: review
requiresApproval: false
---

# /gantry:review

统一审查入口：代码审查、产品需求门禁、实现过程中的对抗性审查。

## 用法

- `/gantry:review` — 标准双轮 / 三轮代码审查
- `/gantry:review --cross-model` — 启用跨模型第三轮审查
- `/gantry:review --requirement [file|change-id]` — 产品需求门禁
- `/gantry:review --adversarial` — dev 阶段对抗性审查

## 执行协议

### 标准代码审查

1. 确认当前阶段为 test 或 review
2. 分配 Reviewer agent
3. 加载 `.gantry/core/phases/6-review.md`
4. 执行双轮审查：
   - 第 1 轮：规格合规（AC 逐条对照）
   - 第 2 轮：代码质量（SOLID / DRY / 安全）
   - 第 3 轮（--cross-model）：跨模型审查
5. 产出 `.gantry/specs/<change-id>/REVIEW.md`
6. 进入人工确认关卡

### `--requirement` 产品需求门禁

目标是判断 `PROPOSAL.md`、PRD 或任意需求文档是否把“为什么做、为谁做、做什么、做到什么程度、哪些不做、还有哪些决策未闭环”讲清楚。

输入：
- 目标文件内容（`PROPOSAL.md` / PRD / 需求文档）
- 如有：`.gantry/specs/CONTEXT.md`（术语表 + 已锁业务决策）
- 如有：既有 `SPEC.md`（兼容期接受 `REQUIREMENT.md`）中与本次需求相关的业务约束

只审查产品职责范围，不评审技术设计、架构方案、数据库 Schema、接口协议、测试方案或发布运维方案。

六维门禁：

| 维度 | 重点 |
|---|---|
| 问题与价值 | 目标用户、业务场景、问题证据、业务目标、成功指标、不做后果 |
| 范围与优先级 | 本次范围、范围排除、后续范围、优先级理由、MVP 合理性 |
| 用户/流程/规则 | 用户角色、触发条件、主流程、状态规则、异常业务场景、业务口径 |
| 一致性与歧义 | 同一角色/状态/指标/范围/验收标准是否冲突 |
| 验收口径 | 能否判断完成，是否覆盖成功/失败/边界/无权限/无数据 |
| 依赖/风险/决策闭环 | 业务依赖、外部承诺、未决问题 owner、产品风险、跨职能评估 |

硬性 blocker：
1. 缺少业务目标或成功指标。
2. 缺少本次范围或验收口径。
3. 缺少目标用户或业务场景。
4. 存在未解决的 critical 业务规则矛盾。
5. 涉及资损、隐私、合规、客户承诺或权限扩大，但无业务边界和 owner。
6. 外部依赖未声明依赖方、交付物或截止时间。
7. 关键未决问题没有 owner 和决策时限。

输出：PASS / FAIL，附 blocker、critical、major、minor 发现列表；FAIL 时不得推进后续需求分析或设计。

### `--adversarial` 对抗性审查

在开发过程中主动触发，不替代 REVIEW 阶段。用于挑战当前实现方案，在问题固化为代码之前发现缺陷。

触发时机：
- 做了不确定的技术决策
- 实现复杂度超出预期
- 偏离 DESIGN.md 的方案
- 同一个问题改了两次仍未解决

输入：
- 当前 git diff
- DESIGN.md 相关段落
- `SPEC.md`（兼容期接受 `REQUIREMENT.md`）相关 AC
- 当前方案的一句话决策理由

审查维度：
1. 正确性：逻辑是否有漏洞，边界情况是否处理。
2. 简单性：是否有更简单方案，是否过度设计。
3. 一致性：是否与 DESIGN.md 和项目既有模式一致。
4. 完整性：是否遗漏需求条件。
5. 风险：最可能出错的地方是什么。

输出写入 `EXECUTION.md` 的当前 task 段「对抗审查」小节；例外任务可同步写入 `SUMMARY.md`。最多 3 轮，3 轮后仍有 unresolved critical 时停止开发并升级人工决策。

## Agent 指令

你是 **Reviewer（审查员）** 角色。严格遵守：
- 不允许修改代码文件（R3.3）
- 审查结果分 severity（critical/major/minor/nit）
- critical/major 问题必须创建修复任务
