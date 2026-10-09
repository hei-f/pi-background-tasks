---
doc_id: commands/bg-logs
audience: user
mode: mixed
review_policy: contract
stability: stable
covers_surfaces: [command:bg-logs]
covers_sources: []
---

# `/bg-logs`

<!-- pi-docs:begin name="command-contract-bg-logs" generator="scripts/docs/generate.mjs" -->
| Command | Availability | Default | Description | Provenance |
| --- | --- | --- | --- | --- |
| `/bg-logs` | `always` | yes | Show bounded output from a background task: /bg-logs <id> [maxBytes] | `src/extension.ts:737` |
<!-- pi-docs:end name="command-contract-bg-logs" -->

Show bounded output from a background task.

## Synopsis

`/bg-logs <task-id-or-prefix> [maxBytes]`

Slash-command logs always read the tail.

## When to use

Use `/bg-logs` when you need task output in the host UI. For agent tool calls, use [`bg_logs`](../tools/bg_logs.md) and avoid repeated calls as a waiting loop.

## Defaults

- `maxBytes`: defaults to the model-safe log cap, the host-provided default (currently 50 KiB), never above 64 KiB.
- Values are normalized to an integer in `[1, MAX_LOG_BYTES]`; invalid numbers use the default.
- `tail`: always `true` for `/bg-logs`.

## Lifecycle

`/bg-logs` is a point-in-time read of the output file. It does not subscribe, follow, or poll. Running tasks may produce more output after the read.

## Examples

```text
/bg-logs b12345678
/bg-logs b1234 2000
```

## Output/result

The notification contains output text. If truncated, a notice is prepended for tail reads:

```text
[Showing tail <bytes-read> of <total>; <omitted> omitted. Full output: <agent-dir>/tasks/.../<task-id>.output]
```

If not truncated, the result ends with:

```text
[Full output: <agent-dir>/tasks/.../<task-id>.output]
```

The full output path is preserved even when model-visible bytes are bounded.

## Errors

- Missing id: `Task ID is required`.
- Unknown id/prefix: `Unknown background task ID: <id>`.
- Ambiguous prefix: lists matching task ids.
- Missing output file: `Output file does not exist for <id>: <path>`.

Errors are shown as `Background logs error: ...`.

## Runtime artifacts

Reads `<agent-dir>/tasks/<session-id>-<pid>/<task-id>.output` (`getAgentDir()`, defaults to `~/.pi/agent/tasks/`); does not modify output or metadata.

## Safety boundaries

Read-only bounded inspection. It is not a polling primitive and should not be used merely to wait for completion.

## Related docs

- [`bg_logs`](../tools/bg_logs.md)
- [`/bg-jobs`](bg-jobs.md)
- [`/bg-kill`](bg-kill.md)
- [Background task runtime](../subsystems/background-task-runtime.md)

## Source ownership/reference

Surface registration lives in `src/extension.ts`; bounded log reading is owned by [background-task-runtime](../subsystems/background-task-runtime.md).
