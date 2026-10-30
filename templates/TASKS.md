# TASKS: <change 标题>

- **Change ID**: <id>
- **关联**: `@.gantry/specs/<id>/SPEC.md`、`@.gantry/specs/<id>/DESIGN.md`

---

## 波次划分

```text
Wave 1 (parallel): T01[P], T02[P]
Wave 2: T03
```

共享工作区首版按 TASKS 顺序选择依赖证据有效的 ready task，wave / `[P]` 仅表示依赖与冲突视图。每次预约一个 fresh executor；完成状态由控制器独立验收写入，DEV 末统一提交。

## 任务清单

```xml
<task id="T01" parallel="true" status="pending">
  <name><一句话任务名></name>
  <read_files>
    <参考边界>
  </read_files>
  <write_files>
    <修改边界>
  </write_files>
  <action>
    <做什么。写意图，不写代码。>
  </action>
  <!-- 可选：preflight 仅探测环境就绪，不执行预期 RED 的行为测试 -->
  <preflight>
  </preflight>
  <verify>
    <证明当前 task 完成的最小、直接、可重复命令；自包含工作目录、环境与 runner>
  </verify>
  <!-- 可选：checks 为必须的类型/Lint 等检查，每行一个完整命令 -->
  <checks>
  </checks>
  <done>
    <完成判定>
  </done>
  <depends_on></depends_on>
</task>
```

## 阻塞日志

| 任务 | 阻塞原因 | 待人工决策项 | 时间 |
|---|---|---|---|
|  |  |  |  |

## Fix 任务（来自 REVIEW / INTEGRATION）

```xml
<!-- 占位 -->
```

## DEV 组合检查

跨任务必跑命令配置在 `.gantry/planning/config.json` 的 `ralph.checkpointCommands` 数组。未额外配置时控制器仍重验任务 verify/checks；未知 runner 测试数记录为 null，不能声称已执行零个或全部用例。

## 共用验证归属

任务按独立验收价值切分，不按固定分钟数拆碎；同目标且共用验收的小改动优先合并。每个 task 保留 focused verify，change 级全量回归、部署、远程 smoke 与 Journey 统一归 TEST / INTEGRATION，具体命令与环境填入 TEST.md 的范围声明。不要按 task / wave 重复部署或运行相同全套检查。

`write_files` 是计划修改路径和自动提交归属参考，不是 full DEV 的验收硬门禁；额外文件记录到 receipt 并显示范围提示，focused verify 仍执行。更新该列表不触发契约阻断。
