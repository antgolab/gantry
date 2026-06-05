# Gantry

> **协议驱动的 AI 工程框架。**  
> 将 AI 辅助开发从临时对话，升级为可追踪、可审查、可验证的软件工程过程。

Gantry 是 AI 辅助开发的工程控制层。它为人类和 Agent 提供一套共享协议，把一个想法推进为生产就绪代码：需求、设计、任务、实现、测试、审查、集成和知识沉淀。

Gantry 不依赖漫长的对话历史或模型记忆，而是通过持久化制品、阶段门禁、任务边界、验证命令、审查闭环和可复用的项目知识，让工程过程显式化。

目标很简单：**让 AI 编程可以规模化，而不让工程纪律崩塌。**

人类与 Agent 在同一套工程协议下协同工作，每一次变更都有边界、有证据、有审查、有沉淀。

---

## 为什么需要 Gantry？

AI 已经可以很快写代码。真正困难的不再是生成速度，而是让工作在跨会话、跨模型、跨成员协作时依然可理解、有边界、经过测试、能够审查，并且可以恢复上下文。

Gantry 针对的是 AI 编程中最常见的系统性失效：

- 跳过需求和设计
- 长对话中的上下文崩溃
- 无意中的范围蔓延
- 难以审查的 diff
- 测试缺失
- 决策丢失和错误重复发生
- 项目知识被困在聊天历史里

Gantry 把这些风险收束为一套结构化的工程协议。

---

## 核心命题

大多数 AI 编程工具解决的是**能力问题**：让 AI 写出更好的代码、更快地补全、更准确地理解上下文。

Gantry 解决的是上一个层次的问题：**当 AI 已经有足够的能力，软件工程过程本身如何保持严谨？**

当一个工程师同时使用多个 AI 助手、每天产出数千行代码时，瓶颈已经不是代码生成速度，而是**工程纪律的维持**：需求是否被真正理解、设计决策是否经过论证、测试是否从验收准则派生、每一次破坏性变更是否经过影响面评估。

Gantry 把这套工程纪律编码为一个可执行的系统——不依赖 AI 的"理解"或"记忆"，而是通过阶段门控、制品约束和状态机，让纪律成为结构性保证。

---

## AI 协作规模化后的四类系统性失效

**① 过程退化 · Process Degradation**
没有外部约束，AI 会自发跳过高摩擦步骤——测试、文档、review——因为生成代码本身是路径最短的响应。单个会话里 AI 能做到全流程，但跨会话、跨任务后，流程遵守率会迅速下降。

**② 上下文崩溃 · Context Collapse**
一个功能稍复杂，对话超过 50k token 后，AI 开始复读之前说过的内容、前后矛盾、对同一段代码给出不同的诊断。长上下文并不等于好上下文——它是一种慢性失效。

**③ 范围侵蚀 · Scope Drift**
AI 在局部优化时容易产生"顺手改了"的行为：修一个函数的同时重构了它的调用方，删一段"看起来没用"的代码（实际上是反射调用），引入了一个新的依赖因为"这个更优雅"。这些改动单独看都合理，累积起来会让 PR diff 难以 review。

**④ 知识流失 · Knowledge Erosion**
每个 AI 会话结束，本次踩坑的上下文、做出的技术决策、被否定的方案——全部消失。下一次面对同样问题的人（或同一个人三个月后）需要从零开始。长期项目里这是最隐蔽也最昂贵的成本。

Gantry 的应对不是试图让 AI"更小心"，而是**通过工程结构让这四类失效在机制上无法发生**。

---

## 系统架构

Gantry 的核心是一个**制品驱动的状态机**：每次开发被拆解为 9 个有序阶段，每个阶段产出一个 `.md` 制品，下游阶段以上游制品作为唯一输入。状态由 CLI 维护，与 AI 工具无关。

```
CHANGE → REQUIREMENT → DESIGN → [UI-DESIGN] → TASK
                                                  ↓
                              ARCHIVE ← INTEGRATION ← REVIEW ← TEST ← DEV
```

**三层交互模式并存，互为补充**：

