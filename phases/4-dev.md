# 阶段 4 · DEV — 单任务 Ralph Loop + fresh executor

## Context Pack 优先

> 消费入口已加载的单任务 pack；新上下文尚未加载时再读。pack 已替你完成下列子检查的"是否触发"判定:
>
> - `1.4-grep-abstractions` · `1.5-lessons-grep` · `1.6-ui-task` · `1.7-schema` · `1.8-breaking-change`
>
> 你只需按 `checklists[].trigger` 决定哪些段必跑、哪些跳过——**不要再自己根据 prose 关键词重判一遍**。pack 给的 reason 字段说明命中证据。
>
> 下面 1.4-1.8 的详细规则仍是执行参考(怎么做),但"该不该做"由 pack 决定。

## 角色

你是 Dev，本协议区分控制器和候选执行者：
- **编排器层**：用 `gantry dispatch --json` 预约一个 ready task，给 fresh executor 单个任务 pack，收回候选后调用 `gantry done <id>` 独立验收。
- **单任务执行层**：每次预约创建一个 fresh executor subagent；仅实现该 task，一次尝试内完成 TDD 和报告。禁止创建子执行者、修改完成状态或推进阶段。

共享工作区任一时刻只允许一个 task 写者。wave / `[P]` 保留为依赖与冲突视图，首版按 TASKS 顺序串行消费 ready 集合，不发起共享目录并行写。

## 输入

- `@.gantry/specs/<change-id>/TASKS.md`
- 要执行的 task id（用户指定，例如 `T03`）
- `@.gantry/specs/<change-id>/DESIGN.md`（**必读 `## 0. 技术栈选定` + `## 0.5 既有架构对齐`**——install / build / test 命令必须匹配选定的栈；触碰模块 / 禁动清单 / 沿用决策必须严格遵循）
- **项目上下文文档**：只消费 pack 已选择的 context-doc，不再读取 STATE 或配置重新选择。
- **黄金范例文件**（若任务 `read_files` 里有 TASK 阶段锚定的范例指针）：打开照抄；这是团队约定的落地依据，**无需重读 `.context/MANIFEST.md`**（TASK 已查过）
- `@.gantry/specs/LESSONS.md`（无 `.context/` 时的回退知识层）
- 仅引用与本任务相关的文件，**不要加载整个项目**

## 单任务编排（主 session / Node controller）

### 0.1 预约与固定输入

运行 `gantry dispatch --json`。`dispatched` 含单个 `taskId`、`attemptId` 和 `repairOrdinal`；此时任务基线、验收 contract 与额度已落盘。重复预约会阻塞，查询/context 不扣额度。`all_done` 后进入 0.5。其他结果保留现场并处理其具体原因，不在主上下文接管绕过预算。

### 0.2 fresh candidate

读取 dispatch 返回的 contextPack，将该任务 pack 交给一个新的 executor subagent，按 loadOrder 最小加载，无需再运行 context 重建。把 pack JSON 冻结为当前 attempt 的输入；当前任务返回前不切换共享 pack、不启动别的写者。worker 只读自己的 pack，不加载整个 wave，不复用失败上下文。

worker 不运行 `gantry done/dispatch/advance/archive`，不改 `TASKS.md`、`EXECUTION.md`、STATE、execution 控制 JSON、锁或验收 contract，不自行 commit。各项检查结果在步骤 6 汇总返回，由编排器统一合入 EXECUTION，不逐项读改日志。禁止启动逃逸进程组的后台写者。

### 一次尝试内的调查与验证

一次预约对应一个受控 executor 进程，进程内允许多轮调查、修改与本地验证。遇到缺包、版本冲突、import 失败、API 不匹配，先核对声明、锁文件、官方导出/文档与可用版本，验证兼容组合并修复，然后重跑 verify/checks。每轮必须检验新假设或产生新证据，不能只复述报错、无差异重跑或仅写 PROGRESS 就交回。

verify/checks 通过后返回候选，外层仍独立验收。只有具体外部权限/不可获取的依赖、需要用户决定的需求歧义、人工批准、取消或执行时限才提前返回；说明已调查路径、已排除方案与所缺条件。禁止自行启动新的 executor、修改预约预算或弱化验收。

### 0.3 外层验收与失败接力

候选返回且受控写进程结束后，编排器运行 `gantry done <id> --json`。控制器实际执行 verify/checks，检查固定边界和验收弱化，将 receipt 绑定源码与索引内容，再按 receipt → EXECUTION → TASKS 顺序完成；stdout“成功”和 worker 手改勾选均不算证据。

