# 横向命令 · A-evolve — 把 change 期间的架构沉淀同步到项目级文档

> **触发方式**：`docs/GO.md` + `同步架构 / 整理沉淀 / sediment / evolve / 架构演进 / 同步 CONTEXT`
> 不属于任何 change，不写 `PROPOSAL.md` / `SPEC.md`（兼容期接受旧命名）。直接产出沉淀同步报告 + patch CONTEXT.md（+ ARCHITECTURE.md如存在）。

## 角色

Architect-Evolver。**只读 archived change 的 DESIGN.md § 9，聚合分类后让用户 review，批准的才 patch 到项目级文档。不动业务代码**。

## 与 A-architect 的边界

| 工作流 | 干什么 | 何时跑 | 改 ARCHITECTURE.md 哪段 |
|---|---|---|---|
| **A-evolve**（本文）| 把 change 级沉淀**单点 append** 到项目级文档 | 每月 / 每季 批量 | 仅 append ADR 列表 / 跨模块契约段 / 修订历史 |
| **A-architect** | 重写 / 大改 ARCHITECTURE 全篇 | 首次建立 / 重大重构 / ADR 重审 | 任何段都可改 |

如果 A-evolve 过程中发现需要“改架构”（比如某条 ADR 应该 deprecated / 依赖规则该改）→ **停下来，提示用户跑 A-architect**，不在本工作流里动。

---

## 触发场景

- **每月 / 每季度**：积累了若干 change 后批量同步一次，避免 CONTEXT 滞后
- **里程碑后**：版本发布或大功能完成后，把这一阶段的沉淀凝固到项目层
- **CONTEXT 失准信号**：4-dev 阶段连续多次发现 AI 没沿用既有抽象（说明索引漏了）
- **`STATE.md` `last_evolve_at` 字段为空 或 距今 > 60 天**：GO.md 在路由时会主动提示
- **M-health 冗余巡检留的尾巴**：若 `.gantry/specs/CONTEXT.md`「清理窗口专列」或「技术债」段有标记，A-evolve 扫描时**主动把对应的「既有抽象索引」条目拎出来让用户确认是否删**（闭环 M-health 步骤 5 的"下次同步主动提醒"）

## 输入

- `@.gantry/specs/STATE.md`（读 `last_evolve_at` 字段，决定从哪个时间点之后的 change 开始扫）
- `@.gantry/specs/CONTEXT.md`（当前快照，patch 目标 · rules 层）
- `@.gantry/specs/ARCHITECTURE.md`（如存在，则同时是 patch 目标 · structure 层）
- `@.gantry/specs/_archive/<change-id>/SPEC.md`（已归档 change 的需求文档 · 只读「CONTEXT 候选 patch」段）
- `@.gantry/specs/_archive/<change-id>/DESIGN.md`（已归档 change 的设计文档 · 只读 § 9 段）
- `@.gantry/specs/<active-id>/DESIGN.md`（当前活跃 change 也算，但仅在 4-dev 完成 / 7-integration 之后才纳入 · 否则跳过）
- `@.gantry/specs/LESSONS.md`（只 grep active 条目关键词，用于发现 CONTEXT 候选是否被失败教训否定）

---

## 你的职责

### 步骤 1 · 确定扫描范围

读 `STATE.md`：

- 有 `last_evolve_at: <YYYY-MM-DD>` 字段 → 只扫该日期**之后**归档的 change（按 `_archive/<id>/ARCHIVE.md` 时间戳判断）
- 无字段（首次跑）→ 扫所有 `.gantry/specs/_archive/*` 的 DESIGN.md
- 有 `last_evolve_promoted: [<list of change-ids>]` → 这些 change 的 § 9 已处理过，跳过

输出范围声明：

```
✅ A-evolve 扫描范围：
  - 上次同步：<YYYY-MM-DD> · 已处理 <N> 个 change
  - 本次扫：<起始日期> 之后归档的 <M> 个 change
    · _archive/add-cache-layer
    · _archive/fix-auth-flow
    · _archive/add-notifications
    · ...（活跃中的 <active-id> · 是否纳入：用户决定）
  - 当前 CONTEXT.md：最近一次更新 <YYYY-MM-DD>，<N> 行
```

