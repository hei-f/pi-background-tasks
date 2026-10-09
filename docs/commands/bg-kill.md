---
doc_id: commands/bg-kill
audience: user
mode: mixed
review_policy: contract
stability: stable
covers_surfaces: [command:bg-kill]
covers_sources: []
---

# `/bg-kill`

<!-- pi-docs:begin name="command-contract-bg-kill" generator="scripts/docs/generate.mjs" -->
| Command | Availability | Default | Description | Provenance |
| --- | --- | --- | --- | --- |
| `/bg-kill` | `always` | yes | Stop a running background task: /bg-kill <id> | `src/extension.ts:777` |
<!-- pi-docs:end name="command-contract-bg-kill" -->

Stop a running background task.

## Synopsis

`/bg-kill <task-id-or-prefix>`

## When to use

Use `/bg-kill` when a tracked background task is no longer needed or is hung. Use [`bg_kill`](../tools/bg_kill.md) for the same operation from an agent tool call.

## Defaults

No defaults beyond task id/prefix resolution. Prefixes must be unambiguous.

## Lifecycle

Only `running` tasks can be killed. A successful user kill is recorded with stop initiator `user` and sets terminal status `cancelled`, keeping the task output path available. Trying to kill a terminal (`completed`, `failed`, `cancelled`, `killed`, or `lost`) task fails loudly. The [`bg_kill`](../tools/bg_kill.md) tool performs the same operation with initiator `model`.

## Examples

```text
/bg-kill b12345678
/bg-kill b1234
```

## Output/result

```text
Killed <task-name> (<task-id>). Output: <agent-dir>/tasks/.../<task-id>.output
```

## Errors

- Missing id: `Task ID is required`.
- Unknown id/prefix: `Unknown background task ID: <id>`.
- Ambiguous prefix: lists matching task ids.
- Non-running task: `Task <id> is <status>, not running`.
- Kill failure: platform-specific loud error.

Errors are shown as `Background kill error: ...`.

## Runtime artifacts

The task's output file and metadata remain in `<agent-dir>/tasks/...` (`~/.pi/agent/tasks/` by default). Termination notices and errors may be appended to the output and metadata.

## Safety boundaries

Process termination differs by platform:

- POSIX first targets the detached process group with `SIGTERM`, falls back to the child handle, and escalates to a group `SIGKILL` after the grace window. Mid-grace a time-boxed `ps` scan collects surviving descendants and each is `SIGKILL`ed individually as a net for escaped grandchildren. If the stop window expires without proof, the plugin releases its output read ends so an orphaned pipe writer cannot keep the host alive, then reports a loud failure.
- Windows uses `taskkill.exe /PID <pid> /T`, then `/F` after the grace window. Force failure is surfaced loudly because descendant processes may have leaked.

Shell commands are not sandboxed; killing controls only tracked process handles/trees.

## Related docs

- [`bg_kill`](../tools/bg_kill.md)
- [`/bg-jobs`](bg-jobs.md)
- [`/bg-logs`](bg-logs.md)
- [Background task runtime](../subsystems/background-task-runtime.md)

## Source ownership/reference

Surface registration lives in `src/extension.ts`; process termination is owned by [background-task-runtime](../subsystems/background-task-runtime.md).
