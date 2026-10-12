# 改善计划 — 由 membership-price-credit-discount 会话驱动

> 关联诊断:[`DIAGNOSIS.md`](./DIAGNOSIS.md) · 分析日期 2026-08-06

优先级说明:**P0 治本**(上下文/清窗) → **P1 治核心**(范围治理 + 验证机制化) → **P2 治周边**(auto + 工具契约)。
每条给出:问题 → 动作 → 落点(框架仓库路径) → 验收。

---

## P0 — 上下文与清窗(治本,先做)

### P0-1 · 决策即写工件(Decision Log)
- **问题**:架构决策发生在对话里,工件是事后追记 → 对话不能丢 → 43 次失控压缩。
- **动作**:DESIGN.md / SPEC.md 模板新增「决策日志」区,要求每个架构选择**当轮追加**(时间 / 选项 / 结论 / 理由),而非阶段末补。让对话可安全丢弃。
- **落点**:`templates/DESIGN.md`、`templates/SPEC.md`;在 `phases/2-design.md` 加「每次澄清后追加 Decision Log」指令。
- **验收**:一次多轮设计澄清后,DESIGN 的 Decision Log 能独立重建决策链,无需回看对话。

### P0-2 · 对齐 harness 压缩与 gantry 清窗
- **问题**:R1.5「清窗前写 PROGRESS」从未执行(0 文件),因为压缩由 harness 自动触发,gantry 无插入点。
- **动作**:新增 **PreCompact hook**,在自动压缩**之前**强制生成 `<task-id>-PROGRESS.md`(已完成 / 当前 / 已排除方案 + 当前工件路径清单)。把「失控压缩」变「受控清窗」。
- **落点**:框架 hook 配置 + `src/lib/` 生成逻辑;文档写进 RULES.md R1.5。
- **验收**:再跑一次长 change,压缩次数 ≈ PROGRESS 文件数,且压缩后能从 PROGRESS + 工件恢复,不依赖 summary。

### P0-3 · STATE 增加运行时字段(自动写入)
- **问题**:STATE 的 token / 窗口使用率字段常年 `—`,无法支撑 R1.1 清窗判据;单线性状态机不反映多 PATCH + 回退。
- **动作**:STATE 增加 `压缩计数` / `当前 token` / `活跃 PATCH 列表` / `阶段回退栈`,由 hook 自动写,不靠人填。
- **落点**:`templates/`(STATE 模板)+ `src/lib/phases.mjs` 状态写入。
- **验收**:STATE 任一时刻能回答「现在几个 open PATCH、回退过几次、上次压缩何时」。

---

## P1 — 范围与 PATCH 治理

### P1-4 · adjust 分级闸门
- **问题**:PATCH-1 在 test 阶段塞进整个新子系统,adjust 从「例外」变「主设计通道」。
- **动作**:PATCH 变更量超阈值(新增子系统 / 影响 ≥N 个 AC / 引入新表)时,强制提示「这是架构级变更,建议开新 change 而非 patch」,需人工显式覆盖才继续。
- **落点**:`.claude/skills/gantry-adjust/` 协议 + `src/` 阈值判定。
- **验收**:构造一个「新增表 + 新机制」的 adjust,流程主动拦截并建议开新 change。

### P1-5 · 子 change / change 拆分机制
- **问题**:一个需求塞 3 个准独立子特性(涨价/折扣/解约)+ 中途重构 = 7 PATCH 的结构性根因。
- **动作**:支持一个需求拆成多个准独立 change,各走 pipeline,顶层用 epic 关联。
- **落点**:`METHODOLOGY.md` + planning/config schema + CLI(`gantry change --parent`)。
- **验收**:同类需求能拆 3 个 change 并行推进,单 change PATCH 数回落到个位数早期水平。

### P1-6 · PATCH 冲突检测
- **问题**:PATCH-3 废弃机制① → PATCH-4 恢复机制① → PATCH-6 删机制②,无净决策记录的反复。
- **动作**:新 PATCH 与既有 open PATCH 方向冲突时,要求先显式标注 `supersedes` / `drop reason`,并在 STATE 记录净决策。
- **落点**:`gantry-adjust` 协议 + PATCH.md 模板加「冲突声明」字段。
- **验收**:P3↔P4 那类反复会被要求写明谁覆盖谁,STATE 能给出「当前生效机制」单一答案。

### P1-7 · 对抗性 Fake 检查(把 R5.2 从规则变门禁)
- **问题**:T19 假绿——`_FakeDB` 不建模事务回卷,失败排首,资损防线被绕过。
- **动作**:涉及事务/资金/幂等的任务,DEV 门禁要求测试证明「Fake 建模了失败/回滚语义」(如 T19 的 `_TxDB`),否则 verify 不通过。
- **落点**:`phases/4-dev.md` 验证清单 + `templates/LESSONS.md` 记入 L-002 教训。
- **验收**:给一个「批 commit + 逐条 rollback」任务,若 Fake 不建模回卷则 verify 拒绝通过。

### P1-8 · 假绿哨兵(固化为流程步骤)
- **问题**:T19 被抓靠 review 阶段偶然的独立复核,不是流程保证。
- **动作**:review 阶段对「Critical 逻辑 + 全绿测试」组合**强制**定向独立复核(独立 reviewer)。
- **落点**:`phases/6-review.md` 增加「资损/Critical 路径必派独立 reviewer」步骤。
- **验收**:任何 Critical 标记任务,REVIEW.md 必含独立复核记录。

---

## P2 — auto 与工具契约

### P2-9 · auto 不确定性闸门
- **问题**:`/gantry-auto` 在设计动荡期反复被调用(8 次连续压缩空转),成本收益倒挂。
- **动作**:进入 auto 前检查——存在 open PATCH / 最近 N 轮有阶段回退 / DESIGN 24h 内被改 → 拒绝进入,提示先人工收敛。
- **落点**:`.claude/skills/gantry-auto/` 前置检查。
- **验收**:设计仍在改时调 auto 被拒并给出理由。

### P2-10 · 工具/环境契约自检
- **问题**:cwd 混乱(backend/ vs app/)3+ 次报错;`Grep not available` 4 次。
- **动作**:skill 启动时校验依赖工具可用性(缺 Grep → 用替代)并探测锁定项目根一次性确认。
- **落点**:各 gantry skill 的启动前置 + 共享 lib。
- **验收**:同一 change 内不再出现 cwd / 缺工具类报错。

### P2-11 · 修复 gantry-adjust 的 disable-model-invocation
- **问题**:`Skill gantry-adjust cannot be used due to disable-model-invocation` 报错 2 次——被设计为不可模型调用,却反复被尝试。
- **动作**:要么改配置允许模型调用,要么在文档/流程明确「adjust 只能用户手动触发」并在 auto/next 里不去调它。
- **落点**:`.claude/skills/gantry-adjust/SKILL.md` frontmatter + 调用方(auto/next)协议。
- **验收**:不再出现该报错。

---

## 建议执行顺序

1. **P0-2 + P0-3**(hook 层,一次性收益最大,直接消灭 43 次失控压缩的根)
2. **P0-1**(模板层,让对话可丢)
3. **P1-7 + P1-8**(防资损假绿,风险最高)
4. **P1-4 + P1-6**(adjust 治理,防设计反复)
5. **P1-5**(结构性,工作量最大,可最后做)
6. **P2** 三条(周边打磨)