如果范围为空（没有新 change 或全部已处理）→ 直接告诉用户"无新沉淀可同步，CONTEXT.md 已最新"，结束。

### 步骤 2 · 抽取 CONTEXT 候选与 § 9 段

对范围内每个 change：

```
grep_search Query="^## CONTEXT 候选 patch" SearchPath="<change/SPEC.md>"
read_file path="<change/SPEC.md>" offset=<候选 patch 起始行> limit=80
grep_search Query="^## 9\\. 架构沉淀建议" SearchPath="<change/DESIGN.md>"
read_file path="<change/DESIGN.md>" offset=<§ 9 起始行> limit=80
```

把每个 change 的「CONTEXT 候选 patch」和 § 9 段**原样**收集起来（带 source change-id 标签），跳过显式写"无候选"或"本 change 无架构层面沉淀建议"的。

> Token 预算：每个 change 的候选 patch + § 9 大约 40-120 行 · 一般 5-10 个 change 一次同步即可。超过 15 个建议拆两次跑。

### 步骤 3 · 聚合分类

按「CONTEXT 候选 patch」+ § 9 的六类聚合（跨 change 合并）：

#### 3.0 域语言 / 默认行为 / 已锁业务规则（来自 SPEC 的 CONTEXT 候选 patch）

| 类型 | 内容 | 来源 change | 影响范围 | 与现 CONTEXT 冲突？ | 与 active LESSONS 冲突？ |
|---|---|---|---|---|---|
| term | 大额分流 = 实付金额 > 50000 元走客服二维码 | custom-credit-purchase | 支付域 | — | — |
| decision | 自定义套餐识别使用 price 原价字段 | custom-credit-purchase | 积分购买 | ⚠️ CONTEXT 旧规则写 sale_price | L-001 支持该修正 |

**冲突检测必跑**：

- 对每条候选 grep CONTEXT.md 现有术语 / 决策 / 默认行为，标出重复或冲突。
- 对每条候选 grep LESSONS.md active 条目的关键词。若 LESSONS 记录旧方案失败，候选必须与 LESSONS 一致；不一致则标 ⚠️，默认不 promote。
- `影响范围` 为"本 change"的候选默认不 promote，除非用户明确改成项目级规则。

#### 3.1 新增可复用抽象（聚合到一张总表）

| 路径 | 能力 | 来自 change | 复用建议 | 跨 change 冲突？ |
|---|---|---|---|---|
| `src/lib/cache.ts` | LRU 缓存 | add-cache-layer | 沿用 | — |
| `src/lib/queue.ts` | 任务队列 | add-bg-jobs | 沿用 | — |
| `src/utils/date-fmt.ts` | 日期格式化 | add-notifications | 沿用 | ⚠️ 与既有 `src/utils/date.ts` 重复 → 让用户决策 |

**冲突检测必跑**：每条新抽象都 grep 一下 CONTEXT.md「既有抽象索引」段是否已有同类 → 有则标 ⚠️；同时 grep LESSONS，看是否有"不要这么封装 / 不要重复实现"的 active 条目。

#### 3.2 项目级技术决策（聚合）

| 决策 | 取值 | 来自 change | 影响范围 | 与现 CONTEXT 冲突？ |
|---|---|---|---|---|
| 缓存层选型 | Redis | add-cache-layer | 全栈 | — |
| 后台作业框架 | BullMQ | add-bg-jobs | 服务端 | — |

#### 3.3 跨模块契约（聚合）

```
新增 API：
  - GET/POST /api/cache/* （来自 add-cache-layer）
  - POST /api/notifications （来自 add-notifications）

新增事件：
  - events.cache.invalidated （来自 add-cache-layer）

Schema 变更：
  - 表 cache_entries （来自 add-cache-layer）
  - 表 notifications （来自 add-notifications）
```

