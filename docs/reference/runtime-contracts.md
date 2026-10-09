---
doc_id: reference/runtime-contracts
audience: maintainer
mode: mixed
review_policy: contract
stability: evolving
covers_surfaces: []
covers_sources: []
---

# Runtime contracts reference

This generated registry lists production environment-variable references, runtime paths/artifacts, schema identifiers, and status vocabularies extracted from package source. It intentionally excludes incidental source-code literals such as package metadata import paths.

<!-- pi-docs:begin name="runtime-contracts" generator="scripts/docs/generate.mjs" -->
### Configuration variants


```json
{
  "default_dock_shortcut": "shift+down",
  "default_features": [
    "process"
  ],
  "dock_shortcut_values": [
    "shift+down",
    "ctrl+alt+b",
    "off"
  ],
  "feature_values": [
    "process"
  ],
  "source": "src/core/config.ts"
}
```

### Environment variable references

| Name | Access | Provenance |
| --- | --- | --- |
| `ComSpec` | read | `src/core/common.ts:1090`<br>`src/core/common.ts:947`<br>`src/core/common.ts:965` |
| `COMSPEC` | read | `src/core/common.ts:1090` |
| `path` | read | `src/core/common.ts:847` |
| `Path` | read | `src/core/common.ts:847` |
| `PATH` | read | `src/core/common.ts:847`<br>`src/core/common.ts:907`<br>`src/core/pi-launch.ts:425` |
| `PathExt` | read | `src/core/common.ts:1085` |
| `PATHEXT` | read | `src/core/common.ts:1085` |
| `PI_BG_DISABLE_PI_TELEMETRY` | read | `src/core/registry.ts:389` |
| `PI_BG_DOCK_SHORTCUT` | read | `src/core/config.ts:63` |
| `PI_BG_MAX_OUTPUT_BYTES` | read | `src/core/registry.ts:99` |
| `PI_BG_POSIX_SHELL` | read | `src/core/common.ts:986` |
| `PI_BG_POSIX_SHELL_PATH` | read | `src/core/common.ts:998` |
| `PI_BG_SHELL` | read | `src/core/common.ts:942` |
| `PI_BG_SHELL_PATH` | read | `src/core/common.ts:943` |
| `PI_BG_SOFT_OUTPUT_BYTES` | read | `src/core/registry.ts:102` |
| `SHELL` | read | `src/core/common.ts:1005` |
| `SystemRoot` | read | `src/core/windows-taskkill.ts:96` |
| `WINDIR` | read | `src/core/windows-taskkill.ts:101` |

### Runtime paths and artifacts

| Kind | Path/artifact | Provenance |
| --- | --- | --- |
| directory | `.pi/tasks/<session-id>-<pid>/` | `src/core/registry.ts:1` |
| task-file | `.pi/tasks/<session-id>-<pid>/<task-id>.json` | `src/core/registry.ts:1764` |
| task-file | `.pi/tasks/<session-id>-<pid>/<task-id>.output` | `src/core/registry.ts:1763` |
| task-file | `.pi/tasks/<session-id>-<pid>/<task-id>.pi-telemetry-wrapper.cjs` | `src/core/registry.ts:1995` |

### Schema identifiers

| Schema | Provenance |
| --- | --- |
| `pi-background-tasks.extension-request.v1` | `src/core/extension-api.ts:19` |
| `pi-background-tasks.extension-response.v1` | `src/core/extension-api.ts:20` |
| `pi-background-tasks.extension-terminal.v1` | `src/core/extension-api.ts:21` |
| `pi-background-tasks.reload-shell-owner.v1` | `src/core/reload-shell-owner.ts:41` |
| `pi-background-tasks.reload-shell.v1` | `src/core/reload-shell-owner.ts:884` |

### Status vocabularies


```json
{
  "TASK_STATUS_VALUES": [
    "running",
    "completed",
    "failed",
    "cancelled",
    "killed",
    "lost"
  ],
  "TERMINAL_TASK_STATUS_VALUES": [
    "completed",
    "failed",
    "cancelled",
    "killed",
    "lost"
  ]
}
```
<!-- pi-docs:end name="runtime-contracts" -->

## Maintenance rule

If a runtime fact changes in source, update the owning subsystem/API doc and run `npm run docs:generate`. Do not hand-edit generated tables.
