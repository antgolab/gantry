# 阶段 7 · INTEGRATION — 集成验证 + UAT + 失败诊断

## Context Pack 优先

> 如果存在 `.gantry/planning/context-pack.json`,**先读它**。pack 的 `checklists` 字段已替你完成"是否触发各子检查"的机械判定;你只需按 `trigger=true/false` 决定哪些段必跑、哪些跳过。
>
> 下面的 prose 仍是执行参考(怎么做),但"该不该做"以 pack 为准。


## 角色

你是 Verifier + Release。

## Pre-hook（可选）

在进入本阶段主流程前，运行：
```bash
gantry hook run before:integration
```
- 退出码 0 或无配置 → 继续
- 退出码非 0 → 停止并告知用户，等待指示

## 输入

- `@.gantry/specs/<change-id>/SPEC.md`（兼容期接受 `REQUIREMENT.md`；含「关键用户路径」成功判据）
- `@.gantry/specs/<change-id>/DESIGN.md`（跨服务时必读 `§2.1 路径服务序列`——断点归属的事实源）
- `@.gantry/specs/<change-id>/TEST.md`（含 UAT 脚本）
- `@.gantry/specs/<change-id>/REVIEW.md`
- 当前已合并/待合并的代码

## 你的职责

### 1. 跑全套自动化

- 全量单测：`npm test`（或等价）
- 集成测试 / e2e：`npm run e2e`（如有）
- 类型检查 / 静态检查：`tsc --noEmit` / `lint` 等
- 构建：`npm run build`

**贴出每条命令的真实输出**到产出中。任何失败立即进入「失败诊断」。

### 2. 跨服务路径总验收（条件步骤 · 单 Coordinator 角色）

> **仅当 SPEC「关键用户路径」定义了跨服务 Journey 时跑**（SPEC 写「无跨服务路径」则整步跳过，在 UAT.md 记一句「本 change 无跨服务路径，跳过路径总验收」）。
>
> 由**一个** Coordinator（你，Integrator 兼任）统一协调——同仓多服务下你能直接读到各端代码与契约，不 spawn 多个对端 agent。这是**整个需求对结果负责的最终关卡**:所有关键 Journey 端到端通过，需求才算完成。

**事实源(第一性):判定断点归属的唯一依据是已锁工件——`SPEC.md` 的路径成功判据 + `DESIGN.md §2.1` 的服务序列。不靠 agent 各执一词。**

#### 2.1 逐条 Journey 端到端跑

对 SPEC 每条 Journey，按 `DESIGN.md §2.1` 的服务序列拉起真实多方(或必要的桩)，走完整路径。**贴真实输出**。每条至少覆盖:正常路径、每一环的失败与补偿、超时、部分成功回滚。

#### 2.2 断点定位与归属判定

路径断在哪一环，抓到**具体服务 + 具体调用**，对照已锁工件判定责任方:

| 断点性质 | 判定依据 | 归属 / 动作 |
|---|---|---|
| 某服务实现**偏离 DESIGN §2.1 的序列/契约** | DESIGN §2.1 | 该服务产 `T-FIX-XX`，回退 `phases/4-dev.md` |
| **DESIGN 路径设计本身有缺陷**(时序错 / 缺补偿) | 对照 SPEC 成功判据 | 回退 `phases/2-design.md` 重锁序列 |
| **SPEC 路径定义 / 成功判据有歧义** | 用户确认 | 回退 `phases/1-requirement.md` |

判定结论写入 `JOURNEY-VERIFY.md`。

#### 2.3 驱动修复并重跑（直到路径通）

责任方修复后，**由 Coordinator 重跑该 Journey**，直到端到端通过——不是产完修复任务就结束。

**R2.6 适用**:同一 Journey 的自动修复重试 ≤ 3 轮，超限停下要求人工决策。

#### 2.4 路径验收账本

产出 `.gantry/specs/<change-id>/JOURNEY-VERIFY.md`(用 `@gantry/templates/JOURNEY-VERIFY.md` 模板):每条 Journey 的验收结果、断点、归属判定、修复任务链接、最终状态。

**总验收门:所有关键 Journey 端到端通过(或断点已全部回退修复并重跑通过)，才能进入下一步 UAT。**

---

### 3. 引导人工 UAT

逐条读 TEST.md 的 UAT 脚本，向用户提问形如：

> UAT-1：深色模式手动切换。请按以下步骤操作：……
> 通过 / 失败 / 描述问题：

记录每条 UAT 的结果到 `.gantry/specs/<change-id>/UAT.md`。

### 4. 失败诊断（自动 + 人工）

任何失败（自动测试或 UAT）：

1. 切到「Diagnose 子角色」，定位 root cause（不是症状）
2. 产出 fix-plan：追加到 `TASKS.md`（兼容期接受 `TASK.md`），编号 `T-FIX-XX`，含完整 verify
3. 回到 `phases/4-dev.md` 执行修复
4. 修完回到本步重跑

**R2.6**：自动重试 ≤ 3 轮。第 3 轮仍失败必须停下来要求人工决策。

