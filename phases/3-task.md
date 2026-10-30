# 阶段 3 · TASK — 把设计拆成可并行的原子任务

## Context Pack 优先

> 复用入口已加载的 context pack；尚未加载时再读 `.gantry/planning/context-pack.json`。pack 的 `checklists` 字段已替你完成"是否触发各子检查"的机械判定;你只需按 `trigger=true/false` 决定哪些段必跑、哪些跳过。
>
> 下面的 prose 仍是执行参考(怎么做),但"该不该做"以 pack 为准。


## 角色

你是 Planner。

## Pre-hook（可选）

先消费 pack 的 `hook-before`：false 时直接跳过，不运行 hook 命令，也不反复探测。旧 pack 无该项时读一次有效 hook 配置；为空则本上下文内跳过，配置变化后重新判断。CLI 已执行的 before:change / before:dev 不重复执行。

在进入本阶段主流程前，运行：
```bash
gantry hook run before:task
```
- 退出码 0 或无配置 → 继续
- 退出码非 0 → 收集诊断，按宿主剩余预算修复后重跑；候选执行者将诊断交外层，不自行批准或另开重试循环。仅预算耗尽或人工/进程/内容保护条件才停止

## 输入

- `@.gantry/specs/<change-id>/SPEC.md`
- `@.gantry/specs/<change-id>/DESIGN.md`（**必读 `## 0. 技术栈选定`**——任务的 verify 命令、依赖管理、目录结构必须按选定的栈写）
- `@.gantry/specs/CONTEXT.md`

## 你的职责

使用 `@gantry/templates/TASKS.md` 模板产出**原子任务列表**。

### 拆解原则

1. **大小**：一个任务是可独立验收的工作切片，能独立产生候选和 focused verify；不按固定分钟数或单个文件强拆。相同目标、共用验收且没有独立交付价值的小改动合并；上下文放不下、边界不清或失败难定位时再拆。DEV 末统一 commit，完成状态仅由控制器验收写入
2. **粒度**：按文件冲突切，不按层切。优先「垂直切片」（一个特性贯穿模型/API/UI）而非「水平层」（先所有模型再所有 API）
3. **并行标记 `[P]`**：互不冲突的任务标 `[P]`，用于依赖/冲突视图；共享工作区首版仍逐 task 顺序执行
4. **依赖**：每个任务显式声明 `depends_on: <task-id>`
5. **锚定团队约定路径（命门 · 若项目有 `.context/`）**：见下方「团队约定路径锚定」。拆任务时若命中团队约定，直接把正确路径写进 `action`、把产物文件锁进 `write_files`——让 DEV 阶段没有偷懒空间。
6. **每任务必备字段**：
   - `id` —— 形如 `T01`、`T02-1`
   - `name` —— 一句话
   - `read_files` —— **参考边界**：AI 在这个任务中允许 read 的文件（支持 glob，比如 `src/repos/*`、`src/utils/date.ts`）
   - `write_files` —— **修改边界**：AI 可以创建 / 修改 / 删除的文件。**作为计划与自动提交归属参考；额外文件由 R6.5 记录提示，不阻断任务验收**
   - `action` —— 要做什么（不写代码，写意图）
   - `verify` —— 证明当前 task 完成的最小、直接、可重复命令（如 `npm test -- theme.test.ts`、`curl ... | jq ...`）
   - `done` —— 完成判定（一句话，对应 AC 的某个子项）
   - 可选 `preflight` —— 环境就绪探针，逐行命令；不要把预期失败的行为测试放在这里
   - 可选 `checks` —— 任务必须的类型/Lint 等命令，逐行执行；不得以逗号拆分 shell 参数

`verify` 命令必须自包含运行所需的工作目录、环境与 runner，不能依赖执行者猜测。任务本身需要数据库或远程依赖时可以直接使用；这里约束的是验证范围最小，而不是禁止真实依赖。控制器会真实执行该命令，记录内容绑定凭据；空跑、可识别跳过/弱化不能完成任务。项目需要跨任务组合检查时，在 `.gantry/planning/config.json` 的 `ralph.checkpointCommands` 声明命令列表。TEST 会从 AC 扩大覆盖，INTEGRATION 再做全量与端到端验证。

