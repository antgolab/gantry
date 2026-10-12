# 诊断报告 — membership-price-credit-discount 会话

> Session `84d39b63` · 2026-08-03 → 08-06 · full pipeline · 分析日期 2026-08-06

---

## 一、关键量化信号

| 指标 | 数值 | 预期 | 判定 |
|---|---|---|---|
| **Context 自动压缩(续窗)** | **43 次** | 受控清窗、阶段边界触发 | 🔴 严重异常 |
| **单 change 内 PATCH 数** | **7 个**(P3↔P4↔P6 互相废弃/重定) | patch 是例外通道 | 🔴 设计反复 |
| **PROGRESS 文件(R1.5)** | **0 个** | 清窗前必写 | 🔴 协议未执行 |
| 用户中断 Request interrupted | 2 次 | — | 🟡 |
| 报错 tool_result | 21 次 | — | 🟡 |
| TASKS 累计 | 27 个(T01→T24+) | — | 膨胀 |
| PATCH 提及频次 | P1:28 P2:13 P3:64 P4:14 P5:44 P6:3 P7:39 | — | P3/P5/P7 反复出现 |

**43 次压缩分布**:08-03(3) / 08-04(15) / 08-05(20) / 08-06(5)。
08-05 11:03→12:42 之间 **8 次连续压缩**,全部是 "continuing /gantry-auto",阶段内部触发,与阶段边界不对齐。

---

## 二、与 gantry 预期设定不符的地方(逐条对照规则)

### 1. R1.2 / R1.5 清窗协议整体失效 —— 最核心问题

gantry 设计的是「阶段切换时输出工件清窗(R1.2)+ 清窗前写 PROGRESS(R1.5)」的**受控清窗**。
实际发生的是 **43 次 harness 自动 "ran out of context" 压缩**,全部在**阶段内部**触发。
gantry 的清窗协议从未被执行:**0 个 PROGRESS 文件**,压缩点与阶段边界不对齐。
→ **框架的清窗设计与 Claude Code 的自动压缩机制完全脱节。**

### 2. R7.1 范围控制被 adjust 通道架空

PROPOSAL 初始 scope = 「涨价 + 积分折扣下架 + 统一解约」三项。但演进为:
- **PATCH-1**(test 阶段)引入「通用新老套餐替换机制」——全新子系统,阶段回退到 requirement。
- **PATCH-3**(integration 阶段)废弃机制①(时间闸门改价),统一走机制②(套餐切换)。
- **PATCH-4** 立即发现「与 PATCH-3 方向冲突,需重定」,又恢复机制①。
- **PATCH-6**(review 回环)再删除机制②,B1 成唯一实现。

这是**在实现阶段反复重做架构决策**。adjust 从「记录新事实的例外通道」变成了「主设计通道」。
每步都是用户决策(合规),但流程没有在 PATCH-1 那种量级时**强制回到 PROPOSAL 重开 change**。

### 3. R5.2 假绿掩盖真实失败 —— 出现资损级后果

PATCH-5 的 **T19(🔴 Critical)**:`disable_renew_monthly_members.py:150-173` 批级 commit + 逐条 rollback,
在 `[成功,失败]` 序下会**静默回卷已 disabled 的成功行**,`--retry-from` 永不可恢复
→ **用户继续扣款且永不解约(资损防线击穿)**。

假绿归因(PATCH.md 原文):`test_single_disable_failure_isolated` 把失败排首 + `_FakeDB` 不建模 rollback 撤销已 execute 行(L-002)。
→ 这正是 R5.2「禁止用 mock 屏蔽真实失败」要防的,却真实发生,靠 review 阶段人工兜底才发现。

### 4. STATE.md 与实际严重脱节

STATE 显示「当前阶段 test / autonomous 1/3 / 重试 0/3 / token `—` / 窗口使用率 `—`」。
实际:PATCH-7 已回退 requirement、PATCH-5 的 T19 Critical 仍「archive 前硬门禁待复审」。
→ **状态机是单线性的,真实工作是多 PATCH 并行 + 阶段反复回退**,STATE 无法表达,失去「唯一状态源」价值。
→ R1.1 的清窗触发条件(token>200k / 使用率>85%)无数据支撑,因为字段是 `—`,没人填。

### 5. 环境/工具契约不稳定(21 次报错的构成)

