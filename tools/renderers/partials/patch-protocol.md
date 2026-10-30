## 你正在协作一个使用 Gantry 流程的项目

完整流程：`PROPOSAL → SPEC → DESIGN → TASKS → DEV → TEST → REVIEW → INTEGRATION`

每阶段产物存到 `.gantry/specs/<change-id>/`，跨 change 文件存到 `.gantry/specs/`：
- `PROPOSAL.md` — 变更提案
- `SPEC.md` — 需求 + AC（Given/When/Then）
- `DESIGN.md` — 技术决策 + ADR + 风险
- `TASKS.md` — 原子任务（XML，含 verify + done）
- `EXECUTION.md` — change 级执行记录
- `<task-id>-SUMMARY.md` — 仅高风险/例外任务完成报告
- `TEST.md` — 测试矩阵
- `REVIEW.md` — 双轮审查
- `.gantry/specs/CONTEXT.md` — 项目级共享上下文
- `.gantry/specs/LESSONS.md` — 跨任务失败知识库

## Patch 识别

每个 phase prompt 执行前**必读**当前 change 的 `.gantry/specs/<change-id>/PATCH.md`：

- 文件存在且 `status: open` → 当前处于 patch 闭环中。
- 先查看「变更记录」理解持续调整原因。
- 再查看「必须更新」中与当前阶段对应的检查项。
- 当前阶段完成后，必须在 `PATCH.md` 中勾选对应项。

| 阶段 | Patch 行为 |
|---|---|
| requirement | 更新 AC / 边界 / 非目标，勾选 `SPEC.md` |
| design | 追加 design delta / ADR 变更，勾选 `DESIGN.md` |
| task | 追加 patch task；废弃旧任务标注 `supersededBy`，勾选 `TASKS.md` |
| dev | 只执行 patch 相关任务，勾选 `DEV` |
| test | 补测试矩阵和结果，勾选 `TEST.md` |
| review | 复核 spec 与实现一致，勾选 `REVIEW.md` |

**禁止**：patch 中静默覆盖旧事实。废弃旧 AC / ADR / task 时必须写明 replacement 或 drop reason。

## 角色红线

- Architect lane 不写实现代码
- Dev lane 不改 `SPEC.md` / `DESIGN.md`（发现问题开新 `PROPOSAL`）
- Reviewer lane 不修代码（只产报告 + 修复 task）

---

## R1 · 上下文与 Token

- **R1.1** 出现以下任一信号必须触发清窗：① 累计 / 输入 token > 200k；② 当前上下文窗口使用率 > 85%；③ 复读已说过的内容
- **R1.2** 阶段切换时输出本阶段工件文件作为后续唯一上下文来源
- **R1.3** 引用历史决策必须用 `@文件路径`，禁止粘贴正文
- **R1.5 · 重启协议** 清窗前必须写 `<task-id>-PROGRESS.md`（已完成 / 当前 / 已排除方案）
- **R1.8 · LESSONS 检查** DEV 前必须 grep `.gantry/learnings/team/`

## R2 · 阶段门

- **R2.1** 没 `PROPOSAL.md` 不能进 `REQUIREMENT`
- **R2.2** 没 `SPEC.md` 不能进 `DESIGN`
- **R2.3** 没 `TASKS.md` 不能写代码；每任务必含可执行 `verify`。**例外 · light 管线**：light 不要求 `TASKS.md`，意图由 `light.json` 固化，越界 / 红线由 `gantry advance` 出口门的 diff 守卫兜底
- **R2.4** verify 未通过禁止标记完成
- **R2.5** 可恢复门禁进入「诊断 → 修复 → 实际重验」循环，首次失败不直接交回用户。DEV 使用最新 `ralph.maxRepairs`，其他阶段（含 light）使用 `autonomous.maxRetries`，均默认3；宿主统一持久化计数，skill/phase/hook/review 不叠加预算，重启不清零。耗尽后报告最后证据，不能用跳过/弱化验收消除失败。
- **R2.6** `autonomous: true` 时，phase prompt 里所有反问 / 多选 / 停下场景一律取推荐项（无推荐项则取列表第一项），选择与理由写进产物，闭环推进。**仅两类不覆盖**：① `requiresApproval` 硬锁的 change / design / integration 三关（`src/lib/phases.mjs#requiresApproval`）——这三关**只适用于 full 管线**，light 无任何人工关卡；② 宿主预算耗尽、取消/时限、锁或活跃进程/清理未确认、控制记录损坏、用户内容归属不明；确需用户提供的新决策或凭据也须等待。可修复的规则偏差先修复重验，不通过弱化测试或重定义验收绕过检查。

## R4 · 提交与产物

- **R4.1** commit 单位 = stage。DEV 阶段末统一 1 个 commit（格式 `<type>(<change-id>): dev 阶段概要`），覆盖全部代码变更 + `EXECUTION.md`。wave 边界不产 commit。
- **R4.2** 代码改动必须伴随测试改动

## R5 · 测试纪律

- **R5.1** 测试用例必须从 AC 派生，禁止从实现派生
- **R5.2** 禁止用 mock 屏蔽真实失败
- **R5.3** 禁止删除 / 弱化测试来"修复"失败

## R6 · 反幻觉

- **R6.1** 引用外部 API / 字段名前必须 grep 验证存在性
- **R6.2** 不确定的事实必须明示"待确认"
- **R6.3** 不能假设代码"应该可以工作"——必须实际跑 verify

## R7 · 范围控制

- **R7.1** 严禁悄悄扩大范围；业务目标和验收范围改变走 adjust；计划文件列表差异仅提示，保留用户改动
- **R7.2** 无关任务指跨 change 的任务；同 change 内多 task 允许打包进同一 stage commit

---

## 违规处理

检测到自己即将违反任一规则时，先输出：
` 规则 R{编号} 触发：<原因>。诊断与修复计划：<计划或必须人工处理的具体原因>。`
可恢复问题先在宿主预算内修复并重验；仅人工确认/缺用户决策或凭据、预算耗尽、取消/时限、进程/控制记录/用户内容保护才停止，禁止自我批准或绕过验收。
