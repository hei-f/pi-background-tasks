---
doc_id: tools/bash
audience: agent
mode: mixed
review_policy: behavioral
stability: stable
covers_surfaces: [tool:bash]
covers_sources: [src/bash-override.ts]
---

# `bash`(覆盖版)

<!-- pi-docs:begin name="tool-contract-bash" generator="scripts/docs/generate.mjs" -->
- Label: **bash**
- Source: `src/extension.ts:824`
- Availability: `always`
- Available by default: **yes**
- Description: Execute a bash command in the current working directory (identical to the built-in bash tool). Returns stdout and stderr; output is truncated to a bounded tail and the full output path is included when truncated. Optionally provide a timeout in seconds. Set run_in_background:true to detach the command as a durable background task instead: the call returns immediately with a task id and output path; default completion delivery sends <background-task-notification> and starts a follow-up agent turn.
- Root schema: `object`

| Field | Required | Type | Description | Constraints |
| --- | --- | --- | --- | --- |
| `command` | yes | `string` | Shell command to execute |  |
| `run_in_background` | no | `boolean` | Optional. Set true to detach this command into the durable background task stack: the call returns immediately with a task id and output path, and terminal state is delivered automatically as <background-task-notification> which also starts a follow-up agent turn. In background mode timeout is a hard-kill deadline in seconds after which the task is force-terminated (0 or omitted = no deadline); foreground timeout semantics are unchanged. Omit or set false for normal foreground execution identical to the built-in bash tool. |  |
| `task_name` | no | `string` | Optional explicit task name shown in the dock, /bg-jobs, the startup receipt, and the completion notification (max 200 characters). Omitted names fall back to the full command. |  |
| `timeout` | no | `number` | Timeout in seconds (optional, no default timeout) |  |

<details>
<summary>Normalized TypeBox contract</summary>


```json
{
  "properties": {
    "command": {
      "description": "Shell command to execute",
      "type": "string"
    },
    "run_in_background": {
      "description": "Optional. Set true to detach this command into the durable background task stack: the call returns immediately with a task id and output path, and terminal state is delivered automatically as <background-task-notification> which also starts a follow-up agent turn. In background mode timeout is a hard-kill deadline in seconds after which the task is force-terminated (0 or omitted = no deadline); foreground timeout semantics are unchanged. Omit or set false for normal foreground execution identical to the built-in bash tool.",
      "type": "boolean"
    },
    "task_name": {
      "description": "Optional explicit task name shown in the dock, /bg-jobs, the startup receipt, and the completion notification (max 200 characters). Omitted names fall back to the full command.",
      "maxLength": 200,
      "type": "string"
    },
    "timeout": {
      "description": "Timeout in seconds (optional, no default timeout)",
      "type": "number"
    }
  },
  "required": [
    "command"
  ],
  "type": "object"
}
```

</details>
<!-- pi-docs:end name="tool-contract-bash" -->

M4 形态落地:本插件直接注册同名小写 `bash` 工具,按工具名命中宿主工具注册表的
Map 同名覆盖(`toolRegistry.set(tool.name, tool)`),替换宿主内置 bash 工具。独立
的 `bg_run` 工具随之退役,不再注册。本页同时是 `bg_run` 退役后的覆盖版说明。
底层分流实现与宿主复用评审见 `src/bash-override.ts`。

## Schema 与兼容性

原宿主 bash schema 的 `command`、`timeout` 字段语义与 constrained sampling 保持
不变,仅新增可选的 `run_in_background:boolean` 与 `task_name:string` 字段。旧调用方
不带这些字段即可,无任何兼容性改动。

## 前台路径(缺省/`run_in_background:false`)

100% 复用宿主公开 `createLocalBashOperations` 的执行路径:参数透传与宿主原生
内置 bash 逐行等价,含 stdin 传输、detached 组语义、超时与 128+signal 退出码
约定。无 `bg_run` 时代的命名/`isAgent`/`notifyOnCompletion` 等专有参数;输出
截断与全文落盘行为由宿主路径原样承担。

