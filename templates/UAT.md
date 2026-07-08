# UAT: <change 标题>

> INTEGRATION 阶段产物,位置:`.gantry/specs/<change-id>/UAT.md`
> 记录每条人工验收(UAT)脚本的执行结果。UAT 脚本来自 `TEST.md`。
> 任何失败 → 进入「失败诊断」,产出 `T-FIX-XX` 修复任务回到 `phases/4-dev.md`(R2.6:自动重试 ≤ 3 轮)。

- **Change ID**: <id>
- **关联**: `@.gantry/specs/<id>/SPEC.md`、`@.gantry/specs/<id>/TEST.md`
- **执行时间**: <YYYY-MM-DD>
- **执行人**: <人工验收者>

---

## UAT 结果

| 编号 | 场景 | 关联 AC | 结果 | 问题描述 / 证据 |
|---|---|---|---|---|
| UAT-1 | <一句话场景> | <AC 编号> | ✅ 通过 / ❌ 失败 / ⚠️ 部分 | <失败时填现象 + 复现步骤;通过留空> |
| UAT-2 |  |  |  |  |

> 每条 UAT 对应 TEST.md 里的一个 UAT 脚本。结果三态:通过 / 失败 / 部分通过。

---

## 失败诊断（仅当有 ❌ / ⚠️ 时填）

| 失败 UAT | root cause（非症状） | 修复任务 | 状态 |
|---|---|---|---|
| UAT-N | <定位到的根因> | `T-FIX-01` | pending / done |

> 每个失败必须定位到 root cause,并在 `TASKS.md` 追加 `T-FIX-XX` 任务(含可执行 verify)。
> 重试轮次:<第 N / 3 轮>。第 3 轮仍失败 → 停下,人工决策。

---

## 结论

- [ ] 全部 UAT 通过
- [ ] 有失败,已产出 fix-plan,回到 DEV
- [ ] 达到重试上限,需人工决策

**验收结论**: <通过可归档 / 打回修复 / 挂起待决策>
