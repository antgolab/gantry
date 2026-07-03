# 方法论（Gantry 骨架 · AI 必读）

> **你是 AI 助手。这是 Gantry 的方法论全文，每次会话开始 / 清窗恢复时必读一遍。**
> 读完之后你应该知道：当前处于哪个阶段、要产出什么工件、和其他阶段的输入输出关系、哪些核心机制不允许绕过。
> 后续具体执行按各阶段 `prompts/<n>-*.md` 的指令走，本文件只定义骨架。

---

## 设计原则（北极星 · 一切取舍的最高裁决）

> 所有功能取舍、架构决策、"要不要做某件事"的争论，最终都回到这一节裁决。

### 北极星

**最大限度增强单人开发效率。** 具体分解为四个可检验的维度：

1. **更准更统一的上下文** — AI 每次拿到恰好正确、口径一致的输入（context-pack / CONTEXT.md 是载体）
2. **更高的执行效率** — 阶段与门禁服务于"少返工"，不为流程而流程（pipeline 分级、light 路径）
3. **更优的工程闭环** — 每个机制有始有终、可验证、不留半拉子
4. **研发周期的一致性** — 同类变更走同样的路径，产出可预期

Gantry 是**工程控制面，不是 agent runtime**：AI 工具已会读文件、改代码、跑命令；Gantry 只补 AI 不可靠的四件事——该读什么、能改什么、必须留什么证据、状态如何持久化。**不要把宿主 AI 已经会做的事搬进 Gantry。**

### 反熵铁律（Loop Engineering）

**每个工件 / 字段 / 代码路径必须有真实消费者，否则就是装饰，应当删除。**

- 判据方向是**单向**的：无消费者 → 删。绝不能反过来用"东西已经存在"来正当化"给它造一个消费者"。
- "消费者"可以是代码，也可以是人（如 `--skip` 的门禁绕过留痕，消费者是事后排查的开发者）；但必须是**当前真实存在**的，不是设想中的。
- 写与读必须对称：只写不读的数据流，要么补上读取端（若承诺过可查），要么连写入一起删（若无人读）。
- 确定性优先：机器能判定的（关键词 / 文件后缀 / 存在性）交给 CLI，需要判断的（质量 / 好坏）留给 AI。禁止 AI 判断字段进入机器契约。

### 用北极星筛选"是否该做某功能"

面对任何"要不要加 X"（可观测层 / 治理 / RBAC / 新阶段 / 新命令）时，依次问：

1. **X 的消费者现在存在吗？** 不存在 → 不做（例：单人场景下的 RBAC、审计合规、团队 retro 报表，消费者要等"团队 / 托管执行"出现才存在）。
2. **X 服务北极星的哪个维度？** 说不出 → 不做。
3. **X 是最小实现吗？** 能挂在已有路径上就不新增命令 / 文件，控制表面积。
4. **X 会引入第二套状态吗？** 会 → 收敛成从既有事实派生的策略，而非新建独立状态机。

> 完备性框架（如 Harness ETCLOVG）用来**发现缺口**，不用来**设定目标**。"对齐度百分比"是陷阱——缺的层里，大部分消费者在单人场景下并不存在。补全它们等于重复"建了完整 API 却零消费"的负资产。

---

## 标准流程

```
PROPOSAL → SPEC → DESIGN → [2a UI-DESIGN]* → TASKS → DEV → TEST → REVIEW → INTEGRATION → ARCHIVE
    │         │         │             │             │      │       │         │            │
    │         └─ CONTEXT.md 跨阶段共享 ┘     前端项目 ┘     └ TDD ─┘         │            │
    │                                                                         │            │
    └─────────────────────── 迭代回灌（new change / proposal） ←──────────────┘            │
                                                                                            ↓
                                                                                     ARCHIVE / 归档

* 仅前端项目走 2a；后端 / CLI / lib 跳过
```

**前端项目路径**：`PROPOSAL → SPEC → DESIGN → 2a UI-DESIGN → TASKS → DEV → TEST → REVIEW (3 轮) → INTEGRATION`
**后端项目路径**：`PROPOSAL → SPEC → DESIGN → TASKS → DEV → TEST → REVIEW → INTEGRATION`
**MVP 路径**：`SPEC → TASKS → DEV`（只跑这三步，3 个文件起步）

---

## 阶段定义

| 阶段 | 输入 | AI 职责 | 输出文件 | 需人工确认 | 迭代可跳 |
|---|---|---|---|---|---|
| CHANGE | 一句话想法 / bug | 反问澄清 + 影响面判定 | `PROPOSAL.md` | 是 | 否 |
| REQUIREMENT | PROPOSAL | 写 AC + 范围切分 + 术语提取 | `SPEC.md` + `CONTEXT.md` | 是 | 条件性 |
| DESIGN | PROPOSAL + SPEC + CONTEXT | **技术栈预选**（5~6 卡让用户选）+ 技术决策 + ADR + 数据流 | `DESIGN.md`（含 `## 0. 技术栈选定`）| 是（栈 + 关键决策）| 条件性 |
| **2a UI-DESIGN** | SPEC + DESIGN | 美学方向 + design tokens + 反 AI-slop 自检 | `UI-DESIGN.md` | 是（关键决策）| 否（前端必跑）/ 是（非前端跳过）|
| TASK | DESIGN（+ UI-DESIGN）| 拆原子任务 + 标 `[P]` 并行 + 依赖图 | `TASKS.md` | 否 | 否 |
| DEV | TASKS 中一项 | fresh subagent + TDD + 原子提交 | 代码 + `EXECUTION.md` | 否 | 否 |
| TEST | 代码 + AC + 非功能需求 | **5 轮金字塔**：功能 / 性能 / 安全 / 兼容 / 可观测（按项目类型裁剪）| `TEST.md` | 否 | 否 |
| REVIEW | diff + SPEC | 双轮审查（spec 合规 + 代码质量）| `REVIEW.md` | 是（仅严重项）| 否 |
| INTEGRATION | 全部已通过 | UAT + 集成 smoke + 失败诊断 | `UAT.md` / fix-plan | 是 | 否 |
| ARCHIVE | 已收尾 | 保存 change 工件副本 | `_archive/<change-id>/` | 否 | — |

