# PROPOSAL: <一句话标题>

- **Change ID**: <kebab-case-id，例如 add-dark-mode>
- **创建日期**: <YYYY-MM-DD>
- **Pipeline**: full / light
- **uiImpact**: true / false
- **状态**: draft / active / archived

---

## Why（为什么做）

<具体场景、痛点、触发原因。不写"会更好"这种空话。>

## What（做什么）

<一段话能说清的范围摘要。>

## 视觉调性（仅 uiImpact=true 时填写）

- **选定**：<编号><名称>
- **理由**：<为什么选这个，结合项目业务一句话>
- **参考产品**：<3 个>
- **明确排除**：<本项目明显不合适的调性，1~3 个，含理由>

## 影响面

- [ ] 影响 `SPEC.md`
- [ ] 影响 `DESIGN.md` / 引入新 ADR
- [ ] 影响现有 AC
- [ ] 影响数据模型 / 迁移
- [ ] 影响外部 API 兼容性
- [ ] 仅修复 bug，无范围变化

## 范围排除（这次不做）

- <至少 1 条>

## 验收线（粗粒度，不是 AC）

- <用户能感知的最终效果，1~3 条>

## 风险与未知

- <列已知风险与未明事项，没有就写"无">

## 待澄清问题（阻断推进 · 必须全部解决）

> change 阶段没问清的点列在这里。每条都**必须先反问用户、拿到答案、把结论合并进上面的 Why/What/影响面，然后划掉本条**。
> 本段存在任何未勾选项（`- [ ]`）时，推进会被门禁阻断——未决问题应当问人，不是带进下一阶段。
> 全部澄清后，把本段内容改为单行：`无`。

- [ ] <未澄清问题示例，澄清后删除本行；若无未决问题，将本段改为"无">

---

> full 的后续 AC 与设计细节进入 `SPEC.md` / `DESIGN.md`；light 直接进入 fast。


## 调研覆盖（复杂变更可选）

无需调研的简单变更可删除本段。需要时取消下例各行的引用符 `>`，填写完整七行后启用；
状态、来源和作用域规范见阶段协议的「研究覆盖台账」。本示例仍是未决事项，不能直接推进。

> <!-- gantry:research-ledger -->
> ## Research Coverage
>
> | surface | status | evidence | openDecision | scope |
> |---|---|---|---|---|
> | contracts | open-needs-user | — | <接口/数据契约待决问题> | * |
> | lifecycle | open-needs-user | — | <状态转换待决问题> | * |
> | failure/retry | open-needs-user | — | <失败与重试待决问题> | * |
> | permission/ownership | open-needs-user | — | <权限归属待决问题> | * |
> | source-of-truth | open-needs-user | — | <事实源冲突待决问题> | * |
> | experience | open-needs-user | — | <体验验收标准，或填写不适用依据> | * |
> | external-version | open-needs-user | — | <官方 URL / version / deprecated，或填写不适用依据> | * |
