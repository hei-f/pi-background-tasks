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
- Source: `src/extension.ts:797`
- Availability: `always`
- Available by default: **yes**
- Description: Execute a bash command in the current working directory (identical to the built-in bash tool). Returns stdout and stderr; output is truncated to a bounded tail and the full output path is included when truncated. Optionally provide a timeout in seconds. Set run_in_background:true to detach the command as a durable background task instead: the call returns immediately with a task id and output path; default completion delivery sends <background-task-notification> and starts a follow-up agent turn.
- Root schema: `object`

| Field | Required | Type | Description | Constraints |
| --- | --- | --- | --- | --- |
| `command` | yes | `string` | Shell command to execute |  |
| `run_in_background` | no | `boolean` | Optional. Set true to detach this command into the durable background task stack: the call returns immediately with a task id and output path, and terminal state is delivered automatically as <background-task-notification> which also starts a follow-up agent turn. Omit or set false for normal foreground execution identical to the built-in bash tool. |  |
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
      "description": "Optional. Set true to detach this command into the durable background task stack: the call returns immediately with a task id and output path, and terminal state is delivered automatically as <background-task-notification> which also starts a follow-up agent turn. Omit or set false for normal foreground execution identical to the built-in bash tool.",
      "type": "boolean"
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
不变,仅新增可选的 `run_in_background:boolean` 字段。旧调用方不带该字段即可,
无任何兼容性改动。

## 前台路径(缺省/`run_in_background:false`)

100% 复用宿主公开 `createLocalBashOperations` 的执行路径:参数透传与宿主原生
内置 bash 逐行等价,含 stdin 传输、detached 组语义、超时与 128+signal 退出码
约定。无 `bg_run` 时代的命名/`isAgent`/`notifyOnCompletion` 等专有参数;输出
截断与全文落盘行为由宿主路径原样承担。

已知边界:宿主交互设置里的自定义 shellPath/commandPrefix 对扩展 API 不可见,
覆盖版前台路径使用宿主默认本地 shell 解析,等价宿主缺省配置(用户未在宿主
设置中自定义 shell 时)。

## 后台路径(`run_in_background:true`)

命令进入插件持久化后台任务栈(`registry.startTask`),返回 task id 与输出路径。
完成通知默认 notify+trigger(M2 入口语义断言:模型入口缺省唤醒后续轮次),因此
不应 sleep 或轮询等待。`timeout`(秒)映射为任务 `timeoutSeconds`。

与退役的 `bg_run` 差异:覆盖版 schema 不再暴露 `name`/`isAgent`/
`surviveReload`/`notifyOnCompletion`/`triggerOnCompletion`;任务名由命令派生,
`isAgent` 恒为 false(无遥测包装),后台任务不支持跨 reload 保活。

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

后台路径创建 `.pi/tasks/<session-id>-<pid>/<task-id>.output` 与 `.json`;
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
