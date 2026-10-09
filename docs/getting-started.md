---
doc_id: getting-started
audience: user
mode: authored
review_policy: contract
stability: stable
covers_surfaces: []
covers_sources: []
---

# Getting started

This guide gets from install to useful background work in a few minutes.

## 1. Install

```bash
pi install npm:pi-background-tasks@latest
```

For a project-local install:

```bash
pi install npm:pi-background-tasks@latest -l
```

For current repository state rather than a release tag:

```bash
pi install git:github.com/ismailsaleekh/pi-background-tasks@main
```

For a local checkout/package path:

```bash
pi install .
pi install . -l
```

## SDK embedding requirement

**Initialized-host contract:** package resources that require post-bind initialization are available in normal Pi TUI, RPC, print, and JSON modes. An SDK embedder must call `bindExtensions()` with at least one counted binding for lifecycle restoration—such as `onError`, UI/command actions, or shutdown handling—so `session_start` is emitted again by `reload()`. If the embedder uses an empty or mode-only binding, it must explicitly call `bindExtensions()` again after every reload.

Bare `createAgentSession()` does not emit `session_start`; `{}` or `{ mode: "print" }` binds once but does not make a later reload emit it. Post-bind resources such as session-context EventBus readiness are therefore unavailable on those bare/reloaded paths until an explicit bind. This is a current public Pi SDK blocker, not supported package behavior. The generated availability tables describe this initialized-host contract; they are not a pre-bind availability guarantee.

## 2. Start a background shell task

When Pi itself should start a long command, use the covered `bash` tool with `run_in_background:true`:

```json
{
  "command": "npm run typecheck",
  "run_in_background": true
}
```

The covered `bash` background path returns a task id and output path, writes output under the host-private agent dir (`<agent-dir>/tasks/...`, e.g. `~/.pi/agent/tasks/...`), and defaults the model entry to `notifyOnCompletion:true` and `triggerOnCompletion:true`, so Pi should not sleep or poll merely to wait. The terminal notification is the wake-up path. The command is still an ordinary local shell command; the package tracks it but does not sandbox it.

## 3. Observe completion

Use the footer dock or commands:

```text
/bg-jobs
/bg-logs <task id> 20000
```

Press the configured dock key (**Shift↓** by default, or **Ctrl+Alt+B**) when the `bg ...` footer appears. With `PI_BG_DOCK_SHORTCUT=off`, use `/bg-jobs` for the textual snapshot. `/bg-clear` acknowledges finished-task footer notices.

## Next links

- [Choose a workflow](choose-a-workflow.md)
- [Configuration](operations/configuration.md)
- [README landing page](../README.md)
