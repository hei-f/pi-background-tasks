# pi-background-tasks Testing

This package follows the package-local QA navigation docs:

- `BACKGROUND-TASKS-INSTRUCTIONS.md` — required agent gateway/read order
- [`docs/operations/testing.md`](docs/operations/testing.md) — gate selection and isolation
- [`TEST_PLAN.md`](TEST_PLAN.md) — exhaustive feature coverage matrix and acceptance truth

The historical monorepo extension standards are contextual background only; do not leave standalone package links to parent `../EXTENSION_*` files in this package's published docs.

## Current commands

Compiled runtime build:

```bash
npm run build:runtime
```

This produces the published `dist/` JavaScript entrypoints and their complete deferred runtime closure from authoritative TypeScript. SDK/package/smoke/release scripts build it before exercising compiled distribution paths.

Default gate:

```bash
npm run test
```

This runs:

```bash
npm run typecheck
npm run test:type-safety
npm run test:unit
npm run test:sdk
npm run test:rpc
npm run test:component
npm run test:package
```

`npm run test:unit` runs `tsx --test tests/unit/**/*.test.ts` and includes the docs freshness gate (`tests/unit/docs-gate.test.ts`), whose strict mode requires every behavioral doc receipt to match current prose and sources. Pure/unit coverage includes the durable file primitives, bounded log reads, the registry stop/state machine, the reload-shell-owner protocol, process-tree parsing, shell policy, EventBus frames, and the covered-`bash` override surface.

Full interactive gate:

```bash
npm run test:full
```

This runs the default gate plus:

```bash
npm run test:pty
npm run test:agent-loop
```

Smoke/release checks:

```bash
npm run smoke
npm run pack:dry-run
npm run docs:verify
npm run docs:verify:attestations
```

Current smoke builds the runtime and then runs `tsx scripts/smoke.ts`. It creates a temporary Pi agent/session directory, sets offline/telemetry-suppression environment variables, and runs the compiled package entrypoints with `/bg-jobs`.

## Coverage summary

Implemented coverage includes:

- tools: covered `bash` (same-name override; `run_in_background:true` enters the background stack and the default entry semantic is notify plus follow-up wake) plus `bg_status`, `bg_logs`, `bg_kill`. The retired `bg_run` tool never registers (M4), and the covered `bash` front path is byte-equivalent to the host built-in via `createLocalBashOperations`. Bounded logs carry `totalBytes` and normalize to `[1, MAX_LOG_BYTES]`, capped by the host-provided `DEFAULT_MAX_BYTES` (currently 50 KiB), never above 64 KiB.
- commands: `/bg-clear`, `/bg-jobs`, `/bg-kill`, `/bg-logs` — listing, bounded log views, finishing-notice clearing, kill-by-id with user-initiator dispatch, byte-limit normalization, and unknown/ambiguous id handling.
- user entry: dock「转后台」composes a shell command with `q`/`x`/`Q`/`X` as printable letters (they do not close the dock), submits on Enter with `entrySource:'user'` (notification only), cancels on Escape, and rejects empty submissions.
- shortcut/UI: component coverage for focused dock list/detail/key handling, detail output-tail scrolling (arrow/page scroll, follow-pause-on-scroll, `lines X–Y of N` position indicator, resume-follow-at-bottom, and no-scroll when output fits), empty/history/unread states, paging, close aliases, stop/stop-all/rerun/path actions, and missing output files; SDK coverage for `/bg-clear` finished-notice clearing and footer hinting; RPC coverage that `/bg-clear` works as a terminal-independent clear path.
- runtime files: output and metadata files under `.pi/tasks/<session-id>-<pid>/`, persisted `isAgent` classification, task-owned context-window telemetry snapshots, cumulative background Pi-agent token usage, tool-use counts, agent model identifier (preferring the fully-qualified `provider/model` form), explicit `isAgent:true` telemetry wrapping for background `pi` agents, split/large telemetry ingestion, metadata after completion/failure, and atomic durable metadata write ordering.
- reload survival: owner/registry units pin structural global reuse, exact identity, two-phase claims, stale/conflict errors, fixed no-claim cleanup, admission commit, cumulative cap, publication attempts, retention/reentrancy inheritance, and injected Windows taskkill ownership. The survivor POSIX stop path runs the same grace-window `ps` descendant scan and individual descendant `SIGKILL` pass as the ordinary path, and a bounded stop timeout destroys the plugin-held output read ends. Real SDK reload cases keep the same live child across a reload and still run stop, logs, and slash-command paths.
- EventBus API: unit coverage for `pi-background-tasks:request:v1`/`response:v1`/`terminal:v1` closed-frame validation, exact capability handshake, malformed payload rejection, unknown keys, unknown operations, duplicate request ids (with a bounded dedupe ledger), missing `session_start`, shutdown refusal, unsubscribe, strict terminal frame shape (status/failedReason/initiator/originMeta/summaryTail/usage), and response-barrier ordering. Completion notifications carry a bounded 64 KiB tail summary; full logs are never auto-returned and the output path stays in the frame.
- durability: `tests/unit/durable-fs.test.ts` covers the shared `src/core/durable-fs.ts` and `src/core/task-durable.ts` primitives — single-open write/sync/close ordering, exclusive `wx` temp creation at `0o600`, direct `w` writes with inherited mode, primary-versus-cleanup error precedence, `renameCompleted` after a post-rename directory failure, the Windows directory-sync skip, atomic replacement, and fatal `fsync` failures. Ordinary task `.output` is a streaming file ended/drained before terminal metadata and is not explicitly fsynced.
- safety: kill, already-finished kill failure, timeout failure, spawn failure, low output-cap failure, multi-task shutdown cleanup, POSIX process-group kill fallback with ps descendant collection and individual descendant kills, Windows `taskkill /T` then `/T /F` tree termination with shared soft attempts, soft-abort-on-force, exit-128 race tolerance, loud force failures, no root-only fallback, SIGKILL escalation that terminates instead of re-arming, duplicate finalization/notification races, metadata/notification failure handling, and pruning. The shutdown handler runs its running-task cleanup even when a reload handoff failure is raised (the original error is preserved).
- package: manifest, docs, ordered `pi.extensions`, exported `src/core/extension-api.ts`, registry-only production dependencies, host-provided Pi AI peer posture, packed runtime files/notices, production-only no-host-peer activation plus all public lazy lanes and shutdown, alias-aware dynamic-import issuer guards, tarball-install smoke, direct-completion import bans, test/helper/script/artifact exclusion, compiler-tree type-escape and file-URL provenance guards, explicitly prepared isolated offline npm installation with an empty-cache negative control and real transitive load, and exact-version compatibility.