失败保留候选和诊断。下一次 `dispatch` 为可修复失败预约新尝试，并创建 fresh executor；每 task **初次执行 + 最新 `ralph.maxRepairs` 次修复**（默认3），先扣额度再启动，崩溃不退还，最后一次修复成功可完成，仍失败则耗尽。明确可重试的传输故障在同预约下最多额外三次，和业务修复预算分开；缺包、版本或 API 不兼容由 executor 在本次尝试内调查修复；真实外部权限缺失、需求决策或验收标准变更需记录具体阻塞，不能盲目重派。手动 `heal` 只记诊断，不预约额度。

### 0.4 恢复与下一个任务

已有候选先用 `done` 重验，不立即重调模型。receipt 已写但状态未写时幂等补齐；TASKS done 缺 receipt 不能放行依赖。后续源码变化会使前序 receipt 保守过期，由控制器在调度前重验，不靠 HEAD/mtime 猜测。记录损坏或旧锁归属不明时停止，不删除记录、归零或盲杀 PID。

不得整体 revert wave、checkout/reset 清理用户修改或无限 fallback。需要改需求/范围走 adjust/PATCH；旧任务缺任务前基线需审阅迁移，不能把当前候选冒充原始基线。

### 0.5 DEV 末统一 checkpoint / commit

全部任务完成后运行 `gantry advance`：CLI 重验失效 receipt，按 `ralph.checkpointCommands` 执行组合检查；只安全暂存本 change 的任务增量和 EXECUTION，在索引内容上重验，再统一一个 stage commit。此前用户暂存内容或与任务不可分的同文件修改会阻塞自动提交，保留现场。提交格式 `<type>(<change-id>): DEV 概要`；task/wave 边界不提交。真实 commit 与待提交记录核对后只推进 TEST 一次。

---

## 单任务执行（executor subagent 职责）

### 1. 读取任务

从 `TASKS.md` 取出对应 `<task>` 块，读懂 `action / files / verify / done`。
若发现任务定义有歧义，**停下来反问**，不允许凭感觉补全。

### 1.4 沿用既有抽象 grep（强制 · 对应 R6.4 / B5 老项目护栏）

> 写新代码前必须 grep 同类抽象。找到了用，找不到才另起。

#### 1.4.1 grep 检查清单

针对本任务 `action` 中提到的每个能力，执行 grep。**禁止凭印象判断"项目里没有"**。

| 任务里的能力 | grep 命令模板 | 找到了怎么办 |
|---|---|---|
| HTTP 请求 | `grep -rn "axios\|fetch\|httpClient\|apiClient" src/` | 用既有客户端，禁直接 fetch |
| 日期格式化 | `grep -rn "format.*[Dd]ate\|date.*[Ff]ormat" src/utils src/lib` | import 用 |
| 状态管理 | 看 `package.json` zustand / redux / mobx | 用现有 store 范式 |
| Repository / DAO | `grep -rn "class.*Repository\|@Entity\|@Repository" src/` | 沿用模式 |
| 错误处理 | `grep -rn "ErrorBoundary\|errorHandler\|class.*Error" src/` | 沿用 |
| 自定义 hooks | `find src -name 'use*.ts*'` | 看有没有相似的 |

#### 1.4.2 保留抽象搜索证据

保留 grep 命令和命中位置，步骤 6 一次汇总：

```
✅ 沿用既有抽象 grep（R6.4）：
- HTTP 请求：找到 src/lib/api-client.ts:1（统一封装 axios）→ 沿用
- 日期格式化：找到 src/utils/date.ts:8（formatDate）→ 沿用
- 通知组件：未找到 → 新建（DESIGN 0.5.3 已批准）
```

**禁止**："项目里好像没有"——必须有 grep 命令和结果作证。

### 1.5 消费团队知识 + 扫 LESSONS（强制，对应 R1.8）

进入实现**之前**：

#### 1.5.1 团队约定（默认零额外读取 · 只在未锚定时兜底查 MANIFEST）

> **token 纪律**：团队约定的昂贵查询在 TASK 阶段已做过一次，正确路径写进了 `action`、黄金范例写进了 `read_files`。DEV 阶段**默认不重读 `.context/MANIFEST.md`**——重读会让同一份知识被每个任务各读一遍，token 随任务数翻倍。下游只读结果，不读源头。

**默认路径(任务已被 TASK 锚定)**：

1. 任务 `action` 已写明正确路径（如「走 btsgen 生成缓存回源」）→ 按它执行，**不查 MANIFEST**。
2. `read_files` 里若有黄金范例文件 → 打开它，**照结构改**（这是降阻力关键，优先于从零重写）。范例文件不存在 → 记一行「范例失效，按 action 原文实现」，不阻塞。
3. `write_files` 边界已锁定正确路径产物；走错路会越界，交接前 R6.5 记录具体文件提示。