```
用户意图
    ↓
┌──────────────────────────────────────────────┐
│  IDE 斜杠命令层（/gantry:change 等）           │  ← 日常主路径，零配置，gantry init 后即用
│  CLI 状态机层（gantry change / next / ship）   │  ← 脚本、CI、精确控制
│  @引用层（docs/GO.md 等）              │  ← 通用回退，任何支持 @ 的 AI 工具
└──────────────────────────────────────────────┘
    ↓
阶段执行（phases/*.md）                          ← 执行内容，与工具无关
    ↓
.specs/<change-id>/*.md                          ← 制品，版本化，可追溯
```

**一套完整 change 产出的工程档案**：

```
.specs/my-feature/
├── CHANGE.md        ← 变更动机、影响面评估、范围排除
├── REQUIREMENT.md   ← 验收准则（Given/When/Then）、用户故事、v1/v2/out
├── DESIGN.md        ← 技术决策、ADR、风险矩阵、§9 架构沉淀建议
├── TASK.md          ← 原子任务、并行波次、verify 命令、依赖关系
├── T01-SUMMARY.md   ← 每任务完成报告：做了什么、verify 输出、决策偏离
├── TEST.md          ← 5 轮测试金字塔：功能/性能/安全/兼容/可观测
└── REVIEW.md        ← 双轮审查：spec 合规 + 代码质量 + 跨模型 spot-check
```

这个档案不是留档负担，而是**下一个 AI 会话的唯一可信上下文**——无论是三天后继续开发、三个月后回溯决策，还是新人入职后快速理解历史选择。

---

## 七层结构性保证

| 机制 | 实现方式 | 解决的失效类型 |
|---|---|---|
| **阶段门控** | 前置制品不存在时 CLI 拒绝推进 | 过程退化：AI 跳步骤 / 漏制品 |
| **上下文边界** | DEV 每个任务独立会话，靠 .md 传状态 | 上下文崩溃：50k+ token 后的失效 |
| **文件声明约束** | task 声明 write_files，提交前 diff 验边界 | 范围侵蚀：越界改动 |
| **破坏性变更协议** | 删 5+ 行 / 改公共接口强制 grep 引用图 + 反问 | 范围侵蚀：隐性破坏调用链 |
| **知识库 + 月度维护** | LESSONS.md UAT 失败提名，C-curator 月度整理 + 过期检测 | 知识流失：踩坑经验无法复用 |
| **约定漂移检测** | CONVENTIONS 模板 + 季度 diff 检查实际代码 | 知识流失：团队规范与实现偏离 |
| **入场扫描护栏** | intel-scan 生成 CONTEXT.md，DESIGN 强制对齐既有架构 | 范围侵蚀：新代码破坏既有抽象 |

---

## 定位与边界

Gantry 不是 AI coding assistant、不是 code generator、不是 agent framework。它是**运行在这些工具之上的工程过程层**：

- **不绑定 AI 工具**：Claude Code / Cursor / Codex / Copilot 都能用，唯一要求是支持 `@` 引用文件
- **不替代 AI**：Gantry 不生成代码，它定义 AI 在什么约束下生成代码
- **不管理基础设施**：它管理的是从"想法"到"生产就绪代码"的工程过程
- **不要求全套使用**：每个 phase、每个 template 都设计为可独立调用，不必全量上车

它更像是软件工程领域的 **Makefile + Git hooks + 代码规范**的组合体——给 AI 时代的开发团队提供一套可执行的工程纪律基础设施。

---

## 适用场景

| 场景 | 推荐程度 |
|---|---|
| 功能改动 > 100 行、需要可追溯制品 | ✅ 主力场景 |
| 团队协作、有代码 review 要求、长期维护 | ✅ 主力场景 |
| 接手老项目、需要快速建立 AI 上下文 | ✅ 主力场景（Brownfield 护栏专为此设计）|
| 个人长期项目、不想每次从头讲上下文 | ✅ 推荐 |
| 改 < 30 行的一次性脚本或简单 bugfix | ⚠️ 跳过 Gantry，直接让 AI 改更快 |
| 纯实验性代码、hackathon | ⚠️ 不适合，过程成本大于价值 |

