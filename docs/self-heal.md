# Gantry 任务修复与失败接力

Ralph task-cycle 自动持久化预约、候选和失败事实。`gantry heal` 保留人工可读诊断入口；它不预约模型调用，不修改验收 contract，也不是预算真值。

## 一次失败如何进入下一轮

1. 首次预约编号0，固定任务前基线和验收；fresh executor 返回候选。
2. 控制器真实运行 verify/checks。失败写入 execution/<task>.json，报告通过 EXECUTION/PROGRESS 交接。
3. 可修复时先持久化 repairsUsed=1，再启动新的 fresh executor。修复2/3相同，重启、换客户端、修改诊断不返还额度。
4. 第三次修复成功仍可完成；第三次修复返回失败后耗尽，禁止第四次修复、整段DEV重派或转主上下文清零。

明确的429/连接中断等传输故障可以在同一预约内最多额外重试三次（1/2/4秒），不增加业务修复序号；未知非零不能这样重试。传输失败可能留下有用代码，因此仍先验证候选。receipt有效时不再调用模型。

## 手动诊断和查询

```bash
gantry heal T02 --reason "舍入边界断言失败" \
  --command "node --test tests/money.test.mjs" \
  --stderr "expected 1.01 got 1.00"
gantry heal --check T02
```

手动记录追加到 `EXECUTION.md` 的 `## Self-Heal Log`，保留 at/reason/command/stderr；reason单行截200字符，stderr限8KB。记录次数不等于已启动修复次数。

| 存储事实 | heal --check 行为 |
|---|---|
| 新TaskRecord存在，修复0/1/2 | 依据持久额度查询，允许剩余尝试 |
| 修复3已预约/运行中 | 不提前判耗尽，该次仍可成功 |
| 修复3已返回且验证失败 | blocked，保留诊断与预算 |
| 无新记录的历史任务 | 沿用保守旧日志阈值，提示审阅迁移；不自动按零额度重开 |
| 损坏或未知版本记录 | blocked，不覆盖、不归零 |

熔断写 fence.lastStageResult.blockedReason 时不覆盖已有非空原因。清除fence只处理阻塞标志，不重置 repairsUsed、预约和历史；不得凭清fence重开第四次修复。

## 恢复

先确认旧受控执行已退出且后代已清理，再运行 `gantry done <task> --json` 重验现有候选。receipt → EXECUTION → TASKS任一落盘窗口中断都可幂等补齐。旧锁归属不明时停止核对，不按PID猜测删除或盲杀。旧任务没有真实任务前基线时，审阅范围和历史预算后再迁移，不静默以当前候选作为初始基线。

需求、AC、范围变化走 adjust/PATCH；代码修复走 task-cycle，二者不能互相替代。验收弱化误报需审阅具体变更并重验，不能全局关闭红灯规则。当前机械检查无法证明所有测试语义，REVIEW仍核实关键断言和TDD报告。

## Integration AC 覆盖门禁

integration 的 `checkAcCoverage` 仍检查 SPEC AC 编号是否映射到 `.gantry/loop/test-commands.yml` 的 cmd/covers。SPEC有AC而映射缺失、为空、漏覆盖或语法错误时阻塞；SPEC无AC才可跳过。`gantry install` 只铺注释模板，不覆盖已有文件。

covers 是覆盖映射，不证明命令已运行。真实执行结果由TEST及任务receipt提供。补齐真实检查与covers后再advance；不要删除covers或弱化SPEC来隐藏缺口。独立 `ac-gate` CLI 已折叠到门禁，不再作为命令。
