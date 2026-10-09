---
doc_id: read-before-edit
audience: agent
mode: generated
review_policy: contract
stability: stable
covers_surfaces: []
covers_sources: []
---
# Read before editing production sources

Every production file under `src/**` and `extensions/**` has exactly one primary behavioral documentation owner. This file is generated from authored ownership frontmatter and owns no production source itself.

## Source ownership

| Source | Primary behavioral owner |
| --- | --- |
| `extensions/background-tasks.ts` | [subsystems/host-ui-and-telemetry](./subsystems/host-ui-and-telemetry.md) |
| `src/bash-override.ts` | [tools/bash](./tools/bash.md) |
| `src/core/canonical-json.ts` | [subsystems/child-launch-durability-and-safety](./subsystems/child-launch-durability-and-safety.md) |
| `src/core/common.ts` | [subsystems/background-task-runtime](./subsystems/background-task-runtime.md) |
| `src/core/config.ts` | [subsystems/host-ui-and-telemetry](./subsystems/host-ui-and-telemetry.md) |
| `src/core/durable-fs.ts` | [subsystems/child-launch-durability-and-safety](./subsystems/child-launch-durability-and-safety.md) |
| `src/core/extension-api.ts` | [api/eventbus-v1](./api/eventbus-v1.md) |
| `src/core/host-settings.ts` | [subsystems/background-task-runtime](./subsystems/background-task-runtime.md) |
| `src/core/lazy-module.ts` | [subsystems/host-ui-and-telemetry](./subsystems/host-ui-and-telemetry.md) |
| `src/core/pi-launch.ts` | [subsystems/child-launch-durability-and-safety](./subsystems/child-launch-durability-and-safety.md) |
| `src/core/process-tree.ts` | [subsystems/background-task-runtime](./subsystems/background-task-runtime.md) |
| `src/core/registry.ts` | [subsystems/background-task-runtime](./subsystems/background-task-runtime.md) |
| `src/core/reload-shell-owner.ts` | [subsystems/background-task-runtime](./subsystems/background-task-runtime.md) |
| `src/core/shell-policy.ts` | [subsystems/background-task-runtime](./subsystems/background-task-runtime.md) |
| `src/core/task-durable.ts` | [subsystems/child-launch-durability-and-safety](./subsystems/child-launch-durability-and-safety.md) |
| `src/core/telemetry.ts` | [subsystems/background-task-runtime](./subsystems/background-task-runtime.md) |
| `src/core/windows-taskkill.ts` | [subsystems/background-task-runtime](./subsystems/background-task-runtime.md) |
| `src/extension.ts` | [subsystems/host-ui-and-telemetry](./subsystems/host-ui-and-telemetry.md) |
| `src/ui/background-tasks-manager.ts` | [subsystems/host-ui-and-telemetry](./subsystems/host-ui-and-telemetry.md) |

## Public surfaces

| Surface | Availability | Default |
| --- | --- | --- |
| `command:bg-clear` | `always` | yes |
| `command:bg-jobs` | `always` | yes |
| `command:bg-kill` | `always` | yes |
| `command:bg-logs` | `always` | yes |
| `tool:bash` | `always` | yes |
| `tool:bg_kill` | `always` | yes |
| `tool:bg_logs` | `always` | yes |
| `tool:bg_status` | `always` | yes |
| `shortcut:ctrl+alt+b` | `dock:ctrl+alt+b` | no |
| `shortcut:ctrl+alt+c` | `always` | yes |
| `shortcut:shift+down` | `dock:shift+down` | yes |
| `renderer:background-task-notification` | `always` | yes |
| `eventbus:background-task-v1` | `always` | yes |