---

## 安装与初始化

```bash
npm install -g gantry
```

初始化目标项目：

```bash
cd your-project
gantry init --tool claude   # 可选: claude / cursor / codex / copilot
```

`gantry init` 自动完成：
- 创建 `.planning/STATE.md`（状态机）
- 把 `skills/*.md` 注入 IDE 对应目录（`.claude/commands/`、`.cursor/rules/` 等）
- 在 `CLAUDE.md` / `AGENTS.md` 写入 Gantry 规则块

---

## 调用方式

### 首选：IDE 斜杠命令

`gantry init` 后即用，零配置：

```
/gantry:change "给订单列表增加导出功能"
/gantry:next
/gantry:exec
/gantry:ship
```

完整命令列表见 `CLAUDE.md` 的「可用斜杠命令」段。

### 统一入口 GO.md

不想记命令名？任何 IDE 任何会话只需一个 `@`：

```
docs/GO.md

设计陪诊网站的预约排班模块
```

`GO.md` 自动判断阶段、生成 change-id、加载所需制品、主动反问澄清。

### 终端 CLI

适合脚本、CI 或不用 IDE 的场景：

```bash
gantry change "给订单列表增加导出功能"
gantry next
gantry exec T01
gantry adjust "导出字段增加手机号"
gantry ship
```

### 手动 @引用

对不支持斜杠命令的工具，直接引用阶段文件：

```
phases/0-change.md

我要做的是：<一句话需求>
```

之后每阶段换引用对应文件（`1-requirement.md`、`2-design.md` 等），连同已有制品一起喂给 AI。

---

## 完整流程

```
CHANGE → REQUIREMENT → DESIGN → [UI-DESIGN] → TASK → DEV → TEST → REVIEW → INTEGRATION → ARCHIVE
```

### 路径 A：从 0 开发新项目

```bash
gantry change "描述需求"   # → CHANGE.md
gantry next                # → REQUIREMENT.md
gantry next                # → DESIGN.md
gantry next                # → TASK.md
gantry exec                # → DEV（逐任务循环）
gantry next                # → TEST
gantry next                # → REVIEW
gantry ship                # → INTEGRATION + 归档
```

### 路径 B：给已有项目加功能

影响范围小时可跳过中间阶段，直接进入任务拆分：

```bash
gantry change "描述需求"
gantry exec    # 确认 TASK.md 后直接执行
gantry ship
```

### MVP 模式（当天跑通）

只走 3 个阶段：

```bash
gantry change "描述需求" && gantry next && gantry exec
```

产物：`REQUIREMENT.md` + `TASK.md` + `SUMMARY.md`，跑顺后再升级完整版。

---

## 文件速查

> 判定标准：**抛开整套流程，只把这一个文件丢给 AI 或当模板用，是否仍能产出有价值的结果**。

### 核心文档（3 个）

| 文件 | 作用 | 能否单独用 | 单独用场景 |
|---|---|---|---|
| `METHODOLOGY.md` | 方法论骨架（流程图 + 阶段定义 + 文件体系 + 核心机制） | ✅ 可单独读 | 想理解整套思路；新成员入门；技术分享 |
| `RULES.md` | 系统级硬规则（R1 token · R2 阶段门 · R3 角色红线 · R4 提交 · R5 测试 · R6 反幻觉 · R7 范围 · R8 语言） | ✅ 可单独注入 | 直接复制进 `.cursorrules` / `.windsurfrules` / 系统提示，给任何 AI 立刻提升纪律 |
| `README.md`（本文件） | 安装 + 调用方式 + 文件速查 + 设计原则 | ✅ 可单独读 | 装到新项目时先看；判断要不要采用 |

### 阶段文件（9 个，按顺序）

