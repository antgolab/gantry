# 阶段 7 · INTEGRATION — 集成验证 + UAT + 失败诊断

## Context Pack 优先

> 复用入口已加载的 context pack；尚未加载时再读 `.gantry/planning/context-pack.json`。pack 的 `checklists` 字段已替你完成"是否触发各子检查"的机械判定;你只需按 `trigger=true/false` 决定哪些段必跑、哪些跳过。
>
> 下面的 prose 仍是执行参考(怎么做),但"该不该做"以 pack 为准。


## 角色

你是 Verifier + Release。

## Pre-hook（可选）

先消费 pack 的 `hook-before`：false 时直接跳过，不运行 hook 命令，也不反复探测。旧 pack 无该项时读一次有效 hook 配置；为空则本上下文内跳过，配置变化后重新判断。CLI 已执行的 before:change / before:dev 不重复执行。

在进入本阶段主流程前，运行：
```bash
gantry hook run before:integration
```
- 退出码 0 或无配置 → 继续
- 退出码非 0 → 收集诊断，按宿主剩余预算修复后重跑；候选执行者将诊断交外层，不自行批准或另开重试循环。仅预算耗尽或人工/进程/内容保护条件才停止

## 输入

- `@.gantry/specs/<change-id>/SPEC.md`（含「关键用户路径」成功判据）
- `@.gantry/specs/<change-id>/DESIGN.md`（跨服务时必读 `§2.1 路径服务序列`——断点归属的事实源）
- `@.gantry/specs/<change-id>/TEST.md`（含 UAT 脚本）
- `@.gantry/specs/<change-id>/REVIEW.md`
- 当前已合并/待合并的代码

## 你的职责

本阶段承担最终系统证据：全量自动化、远程依赖与端到端验证。TASK 的 `<verify>` 仍只代表单个 task 的完成证据，不在此扩展为新的字段。

### 1. 收口全套自动化证据

- 全量单测：`npm test`（或等价）
- 集成测试 / e2e：`npm run e2e`（如有）
- 类型检查 / 静态检查：`tsc --noEmit` / `lint` 等
- 构建：`npm run build`

由一个验证负责人按 change 收口，不按 task / wave 重复部署和跑全套。先核对 TEST 中已有的全量证据：代码与索引内容、命令、配置、目标环境一致，覆盖范围满足本阶段且未被后续改动影响时，引用原始输出路径；只执行缺失或失效部分。单 task 的 focused verify 不能代替全量证据。

远程依赖、部署版本或测试数据变化，或无法确认远程结果仍有效时，重跑对应 smoke / Journey；不以源码摘要替代环境确认。共享环境只部署同一候选版本一次、准备一次共用前置，各场景所需的数据隔离和清理仍必须执行。不同目标环境分别验证，不能因命令相同跨环境复用。

**每条命令必须有真实输出或仍有效的原始证据引用**；UAT.md 记录目标环境、部署版本及复用依据。自动 AC 命令统一交给 `gantry verify-ac` 执行，不再手跑后重复记录。任何失败立即进入「失败诊断」。

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

**R2.6 适用**:Journey 的修复共用宿主当前阶段 `autonomous.maxRetries` 剩余预算（默认3），不按 Journey 另加额度；耗尽后报告证据。

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
2. 产出 fix-plan：追加到 `TASKS.md`，编号 `T-FIX-XX`，含完整 verify
3. 回到 `phases/4-dev.md` 执行修复
4. 修完回到本步重跑

**R2.6**：自动修复使用当前阶段 `autonomous.maxRetries` 剩余预算（默认3），耗尽且仍失败才返回错误。

### 5. 聚合反思（在 ARCHIVE 之前必跑）

扫描本次 change 的 `EXECUTION.md`、所有例外 `*-SUMMARY.md` 的决策与偏离，以及任何遗留 `*-PROGRESS.md` 的已排除方案。只从已有证据归纳，不补写没有发生的过程。

在 `EXECUTION.md` 末尾维护下面的唯一聚合段。若 `## Retrospective` 已存在，更新原段，**不得重复追加**：

```markdown
## Retrospective

### Keep
<被证据证明有效、下次继续采用的做法；无则 none>

### Problem
<返工、等待、误判、失败及根因；无则 none>

### Next
<下次具体改变什么 + 如何验证；无则 none>
```

Keep / Problem / Next 没有有效内容时明确记录 `none`，不得凑数。只基于现有证据归纳；其中可跨任务复用的经验在下一步 Curator 候选复核时参考，不再手工写入 `.gantry/specs/LESSONS.md`，不维护复发次数或晋升状态机。

### 6. 沉淀经验（自动 · friction + Curator，对应 R1.8）

DEV/TEST 阶段的 friction 事件已由 `src/lib/friction.mjs` 自动记录（verifyFail / sameFileEdit3+ / rollback 等）。ARCHIVE 前：