> `archive` 完成当前 change 收尾并把 `.gantry/specs/<id>/` 复制到 `.gantry/specs/_archive/<id>/`（保留源目录），然后把 STATE 重置为 idle。`/gantry:unarchive <change-id>` 是反向生命周期动作：恢复归档工件并重新激活该 change。开发 / 测试中发现变化时，用 `/gantry:adjust "<发生了什么>"` 打开或追加当前 change 的 `PATCH.md` 闭环账本。

---

## 文件体系

所有产物存到：`./.gantry/specs/<change-id>/`

| 文件 | 用途 | 谁来写 |
|---|---|---|
| `PROPOSAL.md` | 一次变更的提案（why / what / 影响面 / 范围排除）| 协作（人起草 + AI 反问补全）|
| `SPEC.md` | 需求 + 验收准则（用户故事 / AC / v1·v2·out / 非功能性）| AI 主笔，人确认 |
| `CONTEXT.md` | 域语言 + 默认决策（术语表 / 已锁决策 / 偏好）| 协作 |
| `DESIGN.md` | 技术设计（架构图 / 数据流 / ADR / 风险）| AI 主笔，人审 |
| `UI-DESIGN.md` | UI 美学方向 + design tokens（OKLCH 颜色 / 字体 / 间距 / 动效）+ 反 AI-slop 自检（仅前端项目）| AI 主笔，人审 |
| `TASKS.md` | 任务清单（任务 / 依赖 / `[P]` / verify / done）| AI |
| `TEST.md` | 5 轮测试金字塔报告（功能矩阵 + UAT + 性能 / 安全 / 兼容 / 可观测口供）| AI |
| `REVIEW.md` | 审查发现（严重度 / 修复决策 / 跨模型分歧）| AI |
| `EXECUTION.md` | change 级执行日志（默认汇总所有 task 完成证据）| AI |
| `<task-id>-SUMMARY.md` | 仅高风险/例外任务使用的专用完成报告，不再默认生成 | AI |
| `BLOCKERS.md` | 当前 change 的人工待处理阻塞/审批摘要 | AI 维护，人处理 |
| `FOLLOWUPS.md` | 非阻塞遗留问题与后续清单 | AI |
| `<task-id>-PROGRESS.md` | **临时**文件——任务执行中途清窗时写入，含「已排除方案」反重复段。任务完成后删除。详见 RULES R1.5/R1.6/R1.7 | AI |
| `LESSONS.md`（`.gantry/specs/` 根）| **项目级常驻**——跨 change 失败知识库。每个 DEV 任务开工前必扫；INTEGRATION 阶段提名新条目。详见 RULES R1.8 | AI 提名 + 人工筛 |
| `STATE.md`（仓库根）| 跨会话状态（当前位置 / 中断任务 / 运行态 checkpoint / 高价值决策）| AI 维护，人可改 |

> 兼容迁移期内，运行时仍接受旧命名：`CHANGE.md` / `REQUIREMENT.md` / `TASK.md` / `SUMMARY.md`。新产出应优先使用新命名。

---

## Agent 角色（同一模型也要扮演不同角色）

| 角色 | 输入 | 输出 | 时机 |
|---|---|---|---|
| **Architect** | PROPOSAL / SPEC | DESIGN.md + ADR | DESIGN 阶段 |
| **UI Director** | SPEC + DESIGN | UI-DESIGN.md（含 design tokens）| 2a UI-DESIGN 阶段（前端项目）|
| **Planner** | DESIGN（+ UI-DESIGN）| TASKS.md | TASK 阶段 |
| **Dev**（多实例并行）| TASKS 中一项 | 代码 + change 级 EXECUTION（例外时单独 SUMMARY） | DEV 阶段，每任务一个 fresh context |
| **Reviewer** | diff + SPEC | REVIEW.md | REVIEW 阶段（建议双轮：同模型 spec 审 + 异模型代码审）|
| **Verifier** | 构建产物 + AC | UAT.md / fix-plan | INTEGRATION 阶段 |

**红线**：Architect 不写代码，UI Director 不写完整组件，Dev 不改 SPEC / UI-DESIGN，Reviewer 不修代码（只产报告 + 修复 task）。

---

## 7 个核心机制（已内化进各阶段 prompt）

1. **任务拆解** — 拆到 fresh context 跑得完且自带 verify 的最小单元，按文件冲突切而不是按层切
2. **Prompt 组织** — 模板 + 文件引用 + 验证锚点；不靠对话堆叠
3. **上下文控制** — 阶段切换 = 清窗 + 重新载入指定 .md
4. **代码生成策略** — 默认分步（每任务 fresh context），仅小特性允许一次性
5. **测试生成** — 测试从 AC 派生而非从实现派生；bug 修复必伴随回归测试
6. **审查 / Refine 循环** — 至少两轮，至少一轮跨模型 spot-check
7. **自迭代** — 失败自动产 fix-plan 回炉，最多 3 轮，超限人工介入

---

## 自迭代上限

任何阶段（plan / dev / verify）的自动重试次数 **≤ 3 轮**。
超限必须停下来让人决策，禁止死循环。
