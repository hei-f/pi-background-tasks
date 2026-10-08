---
doc_id: operations/configuration
audience: maintainer
mode: authored
review_policy: contract
stability: stable
covers_surfaces: []
covers_sources: []
---

# Configuration

This page lists operator-facing configuration found in source. It intentionally does not invent undocumented environment variables.

## Dock selection

Configuration is read before any package registration on each extension activation and is re-read by a real Pi `/reload`. Invalid input throws a bounded `pi_bg_config_invalid` error; it never partially activates a requested subset or falls back to defaults.

| Variable              | Default      | Accepted values and effect                                                                                                   |
| --------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `PI_BG_DOCK_SHORTCUT` | `shift+down` | Exactly `shift+down`, `ctrl+alt+b`, or `off`. Only the selected literal key is registered; `off` registers no dock shortcut. |

The background-task capability is always available and never trimmed: there is no feature-selection environment variable. `process` is the single capability and owns the shell-command tools, the task UI/renderer, footer, and EventBus service:

- commands: `/bg-clear`, `/bg-jobs`, `/bg-logs`, `/bg-kill`;
- tools: `bash` (the covering built-in with `run_in_background`), `bg_status`, `bg_logs`, `bg_kill`;
- shortcut: the selected dock key plus unconditional `ctrl+alt+c`;
- renderer: `background-task-notification`.

Pi's registry rebuild drops stale active names that have no current definition; the package does not deactivate an unrelated extension tool. With the dock shortcut off, the footer advertises `/bg-jobs`; the alternate footer hint is `CtrlAltB`. `Ctrl+Alt+C` remains the terminal-dependent `/bg-clear` fallback.

## Initialized-host SDK contract

Normal Pi TUI, RPC, print, and JSON modes provide lifecycle bindings that initialize post-bind package resources and cause `session_start` to run after reload. An SDK host must call `bindExtensions()` with at least one binding Pi counts (UI context, command-context actions, shutdown handling, or `onError`). With only `{}` or `{ mode: "print" }`, the first explicit bind initializes resources, but `reload()` does not emit the rebuilt runner's `session_start`; the host must explicitly bind again after every `reload()`.

The generated availability tables describe this initialized-host contract and are not a pre-bind availability guarantee.

## Opt-in reload survival

Reload survival is a per-launch field, not a global environment setting:

- `bash({ command, timeout, run_in_background: true })` from the model (notify + wake), or the dock「to background」user entry (notify only)

New launch entries no longer expose `surviveReload` — opt-in survival is inherited only by legacy records and dock reruns. Omitted/false `run_in_background` keeps default foreground behavior. Survival is supported only for ordinary shell tasks across a real same-process Pi reload with the exact session id and canonical cwd. Agent-launched and EventBus-v1 paths do not opt in. The live execution retains its launch-time shell policy, timeout deadline, output cap, and cumulative bytes even if environment/config changes before reload; a dock rerun is new work and uses current configuration.

## Host settings self-read (S1 P2)

On activation the extension reads the **user-level** `settings.json` at `getAgentDir()/settings.json` (default `~/.pi/agent/settings.json`) and consumes two host fields:

- `shellPath`: normalized with the host's own `normalizePath` semantics (`~` expansion, Git-Bash drive-path conversion). It feeds the background POSIX shell chain below; the foreground path passes it through `createBashToolDefinition(cwd, { shellPath })`, exactly like the host runner.
- `shellCommandPrefix`: prepended to both foreground and background commands with the host's `` `${prefix}\n${command}` `` splice.

Any read failure (missing file, malformed JSON, missing/non-string field) or a `shellPath` that does not resolve (invalid path on POSIX; no Git Bash/no `bash.exe` on Windows) silently degrades to defaults — the extension still activates, the background chain falls back to `$SHELL`. **Only user-level settings are read; the host's project-level settings merge is not part of this package's read surface.**

## Shell selection

### POSIX

The policy is resolved once per extension activation. Changing these variables takes effect on the next Pi start or `/reload`, not midway through an activation.