**兜底路径(仅当任务未被锚定，即 `action` 无正确路径声明且项目有 `.context/`)**：

4. 此时才读 `.context/MANIFEST.md`，用任务 `files`/`action` 关键词匹配路由，命中带 `[必须]/[禁止]` 的约定 → 先读 `## TL;DR`，声明「本任务走 <正确路径>」；与 `[禁止]` 冲突则停下。这是少数情况（TASK 判不准才留给这里）。

#### 1.5.2 扫 LESSONS（`.context/` 与 gantry 原生均适用）

1. 用当前任务的 `files` 路径关键词、`action` 中的关键名词，grep `.gantry/specs/LESSONS.md`
2. 对每条命中且 `状态: active` 的 `L-NNN`，在本次执行计划里写一行：
   - 「已查阅 L-NNN，本次方案与之差异是 X」 或
   - 「已查阅 L-NNN，本次确认仍适用，所以不会重试该方案」
3. 若计划做的事与某条 active 条目完全相同 → 停下来按 R1.6 回答"本次与上次的差异是什么"，不允许盲目重试
4. 若既无 `.context/MANIFEST.md` 也无 `.gantry/specs/LESSONS.md` → 用 `@gantry/templates/LESSONS.md` 创建空骨架（有 `.context/` 的项目以其为知识源头，不必强建 LESSONS）

### 1.6 UI 任务额外检查（仅当任务涉及任何用户可见 UI）

判定标准：任务的 `files` 包含 `.css` / `.scss` / `.tsx` / `.vue` / `.jsx` / `.html` / `.svelte`，或 `action` 含 button / 颜色 / 字体 / 卡片 / 布局 / 动画 / 主题 等关键词。

命中时，进入实现**之前**还必须：

1. 加载 `@.gantry/specs/<id>/UI-DESIGN.md`（必须存在；不存在 → 停下来要求先跑 `phases/2-design.md` 的 § 8 前端 UI 设计，仅 PROPOSAL uiImpact=true 时生成）
2. 加载 `@gantry/reference/ui-anti-patterns.md`，按当前任务的关键词 grep 相关章节
3. 加载 `@gantry/reference/frontend-engineer-rules.md`（**第 1 + 第 2 + 第 10 节必读**），其他节按输出类型按需读：
   - 任务是做交互原型 → 补读第 6.1
   - 任务是做幻灯片 / 演示 → 补读第 6.2
   - 任务是做仪表盘 / 数据可视化 → 补读第 6.3
   - 任务有动画 / 交互动效 → 补读第 4 节 + 第 6.4
   - 任务涉及多变体 / 实时调参 → 补读第 5 节（Tweaks 面板）
4. 对每条命中的"强制禁忌"，在执行计划里**显式声明**：
   - 「已知 X 是禁忌（来自 anti-patterns / frontend-rules），本任务不涉及」 或
   - 「已知 X 是禁忌，本任务采用 Y 替代」
5. **Token 来源单一**：颜色 / 字体 / 间距 / 圆角 / 动效必须从 UI-DESIGN.md frontmatter 派生的 CSS variables / theme 文件中取。**禁止**在组件代码里硬编码颜色或字号（frontend-rules 第 2.1 节）
6. **React 三条硬规则马上写入计划**（仅 React 任务）：禁 `const styles` / 跨文件用 `Object.assign(window, ...)` / 禁 `scrollIntoView`（frontend-rules 第 1.1–1.3）
7. 实现完成后再扫一遍 anti-patterns + frontend-rules 第 10 节交付清单（self-review），结果在步骤 6 汇总。