## PTY notes

`test:pty` uses `/usr/bin/expect` to drive a real pseudo-terminal. It verifies:

- open-the-focused-dock and close with `x` in the list/detail views;
- secondary dock keys in a real TUI: arrows, page keys, detail/back, history, stop selected, stop-all confirmation, rerun, output path, and failed/unread history surfacing;
- detail output-tail scrolling with real arrow/page keys: opening a long task's detail and pressing `↑` shows the `lines X–Y of N` position indicator and pauses the live tail.

The detail-view `Model:` line and the compact `model <id>` dock row are also exercised deterministically by the component layer (`tests/component/background-tasks-manager.test.ts`), which is the lowest reliable layer for dock rendering.

### Terminal keyboard-protocol negotiation

`pi` enables the Kitty keyboard protocol at startup by emitting `ESC[>7u ESC[?u ESC[c` and briefly intercepts stdin until that negotiation completes. The expect harness therefore must not key on a bare `>` (which matches the `ESC[>7u` push instantly and fires input before pi is listening); instead it waits for the steady-state status marker `(auto)`, answers the keyboard-protocol query (`ESC[?0u`, i.e. legacy keyboard) and the device-attributes query (`ESC[?1;2c`), and settles briefly before sending keys. This makes legacy keystrokes reach pi deterministically rather than racing the 150 ms negotiation fallback.

### Interactive-stdin capability probe

`test:pty` begins with a one-shot probe (`ptyInputSupported()`) that spawns a minimal raw-mode Node stdin reader under the same `/usr/bin/expect` driver and checks that a sent byte is received. Some hosts cannot deliver stdin to a raw-mode Node TUI through expect (a plain `cat` receives input but Node `process.stdin` does not). On such hosts every PTY case is skipped with a loud reason instead of failing; where stdin is deliverable the full interactive dock scenarios run for real. The deterministic SDK/RPC/component layers remain the authoritative gates in `npm run test` either way.

## Required isolated environment

Automated tests run with isolated temp project/agent/session directories and should use:

```bash
PI_OFFLINE=1
PI_SKIP_VERSION_CHECK=1
PI_TELEMETRY=0
CI=1
```

Tests must not use the user's real `~/.pi/agent`.

## Artifact policy

Use package-local or repo-level artifacts if future snapshot/log persistence is needed:

```text
artifacts/pi-extension-tests/pi-background-tasks/
├── summary.json
├── rpc-events.jsonl
├── tui-ansi.log
├── screen.normalized.txt
└── snapshots/
```

Normalize volatile values before snapshotting: task ids, session ids, PIDs, timestamps, durations, temp paths, and `.pi/tasks/<session-pid>/...` run directories.

## Remaining full exhaustive coverage work

The residual hardening items from the prior delegate/Fusion-era plan were removed with M0; the current scope (process background tasks and the EventBus service) is covered by default unit/SDK/RPC/component/package gates plus full PTY and scripted-provider gates. `TEST_PLAN.md` remains the source of truth for future edge-case additions, especially any new telemetry or stop-path surfaces added after this baseline.