S1 P2(自读生效):扩展激活时读取宿主**用户级** `settings.json` 的
`shellPath`/`shellCommandPrefix`,前台经宿主 `createBashToolDefinition`
第二参注入(与宿主 runner 逐行对齐),后台 `shellPath` 进入 shell 解析链、
`commandPrefix` 以 `<prefix>\n<command>` 前置。文件缺失/解析失败/字段无效
静默降级为宿主缺省(仅读用户级 settings;项目级合并不在读取面)。

## 后台路径(`run_in_background:true`)

命令进入插件持久化后台任务栈(`registry.startTask`),返回 task id 与输出路径。
完成通知默认 notify+trigger(M2 入口语义断言:模型入口缺省唤醒后续轮次),因此
不应 sleep 或轮询等待。

- **`timeout` 语义(P7)**:后台模式下 `timeout` 为强杀截止秒数——`0`/缺省 =
  不限时(不装定时器);`> 0` → `timeoutSeconds` 到点强杀为 `timed_out`。前台
  `timeout` 语义与宿主内置 bash 完全一致,不变。
- **命名(S7)**:可选 `task_name`(≤200 字符,经 schema 校验;存储归一沿用
  normalizeTaskName 80)显式命名第一优先;缺省时任务名 = **完整 `task.command`
  原样**(不 compactWhitespace、不截断、不剥前缀;4KiB 防病态护栏仅作用于显示面,
  `task.command` 字段保持完整)。显示链统一经 `taskDisplayName`:`name` →
  `description` → 完整 command → id → `Background task`。

与退役的 `bg_run` 差异:覆盖版 schema 不再暴露 `isAgent`/`surviveReload`/
`notifyOnCompletion`/`triggerOnCompletion`;显式命名经 `task_name`(非 `bg_run`
时代的 `name`),缺省任务名 = 完整命令原样;`isAgent` 恒为 false(无遥测包装),
后台任务不支持跨 reload 保活。

**通知投递留痕(P8)**:完成通知经宿主 `sendMessage(→ void)` 投递,插件仅能观测
同步接受;同步失败回滚 `notified=false` 并以 warn 留痕,异步失败由宿主
`sendMessage → emitError` 通道留痕(插件无法观测,声明见
[background-task-runtime](../subsystems/background-task-runtime.md))。

## 用户启动入口

用户不通过模型工具启动后台任务:用户入口为 dock「转后台」(列表视图按 `b`,
输入命令后 Enter 提交),以 `entrySource:'user'` 启动、仅通知不唤醒。详见
[Shortcuts and dock](../reference/shortcuts-and-dock.md)。

## Errors

- 缺失/非对象参数由宿主 schema 校验拒绝。
- 空命令:后台路径 `Background command is empty`。
- 直执行接口 `argv` 与 `surviveReload` 组合被拒为
  `pi_bg_survive_reload_requires_shell_command`(直执行无 shell 中介)。
- 外壳/超时/输出上限/ENOSPC 失败沿用注册表既有失败路径。

## Runtime artifacts

后台路径创建 `<agent-dir>/tasks/<session-id>-<pid>/<task-id>.output` 与 `.json`(`getAgentDir()`,缺省 `~/.pi/agent/tasks/`,与宿主 sessions 同级;旧项目内 `.pi/tasks` 不迁移,可手动清理);
任务为 `isAgent:false` 普通 shell 任务,快照携带实际 shell policy,不写遥测
包装器。

## Related docs

- [Shortcuts and dock](../reference/shortcuts-and-dock.md)
- [`bg_status`](bg_status.md)
- [`bg_logs`](bg_logs.md)
- [`bg_kill`](bg_kill.md)
- [Background task runtime](../subsystems/background-task-runtime.md)

## Source ownership/reference

前台执行复用宿主发布面 `createBashToolDefinition`(`@earendil-works/pi-coding-agent`);
分流实现位于 `src/bash-override.ts`;后台栈由
[background-task-runtime](../subsystems/background-task-runtime.md) 负责。
