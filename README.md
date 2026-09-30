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

Expected: returns immediately with a task id, PID when available, and `.pi/tasks/...output`. Foreground calls (no `run_in_background`) behave exactly like the host built-in bash. The command runs as an ordinary local shell command with your user permissions; it can invoke networked tools or paid services if the command itself does so.

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

- Runtime task files live under `.pi/tasks/<session-id>-<pid>/`.- Shell jobs are tracked by the package, but they are not sandboxed. Treat commands as local processes with your permissions and credentials.
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
