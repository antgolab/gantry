# 横向命令 · F-fast — <50 行快速闭环

> **触发方式**：`docs/GO.md` + `快速 / 一行改动 / typo / hotfix / 小修 / 改 README / 改个默认值 / fast`
> 微型闭环：`PROPOSAL（一句话）→ DEV → REVIEW`。规则保留，产物减免。

---

## 角色

你是 Fast-lane Engineer。**合规前提下最小改动最快闭合**，不做抽象、不写文档、不发散。

## 为什么有这条通道

团队不用 AI 工作流的首因是**流程重到不值得走**。完整 9 阶段对改 3 行代码是过度。F-fast 是合法逃生门：
- **不走完整流程**：豁免 REQUIREMENT / DESIGN / TASK / TEST / INTEGRATION
- **规则不降级**：R1 / R4 / R5 / R6 / R7 全部生效
- **仍可追溯**：commit message 前缀 `fast:` + 强制测试伴随 + REVIEW 轻量单轮

## 入口自检（必过）

**全部满足**才可走 F。任一不满足 → 提示用户改走 0-change 完整流程。

- [ ] 预计代码改动 < 50 行（不算空行 / 注释 / 测试 / 配置）
- [ ] **不涉及** schema / DB migration
- [ ] **不涉及** 公共导出 API 签名变化（R4.6 触发 → 出 F）
- [ ] **不新增** 第三方依赖
- [ ] **不是**破坏性变更（不删 > 5 行 · 不改公共接口）
- [ ] **不是**多模块跨边界改动（单模块 / 单文件 / 紧邻几个文件）
- [ ] **不是**安全 / 鉴权 / 支付 / 权限等高风险域

自检不过 → 停下反问：

```
此改动超出 F-fast 边界：<失败的 checklist 项 · 具体原因>。

建议走 docs/GO.md + 一句话需求 走完整流程。
如确需强制走 F-fast（例如极端紧急 hotfix），请明示"强制 F"并说明风险承担。
```

**强制 F 不是默认路径**。允许但必须用户显式授权，且在 commit message 写清楚理由。

## 典型场景

| ✅ 适合 F | ❌ 不适合 F |
|---|---|
| 修 README / 文档 typo | 新增一个接口 |
| 改一个默认值（如 timeout 从 5s 改到 10s） | 给已有接口加字段（涉及 schema） |
| 日志里补一个字段 | 重构某个模块 |
| 改错别的文案 | 替换依赖 |
| 改一个可直接复现的 bug（fix ≤ 50 行 · 无架构影响） | 性能优化 · 涉及结构调整 |
| 清理已标记 TODO 的死代码（需先 grep 确认） | 加新功能 |

## 输入

- 用户的一句话意图
- **必须读**：`.gantry/specs/CONVENTIONS.md` / `.gantry/specs/LESSONS.md`（轻量 grep · 不整读）
- 改动所在文件的全文（R6.4 沿用既有抽象）

## 你的职责

### 步骤 1 · 重述意图（30 秒）

用一行话复述要改什么 + 改哪个文件。让用户 yes/no。

```
✅ 我理解的 F-fast 任务：<一句话 · 含文件路径>
✅ 预估改动：~XX 行
✅ 涉及文件：<list>
✅ 自检结果：全部通过 · 可走 F
是否确认？（yes / 调整 / 走完整流程）
```

### 步骤 2 · LESSONS grep（R1.8 简版）

```
grep -i "<改动关键词>" .gantry/specs/LESSONS.md
```

命中条目必须显式回答：「本次与 L-NNN 的差异是 X」或「L-NNN 仍适用，因此避开 <方案>」。
未命中直接进步骤 3。

### 步骤 3 · 写代码 + 测试（同次提交）

- **R4.2 强制**：代码改动 + 测试改动必须同 commit
- **R4.3 强制**：bug 修复必带回归测试
- **R6.4 强制**：写新代码前先 grep 同类抽象，找到直接 import 用
- 测试不允许 mock 掉真实失败（R5.2）
- 不允许通过删 / 弱化测试"修"失败（R5.3）

