# TASKS: <change 标题>

- **Change ID**: <id>
- **关联**: `@.gantry/specs/<id>/SPEC.md`、`@.gantry/specs/<id>/DESIGN.md`

---

## 波次划分

```text
Wave 1 (parallel): T01[P], T02[P]
Wave 2: T03
```

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
  <verify>
    <一条可执行验证命令>
  </verify>
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