- **cwd 混乱**:`backend/app/models/...` vs `app/models/...` 反复出错(Exit 1/128,3+ 次),
  子代理与主体对项目根目录认知不一致。
- **`Grep is not available in this session`** 重复报错 **4 次**——skill/agent 假设了不存在的工具。
- **`Skill gantry-adjust cannot be used due to disable-model-invocation`** 报错 **2 次**——
  skill 自身配置阻止模型调用,却仍被尝试。
- Edit "String to replace not found" / "File has been modified since read" 若干——并发编辑与 stale read。

---

## 三、卡点项清单(阻塞推进的具体时刻)

1. **08-04 设计澄清马拉松**:06:08→07:14 用户连发 12 条逐步细化
   (version 概念 → 独立全属性替换 → plan_id 复用 → is_active 扩展 → paladin 切换 → 购买校验四分支),
   期间 5 次压缩。**架构在对话里边设计边收敛,没有稳定的 DESIGN 快照**,每次压缩靠 summary 重建。

2. **08-05 机制①↔②反复**:07:10→09:02,PATCH-3 废弃 → PATCH-4 冲突重定,**同一天内自我否定**,大量 token 消耗。

3. **08-05 11:03→12:42 auto 空转**:8 次连续压缩,全是 `/gantry-auto` 续窗,
   maxStages=3 却因 PATCH 回环反复被打断,**自主模式几乎没产生自主推进价值**。

4. **假绿 → review 回退 dev**:T19 迫使 PATCH-5 回 4-dev,再补 `_TxDB` 显式建模事务才修复。

---

## 四、多维根因分析

### 维度 1 · 上下文架构(最根本)

gantry 假设「工件是唯一上下文来源,对话可丢弃」。
但实操中**架构决策发生在对话里而非工件里**——设计澄清、机制取舍、四分支校验逻辑,都在 12+ 轮对话中收敛。
工件(DESIGN/SPEC)是**事后追记**,不是**决策载体**。于是对话不能丢,压缩成了唯一手段。
**43 次压缩本质是「决策没沉淀到工件」的症状。** R1.3「引用历史决策用 @文件路径」无法执行,因为决策不在文件里。

### 维度 2 · 流程刚性 vs 现实弹性的错配

状态机是线性 8 阶段,adjust 是唯一逃生阀。
当真实需求是「一个 change 里 3 个准独立子特性(涨价/折扣/解约)+ 架构中途重构」时,
单线性状态机 + 单 open patch 表达不了,只能靠 7 个 PATCH 塞进一个 change。
→ **根因:缺少 change 拆分/子 change 机制,adjust 被迫承担架构级变更。**

### 维度 3 · 验证纪律的执行落差

R5.2 是规则,但没有**机制**强制「测试从 AC 派生、Fake 必须建模失败语义」。
T19 假绿说明:TDD 里的 Fake(`_FakeDB`)默认不建模事务回卷,写测试者自然写出「失败排首 + 不撤销」的乐观 Fake。
→ 规则靠自觉,缺少「对资损/事务类逻辑强制注入对抗性 Fake」的检查点。

### 维度 4 · 自主模式(auto)的成本收益倒挂

`/gantry-auto` 在高不确定性(架构未定、PATCH 回环)阶段被反复调用,每次都因人工关卡/冲突中断,却已消耗一次压缩。
→ **auto 适合低不确定性的机械推进,不适合设计仍在收敛的阶段**,
但流程没有「不确定性闸门」阻止在设计动荡期进入 auto。

### 维度 5 · 状态可观测性

STATE.md 是人写的单点快照,不反映「多 PATCH × 阶段回退」的真实拓扑,也不记录压缩次数/token(字段全 `—`)。
→ R1.1 的清窗触发判据没有数据支撑。

---

## 五、证据出处

- 会话文件:`~/.claude/projects/-Users-mjk-workspace-bilibili-src-git-bilibili-co-ott-ai-tool/84d39b63-*.jsonl`
- 工件:`ott/ai-tool/.gantry/specs/membership-price-credit-discount/`
  (PATCH.md 41KB / TASKS.md 67KB / DESIGN.md 28KB / REVIEW.md 33KB)
- 压缩计数、PATCH 演进、报错清单均由脚本从 JSONL 抽取(见分析会话 620ee04b)。