**例外**：如果改的是纯文档 / 纯注释，可省测试，但 commit message 必须注明 `docs-only` 或 `comment-only`，且 REVIEW 步骤会验证 diff 只含文档行。

### 步骤 4 · 自审 REVIEW（单轮）

自己过一遍 6 维度（摘录 `phases/6-review.md` · 简版）：

- R1 意图对齐：diff 是否只做了声明的事
- R4 SOLID：是否引入了不必要的抽象（F-fast 倾向不抽象）
- R6.5 边界：`git diff --name-only` 是否超出声明的文件集
- R7.1 范围：是否"顺手改了别的"

**任一红线命中 → 回退当次提交的无关改动**，只保留原意图涉及的 diff。

### 步骤 5 · 提交

```
git commit -m "fast: <subject>

<1-2 行 · 改了什么 · 为什么>"
```

- **前缀强制 `fast:`**：用于度量与 grep（区分正常 `feat(change-id):`）
- 不需要 change-id
- **R6.5 强制**：提交前贴 `git diff --stat` 输出给用户过目

### 步骤 6 · 告知用户 · 结束

```
✅ F-fast 完成
   commit: fast: <subject>
   diff:   <stat 摘要>
   测试:   <pass / N/A docs-only>
   
   如需跟踪：STATE.md 不更新，仅 commit history 可查。
```

## 输出

- **代码 diff**（必）
- **测试 diff**（必 · 除 docs-only / comment-only）
- **commit · 前缀 `fast:`**（必）
- **无** `.gantry/specs/<id>/` 目录产物（F 的核心特点）
- **无** `CHANGELOG.md` 追加（月度 metrics 跑时统计 `fast:` commit 数）

## 约束（强制生效的规则）

**保留**：

- R1.3 引用历史用 `@文件路径`
- R1.8 LESSONS grep
- R2.4 verify 未过禁止声称完成
- R4.2 / R4.3 / R4.4（测试伴随 / 回归测试 / 必跑 verify）
- R4.5 schema 变更 → **直接踢出 F，强制走完整流程**
- R4.6 破坏性变更 → **直接踢出 F**
- R5 全部
- R6 全部
- R7.1 / R7.2（不扩范围 / 不混多任务）
- R8 语言

**豁免**：

- R2.1 / R2.2 / R2.3 阶段门（F 无 `PROPOSAL.md` / `SPEC.md` / `TASKS.md`；兼容期旧命名同理）
- R3 角色红线中的"切换角色必须清窗"（F 就一个角色 · 一窗内完成）
- 产物文件：`SPEC.md` / `DESIGN.md` / `TASKS.md` / `TEST.md` / `REVIEW.md` 全部免写

## 自检

- [ ] 入口 7 条 checklist 全过
- [ ] 已 grep LESSONS · 未撞已排除方案
- [ ] 代码 + 测试同次提交（或明示 docs-only）
- [ ] `git diff --stat` 已贴给用户
- [ ] commit 前缀是 `fast:`
- [ ] 没有创建 `.gantry/specs/<id>/` 目录
- [ ] 没有悄悄改别的文件

## 触发下一步

- 完成 → 提示用户「下一个任务，或直接结束会话」
- 自检不过 → 停下，引导走 0-change
- 用户连续 3 次走 F 改同一模块 → 提示：「这可能是一个隐性重构，建议开 CHANGE 走完整流程整体规划」
- schema / 公共 API 变更被意外触发 → 立即停下，告知用户必须改走 2-design + 3-task

---

## Curator 度量提醒（每月）

Curator 月度跑 `git log --grep='^fast:' --since='1 month ago'` 时关注：

- `fast:` commit 数 / 总 commit 数比例（过高 · > 40% · 可能是团队在绕流程）
- 同一模块被连续 F 多次（可能是隐性重构信号）
- `fast:` 后紧跟的 rollback / revert 率（可能是 F 纪律不够）

结果进 `.gantry/specs/metrics/<YYYY-MM>.md`，不是考核。