| 文件 | 作用 | 能否单独用 | 单独用场景 |
|---|---|---|---|
| `phases/0-change.md` | 把模糊想法**反问澄清**成变更提案（自动生成 change-id）| ✅ 完全独立 | 任何"我想做点什么但讲不清"的时刻；产品经理整理需求 |
| `phases/1-requirement.md` | 把变更提案变成可执行需求 + 验收准则 + 域语言 | ✅ 完全独立 | 写需求文档；把口头需求变成 PRD；提取项目术语表 |
| `phases/2-design.md` | 把需求变成技术设计 + ADR + 风险矩阵 | ✅ 完全独立 | 架构评审；技术选型对比；写设计文档 |
| `phases/2a-ui-design.md` | UI 美学方向决策 + design tokens + 反 AI-slop 自检（仅前端项目）| ✅ 完全独立 | 任何前端项目开工前；redesign；从设计稿提取 design system |
| `phases/3-task.md` | 把设计拆成可并行的原子任务 + verify 命令 | ✅ 完全独立 | 工作分解；冲刺规划；把大功能拆给团队 |
| `phases/4-dev.md` | 在 fresh context 中执行**单个任务**（含 TDD + 提交 + 断点恢复 + UI anti-pattern 扫描）| ⚠️ 半独立 | 严格依赖 `TASK.md` 中的 `verify` 字段 |
| `phases/5-test.md` | 从验收准则派生测试矩阵 + UAT 脚本 | ✅ 完全独立 | 给已有功能补测试；写 QA 脚本；做覆盖率审计 |
| `phases/6-review.md` | 双 / 三轮审查（spec 合规 + 代码质量 + UI 视觉 + 跨模型 spot-check）| ✅ 完全独立 | 给一段 diff 让 AI 评审；merge 前自查；安全审计 |
| `phases/7-integration.md` | UAT 引导 + 失败诊断 + LESSONS 提名 + 归档 | ⚠️ 半独立 | UAT 引导部分可单跑 |

### 横向命令（按需调用）

前缀区分作用：**`L-`** 生命周期；**`M-`** 维护巡检；**`I-`** 项目情报；**`A-`** 架构演进；**`C-`** 知识库管理。

| 文件 | 作用 | 能否单独用 | 单独用场景 |
|---|---|---|---|
| `phases/L-restyle.md` | **一键换调性**：保留功能不变，只换视觉 → 生成 UI-DESIGN v2 + 任务波次 + 风险通告 | ✅ 完全独立 | 产品视觉陈旧；品牌换新；做暗色版 / 高端版 |
| `phases/M-health.md` | **代码库周期性巡检**：6+6 维衰退诊断 / 技术债优先级 + 冗余扫描 | ✅ 完全独立 | 月度 / 季度体检；里程碑前估价；接手陌生项目首周 |
| `phases/I-intel-scan.md` | **老项目入场扫描**：检测 AI 上下文文档 + 扫代码，生成 / 更新 `CONTEXT.md` | ✅ 完全独立 | Brownfield 项目首次使用 Gantry 必跑；老项目架构偏移后重扫 |
| `phases/A-architect.md` | **项目级架构梳理**：建立 / 重构 `ARCHITECTURE.md`，含模块图 + ADR 列表 + 跨模块契约 | ✅ 完全独立 | 里程碑后架构梳理；接手陌生项目；ADR 定期重审 |
| `phases/A-evolve.md` | **架构增量同步**：扫近期归档 change 的 DESIGN §9，逐项 review 后 patch CONTEXT / ARCHITECTURE | ✅ 完全独立 | 每月 / 每季批量同步；里程碑发布后凝固架构决策 |
| `phases/C-curator.md` | **知识库维护 + 团队健康巡检**：LESSONS 状态整理 / knowledge 过期检测 / CONVENTIONS 漂移检测 | ✅ 完全独立 | 月度知识库维护；季度规则 retro；事故后知识沉淀 |

### 制品模板（14 个）