#### 3.4 依赖变动（聚合）

| 包 | 版本变动 | 来自 change | 是否替换 |
|---|---|---|---|
| `ioredis` | + 5.4.0 | add-cache-layer | 替换 node-redis |
| `bullmq` | + 5.x | add-bg-jobs | 新增 |

#### 3.5 禁动清单变动（聚合）

```
新增禁动：
  - src/lib/cache.ts 不允许绕过直接 import ioredis （来自 add-cache-layer）

解禁：
  - src/legacy/cache-old.ts 标记 deprecated，可拆 （来自 add-cache-layer）
```

### 步骤 4 · 逐项 review（用户参与）

**这是 A-evolve 的核心环节。不能跳过。**

按上面五类**逐项**问用户：

```
🟢 候选 1/N · 新增抽象 · src/lib/cache.ts
   能力：LRU 缓存封装
   来自：add-cache-layer（_archive/add-cache-layer）
   建议：append 到 CONTEXT.md「既有抽象索引」段
   AI 检测：与 CONTEXT 现有内容无冲突

   选项：
   ✅ 接受 promote
   ❌ 跳过（理由：例如临时用，不长期保留）
   ✏️ 编辑后 promote（你写新版本）

请回复：1 / 2 / 3
```

每条等用户回复后才进下一条。**严禁**一次性 batch promote 全部。

#### 冲突项必须显式问

冲突标 ⚠️ 的项额外问：

```
⚠️ 冲突候选 · 新抽象 src/utils/date-fmt.ts vs CONTEXT 现有 src/utils/date.ts
   两者能力重叠（都是日期格式化）。

   选项：
   ✅ 替换 — 用 date-fmt.ts 替换 date.ts，CONTEXT 索引指向新的
   ✅ 共存 — CONTEXT 索引同时列两个，注明用途差异
   ❌ 跳过 — 不 promote 新的，date.ts 仍是单一源
   ✏️ 编辑后定夺

请回复：1 / 2 / 3 / 4
```

### 步骤 5 · 生成 patch（合并入 CONTEXT.md · 可选 ARCHITECTURE.md）

收集所有用户批准的项，生成**两份 patch**（项目有 ARCHITECTURE 则两份都生，否则只生 CONTEXT 那份）。

#### 5.1 patch CONTEXT.md（rules 层 · 必生）

```markdown
## CONTEXT.md patch · YYYY-MM-DD

### 「域语言 / 默认行为」段 append
+ 大额分流：实付金额 > 50000 元走客服二维码 · 来源 custom-credit-purchase/SPEC.md:NN · 影响范围：支付域

### 「既有抽象索引」段 append
+ src/lib/cache.ts · LRU 缓存 · 来源 add-cache-layer (2026-04-12)
+ src/lib/queue.ts · 任务队列 · 来源 add-bg-jobs (2026-04-20)

### 「已锁技术决策」段 append
+ [YYYY-MM-DD] 缓存层：Redis（替代原 in-memory）· 来源：add-cache-layer/DESIGN.md:NN · 影响范围：服务端
+ [YYYY-MM-DD] 后台作业框架：BullMQ · 来源：add-bg-jobs/DESIGN.md:NN · 影响范围：服务端

### 「技术栈」段 update
~ ioredis 5.4.0 替换 node-redis（旧版可拆）
+ bullmq 5.x 新增

### 「禁动清单」段 update
+ src/lib/cache.ts 不允许绕过直接 import ioredis
- src/legacy/cache-old.ts（标 deprecated · 待拆）
```

生成 patch 前再跑一次最终门禁：

- [ ] 每条新增 CONTEXT 内容都有日期、来源、影响范围
- [ ] 没有 `影响范围 = 本 change` 的条目
- [ ] 没有与 active LESSONS 冲突的条目；若有，必须同时生成 LESSONS 状态变更说明
- [ ] 没有把失败教训 / 被否决方案写入 CONTEXT
- [ ] CONTEXT 仍保留项目概要、技术栈、既有抽象索引、禁动清单、intel-scan 元数据这些必备段

