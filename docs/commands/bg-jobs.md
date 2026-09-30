---
doc_id: commands/bg-jobs
audience: user
mode: mixed
review_policy: contract
stability: stable
covers_surfaces: [command:bg-jobs]
covers_sources: []
---

# `/bg-jobs`

<!-- pi-docs:begin name="command-contract-bg-jobs" generator="scripts/docs/generate.mjs" -->
| Command | Availability | Default | Description | Provenance |
| --- | --- | --- | --- | --- |
| `/bg-jobs` | `always` | yes | List running and recent background tasks: /bg-jobs | `src/extension.ts:700` |
<!-- pi-docs:end name="command-contract-bg-jobs" -->

List running and recent background tasks.

## Synopsis

`/bg-jobs`

## When to use

Use `/bg-jobs` for a point-in-time textual snapshot when the interactive task manager is unavailable or unnecessary.

## Defaults

No arguments. It lists all tasks currently retained by this extension runtime: running tasks plus recent finished tasks not pruned from the in-memory registry.

## Lifecycle

Tasks have exactly these statuses: `running`, `completed`, `failed`, `cancelled`, `killed`, and `lost`. Finished tasks are kept as recent history up to the runtime's recent-task retention limit; running tasks are preserved when pruning old finished tasks.

## Examples

```text
/bg-jobs
```

## Output/result

If no tasks exist:

```text
No background tasks in this Pi extension runtime.
```

Otherwise each task line includes status icon, id, status, age, optional exit code, optional pid, task-owned telemetry summaries when reported, display name, optional error, and a following `output: <path>` line.

## Errors

No task-resolution errors; it formats the current registry contents.

## Runtime artifacts

`/bg-jobs` reads in-memory task snapshots. It points at `.pi/tasks/<session-id>-<pid>/<task-id>.output` but does not read output bytes.

## Safety boundaries

Read-only inspection. It does not wait, poll, kill, or modify tasks.

## Related docs

- [`/bg-logs`](bg-logs.md)
- [`/bg-kill`](bg-kill.md)
- [`bg_status`](../tools/bg_status.md)
- [Background task runtime](../subsystems/background-task-runtime.md)

## Source ownership/reference

Surface registration lives in `src/extension.ts`; snapshot formatting is owned by [background-task-runtime](../subsystems/background-task-runtime.md).
