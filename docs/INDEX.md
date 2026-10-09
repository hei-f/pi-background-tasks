---
doc_id: INDEX
audience: user
mode: generated
review_policy: contract
stability: stable
covers_surfaces: []
covers_sources: []
---
# Documentation index

Generated navigation for every package-local documentation page. This index intentionally owns no public surface and no production source; ownership is explicit in each primary doc's frontmatter.

## Start here

- [Getting started](./getting-started.md)
- [Choose a workflow](./choose-a-workflow.md)
- [Read before editing production sources](./read-before-edit.md)
- [Runtime contracts](./reference/runtime-contracts.md)

## Docs by audience

### agent

| Doc | Mode | Review | Stability |
| --- | --- | --- | --- |
| [concepts/completion-delivery](./concepts/completion-delivery.md) | authored | contract | stable |
| [read-before-edit](./read-before-edit.md) | generated | contract | stable |
| [tools/bash](./tools/bash.md) | mixed | behavioral | stable |
| [tools/bg_kill](./tools/bg_kill.md) | mixed | contract | stable |
| [tools/bg_logs](./tools/bg_logs.md) | mixed | contract | stable |
| [tools/bg_status](./tools/bg_status.md) | mixed | contract | stable |

### maintainer

| Doc | Mode | Review | Stability |
| --- | --- | --- | --- |
| [api/eventbus-v1](./api/eventbus-v1.md) | mixed | behavioral | evolving |
| [operations/configuration](./operations/configuration.md) | authored | contract | stable |
| [operations/releasing](./operations/releasing.md) | authored | contract | evolving |
| [operations/testing](./operations/testing.md) | authored | contract | evolving |
| [operations/troubleshooting](./operations/troubleshooting.md) | authored | contract | evolving |
| [reference/runtime-contracts](./reference/runtime-contracts.md) | mixed | contract | evolving |
| [subsystems/background-task-runtime](./subsystems/background-task-runtime.md) | authored | behavioral | stable |
| [subsystems/child-launch-durability-and-safety](./subsystems/child-launch-durability-and-safety.md) | authored | behavioral | evolving |
| [subsystems/docs-freshness-gate](./subsystems/docs-freshness-gate.md) | mixed | contract | stable |
| [subsystems/host-ui-and-telemetry](./subsystems/host-ui-and-telemetry.md) | authored | behavioral | stable |

### user

| Doc | Mode | Review | Stability |
| --- | --- | --- | --- |
| [choose-a-workflow](./choose-a-workflow.md) | authored | contract | stable |
| [commands/bg-clear](./commands/bg-clear.md) | mixed | contract | stable |
| [commands/bg-jobs](./commands/bg-jobs.md) | mixed | contract | stable |
| [commands/bg-kill](./commands/bg-kill.md) | mixed | contract | stable |
| [commands/bg-logs](./commands/bg-logs.md) | mixed | contract | stable |
| [getting-started](./getting-started.md) | authored | contract | stable |
| [INDEX](./INDEX.md) | generated | contract | stable |
| [reference/shortcuts-and-dock](./reference/shortcuts-and-dock.md) | mixed | contract | stable |

## Docs by category

- **api**: [api/eventbus-v1](./api/eventbus-v1.md)
- **commands**: [commands/bg-clear](./commands/bg-clear.md), [commands/bg-jobs](./commands/bg-jobs.md), [commands/bg-kill](./commands/bg-kill.md), [commands/bg-logs](./commands/bg-logs.md)
- **concepts**: [concepts/completion-delivery](./concepts/completion-delivery.md)
- **operations**: [operations/configuration](./operations/configuration.md), [operations/releasing](./operations/releasing.md), [operations/testing](./operations/testing.md), [operations/troubleshooting](./operations/troubleshooting.md)
- **reference**: [reference/runtime-contracts](./reference/runtime-contracts.md), [reference/shortcuts-and-dock](./reference/shortcuts-and-dock.md)
- **root**: [choose-a-workflow](./choose-a-workflow.md), [getting-started](./getting-started.md), [INDEX](./INDEX.md), [read-before-edit](./read-before-edit.md)
- **subsystems**: [subsystems/background-task-runtime](./subsystems/background-task-runtime.md), [subsystems/child-launch-durability-and-safety](./subsystems/child-launch-durability-and-safety.md), [subsystems/docs-freshness-gate](./subsystems/docs-freshness-gate.md), [subsystems/host-ui-and-telemetry](./subsystems/host-ui-and-telemetry.md)
- **tools**: [tools/bash](./tools/bash.md), [tools/bg_kill](./tools/bg_kill.md), [tools/bg_logs](./tools/bg_logs.md), [tools/bg_status](./tools/bg_status.md)

## Public surface owners

| Surface | Primary doc |
| --- | --- |
| `command:bg-clear` | [commands/bg-clear](./commands/bg-clear.md) |
| `command:bg-jobs` | [commands/bg-jobs](./commands/bg-jobs.md) |
| `command:bg-kill` | [commands/bg-kill](./commands/bg-kill.md) |
| `command:bg-logs` | [commands/bg-logs](./commands/bg-logs.md) |
| `eventbus:background-task-v1` | [api/eventbus-v1](./api/eventbus-v1.md) |
| `renderer:background-task-notification` | [concepts/completion-delivery](./concepts/completion-delivery.md) |
| `shortcut:ctrl+alt+b` | [reference/shortcuts-and-dock](./reference/shortcuts-and-dock.md) |
| `shortcut:ctrl+alt+c` | [reference/shortcuts-and-dock](./reference/shortcuts-and-dock.md) |
| `shortcut:shift+down` | [reference/shortcuts-and-dock](./reference/shortcuts-and-dock.md) |
| `tool:bash` | [tools/bash](./tools/bash.md) |
| `tool:bg_kill` | [tools/bg_kill](./tools/bg_kill.md) |
| `tool:bg_logs` | [tools/bg_logs](./tools/bg_logs.md) |
| `tool:bg_status` | [tools/bg_status](./tools/bg_status.md) |

## Public surface inventory

| Kind | Name | ID | Availability | Default | Provenance |
| --- | --- | --- | --- | --- | --- |
| command | `bg-clear` | `command:bg-clear` | `always` | yes | `src/extension.ts:688` |
| command | `bg-jobs` | `command:bg-jobs` | `always` | yes | `src/extension.ts:722` |
| command | `bg-kill` | `command:bg-kill` | `always` | yes | `src/extension.ts:769` |
| command | `bg-logs` | `command:bg-logs` | `always` | yes | `src/extension.ts:737` |
| tool | `bash` | `tool:bash` | `always` | yes | `src/extension.ts:824` |
| tool | `bg_kill` | `tool:bg_kill` | `always` | yes | `src/extension.ts:925` |
| tool | `bg_logs` | `tool:bg_logs` | `always` | yes | `src/extension.ts:877` |
| tool | `bg_status` | `tool:bg_status` | `always` | yes | `src/extension.ts:844` |
| shortcut | `ctrl+alt+b` | `shortcut:ctrl+alt+b` | `dock:ctrl+alt+b` | no | `src/extension.ts:706` |
| shortcut | `ctrl+alt+c` | `shortcut:ctrl+alt+c` | `always` | yes | `src/extension.ts:714` |
| shortcut | `shift+down` | `shortcut:shift+down` | `dock:shift+down` | yes | `src/extension.ts:697` |
| renderer | `background-task-notification` | `renderer:background-task-notification` | `always` | yes | `src/extension.ts:546` |
| eventbus | `background-task-v1` | `eventbus:background-task-v1` | `always` | yes | `src/core/extension-api.ts` |