#### 5.2 patch ARCHITECTURE.md（structure 层 · 仅在 ARCHITECTURE.md 存在时生）

```markdown
## ARCHITECTURE.md patch · YYYY-MM-DD

### § 3 ADR 列表 · 新增
+ ADR-008 · 缓存层：Redis
  - 状态：accepted (YYYY-MM-DD)
  - 取舍：in-memory LRU / Redis / Memcached
  - 决定：Redis 7（ioredis 客户端）
  - 理由：多实例部署需共享缓存
  - 代价：多一个运维组件
  - 来源：add-cache-layer
  - 推翻成本：中

+ ADR-009 · 后台作业框架：BullMQ
  - ...

### § 4.1 公共 HTTP API · append
+ /api/cache/*  ← add-cache-layer
+ /api/notifications/*  ← add-notifications

### § 4.2 事件总线 · append
+ events.cache.invalidated  · 来源 add-cache-layer

### § 4.3 数据库 schema · 提及新表
+ cache_entries（详细 schema 见 add-cache-layer migration）
+ notifications（详细 schema 见 add-notifications migration）

### § 8 修订历史 · append
| YYYY-MM-DD | A-evolve | ADR-008/009 新增（来自 add-cache-layer / add-bg-jobs）| A-evolve |
```

**两者分工**：

- 技术栈变动 / 抽象索引 / 禁动清单 → 只进 CONTEXT（这些是 AI 实施层会读的）
- ADR / 跨模块契约 / Schema 总览 / 修订历史 → 只进 ARCHITECTURE（这些是人读 / 2-design 读的）
- 项目级技术决策（如“缓存选 Redis”）**两边都进**：CONTEXT 记一句话供 AI 快查，ARCHITECTURE 记完整 ADR

#### 5.3 给用户最终 review

```
✅ 即将应用的 patch（CONTEXT 共 N 条，ARCHITECTURE 共 M 条）：
[先贴 CONTEXT patch]
[再贴 ARCHITECTURE patch · 如有]

确认应用？
1. ✅ 应用两边
2. ⏸️ 暂存 patch 为 .gantry/specs/evolve/<YYYY-MM-DD>-EVOLVE-PATCH.md，我手动合
3. ✅ 只应用 CONTEXT 不应用 ARCHITECTURE
4. ✅ 只应用 ARCHITECTURE 不应用 CONTEXT
5. ❌ 取消，啥都不动
```

### 步骤 6 · 写入项目级文档（用户选 1/3/4）

**安全要求**：

- 写入前先备份（双选动则两份都备）：
  - `cp .gantry/specs/CONTEXT.md .gantry/specs/CONTEXT.md.bak-<YYYY-MM-DD>`
  - `cp .gantry/specs/ARCHITECTURE.md .gantry/specs/ARCHITECTURE.md.bak-<YYYY-MM-DD>`（如存在）
- 用 `edit` 工具按段 append / update（**不要整文件 rewrite**，避免破坏未涉及的内容）
- 每段 append 在末尾加注释：`<!-- A-evolve YYYY-MM-DD: from <change-id> -->`
- ADR 编号**顺接现有最大值**（grep `^### ADR-\d+` ARCHITECTURE.md 取 max + 1）

### 步骤 7 · 输出 EVOLVE 报告 + 更新 STATE

#### 7.1 报告写入 `.gantry/specs/evolve/<YYYY-MM-DD>-EVOLVE.md`

```markdown
# 架构演进同步 · YYYY-MM-DD

## 扫描范围
- 起始：上次同步 <date> 之后
- 涵盖 change：[列表]

## 候选汇总
- 新抽象：M 条 · 接受 X · 跳过 Y · 编辑 Z
- 技术决策：M 条 · ...
- 跨模块契约：...
- 依赖变动：...
- 禁动清单：...

## 应用 patch
[贴步骤 5 的最终 patch]

## 跳过项 + 理由
- src/utils/date-fmt.ts → 跳过，理由：与既有 date.ts 重复，保留单一源

## 下次建议同步时间
建议 <YYYY-MM-DD>（约 60 天后），或在新增 ≥ 5 个有 § 9 内容的 change 之后
```

