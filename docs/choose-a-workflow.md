---
doc_id: choose-a-workflow
audience: user
mode: authored
review_policy: contract
stability: stable
covers_surfaces: []
covers_sources: []
---

# Choose a workflow

The background-task cycle is always available by default and is never trimmed: there is no feature-selection capability. This package tracks ordinary shell commands only.

## Quick decision tree

1. **Is the work short and interactive?** Use ordinary foreground Pi work.
2. **Is it a long shell command?** Use the covered `bash` tool with `run_in_background:true`; the agent has no separate interactive command entry point. User launch goes through the dock「转后台」entry.

## Comparison table

| Option          | Sync/async  | Context sent    | Can read repo?          | Can use network?        | Can write?              | Route behavior                               | Use when                                          |
| --------------- | ----------- | --------------- | ----------------------- | ----------------------- | ----------------------- | -------------------------------------------- | ------------------------------------------------- |
| Foreground work | Synchronous | Current session | Depends on active tools | Depends on active tools | Depends on active tools | Current session route                        | You need live interaction.                        |
| Covered `bash` `run_in_background:true` | Async | None by package | Command decides | Command decides | Command decides | Not a model route unless command invokes one | Pi should launch a long command and resume later. |

## Tradeoffs and boundaries

### Foreground vs background shell

Foreground commands are best when the next answer depends on immediate output. Background commands are best when the command may take long enough that Pi can do other useful work or yield until completion.

The covered `bash` background path is not a sandbox. It spawns a local shell command with the permissions, environment, network access, and credentials available to the Pi process. A background command can itself call paid services.

### Background defaults

The covered `bash` background path takes:

```json
{ "command": "shell command", "run_in_background": true }
```

The model entry defaults to `notifyOnCompletion:true` and `triggerOnCompletion:true`. With those defaults, Pi should not poll `bg_status` or `bg_logs` merely to wait.

## Examples

### Long command

```json
{
  "command": "npm run build -- --watch",
  "run_in_background": true,
  "timeout": 7200
}
```
