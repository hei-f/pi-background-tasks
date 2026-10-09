---
doc_id: reference/shortcuts-and-dock
audience: user
mode: mixed
review_policy: contract
stability: stable
covers_surfaces: ['shortcut:ctrl+alt+b', 'shortcut:ctrl+alt+c', 'shortcut:shift+down']
covers_sources: []
---

# Shortcuts and dock reference

<!-- pi-docs:begin name="shortcut-contracts" generator="scripts/docs/generate.mjs" -->
| Shortcut | Availability | Default | Description | Provenance |
| --- | --- | --- | --- | --- |
| `ctrl+alt+b` | `dock:ctrl+alt+b` | no | Open focused background task footer dock | `src/extension.ts:706` |
| `ctrl+alt+c` | `always` | yes | Clear finished background task footer notices (terminal-dependent fallback for /bg-clear) | `src/extension.ts:714` |
| `shift+down` | `dock:shift+down` | yes | Open focused background task footer dock | `src/extension.ts:697` |
<!-- pi-docs:end name="shortcut-contracts" -->

## Registered shortcuts

`PI_BG_DOCK_SHORTCUT` selects exactly one dock binding:

| Value        | Registered dock key | Footer hint | Default |
| ------------ | ------------------- | ----------- | ------- |
| `shift+down` | `Shift+Down`        | `Shift↓`    | yes     |
| `ctrl+alt+b` | `Ctrl+Alt+B`        | `CtrlAltB`  | no      |
| `off`        | none                | `/bg-jobs`  | no      |

Only the configured literal key is registered, so selecting the alternate key or `off` avoids a Shift+Down conflict with another extension rather than merely hiding a label. Invalid, blank, differently cased, or whitespace-bearing values fail extension load with `pi_bg_config_invalid`; they do not fall back to Shift+Down. The setting is re-read on `/reload`.

`Ctrl+Alt+C` is separate and remains registered in all three modes. It clears finished background task footer notices as an optional terminal-dependent fallback for [`/bg-clear`](../commands/bg-clear.md). If a terminal does not deliver it, use `/bg-clear`, the canonical command path.

## Footer states

The footer appears when there are running tasks or unseen finished tasks. Count labels are:

- `running` for active tasks;
- `failed` for status `failed`;
- `stopped` for status `killed` or `cancelled`;
- `done` for status `completed`.

`lost` terminal truth (startup-audit records) is deliberately not surfaced as an
unseen footer badge by design; such tasks remain visible through `/bg-jobs`.

Examples:

```text
bg 1 running · Shift↓
bg 1 running · CtrlAltB
bg 1 running · /bg-jobs
bg 1 done · Shift↓ · /bg-clear
bg 1 running · 1 failed · 1 stopped · 1 done · Shift↓ · /bg-clear
bg 1 running · focused
```

The `/bg-clear` hint is hidden while the dock is open, where the entry hint becomes `focused`. A finished task's badge is marked seen when its detail view opens; `/bg-clear` or `Ctrl+Alt+C` marks all currently unseen finished tasks seen. Merely opening the list view or closing the dock does not clear badges.

## To background (dock user entry)

Press `b` in the dock list view to enter the「转后台」command form: type a shell
command, press Enter to submit, Esc to cancel. The submitted command starts a
durable background task through the user entry semantics: `entrySource:'user'`
with notification on terminal state but no automatic follow-up wake. Empty
submissions are rejected with a message; failed submissions keep the dock open
with the error. There is no general user slash-command for this: users start
background work exclusively here in an interactive UI, and use `/bg-jobs`,
`/bg-logs` and `/bg-kill` for inspection and stopping. The model entry is the
covered `bash` tool with `run_in_background:true`, which does default to notify
plus wake (see [Covered `bash`](../tools/bash.md)).

## Dock entry points

- the configured `Shift+Down` or `Ctrl+Alt+B` key, unless set to `off`.

When no dock key is configured, the list view is still reachable through `/bg-jobs`. All enabled entry points open the same task manager when an interactive UI is available.

## Rerun and reload survival

`R` reruns only ordinary shell tasks. If the selected task used `surviveReload:true`, rerun preserves that opt-in but deliberately creates a new execution with a new task id and launch nonce. It resolves the current activation's shell policy and captures current timeout/output-cap configuration; it never reuses or restarts the selected process.

A currently running opted ordinary task that crosses a supported real reload remains the same row/id/PID/output path in the fresh dock. The dock does not scan metadata or adopt PIDs.

## Dock output detail

The detail view follows a UI-only 128 KiB tail buffer, refreshes once per second while following, and shows 12 output lines. Scrolling up pauses following; reaching the bottom or pressing `r` resumes it.

## Related docs

- [`/bg-clear`](../commands/bg-clear.md)
- [Host UI and telemetry](../subsystems/host-ui-and-telemetry.md)

## Source ownership/reference

Shortcut and footer implementation is owned by [host-ui-and-telemetry](../subsystems/host-ui-and-telemetry.md).