### 共用验证的归属（拆任务时确定）

- 相同 verify 是复核粒度的信号：若多个 task 只能由同一条大范围命令证明完成，先寻找各自的 focused verify；确实不可独立验收且无并行收益时合并任务。不能仅因命令相同合并不同目标。
- `<verify>` 保留任务必需的直接验收；全量回归、部署、测试数据准备、远程 smoke 和跨服务 Journey 按 change 收口到 TEST / INTEGRATION，不复制进每个 task 或 wave。任务本身必需的远程验证仍保留。
- TEST / INTEGRATION 各由一个验证负责人组织本阶段检查。并行实现不派生多份非 DEV 环境验证；独立测试可并发，共享部署和可写测试数据串行处理。
- 使用现有 TEST.md 范围声明记录共用命令、目标环境、前置准备与负责阶段；已有有效结果只引用证据，不另建验证计划或状态文件。同一个命令可在 test-commands.yml 的 covers 中覆盖多个 AC。

### 团队约定路径锚定（命门 · 仅当项目有 `.context/`）

> **为什么在 TASK 阶段做**：agent 绕开团队约定（如"查 MySQL 走 btsgen 缓存回源"而非手写 db.Query）不是不守纪律，而是**正确路径的阻力高于错误路径**。规则文档只让 agent"知道"，改变不了阻力差。唯一结构性手段是**在拆任务时就把正确路径写死进 `write_files`**——正确路径成为任务既定边界，手写就越界，被提交前的 R6.5 边界 verify 拦住。这一步不依赖 DEV 阶段 agent 读文档或自觉。

**执行（无 `.context/MANIFEST.md` 时整段跳过）**：

1. 探测 `.context/MANIFEST.md` 是否存在。不存在 → 跳过本节，按常规拆分。
2. 存在 → **读一次 MANIFEST 路由表**（change 级，只读这一次），提取带 `[必须]/[禁止]` 的团队约定条目（如 `[必须] 缓存回源用 btsgen`、`[禁止] 手写 SQL`）及其 keywords。仅当某条约定的 TL;DR 不足以判断正确路径时，才读那一个源文件。
3. 用这份约定表匹配全部任务的 `action` 意图；命中的任务把约定落到字段（这是本阶段查一次、下游只读结果的关键——DEV 阶段不再重查 MANIFEST）：
   - `action` —— 显式写出正确路径（例：「通过 `//go:generate kratos tool btsgen` 生成缓存回源，禁止手写 db.Query + 手动 Redis」）。
   - `write_files` —— 只锁定正确路径的产物文件（例：`internal/dao/dao.go`、`internal/dao/*.bts.go`）；错误路径会写的文件（如某个手写 cache helper）**不要**列入，这样路径偏离可在范围提示中暴露。
   - 若该约定在 `.context` 里带「黄金范例」指针（团队人工填的可抄真实代码路径），把它加进 `read_files`，DEV 阶段照抄降阻力。
4. 无法判断某约定是否适用 → 不强行锚定，留给 DEV 阶段按 MANIFEST 加载（见 `4-dev.md` 1.5），不要瞎猜。

> gantry 只通过 `.context/MANIFEST.md` 这一个接口消费团队知识，**不复制其内容**。知识源头始终是 `.context/`，由团队维护。

#### `read_files` 与 `write_files` 的区别（B3 老项目护栏）

- **`read_files` 应该包含**：
  - 本任务要修改的文件（= write_files 的超集）
  - 本任务要 import / 参考的既有模块（沿用抽象要 read 才能用）
  - DESIGN.md `## 0.5.1` 「触碰模块」中的「已有·复用」项

- **`write_files` 严格控制**：
  - DESIGN.md `## 0.5.1` 「新增模块」项都加进来
  - DESIGN.md `## 0.5.1` 「触碰模块」中需要修改的那些
  - **不允许加「禁动清单」里的文件**（这是 R7.3 + R6.5 联动拦截点）

