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
  <!-- 简单直调可选；复杂 Shell/远程环境必须声明 preflight；仅探测环境就绪，不执行预期 RED 的行为测试 -->
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

编码预约前只探测 verify/checks 中可识别的字面 runner（含简单 && / ; / | 链及文件重定向），不预跑目标行为测试。复杂 Shell（动态命令、命令替换、控制结构、切换目录/环境等）必须在 preflight 明确探测实际 runner、目录及环境；数据库/远程服务也须声明就绪探针。缺失时先安装 runner、修复 PATH/本地执行权限或补充探针，再预约。包脚本、解释器导入等传递依赖不会被自动发现，任务规划必须逐项确认；合法 RED 应交给执行者编码。

跨任务必跑命令配置在 `.gantry/planning/config.json` 的 `ralph.checkpointCommands` 数组。未额外配置时控制器仍重验任务 verify/checks；未知 runner 测试数记录为 null，不能声称已执行零个或全部用例。