> 装了 [impeccable](https://impeccable.style) 的项目可以用 `npx impeccable detect <files>` 自动化此扫描，保留真实输出。

### 1.7 数据库 Schema 任务额外检查（涉及表 / 字段变更必跑 · 对应 R4.5）

> 这是 AI 开发最高频的事故源——改了 ORM model 没生迁移，跑起来报"表/字段不存在"。本段强制堵住。

**判定标准**：任务的 `action` 含「**新增表 / 加字段 / 改字段类型 / 加索引 / 加外键 / 重命名表/列 / 删表/列**」等关键词，或 `files` 涉及：

- ORM model：`models/*.py` / `*Model.ts` / `entity/*.java` / `*.entity.ts` / `schema.prisma` / `*.gorm.go`
- 迁移目录：`migrations/*` / `db/migrate/*` / `alembic/versions/*` / `prisma/migrations/*`
- DDL：`*.sql`（含 `CREATE TABLE` / `ALTER TABLE` 等）

命中时，进入实现**之前**必须：

#### 1.7.1 声明 schema diff

在执行计划里**显式列出**：

```
## Schema Diff（本任务）
- 新增表：`<table>`（字段：col1 TYPE NOT NULL, col2 TYPE DEFAULT ...）+ 索引：...
- 改字段：`<table>.<col>` 类型 `<old>` → `<new>`，迁移策略：<是否需要 backfill / 兼容期>
- 删字段：`<table>.<col>`，迁移策略：<是否需要先双写过渡>
- 新增外键：`<table>.<col>` → `<ref-table>.<ref-col>`（ON DELETE: ...）
```

**禁止**没声明就开干。

#### 1.7.2 选执行机制（按优先级探测项目）

按下面顺序探测，**用第一个命中的**：

| 优先级 | 检测信号 | 用什么 | 命令示例 |
|---|---|---|---|
| 1 | `prisma/schema.prisma` 存在 | Prisma | `npx prisma migrate dev --name <change-id>_<task-id>` |
| 2 | `alembic.ini` 存在 | Alembic | `alembic revision --autogenerate -m "<change-id> <task-id>"` |
| 3 | `db/migrate/` 目录（Rails） | Active Record | `rails generate migration <CamelName>` |
| 4 | `knexfile.*` 存在 | Knex | `npx knex migrate:make <change-id>_<task-id>` |
| 5 | `flyway.conf` / `flyway/sql/` 存在 | Flyway | 手写 `V<timestamp>__<change-id>_<task-id>.sql` 放进 `flyway/sql/` |
| 6 | `liquibase/changelog.xml` 存在 | Liquibase | 追加 `<changeSet>` 到 changelog |
| 7 | `migrations/` 或 `db/migrations/` 目录（无框架）| 手写 SQL | 文件名：`YYYYMMDDHHmm_<change-id>_<task-id>_<verb>.sql` |
| 8 | 全部都没有（裸项目）| **回退**：生成在 `.gantry/specs/<change-id>/migrations/` | 文件名同上，报告中登记"待用户搬到正式迁移目录" |

#### 1.7.3 生成可逆迁移

每个迁移文件必须含 `up` 和 `down`（或对应框架的 migrate / rollback）：

```sql
-- up
ALTER TABLE users ADD COLUMN avatar_url VARCHAR(255) DEFAULT NULL;
CREATE INDEX idx_users_avatar_url ON users(avatar_url);

-- down
DROP INDEX idx_users_avatar_url ON users;
ALTER TABLE users DROP COLUMN avatar_url;
```

**禁止** down 段写 `-- 不可回滚`。即使破坏性变更（删字段），down 也要写"重建空字段 + 数据丢失警告"。

#### 1.7.4 检测 DB 凭据 → 决定要不要现在执行

按下面顺序 grep 项目（用 `grep_search` 工具或等价命令）：

```
.env / .env.local / .env.development / .env.example
config/database.yml / config/database.json
application.yml / application.properties / application-*.yml
docker-compose.yml（DB 服务段：postgres / mysql / mariadb / mongo）
prisma/schema.prisma 的 datasource 段
serverless.yml / wrangler.toml（如适用）
```

##### 路径 A · 找到凭据

**必须停下来反问用户**，模板：

```
🔍 检测到本项目有 DB 连接配置（具体：.env 第 12 行 DATABASE_URL）。
本任务包含 schema 变更：
  - 新增表：notifications
  - 改字段：users.email_verified（NULL → NOT NULL DEFAULT FALSE）

是否现在执行迁移？
  1. 现在执行（我会跑：npx prisma migrate dev --name add-notifications）
  2. 只生成 SQL/迁移文件，由你手动跑（推荐生产敏感项目）
  3. 让我先看 SQL 再决定（我会贴出迁移文件内容给你看）
```

- **用户选 1**：AI 跑迁移命令，保留真实输出，并跑 `\d <table>` / `DESCRIBE <table>` / `SHOW CREATE TABLE` 验证表结构落地
- **用户选 2 / 3**：AI 生成迁移文件，等用户选定后再决定执行

##### 路径 B · 未找到凭据

直接走"只生成迁移文件"：

1. 按 1.7.2 选定的机制生成迁移
2. 在返回报告的「数据库迁移」项**显式提醒**：

```
⚠️ 数据库迁移文件已生成（未检测到 DB 凭据，需手动执行）
  - 文件：prisma/migrations/20260501_add_notifications/migration.sql
  - 执行命令：npx prisma migrate deploy
  - 验证命令：psql -c "\d notifications"
  - 环境清单（执行后逐项打勾）：
    - [ ] local
    - [ ] dev
    - [ ] staging
    - [ ] prod（生产请走 maintenance window，先 dry-run）
```

#### 1.7.5 反幻觉（R6.1）

**禁止凭印象写迁移**：

- 加字段 → 必须先 grep ORM model 确认字段已声明（避免迁移和 model 不一致）
- 改字段类型 → 必须确认旧类型 → 新类型的兼容性（VARCHAR(50) → VARCHAR(20) 可能截断；BIGINT → INT 可能溢出）
- 加 NOT NULL → 必须确认有 DEFAULT 或先做 backfill（不然旧行报错）
- 加外键 → 必须确认引用列有索引

#### 1.7.6 5-test 关联

本步生成的迁移文件，5-test 第 4 轮「4.2 数据迁移测试」会再验证一次（在生产数据快照上预演）。所以报告必须给出迁移文件路径。

### 1.8 破坏性变更高门槛（强制 · 对应 R4.6 / B4 老项目护栏）

> 删错代码 / 改坏公共接口是**老项目最高频真事故**。本段强制堵住。

**判定标准**：本任务 diff 命中下面**任一**条件 → 必须走本协议：

1. **删除既有代码** ≥ 5 行（不算空行 / 注释）
2. **改公共导出**：导出函数 / 类 / 接口的签名变更（参数 / 返回值 / 类型）
3. **改公共 API**：HTTP / GraphQL / gRPC 路由或 schema 变更
4. **删除文件** 或 重命名导出符号

#### 1.8.1 grep 引用图（必须）

对每个被删 / 改签名的符号，执行 grep：

```bash
# 例：删除 formatLegacyDate 函数
grep -rn "formatLegacyDate" src/ tests/ scripts/ docs/
# 例：改 fetchUser 的签名
grep -rn "fetchUser\b" src/ tests/
# 例：删除文件 src/utils/old-helpers.ts
grep -rn "from.*old-helpers\|import.*old-helpers" src/ tests/
```

**贴出完整结果**（哪怕 0 命中也要贴 0 命中的 grep，证明你查了）。

#### 1.8.2 列出影响清单

把 grep 结果整理成清单，**含间接影响**：

```
被删/改的符号：formatLegacyDate (src/utils/legacy-date.ts:12)
直接调用：
  - src/components/InvoiceTable.tsx:34
  - src/api/reports/route.ts:67
  - tests/legacy-date.test.ts:8
间接影响：
  - InvoiceTable 是 src/pages/invoices.tsx 的子组件 → invoice 页面会受影响
  - reports/route 被 cron job daily-report 触发 → 可能影响定时任务
```

⚠️ **特别注意**：

- AI 看到的 grep 结果 ≠ 真实引用图：动态 import / 反射 / 字符串拼接的 require / 配置驱动的 hook 名都可能漏掉
- 对**公共 API**还要 grep **客户端代码**（mobile app / 第三方集成）
- 对**导出符号**还要 grep **文档 / README / Storybook**

#### 1.8.3 反问用户（停下来）

把 1.8.1 + 1.8.2 的结果**贴出来反问用户**：

```
🔴 检测到破坏性变更：删除 formatLegacyDate（5 行 + 8 处调用点）

调用点清单：
  - src/components/InvoiceTable.tsx:34（调用 1 处）
  - src/api/reports/route.ts:67（调用 1 处）
  - tests/legacy-date.test.ts:8（测试用）

请选择处理方式：
  1. 直接删除 + 同步改 8 处调用点（我会一并改）
  2. 留兼容期：保留 formatLegacyDate 但加 @deprecated 注解 + 6 个月后清理（建议）
  3. 写 codemod：生成 ts-morph / jscodeshift 脚本批量替换（适用调用点 > 20）
  4. 不删了，找别的办法实现需求

无人工确认前，我不动手。
```

#### 1.8.4 回归测试覆盖

无论选哪个方案，必须确保：

- 删除 / 改动的旧路径**有测试覆盖**（不能默默 break）
- 改公共 API 的新旧版本必须**同时有测试**（兼容期内两套都跑）

#### 1.8.5 保留破坏性变更证据

保留 1.8.1~1.8.4 的引用图、用户决策和回归证据，步骤 6 一次汇总。

#### 1.8.6 何时**不必**走本协议

- 重构内部实现（导出符号不变）
- 加新参数但保持向后兼容（带默认值的可选参数）
- 删 < 5 行实现细节（无外部引用）

### 2. TDD 优先（默认开启）

按 RED → GREEN → REFACTOR 顺序：

1. **RED**：先写一个失败的测试（直接派生自 AC 或 done 条件）
2. 跑测试，**确认它真的失败**（必须看到失败输出）
3. **GREEN**：写最少代码让它通过
4. 跑测试，**确认它真的通过**（必须看到通过输出）
5. **REFACTOR**：在测试保护下整理实现

> 例外：纯文档/纯配置任务可跳过 TDD，返回报告说明理由，不因此额外创建 SUMMARY。

### 3. 跑 verify

只运行当前 task 的 focused verification：按 `<verify>` 命令执行，保留真实命令、退出码与输出，在步骤 6 汇总。
只有 verify 通过才能进入下一步。

共用的全量回归、部署和远程 smoke 按 change 在 TEST / INTEGRATION 集中执行，不因 task 或 wave 数增加重复次数；当前 task 必需的 focused verify 和控制器独立验收仍必须执行。

`<verify>` 可以连接当前任务完成所必需的数据库或远程依赖；规则不是禁止真实依赖，而是不在 DEV 重复运行与当前 task 无关的全套测试。跨 AC 扩面留给 TEST，全量与端到端留给 INTEGRATION。

### 4. 交接前 self-review（书本驱动 6 维 · 装了 brooks-lint 优先）

> 这是把 6-review 阶段的代码质量轮**前置一部分**到 dev 自查，避免 review 阶段才发现明显问题。

**触发条件**：本任务有任何**生产代码改动**（非纯文档 / 纯配置 / 纯测试）。

##### 路径 A · 装了 brooks-lint（首选）

交接前调用：

```
/brooks-review            # 基于本次未提交 diff 跑诊断
```

如果发现：
- 🔴 Critical → **必须修后再交付**，不允许带病交付
- 🟡 Major → 修或在报告中写明「已知接受 + 理由」
- 🟢 Minor → 记入报告的「已知小问题」项，可不修

保留 brooks-review 输出，在步骤 6 汇总，不另写一份日志。

##### 路径 B · 未装 brooks-lint（内置快查）

按 6 维快速过一遍自己的 diff（每条 ≤ 30 秒）：

- **R1 认知过载**：单个函数 > 50 行 / 嵌套 > 3 层 → 拆
- **R2 变更传播**：本次任务无关的文件 / 模块被改动 → 记录来源与具体路径，不自动回退
- **R3 知识重复**：粘贴同一段逻辑到 2+ 处 → 抽函数
- **R4 偶然复杂**：抽象层级 > 业务实际所需 / 写了"以后可能用到"的扩展点 → 删
- **R5 依赖混乱**：`from xxx import yyy` 反向（业务层 import 基础设施实现） → 倒置
- **R6 领域扭曲**：变量名是技术词（data / info / item）而非领域词（order / driver） → 重命名

发现问题先修，**不允许交付时心想"review 阶段再说"**。

### 5. 交接前 diff 边界 verify（记录与提示，不阻断）

运行 `git diff --name-only HEAD`、`git diff --cached --name-only` 与 `git status --short`，对照任务基线记录实际文件变化及相对 `write_files` 的额外文件。`write_files` 是计划范围；额外文件、未填写该字段、更新计划路径均不停止 focused verify / done，也不要求仅为文件列表变化走 adjust。

控制器把 `changedFiles`、`outOfScope` 写入 receipt；done / loop 显示具体范围提示，EXECUTION 引用实际文件清单。额外变化可能来自并行任务或用户编辑，不自动回滚，不因未列入计划就判任务失败。业务目标、验收标准发生改变仍按 adjust 处理；自动提交仍只处理确认归属的内容，不把额外文件猜成任务产物。

### 5.5 提交（R4.1 · stage 级）

DEV 阶段末由控制器统一 1 个 commit（见「单任务编排」§ 0.5），executor subagent **不自行 commit**。

提交格式：
```
<type>(<change-id>): dev 阶段概要
```
例：`feat(add-dark-mode): dev 主题切换能力`

代码 + 测试同次提交（DEV 末统一提交，覆盖全部 task）。

### 6. 汇总返回报告

一次返回：实际改动 / grep 命令与结果 / verify 命令、退出码和输出 / **6 维自查** / **越界检查** / 命中的迁移或破坏性变更证据 / 是否触发新 fix-plan。编排器验收后统一合入 `EXECUTION.md` 对应 task 段；同一输出仅保留一份，其他位置引用路径或 task 段。

只有高风险/例外任务存在需要独立交接的细节时，才按 `@gantry/templates/SUMMARY.md` 写 `<task-id>-SUMMARY.md`，且须在 write_files 内。EXECUTION 只保留摘要与链接，不复制其正文。普通任务、TDD 例外都不自动创建 SUMMARY。

#### 6.1 Task 微复盘（完成前必填）

在返回报告填写 `problem / cause / next`：

- `problem` 只记录可观察的踩坑、返工或阻力；没有则写 `none`，**不得凑数**。
- `cause` 写问题根因；`problem` 为 `none` 时也写 `none`。
- `next` 写下次具体改变什么以及如何验证；没有则写 `none`，不写“加强注意”“提高质量”这类空话。
- `gantry done` 投影真实验收凭据；报告由编排器合入，不能留下 TODO 或伪造测试结果。

### 7. 标记完成

executor 交还候选和报告。只有编排器调用 `gantry done <id>` 的真实验收事务可以写 TASKS status=done；不手改 XML，不凭报告盖章。

## 中途断点（清窗触发与恢复，对应 R1.5 / R1.6 / R1.7）

### 进度快照（仅中断时）

进度快照统一落在 `.gantry/specs/<change-id>/<task-id>-PROGRESS.md`（用 `@gantry/templates/PROGRESS.md`），不需要专用命令：

- 正常执行不创建或逐子条件更新 PROGRESS。
- **中断前（清窗 / 结束会话且任务未完成）**：按下方「中途暂停」步骤写出 PROGRESS.md（尤其「已排除方案」段）；STATE 由编排器通过 CLI 维护。

> 恢复时按「入场恢复」小节从 PROGRESS.md 续起。这就是 R1.5 重启协议的落地方式——状态由文件承载，不靠命令、不靠记忆。

### 入场恢复（会话开头若发现是接力）

若 pack 包含当前任务 PROGRESS，或用户要求"继续 task X"，**第一动作**：

1. 按 pack.loadOrder 和 focus 加载最小恢复上下文；已读且未变化的内容直接复用，不另读 METHODOLOGY / RULES / 全部上游工件
2. 执行 R1.6 反重复检查：读 PROGRESS 的「已排除方案」，确认下一步不撞车
3. 从 PROGRESS 的「当前正在做」之后续起，禁止重新规划整个任务

### 中途暂停（触发 R1.1 信号时）

若执行中出现累计 / 输入 token > 200k、当前上下文窗口使用率 > 85%、自我复读、同错重现、用户说"打转了"中任一信号：

1. **立即停手**——不要再写代码或跑工具
2. 用 `@gantry/templates/PROGRESS.md` 写出 `.gantry/specs/<id>/<task-id>-PROGRESS.md`，重点填：
   - 已完成子步骤（勾选清单）
   - 当前正在做（一段话，恢复后能直接续上）
   - **已排除的方案 + 理由 + 失败次数**（这是反重复的核心）
   - 待确认的假设
3. 返回中断原因与续接点，由编排器维护状态；executor 不修改 STATE
4. 输出"重启指令"给用户（见 RULES R1.5 模板）
5. 检查是否触发 R1.7：若 task 体量明显过大，向编排器建议拆分，经 adjust 更新验收 contract 后再恢复；executor 不改 TASKS

### 任务完成后

如果该任务有 PROGRESS.md，验收成功后由编排器保留未记录的有效结论并删除它；SUMMARY 已承载的细节只引用，不重复迁移。
PROGRESS 是临时文件，不归档。

## 约束（强制）

- **R2.4**：verify 未通过禁止标记完成
- **R2.5**：dev 阶段 verify 失败，每次自愈都要有新诊断（越界 / 依赖 / 断言 / import / 环境），初次执行后按最新 `ralph.maxRepairs`（默认3）修复；达到上限仍失败即耗尽，禁止清账重跑。light 管线不走本阶段，其自愈闭环见 `phases/F-fast.md`
- **R3.2**：发现需求/设计偏差先调查，通过当前 change 的 adjust/PATCH 交对应角色修复，不自行改 `SPEC.md` / `DESIGN.md`，不仅因偏差就新开 PROPOSAL；需要用户新决策或批准摘要变化时才等待确认
- **R4.5**：Schema 变更必伴随迁移文件。只改 model 不生迁移就提交 → 违规，保留现场并补齐迁移
- **R4.6**：破坏性变更（删 ≥ 5 行 / 改公共接口）必走 1.8 协议：grep 引用图 + 反问用户 + 回归测试覆盖
- **R6.4**：写代码前必 grep 同类抽象（见 1.4），找到了用，不另起炉灶
- **R6.5**：交接前必跑 diff 边界 verify（见 5），额外文件保留现场并列出路径，不因计划范围差异停止
- **R5.2**：禁止用 mock 屏蔽真实失败
- **R6.3**：禁止"应该可以工作"——必须实际跑过 verify
- **R7.1**：业务目标或验收标准变化走 adjust；仅文件列表变化不阻断
- **R1.4**：每个 task 一个 fresh executor subagent，一次只处理一个 context pack；executor 不自行 commit、不跑 `gantry done`，禁止跨 task 混写
- **R1.5 / R1.6 / R1.7**：清窗、恢复、反重复严格按上面"中途断点"小节执行

## 自检

- [ ] verify 命令真的跑了，且输出已贴出
- [ ] 本 task 改动已就绪（代码 + 测试），待编排器统一提交
- [ ] **6 维 self-review 跑了**（生产代码改动必跑：`/brooks-review` 或内置 6 维快查），🔴 已修，🟡 已记，🟢 可省
- [ ] **涉及 schema 变更的任务已生成迁移文件**（R4.5 / 1.7），且含 up + down；检测到凭据已反问用户、未检测到凭据已在报告里提醒手动跑
- [ ] **前端任务走了 1.6**（命中时）：读了 UI-DESIGN.md + frontend-engineer-rules.md；交付前逐项过了 frontend-rules 第 10 节交付清单（console 无错 / 状态完备 / 无硬编码颜色 / 无 `const styles` / 无 `scrollIntoView`）
- [ ] **沿用既有抽象 grep 跑了**（R6.4 / 1.4），报告包含命令与结果；需要能力都已查过项目里有无
- [ ] **破坏性变更走了 1.8 协议**（R4.6）：删代码 ≥ 5 行 / 改公共接口都 grep 了引用图、反问了用户、有回归测试覆盖。未命中跳则明示
- [ ] **交接前 diff 边界 verify 跑了**（R6.5 / 5），报告包含实际变化及额外文件清单
- [ ] 返回报告已汇总「6 维自查」「越界检查」及命中的迁移/破坏性变更证据，待编排器统一合入 EXECUTION
- [ ] 当前 task 微复盘已填写 `problem / cause / next`，无残留 `TODO`；无经验时写 `none`，未凑数
- [ ] 需要独立交接细节时才写 SUMMARY，其他位置只引用
- [ ] 控制器验收通过，TASKS 状态与有效 receipt 一致（executor 不改状态）
- [ ] 没有改动 `SPEC.md` / `DESIGN.md`
- [ ] 已记录计划范围外文件及来源，不自动覆盖或回滚其他任务和用户改动

## Post-hook（可选）

先消费 pack 的 `hook-after`：false 时直接跳过，不运行 hook 命令，也不反复探测。旧 pack 无该项时复用已读取配置；为空则跳过。已配置 hook 每次真实阶段执行仍按配置运行，不缓存其成功结果。

完成本阶段所有工作、自检通过后，运行：
```bash
gantry hook run after:dev
```
- 退出码 0 或无配置 → 继续
- 退出码非 0 → 收集诊断，按宿主剩余预算修复后重跑；候选执行者将诊断交外层，不自行批准或另开重试循环。仅预算耗尽或人工/进程/内容保护条件才停止

## 自主模式自检（autonomous=true）

本阶段末尾禁止向用户反问「是否继续 / 要不要先扫一眼 / 是否推进下一阶段」。按 R2.6：
- 产物齐备、门禁通过 → 直接按「触发下一步」执行
- 多选场景 → 取推荐项（无推荐则取列表第一项），把选择与理由写进本阶段产物
- 停止条件按 当前工具的 `gantry-next` 入口「门禁修复循环」：人工确认/所缺用户决策或凭据、宿主预算耗尽、取消/时限、进程/控制记录/用户内容保护；可恢复门禁先诊断修复

## 触发下一步

- 还有未完成任务 → 清窗，再次进入 `phases/4-dev.md` 跑下一个
- 全部完成 → `phases/5-test.md`

## 失败分类与限域恢复

控制器返回 `failure` 与 `recovery`：task-defect 修所属任务，write_files 为计划提示；dependency-invalid 先重验上游；environment-failure 修复 runner/依赖后继续；相同内容先成功后失败记录 flaky-test，继续调查修复不稳定性；安全返回的未知失败也进入剩余修复预算，取消/清理不确定立即交宿主停止；计划范围差异仅提示。分类写入执行记录并向下一次任务诊断传递，不能依据“测试红”推断依赖漏声明。恢复保留预约与预算、其他任务成果及用户原有 dirty/staged 内容；不整体 revert wave。

## 验收门禁精简

read_files / write_files 是计划元数据；文件列表变化不要求人工修订。不要用断言/用例token数量下降、新增skip或部分skipped/todo输出直接判定失败，记录实际通过/失败/跳过计数；真实失败、零测试/无通过用例仍不能通过。整测试文件删除列出具体路径。EXECUTION TODO只是未填记录，不替代真实receipt判据。

唯一例外：验收字段被误改时，只允许将当前任务的 verify/done/checks/preflight 精确恢复为传入的已保存 contract 原值；不修改 contract 控制记录、TASKS 完成状态或其他任务，不重新定义验收。