#### 7.2 更新 `STATE.md`

```yaml
last_evolve_at: <YYYY-MM-DD>
last_evolve_promoted:
  - add-cache-layer
  - add-bg-jobs
  - add-notifications
  # ... 本次涉及的所有 change-id（无论是否被 promote，只要扫过就记，避免下次重复扫）
```

---

## 输出

- `.gantry/specs/CONTEXT.md`（patch 后 · 用户选 1/3 时）
- `.gantry/specs/ARCHITECTURE.md`（patch 后 · 用户选 1/4 时且文件存在）
- 备份文件（二者之一或两者都有）
- `.gantry/specs/evolve/<YYYY-MM-DD>-EVOLVE.md`（报告 · 必产）
- 更新的 `.gantry/specs/STATE.md`（`last_evolve_at` + `last_evolve_promoted`）

## 约束

- **不动业务代码**：本工作流只 patch `.gantry/specs/` 内的项目级文档，禁止改 `src/` / `tests/` / `package.json`
- **逐项 review 强制**：批量 promote 是禁的（容易把烂决策固化进 CONTEXT）
- **冲突必显式问**：标了 ⚠️ 的项不允许默默走「接受」分支
- **备份必跑**：写任何项目级文档前必须先 `cp` 备份
- **不删已有内容**：A-evolve 只 append / update，不 delete（如果发现某段过时该删 / 某 ADR 该 deprecated，写在报告里建议用户跑 A-architect，不自动删）
- **不读 § 9 以外的 DESIGN 内容**：避免把 change 级冻结决策错误升级到项目级
- **遇到架构级冲突停下来**：例如某 § 9 要求 deprecate 现有 ADR / 改依赖规则 → 不在本工作流动，提示用户跑 A-architect

## 自检

- [ ] 已读 `STATE.md` 的 `last_evolve_at` 决定扫描范围
- [ ] 范围内每个 change 都尝试读了 § 9（即使是"无建议"也已记录跳过）
- [ ] 五类聚合表完整（抽象 / 决策 / 契约 / 依赖 / 禁动清单）
- [ ] 冲突项已检测并显式标 ⚠️
- [ ] 逐项 review 完成，每条都有用户的 1/2/3 回复
- [ ] 检查了 ARCHITECTURE.md 是否存在（决定是否生成 § 5.2 patch）
- [ ] 最终 patch 已让用户一次性确认（可选 1/2/3/4/5 任一）
- [ ] 写任何文档前都备份了
- [ ] ADR 编号顺接现有 max + 1，未二次使用已有编号
- [ ] EVOLVE 报告已归入 `.gantry/specs/evolve/`
- [ ] STATE.md `last_evolve_at` + `last_evolve_promoted` 已更新
- [ ] 遇到架构级冲突未自作主张，已指引用户跑 A-architect

## 触发下一步

- 同步完成 → 提示用户："下次建议 <YYYY-MM-DD> 同步，或新增 ≥ 5 个 change 后再来"
- 用户选了"暂存 patch 我手动合" → 暂停，告知用户 patch 路径，本工作流结束
- 检测到 ARCHITECTURE.md 不存在但 § 9 里有 ADR 级候选项 ≥ 3 条 → **建议跑 `@A-architect.md` 先建立 ARCHITECTURE.md**，再跑 A-evolve 才能正式 patch ADR
- 检测到 ARCHITECTURE.md ADR 冲突 ≥ 5 条（同主题有多个 accepted ADR）→ 建议跑 `@A-architect.md` 重审
- 检测到 CONTEXT.md 已积累 ≥ 200 行 → 建议用户考虑将部分决策迁到 ARCHITECTURE（剩下 CONTEXT 只记 rules 层）