- **示例**：
  ```xml
  <read_files>
    src/features/notifications/*
    src/lib/api-client.ts       <!-- 沿用 -->
    src/components/Modal.tsx    <!-- 复用 -->
    src/utils/date.ts           <!-- 沿用 -->
  </read_files>
  <write_files>
    src/features/notifications/NotificationCenter.tsx
    src/features/notifications/useNotifications.ts
    src/features/notifications/__tests__/*
  </write_files>
  ```

### 波次划分

把任务按依赖图分层：
- 同层 = 同波次（可并行关系视图；共享工作区按 DEV 单写者协议执行）
- 跨层 = 顺序执行

输出形如：

```
Wave 1 (parallel): T01[P], T02[P]
Wave 2 (parallel): T03[P], T04[P] (depends on T01)
Wave 3:            T05 (depends on T03, T04)
```

### 任务模板（XML，便于 AI 解析与执行）

```xml
<task id="T01" parallel="true">
  <name>添加 ThemeContext provider</name>
  <read_files>
    src/theme/*
    src/lib/api-client.ts
    src/utils/storage.ts
  </read_files>
  <write_files>
    src/theme/ThemeContext.tsx
    src/theme/__tests__/ThemeContext.test.tsx
  </write_files>
  <action>
    导出 ThemeProvider 与 useTheme hook。
    主题值从 localStorage 读取，缺省读取系统 prefers-color-scheme。
    沿用 src/utils/storage.ts 的 `safeStorage` 包装（避免隐私模式报错）。
  </action>
  <verify>npm test -- theme/ThemeContext.test.tsx</verify>
  <done>测试通过；hook 在三种状态（light/dark/system）下返回正确值</done>
  <depends_on></depends_on>
</task>
```

## 输出

- `.gantry/specs/<change-id>/TASKS.md`，包含所有任务的 XML 块 + 波次划分图

## 约束（强制）

- **R2.3**：每个任务必须有可执行的 `verify`，否则不允许进入 `DEV`
- 任务粒度太大（无法在 wave 内独立完成和验证）必须再拆
- 不允许「重构 X 模块」这种没有边界的任务

## 自检

- [ ] 每个任务都有完整的 7 字段（`id` / `name` / `read_files` / `write_files` / `action` / `verify` / `done`）
- [ ] **每个 `write_files` 都严格在 DESIGN 「触碰模块 + 新增模块」范围内**（B3 护栏）
- [ ] **任何任务的 `write_files` 都不包含 DESIGN 「禁动清单」中的文件**
- [ ] **（若项目有 `.context/`）命中团队约定的任务，正确路径已写进 `action`、产物文件已锁进 `write_files`**
- [ ] 每个任务的 `verify` 都是证明当前 task 完成的最小、直接、可重复命令，并自包含工作目录、环境与 runner
- [ ] 至少有 1 个 `[P]` 标记的并行任务（除非确实全是串行）
- [ ] 波次划分图清晰、无环依赖
- [ ] 任务编号连续

## Post-hook（可选）

先消费 pack 的 `hook-after`：false 时直接跳过，不运行 hook 命令，也不反复探测。旧 pack 无该项时复用已读取配置；为空则跳过。已配置 hook 每次真实阶段执行仍按配置运行，不缓存其成功结果。

完成本阶段所有工作、自检通过后，运行：
```bash
gantry hook run after:task
```
- 退出码 0 或无配置 → 继续
- 退出码非 0 → 收集诊断，按宿主剩余预算修复后重跑；候选执行者将诊断交外层，不自行批准或另开重试循环。仅预算耗尽或人工/进程/内容保护条件才停止

## 自主模式自检（autonomous=true）

本阶段末尾禁止向用户反问「是否继续 / 要不要先扫一眼 / 是否推进下一阶段」。按 R2.6：
- 产物齐备、门禁通过 → 直接按「触发下一步」执行
- 多选场景 → 取推荐项（无推荐则取列表第一项），把选择与理由写进本阶段产物
- 停止条件按 当前工具的 `gantry-next` 入口「门禁修复循环」：人工确认/所缺用户决策或凭据、宿主剩余预算耗尽、取消/时限、进程/控制记录/用户内容保护；可恢复门禁先在本次调用内诊断修复

## 触发下一步

`phases/4-dev.md`（按波次逐个执行）