| 文件 | 作用 | 能否单独用 | 单独用场景 |
|---|---|---|---|
| `templates/CHANGE.md` | 变更提案 | ✅ 独立 | 任何项目的「变更申请」「功能提案」 |
| `templates/REQUIREMENT.md` | 需求 + 验收准则（Given/When/Then）+ v1·v2·out | ✅ 独立 | 任何项目的需求文档模板 |
| `templates/CONTEXT.md` | 项目级共享上下文 · **rules 层**（术语表 + 已锁决策 + 既有抽象索引 + 禁动清单）| ✅ 独立，**强烈推荐** | 任何项目都该有一份；填好后所有 AI 输出更稳 |
| `templates/CONVENTIONS.md` | 项目约定 · **协作层**（命名规则 + 分支策略 + API 约定 + 测试约定 + PR 门槛）| ✅ 独立，**团队项目推荐** | 新人入职必读；AI 编码风格参考 |
| `templates/ARCHITECTURE.md` | 项目级架构文档 · **structure 层**（模块图 + ADR 列表 + 跨模块契约 + 容量边界）| ✅ 独立，**中大型项目推荐** | 跨模块架构记录；ADR 中心化管理 |
| `templates/DESIGN.md` | change 级技术设计 + ADR + 风险 + §9 架构沉淀建议 | ✅ 独立 | 任何架构 / 技术方案文档 |
| `templates/UI-DESIGN.md` | UI 美学方向 + design tokens（OKLCH / 字体 / 间距 / 动效）+ 反 AI-slop 自检 | ✅ 独立，**前端项目强烈推荐** | 任何前端项目的视觉规约；redesign 起点 |
| `templates/TASK.md` | 任务清单（XML + 波次 + verify + done） | ✅ 独立 | 任何工作分解；可直接当 todo 看板用 |
| `templates/TEST.md` | 测试矩阵 + UAT 脚本 + 覆盖率回顾 | ✅ 独立 | 任何测试计划 / QA 文档 |
| `templates/REVIEW.md` | 双轮审查报告（spec 合规 + 代码质量 + 跨模型分歧）| ✅ 独立 | 任何 code review 报告模板 |
| `templates/SUMMARY.md` | 任务级完成报告（做了什么 + verify 输出 + 决策偏离）| ✅ 独立 | 日报 / 完成回执 / 任务汇报 |
| `templates/LESSONS.md` | **项目级常驻**——跨任务失败知识库 | ✅ 独立，**强烈推荐** | 任何项目；踩坑后追加一条就值 |
| `templates/PROGRESS.md` | **临时**——任务中途上下文边界时的快照（已排除方案是核心）| ⚠️ 半独立 | 强绑定 R1.5 重启协议 |
| `templates/STATE.md` | 跨会话项目状态（活跃 change / 中断任务 / 决策日志）| ⚠️ 半独立 | 只在使用多阶段流程后才有用 |

### 参考资料（4 个）

| 文件 | 作用 | 单独用场景 |
|---|---|---|
| `reference/tech-stacks.md` | 8 个主流前后端组合 + 适用矩阵 + 选型决策模板 | 项目开工前技术选型；评估是否迁移 |
| `reference/ui-aesthetics.md` | UI 美学决策框架——4 个问题 + 5 维度 + 9 张调性卡片 | 前端项目开工前选调性；从设计稿反推 design system |
| `reference/ui-anti-patterns.md` | 反 AI-slop 清单（grep 用）——8 类禁忌 | code review checklist；PR self-review |
| `reference/test-pyramid.md` | 5 轮测试金字塔的工具 / 标准 / 反模式 / 适用矩阵 | 给项目立测试规约；发布前自查 |

### 可选外部扩展

