<div align="center">
  <img src="logo.png" alt="pi-background-tasks logo: a futuristic dispatcher coordinating parallel work nodes into a completed result" width="144" height="144">

# pi-background-tasks

**Keep Pi moving while long jobs run in the background.**

[![npm](https://img.shields.io/npm/v/pi-background-tasks?label=npm)](https://www.npmjs.com/package/pi-background-tasks)
[![Pi extension](https://img.shields.io/badge/Pi-extension-19c7d4)](https://github.com/earendil-works/pi-coding-agent)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19-1f8f4d)](package.json)
[![License](https://img.shields.io/badge/license-ISC-f5a623)](LICENSE)

</div>

`pi-background-tasks` adds durable background shell jobs and a correlated EventBus service for Pi:

- **Run long work without blocking**: start named shell jobs, keep talking to Pi, and get durable completion notifications when they finish.
- **Correlate through EventBus**: other Pi extensions can start, inspect, and stop the same tasks through the public request/response/terminal channels instead of shelling out or maintaining a second manager.

<p align="center">
  <img src="docs/assets/architecture.svg" alt="Architecture diagram showing Pi session, background task registry, and the shell-command task flow" width="760">
</p>

<!-- pi-docs:begin name="readme-package-facts" generator="scripts/docs/generate.mjs" -->
| Fact | Value |
| --- | --- |
| Package | `pi-background-tasks` |
| Version | `2.6.8` |
| Node engine | `>=22.19.0` |
| Pi entrypoints | `./dist/extensions/background-tasks.js` |
| Package image | [logo.png](https://raw.githubusercontent.com/ismailsaleekh/pi-background-tasks/main/logo.png) |
<!-- pi-docs:end name="readme-package-facts" -->

<!-- pi-docs:begin name="readme-public-surfaces" generator="scripts/docs/generate.mjs" -->
| Surface kind | Configured variants | Available by default |
| --- | --- | --- |
| command | 4 | 4 |
| tool | 4 | 4 |
| shortcut | 3 | 2 |
| renderer | 1 | 1 |
| eventbus | 1 | 1 |
| workflow | 0 | 0 |

Public commands: `/bg-clear`, `/bg-jobs`, `/bg-kill`, `/bg-logs`.

Public tools: `bash`, `bg_kill`, `bg_logs`, `bg_status`.

### Configuration-dependent surfaces

| Surface | Availability | Default |
| --- | --- | --- |
| `shortcut:ctrl+alt+b` | `dock:ctrl+alt+b` | no |
| `shortcut:shift+down` | `dock:shift+down` | yes |

Full owner map and generated contracts live in [docs/INDEX.md](docs/INDEX.md).
<!-- pi-docs:end name="readme-public-surfaces" -->

“Available by default” means after Pi has initialized extensions. Normal TUI/RPC/print/JSON modes do this; SDK embedders must provide a counted `bindExtensions()` binding and ensure post-reload binding. Bare `createAgentSession()` and empty/mode-only reload are blocked by the current public host lifecycle API. See [Getting started](docs/getting-started.md#sdk-embedding-requirement).

## Why use it?

| You want to...                                                    | Use this package because...                                                                                                                                                                                                  |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start a dev server, watch build, migration dry run, or long check | covered `bash` with `run_in_background:true` returns immediately, writes durable output files, shows a footer dock, and notifies on terminal state.                                                                           |
| Let Pi keep working instead of sleeping or polling                | Default model-entry completion delivery sends a durable terminal notification and can wake a follow-up turn.                                                                                                                |

## Install

Version information comes from [`package.json`](package.json). Use npm `@latest` for normal installs; use git `main` only when you intentionally want the current repository state.

```bash
# Global install from npm
pi install npm:pi-background-tasks@latest

# Project-local install from npm
pi install npm:pi-background-tasks@latest -l

# Git main branch; not a release tag
pi install git:github.com/ismailsaleekh/pi-background-tasks@main

# Project-local git main install
pi install git:github.com/ismailsaleekh/pi-background-tasks@main -l

# Local checkout/package path, run from this package directory
pi install .
pi install . -l
```

Local paths are loaded from disk without copying; use the path to this package from your current directory.

## Quick start: useful in under five minutes

1. Install and start Pi in a project.
2. Launch a background command through covered `bash` with `run_in_background:true`:

   ```json
   {
     "command": "npm run typecheck -- --watch",
     "run_in_background": true
   }
   ```

   The covered `bash` starts a tracked shell task and returns the task id plus output path. Model-launched `run_in_background:true` tasks notify and can wake a follow-up turn. Users start background tasks through the dock「转后台」entry instead of a model tool.

3. Open the footer dock with the default **Shift↓** binding or list tasks:

   ```text
   /bg-jobs
   ```

4. Read bounded output only when you need it:

   ```text
   /bg-logs b12ab34c 20000
   ```

More walkthrough detail: [Getting started](docs/getting-started.md).

## Select the dock shortcut and avoid conflicts

```bash
PI_BG_DOCK_SHORTCUT=ctrl+alt+b pi  # avoid a Shift+Down owner
PI_BG_DOCK_SHORTCUT=off pi         # use /bg-jobs for the textual snapshot
```

Accepted values are exactly `shift+down` (default), `ctrl+alt+b`, and `off`. Invalid settings fail startup with `pi_bg_config_invalid`; they do not silently restore defaults. The background-task capability is always available and is never trimmed by environment flags. These flags select the dock key only.

Full contract: [Configuration](docs/operations/configuration.md) and [Shortcuts and dock](docs/reference/shortcuts-and-dock.md).

## Pick the right workflow

| Workflow                    | Blocking? | Context                                  | Tools/network/write boundary               | Best for                                                      | Expected behavior                                                                                                                            |
| --------------------------- | --------: | ---------------------------------------- | ------------------------------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary foreground Pi work |       Yes | Full current session                     | Whatever tools the active session has      | Short reads/edits/commands where you want live back-and-forth | Pi waits for the work before responding.                                                                                                     |
| Covered `bash` `run_in_background:true` |        No | No model child unless command starts one | Runs your shell command; **not sandboxed** | Agent-started long commands                                   | Returns task id/output path; model entry defaults to notification plus automatic follow-up wake. |

See [Choose a workflow](docs/choose-a-workflow.md) for a decision tree and tradeoffs.

## Copy-paste examples

### Covered `bash`: start long shell work

```json
{
  "command": "npm run docs:dev",
  "timeout": 3600,
  "run_in_background": true
}
```

Expected: returns immediately with a task id, PID when available, and `<agent-dir>/tasks/...output` (the host-private agent dir, e.g. `~/.pi/agent/tasks/...`). Foreground calls (no `run_in_background`) behave exactly like the host built-in bash. The command runs as an ordinary local shell command with your user permissions; it can invoke networked tools or paid services if the command itself does so.

## Shell selection and host settings

后台 POSIX shell 解析链(P1 同源化,与宿主前台行为对齐):

1. `PI_BG_POSIX_SHELL=bash|sh`(+可选 `PI_BG_POSIX_SHELL_PATH`)显式选择;
2. 宿主用户级 `settings.json` 的 `shellPath`(已应用宿主同款归一化,含 `~` 展开);
3. 宿主前台 `getShellConfig()` 解析结果(缺省:macOS/Linux 为 `/bin/bash` 或 PATH 上的 bash,兜底 `sh`);
4. `$SHELL` 环境变量;
5. `/bin/sh`。

读取失败(settings.json 缺失/解析失败/`shellPath` 指向不存在的文件)或 Windows 上找不到
bash 时**静默降级**到 `$SHELL` 兜底,插件照常激活,不告警。**仅读用户级 settings**
(`~/.pi/agent/settings.json`);宿主项目级 settings 合并不在本插件读取面。

`settings.json` 的 `shellCommandPrefix` 前置到前台与后台命令(`<prefix>\n<command>`换行拼接,与宿主前台逐行对齐);`shellPath` 对前台经宿主 `createBashToolDefinition`
第二参生效,对后台进入上述解析链。

平台边界:Windows 上后台不走该链(`PI_BG_POSIX_SHELL` 系列在 Windows 被忽略,
后台 Win32 分支不消费 `settings.shellPath`),前台仍按宿主 behavior 生效——前后台
Win32 不对称;实测环境为 macOS。

后台 `timeout` 语义:0 或缺省 = 不限时;`> 0` = 该秒数后强杀截止。前台 timeout 语义
与宿主内置 bash 完全一致,不变。(ZCode 对照:ZCode 后台化强制 `timeoutMs: 0` 结构上
永不超时、无任务级准入超时;本插件保留 P7 强杀语义,判别已对齐——用户/模型停止 →
`cancelled`,超时到期 → `failed`+`timed_out`。)

命名(S7):覆盖版 bash 支持可选 `task_name`(≤200 字符,存储归一 80 字符);显式
`task_name` 第一优先,缺省时任务名 = **完整 `task.command` 原样**(4KiB 防病态护栏
仅作用于显示面,`task.command` 字段保持完整)。

通知投递(P3 合并):终态通知先入批队列,由微任务排水把同一排水段的任务合成**一条**
消息(完整 `<background-task-notification>` 块空行拼接,单条格式逐字节不变),以
`deliverAs:'steer'` 发送——宿主 streaming 时注入**当前轮**下一次模型请求(模型同轮
实时看到,不新开轮),空闲时触发新轮;批内任一任务触发唤醒 → 整批唤醒。无时间窗口,
生产终态路径通常跨 macrotask 到达,批大小常为 1;收敛口径为「N 终态 ≤ 1 轮通知 turn」
(实证,非结构性保证)。steer 通道依赖宿主 ≥0.84;更早宿主(0.81-0.83,peer 范围仍允许)
**未核验**,预期回退 follow-up 投递、P3 不收敛但功能不坏。

通知投递留痕(P8 声明):宿主 `sendMessage` 返回 `void`,异步投递失败对插件不可见;
异步失败经**宿主 bindCore `sendMessage → emitError` 通道留痕**(宿主既有机制,插件不
假装知情)。批排水同步失败可观测:回滚**该批全部** `notified=false`,单处 warn 留痕
(不重抛、不重试,单次丢失与批前语义等价)。

准入注记:启动门固定 30 秒防御超时保留现状(插件不排队,gate 仅兜底病态卡死;
ZCode 无准入超时——其并发准入 FIFO 排队不计时)。

## Footer dock

<p align="center">
  <img src="docs/assets/footer-dock.svg" alt="Illustration of the pi-background-tasks footer dock with running and completed tasks" width="760">
</p>

When tasks are running or unseen completions exist, the footer shows a compact `bg ...` segment. Press the configured **Shift↓** (default) or **Ctrl+Alt+B** binding to open the focused bottom dock, or use `/bg-jobs` when the key is off. Use `/bg-clear` to acknowledge finished-task footer notices in any terminal.

| Control                                           | Action                                  |
| ------------------------------------------------- | --------------------------------------- |
| configured `Shift↓` / `Ctrl+Alt+B`, or `/bg-jobs` | Open the dock or list tasks             |
| `/bg-clear`                                       | Clear finished-task notices             |
| `↑` / `↓`, `PageUp` / `PageDown`                  | Move through list or scroll output tail |
| `Enter` / `→`                                     | Inspect details                         |
| `←`                                               | Return to list                          |
| `k`                                               | Stop selected running task              |
| `R`                                               | Rerun selected command                  |
| `b`                                               | Start a background command (「转后台」): type a command, Enter submits, Esc cancels |
| `c`                                               | Show copyable output path               |
| `x` / `Esc` / `q`                                 | Close dock                              |

The dock「转后台」entry is the user-facing way to start background tasks; it notifies on terminal state without waking a follow-up turn. Tasks launched by the model through covered `bash` `run_in_background:true` default to notify plus wake. Task-owned model/context/token/tool telemetry exists only for telemetry-wrapped agent tasks; missing telemetry is shown as unavailable, not synthesized as zero.

## Architecture, trust, and safety

- Runtime task files live under `<agent-dir>/tasks/<session-id>-<pid>/` (`getAgentDir()` defaults to `~/.pi/agent/`, the host-private agent dir; old project-local `.pi/tasks` directories are not migrated and can be removed manually).- Shell jobs are tracked by the package, but they are not sandboxed. Treat commands as local processes with your permissions and credentials.
- Metadata and configuration replacements use write/fsync/rename durability patterns. Ordinary task output is closed and drained before terminal publication but is not explicitly fsynced. POSIX directory entries are fsynced after atomic replacement; Windows lacks the same portable directory-entry crash-durability guarantee.
- Reload persistence keeps an opted ordinary execution alive across a real same-process `/reload`; it never adopts PIDs or copies task JSON, and a hard crash/restart is not a survival path. After the `bg_run` retirement (M4), only dock rerun of an already-opted task preserves the flag; new launches via covered `bash` do not expose it.

Detailed operations: [Configuration](docs/operations/configuration.md).

## EventBus and Autopilot integration

Other Pi extensions can control the same `BackgroundTaskRegistry` through Pi's `events` bus instead of shelling out or maintaining a second task manager. The public channels are:

| Purpose             | Channel                           |
| ------------------- | --------------------------------- |
| Request             | `pi-background-tasks:request:v1`  |
| Response            | `pi-background-tasks:response:v1` |
| Terminal task event | `pi-background-tasks:terminal:v1` |

Operations are `capabilities`, `run`, `status`, `logs`, and `kill`. This is the integration point for orchestrators such as Autopilot that need non-blocking package-managed work with bounded logs and correlated terminal events. Terminal frames additively carry status, failure reason, stop initiator, a fixed bash-source `originMeta`, a bounded ≤64 KiB completion tail, and the task-owned usage snapshot (`durationMs`/`modelUsage`/`toolUseCount`/`totalTokens`); newer terminal status values degrade as failed/killed on older consumers. Consumers must deduplicate terminal frames by `task.id`: an EventBus listener failure can cause a retried publication.

## Documentation map

| Need                                                         | Read                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| First install and first task                                 | [Getting started](docs/getting-started.md)                              |
| Which workflow/tool to choose                                | [Choose a workflow](docs/choose-a-workflow.md)                          |
| Environment variables, shells, output caps, offline behavior | [Configuration](docs/operations/configuration.md)                       |
| Package QA expectations                                      | [TESTING.md](TESTING.md) and [TEST_PLAN.md](TEST_PLAN.md)               |
| Publishing notes                                             | [PUBLISHING.md](PUBLISHING.md)                                          |
| License and derived-rule notice                              | [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |

## Contributing

Keep user-facing claims tied to source. If you change public schemas, command behavior, durability, model routing, or environment variables, update these package-local docs in the same change and run focused checks appropriate to the edit.

For startup work, use `scripts/benchmark-cold-load.mjs` with an owned output/scratch root, explicit `--runtime source|compiled`, and at least 30 fresh-process samples; the exact command and interpretation rules are in [Testing operations](docs/operations/testing.md#cold-load-measurement-discipline). Its “cold” result means an empty JavaScript/Jiti module cache, not a flushed filesystem cache. It is distribution evidence, not a flaky CI threshold. The published Pi entrypoint uses precompiled JavaScript; `dist/src/**` contains private implementation chunks and is not a set of standalone Node entrypoints. Native-Windows and vendor compiled-Bun timing still require their own evidence.