| Variable                                 | Effect                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_BG_POSIX_SHELL=inherit`              | Default. Preserve the existing behavior: use non-empty `SHELL`, otherwise `/bin/sh`, with `-c`.                                                               |
| `PI_BG_POSIX_SHELL=bash`                 | Select Bash explicitly. Check executable `/bin/bash` first, then `bash` in `PATH` order; fail if unavailable.                                                 |
| `PI_BG_POSIX_SHELL=sh`                   | Select sh explicitly. Check executable `/bin/sh` first, then `sh` in `PATH` order; fail if unavailable.                                                       |
| `PI_BG_POSIX_SHELL_PATH=<absolute-file>` | Optional only with `bash` or `sh`. The target must be a regular executable file. Invalid, empty, relative, or unavailable paths fail without search fallback. |

Executable paths are structured spawn arguments, not interpolated command text. Bash and sh receive `-c`, never `-lc`; selecting them does not implicitly load login-shell startup files. For explicit search, `/bin` wins over `PATH`; relative `PATH` directories are resolved at activation so task cwd changes cannot retarget the selected executable.

In `inherit` mode, known Bourne-family names are reported as POSIX-compatible, `bash` is reported as Bash, and Nu/fish/csh/unknown names are reported as `user-non-posix`. The inherited executable itself is intentionally not validated or replaced, preserving compatibility. Before each agent run, guidance reports the exact resolved executable/dialect/args. A non-POSIX inherited shell receives explicit `PI_BG_POSIX_SHELL=bash` remediation.

### Windows

Windows defaults to `cmd.exe`/`ComSpec`. The generic `SHELL` variable is ignored on Windows so existing `cmd` syntax does not silently change language.

| Variable                                | Effect                                       |
| --------------------------------------- | -------------------------------------------- |
| `PI_BG_SHELL=cmd`                       | Use Windows `cmd` dialect.                   |
| `PI_BG_SHELL=bash`                      | Use POSIX-style `bash -c` on Windows.        |
| `PI_BG_SHELL_PATH=<absolute .exe/.com>` | Explicit shell path; requires `PI_BG_SHELL`. |

Invalid Windows shell settings fail loudly instead of falling back. `bash` is invoked with `-c`, not `-lc`. `PI_BG_POSIX_SHELL` and `PI_BG_POSIX_SHELL_PATH` are ignored on Windows, even when present, so they cannot change existing cmd/Bash/ComSpec selection or structured argv behavior.

### Host-sourced shell chain (background, POSIX)

The background `inherit` branch resolves in this order (S1 P1):

1. explicit `PI_BG_POSIX_SHELL=bash|sh` (`PI_BG_POSIX_SHELL_PATH` optional);
2. user-level `settings.shellPath` (host `normalizePath` normalized);
3. host foreground `getShellConfig()` result (`/bin/bash` → PATH bash → `sh` on POSIX);
4. `$SHELL`;
5. `/bin/sh`.

`hostShellPath` (items 2–3) is injected at extension activation by the host-shell resolution and is intentionally consumed only by the POSIX `inherit` branch. **Win32 boundary:** the Windows branch never consumes `settings.shellPath`/host shell resolution — foreground honors it (host behavior), background does not; the platforms are intentionally asymmetric for the background chain. This environment is the tested macOS case.

### Background timeout semantics

With `run_in_background:true`, `timeout` is a hard-kill deadline in seconds: `0` or omitted means no deadline (never force-terminated by timeout); `> 0` sets the kill deadline. Foreground `timeout` semantics are unchanged (host built-in behavior).

## Output and log caps

| Setting/surface                                 | Value/behavior                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_BG_MAX_OUTPUT_BYTES`                        | Optional environment override for the hard task output cap. Default is 2 GiB. Reaching it terminates the task as `failed` (output_limit) instead of claiming success. |
| `PI_BG_SOFT_OUTPUT_BYTES`                       | Optional environment override for the soft output warning threshold. Default is 256 MiB. Crossing it appends a warning notice and continues the task without killing it. |
| `bg_logs.maxBytes` / `/bg-logs <id> [maxBytes]` | Bounded model-visible read. The package cap is the host-provided `DEFAULT_MAX_BYTES` (currently 50 KiB), never above 64 KiB.      |
| Full output                                     | Written under `<getAgentDir()>/tasks/<session-id>-<pid>/<task-id>.output` (host-private agent dir, default `~/.pi/agent/tasks/`; project-local `.pi/tasks` is not migrated and can be removed manually).                                                      |

Bounded logs are for context safety; they point to the full local output file when more bytes exist.

## Pi-agent telemetry opt-out

| Variable                       | Effect                                                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `PI_BG_DISABLE_PI_TELEMETRY=1` | Do not wrap shell commands that appear to launch `pi -p ...` or `pi --mode json ...` when `isAgent:true`. Raw stdout is preserved. |

Telemetry wrapping is best-effort and task-owned. Missing telemetry is reported as unavailable, never as zero. Wrapping requires a resolved shell with compatible POSIX function syntax. Under Windows `cmd` or an inherited Nu/fish/csh/unknown shell, safe interception is unavailable, the command is left unchanged, and task metadata records the reason.

## Offline behavior

- Background shell commands may still do whatever the command does; the package does not block their network access.

## Durability and platform note

Task metadata uses durable write helpers. Ordinary task `.output` streams are ended and drained before terminal publication but are not explicitly fsynced. POSIX performs directory `fsync` after atomic replacement. Windows still flushes replaced file contents before rename and treats rename failures as fatal, but it does not get the same portable directory-entry crash-durability guarantee.