| 扩展 | 维度 | Gantry 何处优先调用 | 何时受益 |
|---|---|---|---|
| [`brooks-lint`](https://github.com/hyhmrright/brooks-lint) | **代码质量** | `4-dev` self-review · `5-test` · `6-review` · `M-health` | 想要带书本引用的结构化 review 报告；周期性体检代码库 |
| `jscpd` + `knip` / `vulture` / `staticcheck` 等 | **字面冗余 + 死代码** | `M-health` 步骤 2.5 | 找重复代码块；清理未用导出 / 依赖 / 死分支 |
| [`ui-ux-pro-max`](https://uupm.cc) | **UI 广度** | `2a-ui-design` 字体 / 颜色 / 图表选择 | 想从更大候选池里挑；做数据可视化 |
| [`impeccable`](https://impeccable.style) | **UI 深度** | `2a-ui-design` design tokens · `4-dev` · `6-review` 第三轮 | 想把 design system 抠到组件级 |

**都没装 Gantry 也能跑**——`reference/*` 作为基线，代码诊断 / 测试诊断 / 调性 / 反 AI-slop 都有内置回退。装上后质量明显提升。

### 可选运行时门禁：Forge

如果在 Claude Code 里经常遇到 AI 跳过阶段、漏写制品、漏测试或漏 review，可以额外接入 Forge 作为运行时门禁 adapter。Forge 读取 Gantry 的阶段 / change-id / task-id，通过 Claude Code hooks 做运行时拦截。没装时 Gantry 行为完全不变。

详见：[`reference/runtime-adapters/forge.md`](reference/runtime-adapters/forge.md)

---

## 项目级文档三层

`.specs/` 下有三层文档，职责不重叠：

| 文件 | 职责 | 维护者 | 体量 |
|---|---|---|---|
| `.specs/CONTEXT.md` | **rules 层**：技术栈版本 / 命名约定 / 既有抽象索引 / 禁动清单 | `I-intel-scan` 首创 + `A-evolve` 增量 | 50–200 行 |
| `.specs/ARCHITECTURE.md` | **structure 层**：模块图 / ADR 列表 / 跨模块契约 / 容量边界 | `A-architect` 首创 + `A-evolve` 增量 append | 200–600 行 |
| `.specs/<change-id>/DESIGN.md` | **change 层**：本次 change 的技术决策 / ADR / 风险 / §9 沉淀建议 | `2-design` 写，归档后冻结 | 100–400 行 |

联动方式：

```
每个 change 完成 → DESIGN.md §9 填「新增抽象」「项目级决策」
             ↓ N 个 change 后
gantry evolve → 扫各 change 的 §9 → patch CONTEXT + ARCHITECTURE
             ↓ ADR 冲突 ≥ 5 或 CONTEXT > 200 行
gantry architect → 重审并整理 ARCHITECTURE.md
```

---

## 决策指南

按需求选组合——除了 `PROGRESS.md` 和 `STATE.md` 这种和流程强绑定的状态文件，其它每一个 phase 与每一个 template 都设计成可独立使用，不要求全套上车。

| 你想要的 | 推荐组合 | 不需要 |
|---|---|---|
| 只想让 AI 更靠谱、更少幻觉 | `RULES.md` 注入系统提示 | 其他都不要 |
| 只想理顺一个想法 | `phases/0-change.md` + `templates/CHANGE.md` | 其他都不要 |
| 只想写好一份需求文档 | `phases/1-requirement.md` + `templates/REQUIREMENT.md` + `templates/CONTEXT.md` | 其他都不要 |
| 只想做技术设计 | `phases/2-design.md` + `templates/DESIGN.md` + `reference/tech-stacks.md` | 其他都不要 |
| 只想拆好一组任务 | `phases/3-task.md` + `templates/TASK.md` | 其他都不要 |
| 只想做 code review | `phases/6-review.md` + `templates/REVIEW.md` | 其他都不要 |
| 只想做 UI 视觉 audit | `phases/6-review.md` 第三轮 + `reference/ui-anti-patterns.md` | 其他都不要 |
| 只想做代码库体检 | `phases/M-health.md` | 其他都不要 |
| 只想整理知识库 | `phases/C-curator.md` | 其他都不要 |
| 只想给前端立 design system | `phases/2a-ui-design.md` + `templates/UI-DESIGN.md` + `reference/ui-aesthetics.md` | 其他都不要 |
| 只想沉淀失败教训 | `templates/LESSONS.md` | 其他都不要 |
| 给 AI 一个项目级"小抄" | 填好 `templates/CONTEXT.md` | 其他都不要 |
| 想跑完整闭环 | 全套 | — |

---

## Token 成本

> Gantry 的设计是 **单窗压力小、制品有外溢价值**。多花的 token 沉淀为团队资产，不是消耗品。

### 单阶段参考

| 单独跑 | 典型 token | 产出 |
|---|---|---|
| `0-change.md` | ~6k – 8k | CHANGE.md |
| `1-requirement.md` | ~6k – 9k | REQUIREMENT.md（AC 完备）|
| `2-design.md` | ~10k – 15k | DESIGN.md（含技术栈卡片）|
| `2a-ui-design.md` | ~12k – 18k | UI-DESIGN.md（含调性 + tokens）|
| `3-task.md` | ~8k – 12k | TASK.md（N 个任务）|
| `4-dev.md` × 单个 task | ~25k – 60k | 实现代码 + 测试 + SUMMARY |
| `5-test.md` | ~30k – 80k | TEST.md（5 轮 + 真跑测试输出）|
| `6-review.md` | ~25k – 50k | REVIEW.md（三轮）|
| `7-integration.md` | ~20k – 40k | UAT + LESSONS 提名 |
| `M-health.md` | ~15k – 30k | HEALTH.md（技术债诊断）|

### 完整闭环

| change 规模 | 典型任务数 | 完整模式 | 极简模式 |
|---|---|---|---|
| 小（< 100 行 / 加字段 / 修 bug）| 1–2 | ~80k – 150k | ~50k – 100k |
| 中（100–500 行 / PR 级 feature）| 3–5 | ~150k – 300k | ~120k – 240k |
| 中大（500–1500 行 / 中型 feature）| 5–10 | ~250k – 530k | ~205k – 445k |
| 大（1500+ 行 / milestone）| 10+ | ~500k – 1M | 建议拆 milestone |

### 怎么选

1. **改 < 30 行 / 一次性 / 简单 bugfix** → 跳 Gantry，让 AI 直接改
2. **改 30–100 行 / 个人项目** → 走原生 skill（brainstorm + TDD + review 三件套就够）
3. **改 100–500 行 / 想要可追溯制品** → Gantry 极简模式，或单点调 6-review
4. **改 500+ 行 / 团队 / 长期** → Gantry 完整，**多花的 token 沉淀为团队资产**

---

## Brownfield 安全护栏

> 两个高频担忧：**AI 不按既有架构开发** + **AI 乱删乱改不相关代码**。

| 护栏 | 文件 | 拦截的事故类型 |
|---|---|---|
| 入场扫描自动生成 CONTEXT.md | `I-intel-scan.md` | AI 不知道项目栈 / 命名 / 既有抽象 → 写出格格不入的代码 |
| DESIGN §0.5 既有架构对齐 | `2-design.md` | 引入与项目不符的新模式 |
| TASK `write_files` 强约束 + 提交前 diff 边界 verify | `3-task.md` + `4-dev.md` | "顺手改了别的文件" |
| 破坏性变更高门槛协议 | `4-dev.md` + RULES R4.6 | 删错代码 / 改坏公共接口 |
| 沿用既有抽象 grep 检查 | `4-dev.md` + RULES R6.4 | 重复实现已有抽象 |

### 老项目首次使用

```bash
gantry intel-scan          # 生成 CONTEXT.md（仅首次，+15k–30k tokens）
gantry change "加功能"     # 之后正常走流程
```

### 护栏的实际效果对比

| 场景 | 不走护栏 | 走完护栏 |
|---|---|---|
| 老项目用 Repository 模式 | AI 写 Service 直接调 ORM | DESIGN §0.5 对齐 → 沿用 Repository |
| 项目已有 `formatDate` | AI 自己写 `formatDate2` | 1.4 grep → 找到 → import 用 |
| 看到"没人用"的函数 | 顺手删了（其实是反射调用）| 1.8 协议 → grep 全库 → 反问用户 |
| 给公共 hook 加必填参数 | 改了，12 处调用全炸 | 1.8 协议 → grep 引用图 → 选兼容方案 |

---

## 升级与定制

- **要更轻量**：删掉 `2-design.md` 和 `6-review.md`，对应阶段并入相邻步骤
- **要更严格**：在 `RULES.md` 里追加项目专属规则（如 commit 格式、覆盖率门槛）
- **要换语言 / 换术语**：批量替换 phases 与 templates 里的关键词，方法论保留
- **要加新阶段**：在 `phases/` 里加 `8-<name>.md`，并在 `METHODOLOGY.md` 流程图里插入

---

## 六条设计原则

1. **每阶段一次 fresh context**：阶段切换时清窗，靠制品文件传递状态，不靠对话堆叠
2. **每个产出可被一个文件承载**：没有隐式状态，没有"AI 记得"
3. **任务必带 verify 命令**：`TASK.md` 每项含可执行验证命令，否则不允许进入执行
4. **审查至少两轮**：spec 合规 + 代码质量；建议其中一轮跨模型
5. **失败是输入，不是终点**：UAT 失败自动产 fix-plan，回到 `4-dev`，最多 3 轮
6. **Artifact-first，非 Phase-gated**：阶段可跳过、可回炉，但制品不能缺席

---

## 发展路线

Gantry 的演进方向是**从工程过程管理，向 AI 协作智能体基础设施扩展**——在不破坏当前"零依赖、可独立调用"核心原则的前提下，逐步具备更强的自动化能力和团队协作支撑。

### v1.x · 稳固基础（当前阶段）

- [x] 9 阶段 pipeline + CLI 状态机
- [x] Claude Code / Cursor / Codex / Copilot 四工具 IDE skills 分发
- [x] Brownfield 安全护栏（CONTEXT + 破坏性变更协议）
- [x] LESSONS.md 知识库 + C-curator 月度维护
- [x] CONVENTIONS.md 项目约定模板
- [ ] `gantry doctor`：环境自检命令，检测配置完整性和常见问题
- [ ] 更完善的错误恢复和 checkpoint 系统
- [ ] 测试覆盖率提升至 90%+

### v2.0 · 语义门控（2026 Q4）

阶段门控从"文件存在性检查"升级为"内容质量评估"：

- **AI-assisted gate evaluation**：门控时调用轻量 AI 检查制品关键字段是否完备
- **制品质量评分**：提交时输出质量分数，低于阈值时警告而非阻断
- **智能上下文裁剪**：按阶段自动裁剪需要加载的制品段落，显著降低 token 成本
- **LESSONS 语义去重**：提名时自动识别与已有条目高度相似的新提名，建议合并

### v2.x · 集成层（2027 Q1）

- **GitHub Actions 集成**：PR 合并前自动检查 `.specs/<change-id>/` 制品完整性
- **Pre-commit hook**：`write_files` 声明与实际 diff 对比，超边界时拒绝提交
- **metrics dashboard**：基于 `gantry metrics` 数据的 Web 可视化面板
- **跨模型 review 自动化**：`6-review` 阶段自动调用第二个模型做 spot-check

### v3.0 · 多智能体编排（2027 Q2–Q3）

- **Wave 并行执行**：同一波次内的独立任务分发给多个 AI 实例同时执行，结果自动 merge
- **角色感知路由**：根据任务类型自动选择最合适的 AI 模型和角色
- **冲突检测**：并行任务修改同一文件时提前检测冲突区域，暂停等待人工决策
- **Agent 交接协议**：Architect → Executor → Reviewer 的标准化制品交接格式

### v3.x · 知识图谱（2027 Q4）

- **知识图谱**：LESSONS 条目之间建立因果 / 关联 / 演进关系，支持 `gantry why <topic>` 语义检索
- **跨仓库 LESSONS 共享**：多个仓库的 LESSONS 聚合到组织级知识库
- **架构决策追踪**：ADR 从静态文档变为动态追踪——记录执行状态、验证结果、是否需要重审
- **自适应阶段裁剪**：根据 change 风险评分自动建议跳过或加严特定阶段

### 长期愿景

Gantry 的终态是**AI 协作时代的工程操作系统**：

- 工程师描述意图，Gantry 自动路由到合适的阶段组合和 AI 模型
- 人工介入只发生在真正需要判断的节点（设计决策、风险接受、UAT 验收）
- 每一次变更都自动沉淀为组织知识资产，知识复用率随项目年龄增长而非衰减
- 新人入职时，Gantry 能自动从历史档案中生成项目认知地图

这个愿景的实现不依赖 AI 能力的突破，而依赖**工程过程的持续结构化**——而这正是 Gantry 从第一天起就在做的事。

---

## 许可

MIT
