# JOURNEY-VERIFY: <change 标题>

> INTEGRATION 阶段产物,位置:`.gantry/specs/<change-id>/JOURNEY-VERIFY.md`
> 跨服务用户路径的端到端总验收账本。**仅当 SPEC「关键用户路径」定义了跨服务 Journey 时产出**;单服务变更不建此文件,在 UAT.md 写明「无跨服务路径」即可。
> 断点归属的**唯一事实源**:`SPEC.md` 的路径成功判据 + `DESIGN.md §2.1` 的服务序列。

- **Change ID**: <id>
- **关联**: `@.gantry/specs/<id>/SPEC.md`(路径成功判据)、`@.gantry/specs/<id>/DESIGN.md`(§2.1 服务序列)
- **执行时间**: <YYYY-MM-DD>
- **协调者**: Integrator (Coordinator)

---

## 路径验收总览

| Journey | 涉及服务 | 端到端结果 | 断点 | 最终状态 |
|---|---|---|---|---|
| J1 · <短标题> | order/stock/pay/notify | ✅ 通过 / ❌ 断 / ⚠️ 部分 | <断在哪一环,如 pay.Charge 超时> | 通过 / 修复中 / 挂起 |
| J2 |  |  |  |  |

---

## 逐条 Journey 详情

### J1 · <短标题>

- **成功判据**(来自 SPEC): <用户可观察的最终成功状态>
- **服务序列**(来自 DESIGN §2.1): `order.CreateOrder → stock.Lock → pay.Charge → notify.Send`
- **端到端执行**(贴真实输出):
  ```
  <正常路径 / 失败与补偿 / 超时 / 部分成功回滚 的实际运行输出>
  ```
- **覆盖检查**:
  - [ ] 正常路径
  - [ ] 每一环失败 + 补偿
  - [ ] 超时
  - [ ] 部分成功回滚(无资源悬挂)

---

## 断点归属判定（仅当有 ❌ / ⚠️ 时填）

| # | Journey | 断点(服务+调用) | 分歧 | 判定依据 | 责任方 | 动作 |
|---|---|---|---|---|---|---|
| 1 | J1 | pay.Charge | consumer 未处理 TIMEOUT | DESIGN §2.1 定义超时 3s+补偿 | order-svc | `T-FIX-01` → dev |
| 2 | J1 | stock.Lock | 契约未定义幂等重入 | 路径设计缺陷 | 契约 | 回退 design |

> 判定依据只能是已锁 SPEC/DESIGN,不允许两端各执一词。
> 实现偏离已锁序列/契约 → 责任方回退 `phases/4-dev.md`。
> 路径设计本身缺陷 → 回退 `phases/2-design.md`。
> 成功判据歧义 → 回退 `phases/1-requirement.md`。
> 重试轮次:<第 N / 3 轮>。第 3 轮仍未通过 → 停下,人工决策(R2.6)。

---

## 结论

- [ ] 全部 Journey 端到端通过
- [ ] 有断点,已判定归属 + 产出 fix-plan + 回退对应阶段
- [ ] 断点已修复并重跑通过
- [ ] 达到重试上限,需人工决策

**总验收结论**: <所有关键路径通过,可进 UAT / 打回修复 / 挂起待决策>