### 5. 提名 LESSONS（在 ARCHIVE 之前必跑，对应 R1.8）

扫本次 change 的 `EXECUTION.md`、所有例外 `*-SUMMARY.md` 的「决策与偏离」段，以及任何遗留的 `*-PROGRESS.md`「已排除方案」段。
按 `@gantry/templates/LESSONS.md` 末尾的「提名条件」筛选：

- 调试 / 试错耗时 > 30 分钟 → 提名
- 错因不局限于本任务、其它任务也会撞 → 提名
- 6 个月内有合理概率被再次尝试 → 提名
- 否则不入库（避免污染）

把入选的失败按 LESSONS.md 的条目格式追加到 `.gantry/specs/LESSONS.md`，编号续上 `L-NNN`，必须填齐：标签 / 关键词 / 适用栈 / 状态。
**复核**：扫一眼现有 active 条目，看是否有本次 change 让它们 `superseded` 或 `deprecated`，标注上。

### 6. 收尾（CLOSE）— 归档由 archive 命令执行

全部通过后：

- 在 `.gantry/specs/CHANGELOG.md` 追加一行（日期 / change-id / 一句话摘要 / PR 链接 / 新增 LESSONS 条目编号）
- 运行 `gantry archive` 收尾（归档到 `_archive` 并重置 STATE 到 idle）
- **`.gantry/specs/<change-id>/` 保留在原位**；`_archive` 保存一份归档副本

#### 6.0 收尾与归档

`gantry archive` 默认复制归档，不删除源目录。

收尾完成后明确告诉用户：

```
✅ INTEGRATION 完成。运行 gantry archive 归档并把状态重置为 idle。
   change 目录仍在 .gantry/specs/<change-id>/，归档副本在 .gantry/specs/_archive/<change-id>/。

   强制收尾：gantry archive --force
   保留历史归档：gantry archive --keep-history
```

#### 6.1 项目级架构文档同步（不在本步做 · 走 A-evolve）

本 change 的 `DESIGN.md § 9 架构沉淀建议` **不在收尾时立即合并到 `CONTEXT.md`**。原因：单个 change 视角窄，容易把临时决策错升项目级。

正确做法：

- 收尾后 DESIGN.md § 9 内容保留在 change 目录里，等待批量 evolve
- 在收尾提示里告诉用户：

  ```
  本 change 的 DESIGN § 9 架构沉淀建议有 N 条候选项，已留待批量同步。
  建议在积累 ≥ 5 个 change 或满 60 天后跑：
  docs/GO.md 同步架构
  （走 /gantry-context evolve 工作流逐项 review 后 patch CONTEXT.md）
  ```

  N = `grep -c '^### 9\\.' DESIGN.md`，如果整段是"无架构层面沉淀建议"则 N=0，不必提示
- **禁止**在本步直接修改 `.gantry/specs/CONTEXT.md`——它的更新统一走 `/gantry-context evolve` 或 `/gantry-context scan`

### 7. 出 PR（可选）

如果用户用 git 流水线：
- 检查 PR 标题/正文已自动从 `PROPOSAL.md` + `EXECUTION.md` 拼装（兼容期接受旧命名）
- 列出涉及的文件、AC 覆盖、UAT 结论
- 把 `.gantry/specs/` 内的文件归类到 PR 描述（不污染代码 diff）

## 输出

- `.gantry/specs/<change-id>/UAT.md`
- `.gantry/specs/<change-id>/JOURNEY-VERIFY.md`（仅跨服务；SPEC 声明无跨服务路径时跳过，在 UAT.md 写明）
- 更新的 `.gantry/specs/CHANGELOG.md`
- 0~N 个 fix-plan（如有失败或路径断点）
- `gantry archive` 会把 change 副本归档到 `.gantry/specs/_archive/<change-id>/`

## 约束（强制）

- **R2.6**：UAT 失败的自动重试 ≤ 3 轮
- **R4.4**：禁止声称"通过"而没贴真实输出
- **不在本阶段移动 / 删除 `.gantry/specs/<change-id>/`**——archive 归档只复制，源目录保留

## 自检

- [ ] 全量自动化结果已贴出且全绿
- [ ] 跨服务:每条 Journey 端到端跑过 + 断点已判定归属 + 全部通过或已回退修复重跑通过（单服务已写明跳过）
- [ ] 每条 UAT 都有人工通过/失败标注
- [ ] 失败的项目都已经过最多 3 轮自动重试，超限的已暂停
- [ ] CHANGELOG 已追加
- [ ] `archive` 后源 `.gantry/specs/<change-id>/` 仍保留；默认存在 `_archive/<change-id>/` 副本

## Post-hook（可选）

完成本阶段所有工作、自检通过后，运行：
```bash
gantry hook run after:integration
```
- 退出码 0 或无配置 → 继续
- 退出码非 0 → 停止并告知用户，等待指示

## 触发下一步

- 此 CHANGE 完成 → `gantry archive`（收尾 + 默认归档）→ `gantry change "<新>"`
- 有未解决的 fix-plan → 暂停，告知用户决策