- 由 Curator（`src/lib/curator.mjs` 的 `proposeLearning`）汇总 friction 事件，自动生成候选 learning。
- 人工复核候选（对照 `## Retrospective` 的 Problem / Next）后合入 `.gantry/learnings/team/`，不再手动提名、不再手工追加条目。

### 7. 收尾（CLOSE）— 归档由 archive 命令执行

全部通过后：

- 在 `.gantry/specs/CHANGELOG.md` 追加一行（日期 / change-id / 一句话摘要 / PR 链接 / 新增 learning 条目）
- 运行 `gantry archive` 收尾（把 `.gantry/specs/<change-id>/` 整体**移动**到 `_archive/<change-id>/`，并重置 STATE 到 idle）；`unarchive <id>` 可从归档恢复

#### 7.0 收尾与归档

`gantry archive` 默认复制归档，不删除源目录。

收尾完成后明确告诉用户：

```
✅ INTEGRATION 完成。运行 gantry archive 归档并把状态重置为 idle。
   change 目录仍在 .gantry/specs/<change-id>/，归档副本在 .gantry/specs/_archive/<change-id>/。

   强制收尾：gantry archive --force
   保留历史归档：gantry archive --keep-history
```

#### 7.1 项目级架构文档同步（不在本步做 · 走 A-evolve）

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

### 8. 出 PR（可选）

如果用户用 git 流水线：
- 检查 PR 标题/正文已自动从 `PROPOSAL.md` + `EXECUTION.md` 拼装
- 列出涉及的文件、AC 覆盖、UAT 结论
- 把 `.gantry/specs/` 内的文件归类到 PR 描述（不污染代码 diff）

## 输出

- `.gantry/specs/<change-id>/UAT.md`
- `.gantry/specs/<change-id>/JOURNEY-VERIFY.md`（仅跨服务；SPEC 声明无跨服务路径时跳过，在 UAT.md 写明）
- 更新的 `.gantry/specs/CHANGELOG.md`
- 0~N 个 fix-plan（如有失败或路径断点）
- `gantry archive` 会把 change 副本归档到 `.gantry/specs/_archive/<change-id>/`

## 约束（强制）

- **R2.6**：UAT 自动化失败按阶段剩余预算修复；人工 UAT 判断仍需用户确认
- **R4.4**：禁止声称"通过"而没贴真实输出
- **不在本阶段移动 / 删除 `.gantry/specs/<change-id>/`**——archive 归档只复制，源目录保留

## 自检

- [ ] 全量自动化结果已贴出且全绿
- [ ] 跨服务:每条 Journey 端到端跑过 + 断点已判定归属 + 全部通过或已回退修复重跑通过（单服务已写明跳过）
- [ ] 每条 UAT 都有人工通过/失败标注
- [ ] 失败项目已在宿主预算内修复并重验，耗尽的已附诊断；未另加每项目重试额度
- [ ] `EXECUTION.md` 只有一个 `## Retrospective`，Keep / Problem / Next 均有证据或明确为 none
- [ ] CHANGELOG 已追加
- [ ] `archive` 后源 `.gantry/specs/<change-id>/` 已移动到 `_archive/<change-id>/`，源目录不再存在；`unarchive <id>` 可恢复

## Post-hook（可选）

先消费 pack 的 `hook-after`：false 时直接跳过，不运行 hook 命令，也不反复探测。旧 pack 无该项时复用已读取配置；为空则跳过。已配置 hook 每次真实阶段执行仍按配置运行，不缓存其成功结果。

完成本阶段所有工作、自检通过后，运行：
```bash
gantry hook run after:integration
```
- 退出码 0 或无配置 → 继续
- 退出码非 0 → 收集诊断，按宿主剩余预算修复后重跑；候选执行者将诊断交外层，不自行批准或另开重试循环。仅预算耗尽或人工/进程/内容保护条件才停止

## 自主模式自检（autonomous=true）

本阶段末尾禁止向用户反问「是否继续 / 要不要先扫一眼 / 是否推进下一阶段」。按 R2.6：
- 产物齐备、门禁通过 → 直接按「触发下一步」执行
- 多选场景 → 取推荐项（无推荐则取列表第一项），把选择与理由写进本阶段产物
- 停止条件按 当前工具的 `gantry-next` 入口「门禁修复循环」：人工确认/所缺用户决策或凭据、宿主剩余预算耗尽、取消/时限、进程/控制记录/用户内容保护；可恢复门禁先在本次调用内诊断修复

## 触发下一步

- 此 CHANGE 完成 → `gantry archive`（收尾 + 默认归档）→ `gantry change "<新>"`
- 有未解决的 fix-plan → 暂停，告知用户决策

## 当前代码的 AC 证据

集成运行和最终源码确定后，运行 `gantry verify-ac --json`；涉及人工或跨服务观察时，记录当前 UAT/JOURNEY-VERIFY 及附件，再以 `--observation <临时JSON>` 关联实际观察。integration 的静态门禁只读校验这些证据，不自行启动验证命令。源码或验证配置变化后必须重验；fail/caveat/缺失证据不允许无保留通过。
