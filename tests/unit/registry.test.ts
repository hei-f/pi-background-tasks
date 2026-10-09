import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildTaskNotificationContent,
  parseJsonText,
  shellQuote,
} from "../../src/core/common.js";
import {
  BackgroundTaskRegistry,
  TERMINAL_SUMMARY_TAIL_BYTES,
  WIN32_CMD_PI_TELEMETRY_UNAVAILABLE_REASON,
  commandMayLaunchPiAgent,
  type BackgroundTaskContext,
  type BackgroundTaskSpawn,
  type CompletionNotificationMessage,
  type CompletionNotificationOptions,
} from "../../src/core/registry.js";
import type {
  BgTask,
  BgTaskSnapshot,
  ReloadShellActivationLeaseV1,
  ReloadShellOwnerHubV1,
} from "../../src/core/common.js";
import {
  createReloadShellOwnerHubForTests,
  inspectReloadShellOwnerForTests,
  makeReloadShellIdentity,
} from "../../src/core/reload-shell-owner.js";
import type {
  TaskkillOutcome,
  WindowsKillPhase,
} from "../../src/core/windows-taskkill.js";
import {
  BackgroundTaskExtensionServiceClosedError,
  type BackgroundTaskTerminalPublication,
} from "../../src/core/extension-api.js";

type JsonObject = Record<PropertyKey, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** P4 断言辅助:POSIX 与 Windows 统一绝对路径判定。 */
function isPathAbsolute(value: string): boolean {
  return isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value);
}

function parseJsonObject(text: string, message: string): JsonObject {
  const parsed = parseJsonText(text);
  assert.ok(isJsonObject(parsed), message);
  return parsed;
}

function requiredJsonObject(value: unknown, message: string): JsonObject {
  assert.ok(isJsonObject(value), message);
  return value;
}

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid: number;
  killCalls: Array<NodeJS.Signals | undefined> = [];
  killImpl: (signal?: NodeJS.Signals) => boolean;

  constructor(pid: number, killImpl?: (signal?: NodeJS.Signals) => boolean) {
    super();
    this.pid = pid;
    this.killImpl = killImpl ?? (() => true);
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killCalls.push(signal);
    return this.killImpl(signal);
  }

  writeStdout(value: string): void {
    this.stdout.emit("data", Buffer.from(value, "utf8"));
  }

  writeStderr(value: string): void {
    this.stderr.emit("data", Buffer.from(value, "utf8"));
  }

  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.emit("close", code, signal);
  }

  fail(error: Error): void {
    this.emit("error", error);
  }
}

interface SpawnRecord {
  child: FakeChild;
  shell: string;
  args: string[];
  options: Parameters<BackgroundTaskSpawn>[2];
}

interface HarnessOptions {
  platform?: NodeJS.Platform;
  maxRecentTasks?: number;
  maxOutputBytes?: number;
  softOutputBytes?: number;
  killGraceMs?: number;
  stopWaitMs?: number;
  taskAdmissionTimeoutMs?: number;
  killProcess?: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  /** M3 ps 后代收集注入:单测以 fixture 取代真实 ps,缺省空集(退化组信号路径)。 */
  collectPosixDescendantPids?: (rootPid: number) => Promise<Set<number>>;
  killTree?: (
    pid: number,
    phase: WindowsKillPhase,
    signal?: AbortSignal,
  ) => Promise<TaskkillOutcome>;
  sendCompletionNotification?: (
    message: CompletionNotificationMessage,
    options: CompletionNotificationOptions,
  ) => void;
  /** S3 S1:通知批排水调度器注入(透传 registryOptions;缺省生产 queueMicrotask,
   * 需要手动控制排水时传捕获式 `(d) => { captured = d; }`)。 */
  scheduleDrain?: (drain: () => void) => void;
  /** M5:终态帧发布负载(任务快照 + 完成摘要)。 */
  publishTerminal?: (publication: BackgroundTaskTerminalPublication) => void;
  logger?: Pick<Console, "error" | "warn">;
  makeTaskId?: () => string;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  childFactory?: (pid: number) => FakeChild;
  spawn?: BackgroundTaskSpawn;
  modelRegistry?: BackgroundTaskContext["modelRegistry"];
  reloadShellOwner?: ReloadShellOwnerHubV1;
}

async function createHarness(options: HarnessOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-bg-registry-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  let pid = 4200;
  let idSeq = 0;
  const children: SpawnRecord[] = [];
  const notifications: Array<{
    message: CompletionNotificationMessage;
    options: CompletionNotificationOptions;
  }> = [];
  const errors: unknown[][] = [];
  const warns: unknown[][] = [];
  let changes = 0;
  const registryOptions: ConstructorParameters<
    typeof BackgroundTaskRegistry
  >[0] = {
    logger: options.logger ?? {
      error: (...args: unknown[]) => {
        errors.push(args);
      },
      warn: (...args: unknown[]) => {
        warns.push(args);
      },
    },
    makeTaskId:
      options.makeTaskId ?? (() => `bunit${String(++idSeq).padStart(3, "0")}`),
    sendCompletionNotification:
      options.sendCompletionNotification ??
      ((message, opts) => {
        notifications.push({ message, options: opts });
      }),
    onChange: () => {
      changes++;
    },
    ...(options.reloadShellOwner === undefined
      ? {}
      : { reloadShellOwner: options.reloadShellOwner }),
    spawn:
      options.spawn ??
      ((shell, args, spawnOptions) => {
        const child = options.childFactory?.(++pid) ?? new FakeChild(++pid);
        children.push({ child, shell, args: [...args], options: spawnOptions });
        return child;
      }),
    collectPosixDescendantPids:
      options.collectPosixDescendantPids ?? (async () => new Set()),
  };
  if (options.publishTerminal !== undefined)
    registryOptions.publishTerminal = options.publishTerminal;
  if (options.platform !== undefined)
    registryOptions.platform = options.platform;
  if (options.env !== undefined) registryOptions.env = options.env;
  if (options.maxRecentTasks !== undefined)
    registryOptions.maxRecentTasks = options.maxRecentTasks;
  if (options.maxOutputBytes !== undefined)
    registryOptions.maxOutputBytes = options.maxOutputBytes;
  if (options.softOutputBytes !== undefined)
    registryOptions.softOutputBytes = options.softOutputBytes;
  if (options.killGraceMs !== undefined)
    registryOptions.killGraceMs = options.killGraceMs;
  if (options.stopWaitMs !== undefined)
    registryOptions.stopWaitMs = options.stopWaitMs;
  if (options.taskAdmissionTimeoutMs !== undefined)
    registryOptions.taskAdmissionTimeoutMs = options.taskAdmissionTimeoutMs;
  // S3 P5:运行时目录迁宿主私有 agent 目录——单测注入临时 agentDir 保持隔离
  registryOptions.agentDir = agentDir;
  if (options.scheduleDrain !== undefined)
    registryOptions.scheduleDrain = options.scheduleDrain;
  if (options.now !== undefined) registryOptions.now = options.now;
  if (options.killProcess !== undefined)
    registryOptions.killProcess = options.killProcess;
  if (options.killTree !== undefined)
    registryOptions.killTree = options.killTree;
  const registry = new BackgroundTaskRegistry(registryOptions);
  const ctx: BackgroundTaskContext = {
    cwd,
    sessionId: "registry-test",
    modelRegistry: options.modelRegistry ?? { getAll: () => [] },
    model: undefined,
  };
  return {
    root,
    cwd,
    agentDir,
    ctx,
    registry,
    children,
    notifications,
    errors,
    warns,
    get changes() {
      return changes;
    },
  };
}

async function cleanup(root: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !/ENOTEMPTY/.test(error.message) ||
        attempt === 4
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message = "condition",
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

/** S3 S1 捕获式排水触发:等待首个入队调度出排水回调后手动执行。
 * 排水回调在微任务内同步取空队列,调用即完成本批投递(空队列调用为无害 no-op)。 */
async function drainCaptured(
  getCaptured: () => (() => void) | undefined,
  label: string,
  timeoutMs = 1000,
): Promise<void> {
  await waitFor(
    () => getCaptured() !== undefined,
    `${label} drain scheduled`,
    timeoutMs,
  );
  const drain = getCaptured();
  assert.ok(drain, `${label} drain callback must be captured`);
  drain();
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      Reflect.get(error, "code") === "ESRCH"
    );
  }
}

function pgidFor(pid: number): number | undefined {
  const result = spawnSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], {
    encoding: "utf8",
  });
  if (result.status !== 0) return undefined;
  const pgid = Number(result.stdout.trim());
  return Number.isSafeInteger(pgid) && pgid > 0 ? pgid : undefined;
}

function errnoError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

async function waitForPidExit(
  pid: number,
  label: string,
  timeoutMs = 1000,
): Promise<void> {
  await waitFor(
    () => !pidExists(pid),
    `${label} pid ${String(pid)} exit`,
    timeoutMs,
  );
}

async function filesBelow(path: string): Promise<string[]> {
  if (!existsSync(path)) return [];
  const files: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) await visit(child);
      else files.push(child);
    }
  };
  await visit(path);
  return files;
}

async function readJsonEventually(
  path: string,
  timeoutMs = 1000,
): Promise<JsonObject> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    last = await readFile(path, "utf8").catch(() => "");
    try {
      if (last.trim())
        return parseJsonObject(last, "metadata JSON must be an object");
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return parseJsonObject(last, "metadata JSON must be an object");
}

function lastSpawn(h: Awaited<ReturnType<typeof createHarness>>): SpawnRecord {
  const spawn = h.children.at(-1);
  assert.ok(spawn, "test harness should have recorded a child process spawn");
  return spawn;
}

function taskkillOutcome(
  exitCode: number | null,
  stderr = "",
): TaskkillOutcome {
  return {
    exitCode,
    signal: null,
    stdout: "",
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolveFn: ((value: T) => void) | undefined;
  let rejectFn: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  assert.ok(resolveFn, "deferred resolve should initialize");
  assert.ok(rejectFn, "deferred reject should initialize");
  return { promise, resolve: resolveFn, reject: rejectFn };
}

function isKillRequester(
  value: unknown,
): value is (task: BgTask, signal?: NodeJS.Signals) => void {
  return typeof value === "function";
}

function requestKillForTest(
  registry: BackgroundTaskRegistry,
  task: BgTask,
  signal?: NodeJS.Signals,
): void {
  const method = Reflect.get(registry, "requestKill");
  assert.ok(isKillRequester(method), "registry requestKill should be callable");
  method.call(registry, task, signal);
}

async function startFakeTask(
  h: Awaited<ReturnType<typeof createHarness>>,
  name = "Registry Task",
): Promise<{ task: BgTask; child: FakeChild }> {
  const task = await h.registry.startTask(h.ctx, "node fake.js", {
    name,
    isAgent: false,
    notifyOnCompletion: true,
    triggerOnCompletion: true,
  });
  return { task, child: lastSpawn(h).child };
}

void describe("BackgroundTaskRegistry", () => {
  void it("validates reload survival before admission, filesystem, insertion, wrapper, or spawn", async () => {
    const hub = createReloadShellOwnerHubForTests();
    const h = await createHarness({ reloadShellOwner: hub });
    let ensureCalls = 0;
    const originalEnsureRuntimeDir = h.registry.ensureRuntimeDir.bind(
      h.registry,
    );
    h.registry.ensureRuntimeDir = async (ctx) => {
      ensureCalls += 1;
      return originalEnsureRuntimeDir(ctx);
    };
    try {
      await assert.rejects(
        () =>
          h.registry.startTask(h.ctx, "echo malformed", {
            isAgent: false,
            surviveReload: "yes",
          } as never),
        /pi_bg_survive_reload_invalid/u,
      );
      await assert.rejects(
        () =>
          h.registry.startTask(h.ctx, "pi -p agent", {
            isAgent: true,
            surviveReload: true,
          }),
        /pi_bg_survive_reload_requires_non_agent/u,
      );
      await assert.rejects(
        () =>
          h.registry.startTask(h.ctx, "echo unavailable", {
            isAgent: false,
            surviveReload: true,
          }),
        /pi_bg_reload_owner_unavailable/u,
      );
      assert.equal(ensureCalls, 0);
      assert.equal(h.children.length, 0);
      assert.equal(h.registry.allTasks().length, 0);
      assert.deepEqual(await filesBelow(join(h.agentDir)), []);
    } finally {
      h.registry.setShuttingDown(true);
      await cleanup(h.root);
    }
  });

  void it("starts a real owner-backed ordinary consumer only after activation and admission commit", async () => {
    const hub = createReloadShellOwnerHubForTests({ handoffTimeoutMs: 1000 });
    const h = await createHarness({
      reloadShellOwner: hub,
      killGraceMs: 10,
      stopWaitMs: 200,
      killProcess: () => true,
    });
    const identity = makeReloadShellIdentity(
      h.ctx.sessionId ?? "",
      realpathSync(h.cwd),
    );
    const claim = hub.beginActivation(identity, "startup", "a".repeat(32));
    const adapter = await h.registry.stageReloadActivation(claim);
    const lease = hub.commitActivation(claim, adapter);
    try {
      const task = await h.registry.startTask(h.ctx, "node owner-consumer.js", {
        name: "Owner consumer",
        isAgent: false,
        surviveReload: true,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const child = lastSpawn(h).child;
      assert.equal(task.surviveReload, true);
      const execution = task.reloadExecution;
      assert.ok(execution);
      assert.equal(execution.admissionCommitted, true);
      assert.equal(execution.child, child);
      assert.equal(task.reloadSurvival?.authority, "same-process-live-owner");
      assert.equal(task.reloadSurvival?.hostPid, process.pid);
      assert.equal(task.reloadSurvival?.sessionId, h.ctx.sessionId);
      assert.equal(task.reloadSurvival?.cwdRealpath, realpathSync(h.cwd));
      assert.equal(task.reloadSurvival?.childPid, child.pid);
      assert.equal(task.reloadSurvival?.leaseGeneration, 1);
      assert.equal(task.reloadSurvival?.handoffCount, 0);
      assert.match(task.reloadSurvival?.launchNonce ?? "", /^[0-9a-f]{32}$/u);
      assert.equal(task.reloadSurvival?.completionId, `${task.id}:1`);
      assert.equal(
        task.telemetryWrapped,
        undefined,
        "opted ordinary work never creates a Pi wrapper",
      );
      assert.equal(hub.isCurrentLease(lease), true);

      child.writeStdout("owner-output\n");
      child.close(0, null);
      await waitFor(
        () => task.status === "completed",
        "owner-backed completion",
      );
      assert.equal(task.exitCode, 0);
      assert.equal(execution.closeObservation?.code, 0);
      await waitFor(
        () => task.reloadExecution === undefined,
        "released terminal execution reference",
      );
      assert.match(await readFile(task.outputAbsPath, "utf8"), /owner-output/u);
      await waitFor(async () => {
        const metadata = await readJsonEventually(task.metadataAbsPath);
        return metadata["status"] === "completed";
      }, "owner metadata completion");
      const metadata = await readJsonEventually(task.metadataAbsPath);
      assert.equal(metadata["surviveReload"], true);
      assert.deepEqual(metadata["reloadSurvival"], task.reloadSurvival);
    } finally {
      h.registry.releaseReloadActivation(lease);
      h.registry.setShuttingDown(true);
      for (const { child } of h.children) {
        if (child.listenerCount("close") > 0) child.close(null, "SIGTERM");
      }
      await cleanup(h.root);
    }
  });

  void it("retains a real failed-admission child owner until natural terminal settlement", async () => {
    if (process.platform === "win32") return;
    const hub = createReloadShellOwnerHubForTests({ handoffTimeoutMs: 1000 });
    let projectAgentDir = "";
    let child: ReturnType<typeof spawn> | undefined;
    const signals: string[] = [];
    const h = await createHarness({
      reloadShellOwner: hub,
      stopWaitMs: 80,
      killGraceMs: 20,
      spawn: (command, args, options) => {
        // S3 P5:metadata 写入宿主私有 agent 目录——删其 tasks 层模拟写入失败
        rmSync(join(projectAgentDir, "tasks"), {
          recursive: true,
          force: true,
        });
        child = spawn(command, args, options);
        return child;
      },
      killProcess: (_pid, signal) => {
        signals.push(String(signal));
        return true;
      },
    });
    projectAgentDir = h.agentDir;
    const identity = makeReloadShellIdentity(
      h.ctx.sessionId ?? "",
      realpathSync(h.cwd),
    );
    const claim = hub.beginActivation(identity, "startup", "1".repeat(32));
    const lease = hub.commitActivation(
      claim,
      await h.registry.stageReloadActivation(claim),
    );
    let execution = inspectReloadShellOwnerForTests(hub, identity)
      .executions[0];
    let passingAssertionsCompleted = false;
    try {
      const launch = h.registry.startTask(
        h.ctx,
        `node -e ${JSON.stringify("setTimeout(() => process.exit(0), 260)")}`,
        {
          name: "Failed admission owner retention",
          isAgent: false,
          surviveReload: true,
          notifyOnCompletion: false,
          triggerOnCompletion: false,
        },
      );
      await waitFor(() => {
        execution = inspectReloadShellOwnerForTests(hub, identity)
          .executions[0];
        return execution !== undefined;
      }, "failed-admission execution registration");
      await assert.rejects(
        launch,
        /cleanup also failed|Failed to start background task/u,
      );

      const pid = child?.pid;
      assert.equal(typeof pid, "number");
      assert.ok(execution);
      assert.equal(
        pidExists(pid as number),
        true,
        "real child must still be live at rejection",
      );
      assert.equal(
        h.registry.allTasks().length,
        0,
        "rejected launch must leave no registry task",
      );
      assert.equal(
        inspectReloadShellOwnerForTests(hub, identity).executions.length,
        1,
      );
      assert.equal(
        execution.child,
        child,
        "owner must retain the only live child handle",
      );
      assert.notEqual(execution.phase, "released");
      assert.notEqual(
        execution.task.status,
        "completed",
        "admission failure cannot fake success",
      );
      assert.ok(signals.includes("SIGTERM"));
      assert.ok(signals.includes("SIGKILL"));

      h.registry.releaseReloadActivation(lease);
      const hostless = inspectReloadShellOwnerForTests(hub, identity);
      assert.equal(hostless.phase, "releasing");
      assert.equal(hostless.hasAdapter, false);
      assert.equal(
        hostless.executions[0],
        execution,
        "cleanup must not require a host adapter",
      );
      assert.equal(execution.child, child);

      await waitFor(
        () => !pidExists(pid as number),
        "failed-admission child natural exit",
        2000,
      );
      await waitFor(
        () =>
          inspectReloadShellOwnerForTests(hub, identity).executions.length ===
          0,
        "failed-admission owner terminal release",
        2000,
      );
      assert.equal(execution.phase, "released");
      assert.equal(execution.child, undefined);
      assert.equal(execution.task.status, "failed");
      passingAssertionsCompleted = true;
    } finally {
      const pid = child?.pid;
      if (!passingAssertionsCompleted && pid !== undefined && pidExists(pid)) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Failure-only rescue; passing assertions require natural settlement.
          }
        }
        await waitFor(
          () => !pidExists(pid),
          "failed-admission failure-only cleanup",
          2000,
        ).catch(() => undefined);
      }
      h.registry.releaseReloadActivation(lease);
      h.registry.setShuttingDown(true);
      await cleanup(h.root);
    }
  });

  void it("carries the R1 publication ledger across handoff with one cumulative three-attempt budget", async () => {
    const hub = createReloadShellOwnerHubForTests({ handoffTimeoutMs: 1000 });
    let oldAttempts = 0;
    const h = await createHarness({
      reloadShellOwner: hub,
      publishTerminal: () => {
        oldAttempts += 1;
        throw new Error("old activation listener failure");
      },
    });
    const identity = makeReloadShellIdentity(
      h.ctx.sessionId ?? "",
      realpathSync(h.cwd),
    );
    const firstClaim = hub.beginActivation(identity, "startup", "9".repeat(32));
    const firstAdapter = await h.registry.stageReloadActivation(firstClaim);
    const firstLease = hub.commitActivation(firstClaim, firstAdapter);
    let freshLease: ReloadShellActivationLeaseV1 | undefined;
    let fresh: BackgroundTaskRegistry | undefined;
    try {
      const task = await h.registry.startTask(
        h.ctx,
        "node publication-owner.js",
        {
          name: "Publication owner",
          isAgent: false,
          surviveReload: true,
          notifyOnCompletion: false,
          triggerOnCompletion: false,
        },
      );
      const child = lastSpawn(h).child;
      child.close(0, null);
      await waitFor(
        () =>
          task.terminalPublishAttempts === 1 &&
          task.terminalPublishRetryHandle !== undefined,
        "first owner publication retry",
      );
      assert.equal(task.terminalPublicationState, "pending");
      h.registry.prepareReloadHandoff(firstLease);
      assert.equal(task.terminalPublishRetryHandle, undefined);

      const freshPublications: BgTaskSnapshot[] = [];
      fresh = new BackgroundTaskRegistry({
        reloadShellOwner: hub,
        sendCompletionNotification() {},
        publishTerminal: (publication) =>
          freshPublications.push(publication.task),
        spawn: () => {
          throw new Error("fresh registry must not respawn terminal execution");
        },
      });
      const claim = hub.beginActivation(
        identity,
        "reload",
        "a".repeat(31) + "b",
      );
      const adapter = await fresh.stageReloadActivation(claim);
      freshLease = hub.commitActivation(claim, adapter);
      await waitFor(
        () => task.terminalPublicationState === "delivered",
        "fresh publication",
      );
      assert.equal(oldAttempts, 1);
      assert.equal(task.terminalPublishAttempts, 2);
      assert.equal(task.terminalPublished, true);
      assert.equal(
        freshPublications.filter((entry) => entry.id === task.id).length,
        1,
      );
      await waitFor(
        () => task.reloadExecution === undefined,
        "published owner release",
      );
    } finally {
      if (fresh !== undefined && freshLease !== undefined) {
        fresh.releaseReloadActivation(freshLease);
        fresh.setShuttingDown(true);
      }
      h.registry.setShuttingDown(true);
      await cleanup(h.root);
    }
  });

  void it("leaves a reentrant reload throw pending for cumulative fresh attempt two", async () => {
    const hub = createReloadShellOwnerHubForTests({ handoffTimeoutMs: 1000 });
    let oldLease: ReloadShellActivationLeaseV1 | undefined;
    let detached = false;
    let oldAttempts = 0;
    const h = await createHarness({
      reloadShellOwner: hub,
      publishTerminal: () => {
        oldAttempts += 1;
        const lease = oldLease;
        if (lease === undefined)
          throw new Error("old lease was not initialized");
        if (!detached) {
          detached = true;
          h.registry.prepareReloadHandoff(lease);
          h.registry.closeTerminalPublication("publisher_closed");
        }
        throw new Error(
          "synthetic listener failure after reentrant reload detach",
        );
      },
    });
    const identity = makeReloadShellIdentity(
      h.ctx.sessionId ?? "",
      realpathSync(h.cwd),
    );
    const firstClaim = hub.beginActivation(identity, "startup", "2".repeat(32));
    oldLease = hub.commitActivation(
      firstClaim,
      await h.registry.stageReloadActivation(firstClaim),
    );
    let fresh: BackgroundTaskRegistry | undefined;
    let freshLease: ReloadShellActivationLeaseV1 | undefined;
    try {
      const task = await h.registry.startTask(
        h.ctx,
        "node reentrant-publication.js",
        {
          name: "Reentrant publication handoff",
          isAgent: false,
          surviveReload: true,
          notifyOnCompletion: false,
          triggerOnCompletion: false,
        },
      );
      lastSpawn(h).child.close(0, null);
      await waitFor(() => detached, "reentrant publication detach");
      await waitFor(
        () => task.status === "completed",
        "reentrant publication terminal",
      );

      const stateAfterThrow = task.terminalPublicationState;
      const reasonAfterThrow = task.terminalPublicationAbandonReason;
      const attemptsAfterThrow = task.terminalPublishAttempts;
      const retryAfterThrow = task.terminalPublishRetryHandle;
      const oldErrorCount = h.errors.length;

      const freshPublications: BgTaskSnapshot[] = [];
      fresh = new BackgroundTaskRegistry({
        reloadShellOwner: hub,
        sendCompletionNotification() {},
        publishTerminal: (publication) =>
          freshPublications.push(publication.task),
        spawn: () => {
          throw new Error(
            "fresh registry must not respawn a terminal execution",
          );
        },
      });
      const claim = hub.beginActivation(identity, "reload", "3".repeat(32));
      freshLease = hub.commitActivation(
        claim,
        await fresh.stageReloadActivation(claim),
      );
      await waitFor(
        () => task.reloadExecution === undefined,
        "reentrant owner release",
      );

      assert.equal(stateAfterThrow, "pending");
      assert.equal(reasonAfterThrow, undefined);
      assert.equal(attemptsAfterThrow, 1);
      assert.equal(
        retryAfterThrow,
        undefined,
        "old registry must not schedule a retry",
      );
      assert.equal(
        oldErrorCount,
        0,
        "transferred throw must not log old-host abandonment",
      );
      assert.equal(oldAttempts, 1);
      assert.equal(task.terminalPublicationState, "delivered");
      assert.equal(task.terminalPublicationAbandonReason, undefined);
      assert.equal(task.terminalPublishAttempts, 2);
      assert.equal(
        freshPublications.filter((entry) => entry.id === task.id).length,
        1,
      );
      assert.deepEqual(
        inspectReloadShellOwnerForTests(hub, identity).executions,
        [],
      );
    } finally {
      if (fresh !== undefined && freshLease !== undefined) {
        fresh.releaseReloadActivation(freshLease);
        fresh.setShuttingDown(true);
      }
      h.registry.setShuttingDown(true);
      await cleanup(h.root);
    }
  });

  void it("imports the same execution into a fresh registry and keeps one cumulative output cap", async () => {
    const hub = createReloadShellOwnerHubForTests({ handoffTimeoutMs: 1000 });
    let child: FakeChild | undefined;
    let groupPresent = true;
    const killProcess = (
      _pid: number,
      signal?: NodeJS.Signals | number,
    ): boolean => {
      if (signal === 0) {
        if (groupPresent) return true;
        throw errnoError("ESRCH", "group gone");
      }
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        groupPresent = false;
        queueMicrotask(() => child?.close(null, signal));
        return true;
      }
      return true;
    };
    const h = await createHarness({
      reloadShellOwner: hub,
      maxOutputBytes: 10,
      killGraceMs: 10,
      stopWaitMs: 200,
      killProcess,
    });
    const identity = makeReloadShellIdentity(
      h.ctx.sessionId ?? "",
      realpathSync(h.cwd),
    );
    const initialClaim = hub.beginActivation(
      identity,
      "startup",
      "c".repeat(32),
    );
    const initialAdapter = await h.registry.stageReloadActivation(initialClaim);
    const initialLease = hub.commitActivation(initialClaim, initialAdapter);
    let freshLease: ReloadShellActivationLeaseV1 | undefined;
    let fresh: BackgroundTaskRegistry | undefined;
    try {
      const task = await h.registry.startTask(h.ctx, "node cap-owner.js", {
        name: "Cumulative cap",
        isAgent: false,
        surviveReload: true,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      child = lastSpawn(h).child;
      child.writeStdout("123456");
      assert.equal(task.bytesWritten, 6);
      const execution = task.reloadExecution;
      assert.ok(execution);
      h.registry.prepareReloadHandoff(initialLease);

      const published: BgTaskSnapshot[] = [];
      fresh = new BackgroundTaskRegistry({
        reloadShellOwner: hub,
        maxOutputBytes: 10,
        killGraceMs: 10,
        stopWaitMs: 200,
        killProcess,
        platform: process.platform,
        env: process.env,
        sendCompletionNotification() {},
        publishTerminal: (publication) => published.push(publication.task),
        spawn: () => {
          throw new Error(
            "fresh registry must not respawn a claimed execution",
          );
        },
      });
      const claim = hub.beginActivation(identity, "reload", "d".repeat(32));
      const adapter = await fresh.stageReloadActivation(claim);
      freshLease = hub.commitActivation(claim, adapter);
      assert.equal(fresh.resolveTask(task.id), task);
      assert.equal(task.reloadExecution, execution);
      assert.equal(task.bytesWritten, 6);

      child.writeStdout("789012");
      await waitFor(() => task.status === "failed", "cumulative cap terminal");
      assert.equal(task.capExceeded, true);
      assert.match(task.error ?? "", /Output exceeded cap of 10B/u);
      assert.equal(task.reloadSurvival?.outputCapBytes, 10);
      assert.equal(task.reloadSurvival?.handoffCount, 1);
      // REVIEW 时序修复:终态发布在 await 关口之后,须等待发布落地再断言内容
      await waitFor(
        () => published.filter((entry) => entry.id === task.id).length === 1,
        "cumulative cap terminal publication",
      );
      assert.equal(published.filter((entry) => entry.id === task.id).length, 1);
      const logs = await fresh.getTaskLogs(task, 1024, true);
      assert.match(logs.text, /1234567890/u);
      assert.doesNotMatch(logs.text, /123456789012/u);
      await waitFor(
        () => task.reloadExecution === undefined,
        "cap owner release",
      );
    } finally {
      if (fresh !== undefined && freshLease !== undefined) {
        fresh.releaseReloadActivation(freshLease);
        fresh.setShuttingDown(true);
      }
      h.registry.setShuttingDown(true);
      child?.close(null, "SIGTERM");
      await cleanup(h.root);
    }
  });

  void it("retains injected Windows taskkill tree authority across a registry handoff", async () => {
    const hub = createReloadShellOwnerHubForTests({ handoffTimeoutMs: 1000 });
    const phases: WindowsKillPhase[] = [];
    let child: FakeChild | undefined;
    let softAborted = 0;
    const killTree = async (
      _pid: number,
      phase: WindowsKillPhase,
      signal?: AbortSignal,
    ): Promise<TaskkillOutcome> => {
      phases.push(phase);
      if (phase === "terminate") {
        return new Promise<TaskkillOutcome>((resolve) => {
          signal?.addEventListener(
            "abort",
            () => {
              softAborted += 1;
              resolve(taskkillOutcome(null, "aborted"));
            },
            { once: true },
          );
        });
      }
      queueMicrotask(() => child?.close(null, "SIGTERM"));
      return taskkillOutcome(0);
    };
    const h = await createHarness({
      reloadShellOwner: hub,
      platform: "win32",
      env: { SystemRoot: "C:\\Windows", ComSpec: "cmd.exe" },
      killTree,
      killGraceMs: 10,
      stopWaitMs: 300,
    });
    const identity = makeReloadShellIdentity(
      h.ctx.sessionId ?? "",
      realpathSync(h.cwd),
    );
    const firstClaim = hub.beginActivation(identity, "startup", "e".repeat(32));
    const firstAdapter = await h.registry.stageReloadActivation(firstClaim);
    const firstLease = hub.commitActivation(firstClaim, firstAdapter);
    let freshLease: ReloadShellActivationLeaseV1 | undefined;
    let fresh: BackgroundTaskRegistry | undefined;
    try {
      const task = await h.registry.startTask(h.ctx, "echo windows-owner", {
        name: "Windows owner",
        isAgent: false,
        surviveReload: true,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      child = lastSpawn(h).child;
      const originalExecution = task.reloadExecution;
      h.registry.prepareReloadHandoff(firstLease);

      fresh = new BackgroundTaskRegistry({
        reloadShellOwner: hub,
        platform: "win32",
        env: { SystemRoot: "C:\\Windows", ComSpec: "cmd.exe" },
        killTree,
        killGraceMs: 10,
        stopWaitMs: 300,
        sendCompletionNotification() {},
        spawn: () => {
          throw new Error("claimed Windows execution must not respawn");
        },
      });
      const claim = hub.beginActivation(identity, "reload", "f".repeat(32));
      const adapter = await fresh.stageReloadActivation(claim);
      freshLease = hub.commitActivation(claim, adapter);
      assert.equal(task.reloadExecution, originalExecution);
      assert.equal(task.reloadExecution?.child, child);

      await fresh.stopTask(task, "user");
      // user 发起停止 → cancelled(M2 迁移表)
      assert.equal(task.status, "cancelled");
      assert.deepEqual(phases, ["terminate", "force"]);
      assert.equal(softAborted, 1);
      assert.deepEqual(
        child.killCalls,
        [],
        "Windows owner must never fall back to root-only child.kill",
      );
      await waitFor(
        () => task.reloadExecution === undefined,
        "Windows owner release",
      );
    } finally {
      if (fresh !== undefined && freshLease !== undefined) {
        fresh.releaseReloadActivation(freshLease);
        fresh.setShuttingDown(true);
      }
      h.registry.setShuttingDown(true);
      child?.close(null, "SIGTERM");
      await cleanup(h.root);
    }
  });

  void it("uses the short no-claim seam to stop and reap a real opted process without adoption", async () => {
    if (process.platform === "win32") return;
    const hub = createReloadShellOwnerHubForTests({
      handoffTimeoutMs: 40,
      logger: { error() {} },
    });
    const h = await createHarness({
      reloadShellOwner: hub,
      spawn: (command, args, options) => spawn(command, args, options),
      killGraceMs: 20,
      stopWaitMs: 500,
    });
    const identity = makeReloadShellIdentity(
      h.ctx.sessionId ?? "",
      realpathSync(h.cwd),
    );
    const claim = hub.beginActivation(identity, "startup", "b".repeat(32));
    const adapter = await h.registry.stageReloadActivation(claim);
    const lease = hub.commitActivation(claim, adapter);
    let pid: number | undefined;
    try {
      const task = await h.registry.startTask(
        h.ctx,
        `node -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
        {
          name: "No claimant",
          isAgent: false,
          surviveReload: true,
          notifyOnCompletion: false,
          triggerOnCompletion: false,
        },
      );
      pid = task.pid;
      assert.equal(typeof pid, "number");
      const execution = task.reloadExecution;
      assert.ok(execution);
      h.registry.prepareReloadHandoff(lease);
      await waitFor(
        () => execution.phase === "released",
        "orphan owner release",
        2000,
      );
      assert.equal(task.status, "failed");
      assert.match(task.error ?? "", /pi_bg_reload_handoff_expired/u);
      assert.equal(task.terminalPublicationState, "abandoned");
      assert.equal(
        task.terminalPublicationAbandonReason,
        "reload_handoff_expired",
      );
      if (pid !== undefined) assert.equal(pidExists(pid), false);
      assert.deepEqual(
        inspectReloadShellOwnerForTests(hub, identity).executions,
        [],
      );
    } finally {
      if (pid !== undefined && pidExists(pid)) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // Failure-only rescue; passing assertions above require this to be unnecessary.
        }
      }
      h.registry.setShuttingDown(true);
      await cleanup(h.root);
    }
  });

  void it("releases a real late-closing child after handoff deadline stop timeout", async () => {
    if (process.platform === "win32") return;
    const logs: string[] = [];
    const hub = createReloadShellOwnerHubForTests({
      handoffTimeoutMs: 20,
      logger: {
        error: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
      },
    });
    let child: ReturnType<typeof spawn> | undefined;
    const h = await createHarness({
      reloadShellOwner: hub,
      stopWaitMs: 100,
      killGraceMs: 25,
      spawn: (command, args, options) => {
        child = spawn(command, args, options);
        return child;
      },
      killProcess: () => true,
    });
    const identity = makeReloadShellIdentity(
      h.ctx.sessionId ?? "",
      realpathSync(h.cwd),
    );
    const claim = hub.beginActivation(identity, "startup", "4".repeat(32));
    const lease = hub.commitActivation(
      claim,
      await h.registry.stageReloadActivation(claim),
    );
    let replacementLease: ReloadShellActivationLeaseV1 | undefined;
    let passingAssertionsCompleted = false;
    try {
      const task = await h.registry.startTask(
        h.ctx,
        `node -e ${JSON.stringify("setTimeout(() => process.exit(0), 260)")}`,
        {
          name: "Deadline late close",
          isAgent: false,
          surviveReload: true,
          notifyOnCompletion: false,
          triggerOnCompletion: false,
        },
      );
      const pid = child?.pid;
      const execution = task.reloadExecution;
      assert.equal(typeof pid, "number");
      assert.ok(execution);
      h.registry.prepareReloadHandoff(lease);

      // 负载下固定等待不足:先等待 stop 路径结算(pid 消失 + 终态 + execution 释放),
      // 再断言其余状态,消除环境性 flaky。
      await waitFor(
        () =>
          !pidExists(pid as number) &&
          task.status === "failed" &&
          execution.phase === "released",
        "handoff deadline stop settles",
        5000,
      );

      assert.equal(pidExists(pid as number), false);
      assert.equal(task.status, "failed");
      assert.match(task.error ?? "", /pi_bg_reload_handoff_expired/u);
      assert.equal(execution.phase, "released");
      assert.equal(execution.child, undefined);
      assert.deepEqual(
        inspectReloadShellOwnerForTests(hub, identity).executions,
        [],
      );
      assert.match(logs.join("\n"), /reload handoff expiry could not settle/u);

      const replacement = hub.beginActivation(
        identity,
        "startup",
        "5".repeat(32),
      );
      replacementLease = hub.commitActivation(
        replacement,
        await h.registry.stageReloadActivation(replacement),
      );
      assert.equal(hub.isCurrentLease(replacementLease), true);
      passingAssertionsCompleted = true;
    } finally {
      const pid = child?.pid;
      if (!passingAssertionsCompleted && pid !== undefined && pidExists(pid)) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Failure-only rescue; passing assertions require the natural close.
          }
        }
        await waitFor(
          () => !pidExists(pid),
          "deadline late-close failure-only cleanup",
          2000,
        ).catch(() => undefined);
      }
      if (replacementLease !== undefined)
        h.registry.releaseReloadActivation(replacementLease);
      h.registry.setShuttingDown(true);
      await cleanup(h.root);
    }
  });

  void it("preserves full shell command bytes except surrounding whitespace", async () => {
    const h = await createHarness({ platform: "linux" });
    try {
      const command = `'${process.execPath}' '${join(h.cwd, "bin", "autopilot-agent-run.mjs")}' --spec '${join(h.cwd, "specs", "unit spec.json")}'`;
      const task = await h.registry.startTask(h.ctx, `  ${command}  `, {
        name: "Quoted Runner",
        isAgent: true,
        notifyOnCompletion: false,
      });
      const spawn = lastSpawn(h);
      assert.equal(task.command, command);
      assert.equal(spawn.args.at(-1), command);
      assert.equal(
        JSON.parse(readFileSync(task.metadataAbsPath, "utf8")).command,
        command,
      );
    } finally {
      await cleanup(h.root);
    }
  });

  void it("uses explicit isAgent to decide Pi telemetry wrapping", async () => {
    assert.equal(commandMayLaunchPiAgent("pi -p hello"), true);
    assert.equal(
      commandMayLaunchPiAgent("/usr/local/bin/pi -p hello"),
      false,
      "shell-function wrapper cannot intercept path-qualified pi commands",
    );

    const h = await createHarness({ platform: "linux" });
    try {
      const scriptLikePi = await h.registry.startTask(h.ctx, "pi -p hello", {
        name: "Plain Pi Script",
        isAgent: false,
        notifyOnCompletion: false,
      });
      assert.equal(scriptLikePi.isAgent, false);
      assert.doesNotMatch(lastSpawn(h).args.join("\n"), /pi-telemetry-wrapper/);

      const agentPi = await h.registry.startTask(h.ctx, "pi -p hello", {
        name: "Agent Pi",
        isAgent: true,
        notifyOnCompletion: false,
      });
      assert.equal(agentPi.isAgent, true);
      const wrappedCommand = lastSpawn(h).args.join("\n");
      assert.match(wrappedCommand, /pi\(\) \{ .*pi-telemetry-wrapper\.cjs/);
      assert.ok(wrappedCommand.includes(process.execPath));
      assert.doesNotMatch(wrappedCommand, /pi\(\) \{ node /);
      const wrapperPath = join(
        dirname(agentPi.outputAbsPath),
        `${agentPi.id}.pi-telemetry-wrapper.cjs`,
      );
      const wrapperSource = await readFile(wrapperPath, "utf8");
      assert.match(wrapperSource, /const launch = /);
      assert.match(
        wrapperSource,
        /spawn\(launch\.executable, childArgs, \{[^}]*shell: false/,
      );
      assert.doesNotMatch(wrapperSource, /spawn\("pi"/);
      assert.doesNotThrow(
        () =>
          new Function(
            "require",
            "process",
            wrapperSource.replace(/^#!.*\n/, ""),
          ),
      );

      const pathQualifiedPi = await h.registry.startTask(
        h.ctx,
        "/usr/local/bin/pi -p hello",
        {
          name: "Path Pi",
          isAgent: true,
          notifyOnCompletion: false,
        },
      );
      assert.equal(pathQualifiedPi.isAgent, true);
      assert.doesNotMatch(lastSpawn(h).args.join("\n"), /pi-telemetry-wrapper/);
    } finally {
      await cleanup(h.root);
    }

    const disabled = await createHarness({
      env: { ...process.env, PI_BG_DISABLE_PI_TELEMETRY: "1" },
    });
    try {
      await disabled.registry.startTask(disabled.ctx, "pi -p hello", {
        name: "Disabled Agent",
        isAgent: true,
        notifyOnCompletion: false,
      });
      assert.doesNotMatch(
        lastSpawn(disabled).args.join("\n"),
        /pi-telemetry-wrapper/,
      );
    } finally {
      await cleanup(disabled.root);
    }
  });

  void it("leaves Pi agent commands unchanged under Windows cmd and records telemetry unavailability", async () => {
    const h = await createHarness({
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    });
    try {
      const command = 'pi --mode json "hello & echo pwned"';
      const task = await h.registry.startTask(h.ctx, command, {
        name: "Cmd Pi Agent",
        isAgent: true,
        notifyOnCompletion: false,
      });
      const spawn = lastSpawn(h);
      assert.equal(task.command, command);
      assert.equal(spawn.shell, "C:\\Windows\\System32\\cmd.exe");
      assert.deepEqual(spawn.args, ["/d", "/s", "/c", `"${command}"`]);
      assert.equal(spawn.options.shell, undefined);
      assert.equal(spawn.options.windowsVerbatimArguments, true);
      assert.equal(task.telemetryWrapped, undefined);
      assert.equal(
        task.telemetryUnavailableReason,
        WIN32_CMD_PI_TELEMETRY_UNAVAILABLE_REASON,
      );
      const files = await readdir(dirname(task.outputAbsPath));
      assert.equal(
        files.some((file) => file.includes("pi-telemetry-wrapper")),
        false,
      );
      const metadata = parseJsonObject(
        await readFile(task.metadataAbsPath, "utf8"),
        "metadata must be an object",
      );
      assert.equal(
        metadata["telemetryUnavailableReason"],
        WIN32_CMD_PI_TELEMETRY_UNAVAILABLE_REASON,
      );
      spawn.child.close(0, null);
      await waitFor(
        () => task.status === "completed",
        "cmd telemetry task completion",
      );
      assert.equal(await readFile(task.outputAbsPath, "utf8"), "");
    } finally {
      await cleanup(h.root);
    }
  });

  void it("rejects unresolved Windows bash before creating a task", async () => {
    const h = await createHarness({
      platform: "win32",
      env: { PI_BG_SHELL: "bash", PATH: "" },
    });
    try {
      await assert.rejects(
        h.registry.startTask(h.ctx, "echo ok", {
          name: "Bad Bash",
          notifyOnCompletion: false,
        }),
        /could not resolve bash/,
      );
      assert.equal(h.children.length, 0);
      assert.equal(h.registry.allTasks().length, 0);
    } finally {
      await cleanup(h.root);
    }
  });

  void it(
    "retains an admission-owned POSIX group after leader close until its TERM-ignoring descendant is forced",
    { timeout: 5000 },
    async () => {
      if (process.platform === "win32") return;
      const root = await mkdtemp(join(tmpdir(), "pi-bg-inserted-tree-"));
      const cwd = join(root, "project");
      const script = join(root, "leader.mjs");
      const descendantScript = join(root, "descendant.mjs");
      const rootPidPath = join(root, "leader.pid");
      const descendantPidPath = join(root, "descendant.pid");
      await mkdir(cwd, { recursive: true });
      await writeFile(
        descendantScript,
        [
          `import { writeFileSync } from 'node:fs';`,
          `process.on('SIGTERM', () => undefined);`,
          `writeFileSync(process.env.PI_BG_TREE_DESCENDANT_PID, String(process.pid));`,
          `setInterval(() => {}, 1000);`,
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        script,
        [
          `import { spawn } from 'node:child_process';`,
          `import { writeFileSync } from 'node:fs';`,
          `process.on('SIGTERM', () => process.exit(0));`,
          `writeFileSync(process.env.PI_BG_TREE_ROOT_PID, String(process.pid));`,
          `spawn(process.execPath, [process.env.PI_BG_TREE_DESCENDANT_SCRIPT], { stdio: 'ignore' });`,
          `setInterval(() => {}, 1000);`,
          "",
        ].join("\n"),
        "utf8",
      );

      const enteredMetadata = deferred<void>();
      const releaseMetadata = deferred<void>();
      const terminalSnapshots: BgTaskSnapshot[] = [];
      const notifications: CompletionNotificationMessage[] = [];
      const killCalls: Array<{
        pid: number;
        signal?: NodeJS.Signals | number;
      }> = [];
      const registry = new BackgroundTaskRegistry({
        killGraceMs: 250,
        stopWaitMs: 800,
        env: {
          ...process.env,
          PI_BG_TREE_ROOT_PID: rootPidPath,
          PI_BG_TREE_DESCENDANT_PID: descendantPidPath,
          PI_BG_TREE_DESCENDANT_SCRIPT: descendantScript,
        },
        killProcess: (pid, signal) => {
          const call: { pid: number; signal?: NodeJS.Signals | number } = {
            pid,
          };
          if (signal !== undefined) call.signal = signal;
          killCalls.push(call);
          return process.kill(pid, signal);
        },
        publishTerminal: (publication) =>
          terminalSnapshots.push(publication.task),
        sendCompletionNotification: (message) => notifications.push(message),
      });
      const ctx: BackgroundTaskContext = {
        cwd,
        sessionId: "inserted-process-tree",
        modelRegistry: { getAll: () => [] },
        model: undefined,
      };
      const originalWriteMetadata = Reflect.get(registry, "writeMetadata");
      assert.equal(typeof originalWriteMetadata, "function");
      let metadataCalls = 0;
      Reflect.set(
        registry,
        "writeMetadata",
        async function (
          this: BackgroundTaskRegistry,
          task: BgTask,
          signal?: AbortSignal,
        ) {
          metadataCalls += 1;
          if (metadataCalls === 1) {
            enteredMetadata.resolve(undefined);
            await releaseMetadata.promise;
          }
          return Reflect.apply(originalWriteMetadata, this, [task, signal]);
        },
      );

      let start: Promise<BgTask> | undefined;
      let rootPid: number | undefined;
      let descendantPid: number | undefined;
      let assertionsComplete = false;
      try {
        start = registry.startTask(
          ctx,
          `exec ${shellQuote(process.execPath)} ${shellQuote(script)}`,
          { name: "inserted process tree", notifyOnCompletion: true },
        );
        await enteredMetadata.promise;
        await waitFor(
          () => existsSync(rootPidPath) && existsSync(descendantPidPath),
          "leader and descendant pid files",
          1500,
        );
        rootPid = Number((await readFile(rootPidPath, "utf8")).trim());
        descendantPid = Number(
          (await readFile(descendantPidPath, "utf8")).trim(),
        );
        assert.ok(Number.isSafeInteger(rootPid) && rootPid > 0);
        assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
        assert.equal(
          pgidFor(descendantPid),
          rootPid,
          "descendant must remain in the owned group",
        );

        registry.setShuttingDown(true);
        const drain = registry.waitForTaskAdmissions();
        await waitForPidExit(rootPid, "inserted task leader", 750);
        const task = registry.allTasks()[0];
        assert.ok(task, "inserted task must remain registry-owned");
        assert.equal(
          pidExists(descendantPid),
          true,
          "fixture descendant must survive group TERM",
        );
        assert.equal(
          task.status,
          "running",
          "leader close cannot publish terminal tree cleanup",
        );
        assert.ok(
          task.killEscalationTimer,
          "leader close must retain the force owner",
        );
        assert.equal(terminalSnapshots.length, 0);
        assert.equal(notifications.length, 0);

        releaseMetadata.resolve(undefined);
        const startResult = await start.then(
          () => "fulfilled" as const,
          () => "rejected" as const,
        );
        assert.equal(startResult, "rejected");
        await drain;
        const stopResult = await registry.stopAllRunning(
          "shutdown",
          "Killed during inserted process-tree regression",
        );
        assert.deepEqual(stopResult, { stopped: 1, failures: [] });
        await waitForPidExit(descendantPid, "inserted task descendant", 750);
        assert.equal(pidExists(rootPid), false);
        assert.equal(pidExists(descendantPid), false);
        assert.equal(task.status, "killed");
        assert.equal(
          task.killEscalationTimer,
          undefined,
          "tree owner must disarm after ESRCH",
        );
        assert.equal(
          killCalls.filter((call) => call.signal === "SIGKILL").length,
          1,
          "the owned process group must receive exactly one force signal",
        );
        assert.equal(
          terminalSnapshots.length,
          0,
          "shutdown publication remains suppressed",
        );
        assert.equal(
          notifications.length,
          0,
          "shutdown notification remains suppressed",
        );
        assertionsComplete = true;
      } finally {
        releaseMetadata.resolve(undefined);
        Reflect.set(registry, "writeMetadata", originalWriteMetadata);
        registry.setShuttingDown(true);
        if (start !== undefined) await start.catch(() => undefined);
        // Rescue is failure-only: a green regression receives no test-originated signal.
        if (!assertionsComplete && rootPid !== undefined) {
          try {
            process.kill(-rootPid, "SIGKILL");
          } catch {
            // The owned process group may already be gone.
          }
        }
        if (
          !assertionsComplete &&
          descendantPid !== undefined &&
          pidExists(descendantPid)
        ) {
          try {
            process.kill(descendantPid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
        if (descendantPid !== undefined && pidExists(descendantPid)) {
          await waitForPidExit(
            descendantPid,
            "failure-only rescued descendant",
            1500,
          );
        }
        const cleanupTask = registry.allTasks()[0];
        if (cleanupTask?.status === "running") {
          await registry
            .stopAllRunning(
              "shutdown",
              "Failure-only process-tree test cleanup",
            )
            .catch(() => undefined);
        }
        if (cleanupTask !== undefined) {
          await waitFor(
            () => cleanupTask.status !== "running",
            "process-tree test finalization",
          );
          await cleanupTask.metadataWriteChain?.catch(() => undefined);
        }
        await cleanup(root);
      }
    },
  );

  void it("publishes POSIX ownership and close listeners before an already-aborted admission can kill", async () => {
    let childRef: FakeChild | undefined;
    let groupAlive = true;
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const h = await createHarness({
      platform: "linux",
      killGraceMs: 20,
      stopWaitMs: 250,
      killProcess: (_pid, signal) => {
        signals.push(signal);
        if (signal === 0) {
          if (groupAlive) return true;
          throw errnoError("ESRCH", "owned group is gone");
        }
        if (signal === "SIGTERM") {
          groupAlive = false;
          childRef?.close(null, "SIGTERM");
        }
        return true;
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    const originalSpawn = Reflect.get(h.registry, "spawn");
    assert.equal(typeof originalSpawn, "function");
    Reflect.set(
      h.registry,
      "spawn",
      (
        command: string,
        args: string[],
        options: Parameters<BackgroundTaskSpawn>[2],
      ) => {
        const child = Reflect.apply(originalSpawn, h.registry, [
          command,
          args,
          options,
        ]);
        h.registry.setShuttingDown(true);
        return child;
      },
    );
    try {
      await assert.rejects(
        h.registry.startTask(h.ctx, "node reentrant-admission-close.js", {
          name: "Reentrant admission close",
          notifyOnCompletion: false,
        }),
        /admission|closed/i,
      );
      await h.registry.waitForTaskAdmissions();
      const task = h.registry.allTasks()[0];
      assert.ok(task, "spawned task must remain registry-owned");
      await waitFor(
        () => task.status === "killed",
        "reentrant admission close finalization",
      );
      assert.equal(signals.filter((signal) => signal === "SIGTERM").length, 1);
      assert.equal(signals.filter((signal) => signal === "SIGKILL").length, 0);
      assert.ok(signals.some((signal) => signal === 0));
      assert.equal(task.killEscalationTimer, undefined);
    } finally {
      groupAlive = false;
      Reflect.set(h.registry, "spawn", originalSpawn);
      await cleanup(h.root);
    }
  });

  void it("holds ordinary POSIX terminal delivery through root-close-before-grace and shares one force", async () => {
    let childRef: FakeChild | undefined;
    let groupAlive = true;
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const terminals: BgTaskSnapshot[] = [];
    const h = await createHarness({
      platform: "linux",
      killGraceMs: 25,
      stopWaitMs: 300,
      publishTerminal: (publication) => terminals.push(publication.task),
      killProcess: (_pid, signal) => {
        signals.push(signal);
        if (signal === 0) {
          if (groupAlive) return true;
          throw errnoError("ESRCH", "owned group is gone");
        }
        if (signal === "SIGTERM") {
          childRef?.close(null, "SIGTERM");
          return true;
        }
        if (signal === "SIGKILL") {
          groupAlive = false;
          return true;
        }
        return true;
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const { task } = await startFakeTask(h, "POSIX Root Close Barrier");
      const stops = [
        h.registry.stopTask(task, "user"),
        h.registry.stopTask(task, "user"),
        h.registry.stopTask(task, "user"),
      ];
      assert.equal(task.status, "running");
      assert.equal(
        terminals.length,
        0,
        "direct close must not publish before group force",
      );
      await Promise.all(stops);
      assert.equal(signals.filter((signal) => signal === "SIGTERM").length, 1);
      assert.equal(signals.filter((signal) => signal === "SIGKILL").length, 1);
      assert.ok(
        signals.some((signal) => signal === 0),
        "group disappearance must be observed",
      );
      assert.equal(task.status, "cancelled");
      assert.equal(task.killEscalationTimer, undefined);
      assert.equal(terminals.length, 1);
      assert.equal(terminals[0]?.status, "cancelled");
      // S1 排水异步化:生产缺省 queueMicrotask 在 await 间自然排水,计数断言
      // 按 waitFor 口径等待送达
      await waitFor(
        () => h.notifications.length === 1,
        "root-close barrier notification",
      );
    } finally {
      groupAlive = false;
      await cleanup(h.root);
    }
  });

  void it("does not signal a released POSIX group during natural-close terminalization", async () => {
    let signalCalls = 0;
    const h = await createHarness({
      platform: "linux",
      stopWaitMs: 250,
      killProcess: () => {
        signalCalls += 1;
        throw new Error("released group must not be signaled");
      },
    });
    try {
      const { task, child } = await startFakeTask(
        h,
        "POSIX Natural Close Race",
      );
      child.close(0, null);
      const stopped = await h.registry.stopTask(task, "shutdown");
      assert.equal(stopped, task);
      assert.equal(task.status, "completed");
      assert.equal(signalCalls, 0);
      assert.equal(task.ownedPosixProcessGroupId, undefined);
      assert.equal(task.posixProcessGroupSignalAuthorityReleased, true);
    } finally {
      await cleanup(h.root);
    }
  });

  void it("disarms an already-gone POSIX group without a stale escalation or force signal", async () => {
    let childRef: FakeChild | undefined;
    let groupAlive = true;
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const h = await createHarness({
      platform: "linux",
      killGraceMs: 25,
      stopWaitMs: 300,
      killProcess: (_pid, signal) => {
        signals.push(signal);
        if (signal === 0) {
          if (groupAlive) return true;
          throw errnoError("ESRCH", "owned group is gone");
        }
        if (signal === "SIGTERM") {
          groupAlive = false;
          childRef?.close(null, "SIGTERM");
        }
        return true;
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const { task } = await startFakeTask(h, "POSIX Already Gone");
      await h.registry.stopTask(task, "user");
      assert.equal(signals.filter((signal) => signal === "SIGKILL").length, 0);
      assert.ok(signals.some((signal) => signal === 0));
      assert.equal(task.status, "cancelled");
      assert.equal(task.killEscalationTimer, undefined);
      await new Promise((resolve) => setTimeout(resolve, 75));
      assert.equal(signals.filter((signal) => signal === "SIGKILL").length, 0);
    } finally {
      groupAlive = false;
      await cleanup(h.root);
    }
  });

  void it("turns POSIX group force failure into loud failed terminal truth", async () => {
    let childRef: FakeChild | undefined;
    let groupAlive = true;
    const terminals: BgTaskSnapshot[] = [];
    const h = await createHarness({
      platform: "linux",
      killGraceMs: 20,
      stopWaitMs: 250,
      publishTerminal: (publication) => terminals.push(publication.task),
      killProcess: (_pid, signal) => {
        if (signal === 0) return groupAlive;
        if (signal === "SIGTERM") {
          childRef?.close(null, "SIGTERM");
          return true;
        }
        if (signal === "SIGKILL") throw errnoError("EACCES", "force denied");
        return true;
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const { task } = await startFakeTask(h, "POSIX Force Failure");
      await assert.rejects(
        h.registry.stopTask(task, "user"),
        /SIGKILL[\s\S]*force denied[\s\S]*Descendant processes may have leaked/i,
      );
      await waitFor(
        () => task.status === "failed",
        "loud POSIX force-failure finalization",
      );
      assert.match(task.error ?? "", /Descendant processes may have leaked/i);
      assert.equal(task.killEscalationTimer, undefined);
      // REVIEW 时序修复:终态发布在 await 关口之后,须等待发布落地再断言内容
      await waitFor(
        () => terminals.length === 1,
        "POSIX force-failure terminal publication",
      );
      assert.equal(terminals[0]?.status, "failed");
    } finally {
      groupAlive = false;
      await cleanup(h.root);
    }
  });

  void it("uses POSIX process-group kill before child fallback", async () => {
    let childRef: FakeChild | undefined;
    let groupAlive = true;
    const killCalls: Array<{ pid: number; signal?: NodeJS.Signals | number }> =
      [];
    const h = await createHarness({
      platform: "darwin",
      killProcess: (pid, signal) => {
        const call: { pid: number; signal?: NodeJS.Signals | number } = { pid };
        if (signal !== undefined) call.signal = signal;
        killCalls.push(call);
        if (signal === 0) {
          if (groupAlive) return true;
          throw errnoError("ESRCH", "owned group is gone");
        }
        if (signal === "SIGTERM") {
          groupAlive = false;
          queueMicrotask(() => childRef?.close(null, signal));
        }
        return true;
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const { task, child } = await startFakeTask(h);
      task.pid = child.pid + 99_999;
      await h.registry.stopTask(task, "user");
      assert.equal(
        killCalls[0]?.pid,
        -child.pid,
        "signals must use spawn-captured ownership",
      );
      assert.equal(killCalls[0]?.signal, "SIGTERM");
      assert.equal(
        killCalls.filter((call) => call.signal === "SIGKILL").length,
        0,
      );
      assert.ok(killCalls.some((call) => call.signal === 0));
      assert.deepEqual(child.killCalls, []);
      assert.equal(task.status, "cancelled");
    } finally {
      groupAlive = false;
      await cleanup(h.root);
    }
  });

  void it("runs ps descendant collection between POSIX TERM and the grace force and kills collected descendants after the group SIGKILL", async () => {
    let childRef: FakeChild | undefined;
    let groupAlive = true;
    const ordered: string[] = [];
    const h = await createHarness({
      platform: "linux",
      killGraceMs: 40,
      stopWaitMs: 400,
      killProcess: (pid, signal) => {
        ordered.push(
          `kill:${String(pid)}:${signal === undefined ? "0" : String(signal)}`,
        );
        if (signal === 0) {
          if (groupAlive) return true;
          throw errnoError("ESRCH", "owned group is gone");
        }
        if (signal === "SIGTERM") {
          childRef?.close(null, "SIGTERM");
          return true;
        }
        if (signal === "SIGKILL" && pid < 0) {
          groupAlive = false;
          return true;
        }
        return true;
      },
      collectPosixDescendantPids: (rootPid) => {
        ordered.push(`collect:${String(rootPid)}`);
        return Promise.resolve(new Set([5101, 5102]));
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const { task, child } = await startFakeTask(h, "POSIX Descendant Net");
      await h.registry.stopTask(task, "user");
      assert.equal(
        ordered[0],
        `kill:${String(-child.pid)}:SIGTERM`,
        "group SIGTERM must come first",
      );
      const collectIndex = ordered.findIndex((entry) =>
        entry.startsWith("collect:"),
      );
      assert.ok(
        collectIndex >= 0,
        "descendant collection must run between TERM and force",
      );
      assert.equal(
        ordered[collectIndex],
        `collect:${String(child.pid)}`,
        "collection must target the spawn-captured group id",
      );
      const groupKillIndex = ordered.findIndex(
        (entry) => entry === `kill:${String(-child.pid)}:SIGKILL`,
      );
      assert.ok(
        groupKillIndex > collectIndex,
        "group SIGKILL must follow the collection window",
      );
      for (const descendant of [5101, 5102]) {
        const descendantIndex = ordered.indexOf(
          `kill:${String(descendant)}:SIGKILL`,
        );
        assert.ok(
          descendantIndex > groupKillIndex,
          `descendant ${String(descendant)} SIGKILL must follow the group SIGKILL`,
        );
      }
      assert.ok(
        ordered.some((entry) => entry === `kill:${String(-child.pid)}:0`),
        "group disappearance must still be observed",
      );
      assert.equal(task.status, "cancelled");
      assert.equal(task.killEscalationTimer, undefined);
    } finally {
      groupAlive = false;
      await cleanup(h.root);
    }
  });

  void it("degrades to the group signal when POSIX descendant collection fails", async () => {
    let childRef: FakeChild | undefined;
    let groupAlive = true;
    const ordered: string[] = [];
    const h = await createHarness({
      platform: "linux",
      killGraceMs: 40,
      stopWaitMs: 400,
      killProcess: (pid, signal) => {
        ordered.push(
          `kill:${String(pid)}:${signal === undefined ? "0" : String(signal)}`,
        );
        if (signal === 0) {
          if (groupAlive) return true;
          throw errnoError("ESRCH", "owned group is gone");
        }
        if (signal === "SIGTERM") {
          childRef?.close(null, "SIGTERM");
          return true;
        }
        if (signal === "SIGKILL" && pid < 0) {
          groupAlive = false;
          return true;
        }
        return true;
      },
      collectPosixDescendantPids: () =>
        Promise.reject(new Error("ps unavailable")),
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const { task, child } = await startFakeTask(h, "POSIX Degraded Net");
      await h.registry.stopTask(task, "user");
      assert.ok(
        ordered.every(
          (entry) =>
            !entry.startsWith("collect:") &&
            !entry.startsWith(`kill:${String(child.pid)}`),
        ),
        "failed collection must not produce per-descendant signals",
      );
      assert.equal(
        ordered.filter((entry) => entry.endsWith(":SIGKILL")).length,
        1,
        "exactly the one group SIGKILL must remain",
      );
      assert.equal(task.status, "cancelled");
    } finally {
      groupAlive = false;
      await cleanup(h.root);
    }
  });

  void it("does not individually signal collected descendants when the group disappears before the grace force", async () => {
    let childRef: FakeChild | undefined;
    let groupAlive = true;
    const ordered: string[] = [];
    const h = await createHarness({
      platform: "linux",
      killGraceMs: 30,
      stopWaitMs: 300,
      killProcess: (pid, signal) => {
        ordered.push(
          `kill:${String(pid)}:${signal === undefined ? "0" : String(signal)}`,
        );
        if (signal === 0) {
          if (groupAlive) return true;
          throw errnoError("ESRCH", "owned group is gone");
        }
        if (signal === "SIGTERM") {
          groupAlive = false;
          childRef?.close(null, "SIGTERM");
          return true;
        }
        return true;
      },
      collectPosixDescendantPids: (rootPid) => {
        ordered.push(`collect:${String(rootPid)}`);
        return Promise.resolve(new Set([5201]));
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const { task, child } = await startFakeTask(h, "POSIX Gone Before Force");
      await h.registry.stopTask(task, "user");
      assert.equal(
        ordered.filter((entry) => entry.endsWith(":SIGKILL")).length,
        0,
        "no force phase must run when the group is already gone",
      );
      assert.ok(
        ordered.some((entry) => entry === `kill:${String(-child.pid)}:0`),
        "group disappearance must be observed through signal-0",
      );
      assert.equal(task.status, "cancelled");
      assert.equal(task.killEscalationTimer, undefined);
    } finally {
      groupAlive = false;
      await cleanup(h.root);
    }
  });

  void it("records POSIX descendant kill failures without failing the group disappearance proof", async () => {
    let childRef: FakeChild | undefined;
    let groupAlive = true;
    const h = await createHarness({
      platform: "linux",
      killGraceMs: 40,
      stopWaitMs: 400,
      killProcess: (pid, signal) => {
        if (signal === 0) {
          if (groupAlive) return true;
          throw errnoError("ESRCH", "owned group is gone");
        }
        if (signal === "SIGTERM") {
          childRef?.close(null, "SIGTERM");
          return true;
        }
        if (pid === 5302) throw errnoError("EACCES", "descendant denied");
        if (pid < 0) {
          groupAlive = false;
          return true;
        }
        return true;
      },
      collectPosixDescendantPids: async () => new Set([5301, 5302]),
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const { task } = await startFakeTask(h, "POSIX Descendant Failure");
      await h.registry.stopTask(task, "user");
      assert.equal(task.status, "cancelled");
      assert.match(
        task.error ?? "",
        /POSIX descendant SIGKILL failed[\s\S]*pid 5302[\s\S]*Descendant processes may have leaked/i,
      );
    } finally {
      groupAlive = false;
      await cleanup(h.root);
    }
  });

  void it("releases the plugin-held output sources when the POSIX stop window expires with the group still alive", async () => {
    let destroyedSources = 0;
    const h = await createHarness({
      platform: "linux",
      killGraceMs: 20,
      stopWaitMs: 100,
      killProcess: () => {
        // 组与后代探测永久存活:TERM/SIGKILL 送达但组不消失,证明性失败在
        // 所有权 deadline 内触发,子进程永不 close。
        return true;
      },
      collectPosixDescendantPids: async () => new Set(),
      childFactory: (pid) => {
        const child = new FakeChild(pid);
        const stdout = child.stdout as EventEmitter & {
          destroy?: () => void;
        };
        stdout.destroy = () => {
          destroyedSources += 1;
        };
        const stderr = child.stderr as EventEmitter & {
          destroy?: () => void;
        };
        stderr.destroy = () => {
          destroyedSources += 1;
        };
        return child;
      },
    });
    try {
      const { task } = await startFakeTask(h, "POSIX Force-Exit Release");
      await assert.rejects(
        h.registry.stopTask(task, "user"),
        /Descendant processes may have leaked/i,
      );
      assert.equal(
        destroyedSources,
        2,
        "child stdout/stderr read ends must be destroyed",
      );
      assert.equal(
        task.stream?.destroyed,
        true,
        "output stream must be destroyed",
      );
      assert.equal(task.status, "running");
    } finally {
      await cleanup(h.root);
    }
  });

  void it("destroys survivor output read ends and reports loudly when the reload stop wait expires with the group alive", async () => {
    if (process.platform === "win32") return;
    let destroyedSources = 0;
    const hub = createReloadShellOwnerHubForTests({ handoffTimeoutMs: 2000 });
    const h = await createHarness({
      platform: "linux",
      reloadShellOwner: hub,
      killGraceMs: 20,
      stopWaitMs: 100,
      // 组与后代探测永久存活:TERM/SIGKILL 送达但组不消失,证明性失败在所有权
      // deadline 内触发,子进程永不 close(requestStop 以 stopWait 超时 reject)。
      killProcess: () => true,
      collectPosixDescendantPids: async () => new Set(),
      childFactory: (pid) => {
        const child = new FakeChild(pid);
        const stdout = child.stdout as EventEmitter & {
          destroy?: () => void;
        };
        stdout.destroy = () => {
          destroyedSources += 1;
        };
        const stderr = child.stderr as EventEmitter & {
          destroy?: () => void;
        };
        stderr.destroy = () => {
          destroyedSources += 1;
        };
        return child;
      },
    });
    const identity = makeReloadShellIdentity(
      h.ctx.sessionId ?? "",
      realpathSync(h.cwd),
    );
    const claim = hub.beginActivation(identity, "startup", "7".repeat(32));
    const lease = hub.commitActivation(
      claim,
      await h.registry.stageReloadActivation(claim),
    );
    try {
      const task = await h.registry.startTask(h.ctx, "node reload-stuck.js", {
        name: "Reload Stuck",
        isAgent: false,
        surviveReload: true,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      await assert.rejects(
        h.registry.stopTask(task, "user"),
        /Descendant processes may have leaked|did not exit/i,
      );
      assert.equal(
        destroyedSources,
        2,
        "reload survivor stdout/stderr read ends must be destroyed",
      );
      assert.equal(
        task.stream?.destroyed,
        true,
        "reload survivor output stream must be destroyed",
      );
    } finally {
      if (h.registry.hasCurrentReloadLease())
        h.registry.releaseReloadActivation(lease);
      h.registry.setShuttingDown(true);
      await cleanup(h.root);
    }
  });

  void it("kills collected POSIX descendants after the group SIGKILL on the reload survivor path", async () => {
    if (process.platform === "win32") return;
    let childRef: FakeChild | undefined;
    let groupAlive = true;
    const hub = createReloadShellOwnerHubForTests({ handoffTimeoutMs: 2000 });
    const h = await createHarness({
      platform: "linux",
      reloadShellOwner: hub,
      killGraceMs: 20,
      stopWaitMs: 250,
      killProcess: (pid, signal) => {
        if (signal === 0) {
          if (groupAlive) return true;
          throw errnoError("ESRCH", "owned group is gone");
        }
        if (pid === 5302) throw errnoError("EACCES", "descendant denied");
        if (signal === "SIGKILL" && pid < 0) {
          // 组 SIGKILL:组消失并令子进程 close,触发幸存执行的终态化
          groupAlive = false;
          queueMicrotask(() => childRef?.close(null, signal));
          return true;
        }
        return true;
      },
      collectPosixDescendantPids: async () => new Set([5301, 5302]),
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    const identity = makeReloadShellIdentity(
      h.ctx.sessionId ?? "",
      realpathSync(h.cwd),
    );
    const claim = hub.beginActivation(identity, "startup", "8".repeat(32));
    const lease = hub.commitActivation(
      claim,
      await h.registry.stageReloadActivation(claim),
    );
    try {
      const task = await h.registry.startTask(h.ctx, "node reload-tree.js", {
        name: "Reload Tree",
        isAgent: false,
        surviveReload: true,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      await h.registry.stopTask(task, "user");
      assert.equal(task.status, "cancelled");
      assert.match(
        task.error ?? "",
        /POSIX descendant SIGKILL failed[\s\S]*pid 5302[\s\S]*Descendant processes may have leaked/i,
      );
    } finally {
      if (h.registry.hasCurrentReloadLease())
        h.registry.releaseReloadActivation(lease);
      h.registry.setShuttingDown(true);
      groupAlive = false;
      await cleanup(h.root);
    }
  });

  void it("falls back to child.kill when process-group kill fails and reports when both fail", async () => {
    const h = await createHarness({
      platform: "linux",
      killProcess: () => {
        throw errnoError("ESRCH", "group already gone");
      },
      childFactory: (pid) =>
        new FakeChild(pid, function (this: FakeChild, signal) {
          queueMicrotask(() => {
            this.close(null, signal ?? null);
          });
          return true;
        }),
    });
    try {
      const { task, child } = await startFakeTask(h, "Fallback Kill");
      await h.registry.stopTask(task, "user");
      assert.deepEqual(child.killCalls, ["SIGTERM"]);
      assert.equal(task.status, "cancelled");
    } finally {
      await cleanup(h.root);
    }

    const failing = await createHarness({
      platform: "linux",
      killProcess: () => {
        throw errnoError("ESRCH", "group already gone");
      },
      childFactory: (pid) =>
        new FakeChild(pid, () => {
          throw new Error("child unavailable");
        }),
    });
    try {
      const { task } = await startFakeTask(failing, "Failed Kill");
      await assert.rejects(
        () => failing.registry.stopTask(task, "user"),
        /Could not kill task[\s\S]*child unavailable/,
      );
      assert.equal(task.status, "running");
    } finally {
      await cleanup(failing.root);
    }
  });

  void it("uses taskkill tree termination on Windows and never falls back to child.kill", async () => {
    let processKillCalled = false;
    let childRef: FakeChild | undefined;
    const killTreeCalls: Array<{ pid: number; phase: WindowsKillPhase }> = [];
    const h = await createHarness({
      platform: "win32",
      killGraceMs: 20,
      stopWaitMs: 500,
      killProcess: () => {
        processKillCalled = true;
        return true;
      },
      killTree: (pid, phase) => {
        killTreeCalls.push({ pid, phase });
        if (phase === "force") {
          queueMicrotask(() => {
            childRef?.close(null, "SIGKILL");
          });
        }
        return Promise.resolve(taskkillOutcome(0));
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid, () => {
          throw new Error("root-only kill must not run");
        });
        return childRef;
      },
    });
    try {
      const { task, child } = await startFakeTask(h, "Windows Kill");
      await h.registry.stopTask(task, "user");
      assert.equal(processKillCalled, false);
      assert.deepEqual(killTreeCalls, [
        { pid: child.pid, phase: "terminate" },
        { pid: child.pid, phase: "force" },
      ]);
      assert.deepEqual(child.killCalls, []);
      const windowsSpawn = h.children[0];
      assert.ok(windowsSpawn, "Windows shell spawn should be recorded");
      // ComSpec is a full path on a real Windows host, so compare the basename.
      assert.equal(basename(windowsSpawn.shell).toLowerCase(), "cmd.exe");
      assert.deepEqual(windowsSpawn.args.slice(0, 3), ["/d", "/s", "/c"]);
    } finally {
      await cleanup(h.root);
    }
  });

  void it("shares duplicate Windows graceful stops and aborts soft taskkill when force starts", async () => {
    let childRef: FakeChild | undefined;
    let softAbortCount = 0;
    let firstTimer: NodeJS.Timeout | undefined;
    const phases: WindowsKillPhase[] = [];
    const h = await createHarness({
      platform: "win32",
      killGraceMs: 20,
      stopWaitMs: 500,
      killTree: (_pid, phase, signal) => {
        phases.push(phase);
        if (phase === "terminate") {
          if (signal !== undefined) {
            signal.addEventListener(
              "abort",
              () => {
                softAbortCount += 1;
              },
              { once: true },
            );
          }
          return new Promise<TaskkillOutcome>(() => undefined);
        }
        assert.equal(
          signal,
          undefined,
          "force taskkill must not reuse the soft abort signal",
        );
        assert.equal(
          softAbortCount,
          1,
          "soft attempt should be aborted before force starts",
        );
        queueMicrotask(() => {
          childRef?.close(null, "SIGKILL");
        });
        return Promise.resolve(taskkillOutcome(0));
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const { task } = await startFakeTask(h, "Windows Duplicate Stop");
      const first = h.registry.stopTask(task, "user");
      firstTimer = task.killEscalationTimer;
      assert.ok(
        firstTimer,
        "first graceful stop should arm an escalation timer",
      );
      const second = h.registry.stopTask(task, "user");
      const third = h.registry.stopTask(task, "user");
      assert.equal(
        task.killEscalationTimer,
        firstTimer,
        "duplicate stops must share one timer",
      );
      await Promise.all([first, second, third]);
      assert.deepEqual(phases, ["terminate", "force"]);
      assert.equal(task.killEscalationTimer, undefined);
      assert.equal(softAbortCount, 1);
    } finally {
      await cleanup(h.root);
    }
  });

  void it("treats explicit Windows force as terminal and does not arm escalation", async () => {
    const phases: WindowsKillPhase[] = [];
    const h = await createHarness({
      platform: "win32",
      killGraceMs: 20,
      killTree: (_pid, phase) => {
        phases.push(phase);
        return Promise.resolve(taskkillOutcome(0));
      },
    });
    try {
      const { task } = await startFakeTask(h, "Windows Explicit Force");
      requestKillForTest(h.registry, task, "SIGKILL");
      assert.equal(task.killEscalationTimer, undefined);
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.deepEqual(phases, ["force"]);
      assert.equal(task.killEscalationTimer, undefined);
    } finally {
      await cleanup(h.root);
    }
  });

  void it("records Windows taskkill exit 128 as an already-exited race", async () => {
    const h = await createHarness({
      platform: "win32",
      killGraceMs: 500,
      stopWaitMs: 1000,
      killTree: () =>
        Promise.resolve(taskkillOutcome(128, "process not found")),
    });
    try {
      const { task, child } = await startFakeTask(h, "Windows Missing Process");
      const stopped = h.registry.stopTask(task, "user");
      await waitFor(
        () =>
          readFileSync(task.outputAbsPath, "utf8").includes(
            "process not found",
          ),
        "exit 128 notice",
      );
      child.close(0, null);
      await stopped;
      assert.equal(task.status, "cancelled");
      assert.match(
        await readFile(task.outputAbsPath, "utf8"),
        /already-exited race/,
      );
    } finally {
      await cleanup(h.root);
    }
  });

  void it("persists a Windows soft failure and still escalates to force after grace", async () => {
    let childRef: FakeChild | undefined;
    const phases: WindowsKillPhase[] = [];
    const h = await createHarness({
      platform: "win32",
      killGraceMs: 20,
      stopWaitMs: 500,
      killTree: (_pid, phase) => {
        phases.push(phase);
        if (phase === "terminate")
          return Promise.resolve(taskkillOutcome(1, "soft denied"));
        queueMicrotask(() => {
          childRef?.close(null, "SIGKILL");
        });
        return Promise.resolve(taskkillOutcome(0));
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const { task } = await startFakeTask(h, "Windows Soft Failure");
      await h.registry.stopTask(task, "user");
      assert.deepEqual(phases, ["terminate", "force"]);
      assert.match(task.error ?? "", /soft denied/);
      const metadata = parseJsonObject(
        await readFile(task.metadataAbsPath, "utf8"),
        "metadata",
      );
      assert.match(String(metadata["error"]), /soft denied/);
    } finally {
      await cleanup(h.root);
    }
  });

  void it("surfaces Windows force failure loudly without root-only fallback", async () => {
    const h = await createHarness({
      platform: "win32",
      killGraceMs: 20,
      stopWaitMs: 500,
      killTree: (_pid, phase) =>
        Promise.resolve(
          phase === "terminate"
            ? taskkillOutcome(1, "soft denied")
            : taskkillOutcome(5, "force denied"),
        ),
      childFactory: (pid) =>
        new FakeChild(pid, () => {
          throw new Error("root-only kill must not run");
        }),
    });
    try {
      const { task, child } = await startFakeTask(h, "Windows Force Failure");
      await assert.rejects(
        () => h.registry.stopTask(task, "user"),
        /Windows taskkill \/T \/F force termination failed[\s\S]*Descendant processes may have leaked/,
      );
      assert.equal(task.status, "running");
      assert.match(task.error ?? "", /force denied/);
      assert.deepEqual(child.killCalls, []);
    } finally {
      await cleanup(h.root);
    }
  });

  void it("keeps terminal metadata running until in-flight Windows force settles", async () => {
    let childRef: FakeChild | undefined;
    let forceStarted = false;
    const force = deferred<TaskkillOutcome>();
    const terminals: BgTaskSnapshot[] = [];
    const h = await createHarness({
      platform: "win32",
      killGraceMs: 20,
      stopWaitMs: 1000,
      publishTerminal: (publication) => {
        terminals.push(publication.task);
      },
      killTree: (_pid, phase) => {
        if (phase === "terminate") return Promise.resolve(taskkillOutcome(0));
        forceStarted = true;
        queueMicrotask(() => {
          childRef?.close(null, "SIGKILL");
        });
        return force.promise;
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const { task } = await startFakeTask(h, "Windows Force Barrier");
      const stopped = h.registry.stopTask(task, "user");
      await waitFor(() => forceStarted, "force taskkill start");
      await waitFor(
        () => task.finalized === true,
        "child close reached finalization",
      );
      const runningMetadata = parseJsonObject(
        await readFile(task.metadataAbsPath, "utf8"),
        "metadata before force settles",
      );
      assert.equal(runningMetadata["status"], "running");
      assert.equal(terminals.length, 0);
      force.resolve(taskkillOutcome(0));
      await stopped;
      assert.equal(task.status, "cancelled");
      const terminalMetadata = parseJsonObject(
        await readFile(task.metadataAbsPath, "utf8"),
        "metadata after force settles",
      );
      assert.equal(terminalMetadata["status"], "cancelled");
      assert.equal(terminals.length, 1);
    } finally {
      await cleanup(h.root);
    }
  });

  void it("keeps duplicate stop requests idempotent and escalates to SIGKILL after grace", async () => {
    let childRef: FakeChild | undefined;
    let groupAlive = true;
    const killCalls: Array<NodeJS.Signals | number | undefined> = [];
    const h = await createHarness({
      platform: "linux",
      killGraceMs: 20,
      stopWaitMs: 500,
      killProcess: (_pid, signal) => {
        killCalls.push(signal);
        if (signal === 0) {
          if (groupAlive) return true;
          throw errnoError("ESRCH", "owned group is gone");
        }
        if (signal === "SIGKILL") {
          groupAlive = false;
          queueMicrotask(() => {
            childRef?.close(null, "SIGKILL");
          });
        }
        return true;
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const { task } = await startFakeTask(h, "Escalate Kill");
      const first = h.registry.stopTask(task, "user");
      const second = h.registry.stopTask(task, "user");
      await Promise.all([first, second]);
      assert.deepEqual(
        killCalls.filter((signal) => signal !== 0),
        ["SIGTERM", "SIGKILL"],
      );
      assert.equal(task.status, "cancelled");
      assert.equal(
        task.killEscalationTimer,
        undefined,
        "escalation timer must be cleared",
      );
    } finally {
      groupAlive = false;
      await cleanup(h.root);
    }
  });

  void it("schedules exactly one SIGKILL escalation for concurrent stop requests", async () => {
    // Regression: SIGTERM de-duplication guarded the signal but not the timer,
    // so each concurrent stopTask scheduled its own escalation. When the child
    // outlived the grace window that produced duplicate SIGKILLs.
    let groupAlive = true;
    const killCalls: Array<NodeJS.Signals | number | undefined> = [];
    const h = await createHarness({
      platform: "linux",
      killGraceMs: 20,
      stopWaitMs: 120,
      // Never close the child, so stop waiters time out after the sole force.
      killProcess: (_pid, signal) => {
        killCalls.push(signal);
        if (signal === 0) {
          if (groupAlive) return true;
          throw errnoError("ESRCH", "owned group is gone");
        }
        if (signal === "SIGKILL") groupAlive = false;
        return true;
      },
      childFactory: (pid) => new FakeChild(pid),
    });
    try {
      const { task } = await startFakeTask(h, "Escalate Once");
      await Promise.all([
        h.registry.stopTask(task, "user").catch(() => undefined),
        h.registry.stopTask(task, "user").catch(() => undefined),
        h.registry.stopTask(task, "user").catch(() => undefined),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.deepEqual(
        killCalls.filter((signal) => signal !== 0),
        ["SIGTERM", "SIGKILL"],
        "concurrent stop requests must escalate to SIGKILL exactly once",
      );
    } finally {
      groupAlive = false;
      await cleanup(h.root);
    }
  });

  void it("finalizes and notifies once under error/close and output-cap races", async () => {
    const liveGroups = new Set<number>();
    const h = await createHarness({
      maxOutputBytes: 8,
      killProcess: (pid, signal) => {
        const groupId = Math.abs(pid);
        if (signal === 0) {
          if (liveGroups.has(groupId)) return true;
          throw errnoError("ESRCH", "owned group is gone");
        }
        liveGroups.delete(groupId);
        return true;
      },
      childFactory: (pid) => {
        liveGroups.add(pid);
        return new FakeChild(pid);
      },
    });
    try {
      const { task, child } = await startFakeTask(h, "Race Failure");
      child.fail(new Error("spawn exploded"));
      child.close(0, null);
      await waitFor(() => task.status !== "running", "spawn race finalization");
      await waitFor(
        () => h.notifications.length === 1,
        "single spawn-race notification",
      );
      assert.equal(task.status, "failed");
      assert.match(task.error ?? "", /spawn exploded/);
      assert.equal(h.notifications.length, 1);
      // BUG-181: the terminal event itself is authoritative; agents must not poll to reconfirm it.
      const notification = h.notifications[0];
      assert.ok(notification, "terminal notification should be captured");
      assert.match(
        notification.message.content,
        /<guidance>Terminal state and output metadata are durable\. Do not call bg_status to reconfirm; use bg_logs only if output is needed\.<\/guidance>/,
      );
      // S1:通知以 deliverAs:"steer" 注入(宿主按 streaming/triggerTurn 分流)
      assert.deepEqual(notification.options, {
        deliverAs: "steer",
        triggerTurn: true,
      });

      const capped = await h.registry.startTask(h.ctx, "node noisy.js", {
        name: "Output Race",
        notifyOnCompletion: true,
        triggerOnCompletion: true,
      });
      const cappedChild = lastSpawn(h).child;
      cappedChild.writeStdout("0123456789abcdef");
      cappedChild.close(1, null);
      cappedChild.close(0, null);
      await waitFor(
        () => capped.status !== "running",
        "output-cap finalization",
      );
      await waitFor(
        () => h.notifications.length === 2,
        "single output-cap notification",
      );
      assert.equal(capped.status, "failed");
      assert.match(capped.error ?? "", /Output exceeded cap/);
      assert.equal(h.notifications.length, 2);
    } finally {
      await cleanup(h.root);
    }
  });

  void it("publishes terminal snapshots exactly once after durable metadata", async () => {
    const terminals: BgTaskSnapshot[] = [];
    const metadataStatuses: unknown[] = [];
    let metadataPath = "";
    const h = await createHarness({
      publishTerminal: (publication) => {
        terminals.push(publication.task);
        metadataStatuses.push(
          parseJsonObject(
            readFileSync(metadataPath, "utf8"),
            "terminal metadata must be written",
          )["status"],
        );
      },
    });
    try {
      const { task, child } = await startFakeTask(h, "Terminal Once");
      metadataPath = task.metadataAbsPath;
      child.close(0, null);
      child.close(1, null);
      await waitFor(() => task.status !== "running", "terminal status");
      await waitFor(
        () => terminals.length === 1,
        "single terminal publication",
      );
      const terminal = terminals[0];
      assert.ok(terminal, "terminal snapshot should be present");
      assert.equal(terminal.id, task.id);
      assert.equal(terminal.status, "completed");
      assert.deepEqual(metadataStatuses, ["completed"]);
    } finally {
      await cleanup(h.root);
    }
  });

  void it("carries a bounded tail summary field in completion notifications (M5 REVIEW)", async () => {
    const h = await createHarness({});
    try {
      const { task, child } = await startFakeTask(h, "Summary Notification");
      child.writeStdout("hello tail world\n");
      child.close(0, null);
      await waitFor(
        () => task.status === "completed",
        "summary notification completion",
      );
      await waitFor(
        () => h.notifications.length === 1,
        "summary notification single delivery",
      );
      const notification = h.notifications[0];
      assert.ok(notification, "completion notification must be captured");
      const content = notification.message.content;
      const tailMatch = /<summary-tail>([\s\S]*?)<\/summary-tail>/u.exec(
        content,
      );
      assert.ok(tailMatch, "notification must carry the bounded tail summary");
      // readTerminalSummaryTail 会对 tail 做尾部空白裁剪
      assert.equal(tailMatch[1], "hello tail world");
      assert.match(content, /<output-file>[^<]+<\/output-file>/u);

      // 超长输出:完成摘要必须是 64KiB 内截断的 tail,且不携带完整日志
      const noisy = await h.registry.startTask(h.ctx, "node noisy-summary.js", {
        name: "Noisy Summary",
        notifyOnCompletion: true,
      });
      const noisyChild = lastSpawn(h).child;
      noisyChild.writeStdout("a".repeat(200 * 1024));
      noisyChild.close(0, null);
      await waitFor(
        () => noisy.status === "completed",
        "noisy summary completion",
      );
      await waitFor(
        () => h.notifications.length === 2,
        "noisy summary notification",
      );
      const noisyContent = h.notifications[1]?.message.content ?? "";
      const noisyTail =
        /<summary-tail>([\s\S]*?)<\/summary-tail>/u.exec(noisyContent)?.[1] ??
        "";
      assert.ok(
        Buffer.byteLength(noisyTail, "utf8") <= TERMINAL_SUMMARY_TAIL_BYTES,
        "summary-tail must stay within 64KiB",
      );
      assert.doesNotMatch(
        noisyContent,
        /a{200000}/u,
        "notification must not carry the full log",
      );
    } finally {
      await cleanup(h.root);
    }
  });

  void it("keeps failed terminal EventBus delivery loud and retriable", async () => {
    const terminals: BgTaskSnapshot[] = [];
    let attempts = 0;
    const h = await createHarness({
      publishTerminal: (publication) => {
        attempts += 1;
        if (attempts === 1) throw new Error("terminal bus unavailable");
        terminals.push(publication.task);
      },
    });
    try {
      const { task, child } = await startFakeTask(h, "Terminal Retry");
      child.close(0, null);
      await waitFor(
        () => task.status === "completed",
        "terminal retry completion",
      );
      await waitFor(() => terminals.length === 1, "terminal retry publication");
      assert.equal(attempts, 2);
      assert.equal(task.terminalPublished, true);
      assert.equal(terminals[0]?.id, task.id);
      assert.match(
        h.errors.flat().join(" "),
        /terminal publication failed|terminal bus unavailable/,
      );
    } finally {
      await cleanup(h.root);
    }
  });

  void it("abandons a pending retry on shutdown without claiming terminal delivery", async () => {
    let attempts = 0;
    let failPublication = true;
    let task: BgTask | undefined;
    const h = await createHarness({
      publishTerminal: () => {
        attempts += 1;
        if (failPublication) throw new Error("terminal listener unavailable");
      },
    });
    try {
      const started = await startFakeTask(h, "Terminal Shutdown Abandonment");
      task = started.task;
      started.child.close(0, null);
      await waitFor(
        () => task?.terminalPublishRetryHandle !== undefined,
        "terminal retry arm",
      );

      h.registry.setShuttingDown(true);
      assert.equal(
        task.status,
        "completed",
        "terminal task truth must remain intact",
      );
      assert.notEqual(
        task.terminalPublished,
        true,
        "abandonment is not successful delivery",
      );
      assert.equal(Reflect.get(task, "terminalPublicationState"), "abandoned");
      assert.equal(
        Reflect.get(task, "terminalPublicationAbandonReason"),
        "registry_shutdown",
      );
      assert.equal(
        task.terminalPublishRetryHandle,
        undefined,
        "shutdown must cancel retry timer",
      );

      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(
        attempts,
        1,
        "a disposed registry must never re-arm its publisher",
      );
      const metadata = parseJsonObject(
        await readFile(task.metadataAbsPath, "utf8"),
        "terminal metadata must survive publication abandonment",
      );
      assert.equal(metadata["status"], "completed");
      assert.equal(
        task.notified,
        true,
        "notification truth remains independent of EventBus delivery",
      );
    } finally {
      failPublication = false;
      if (task !== undefined) {
        if (task.terminalPublishRetryHandle !== undefined)
          clearTimeout(task.terminalPublishRetryHandle);
        task.terminalPublishRetryHandle = undefined;
        // Baseline-only cleanup: stop its unbounded retry after preserving red evidence.
        if (Reflect.get(task, "terminalPublicationState") === undefined)
          task.terminalPublished = true;
      }
      await cleanup(h.root);
    }
  });

  void it("abandons a typed closed publisher error without retrying or message matching", async () => {
    let attempts = 0;
    const h = await createHarness({
      publishTerminal: () => {
        attempts += 1;
        throw new BackgroundTaskExtensionServiceClosedError();
      },
    });
    try {
      const { task, child } = await startFakeTask(h, "Typed Publisher Closure");
      child.close(0, null);
      await waitFor(
        () => task.terminalPublicationState === "abandoned",
        "typed publisher abandonment",
      );
      await new Promise((resolve) => setTimeout(resolve, 250));

      assert.equal(attempts, 1);
      assert.equal(task.terminalPublished, false);
      assert.equal(task.terminalPublicationAbandonReason, "publisher_closed");
      assert.equal(task.terminalPublishRetryHandle, undefined);
      assert.equal(h.errors.length, 1);
    } finally {
      await cleanup(h.root);
    }
  });

  void it("bounds persistent terminal listener failures while retaining transient retry", async () => {
    let attempts = 0;
    let failPublication = true;
    let task: BgTask | undefined;
    const h = await createHarness({
      publishTerminal: () => {
        attempts += 1;
        if (failPublication)
          throw new Error(`persistent listener failure ${String(attempts)}`);
      },
    });
    try {
      const started = await startFakeTask(h, "Terminal Retry Exhaustion");
      task = started.task;
      started.child.close(0, null);
      await waitFor(() => attempts >= 3, "bounded terminal attempts");
      await new Promise((resolve) => setTimeout(resolve, 180));

      assert.equal(
        attempts,
        3,
        "terminal delivery uses three total attempts, not an open loop",
      );
      assert.notEqual(
        task.terminalPublished,
        true,
        "exhaustion is not successful delivery",
      );
      assert.equal(Reflect.get(task, "terminalPublicationState"), "abandoned");
      assert.equal(
        Reflect.get(task, "terminalPublicationAbandonReason"),
        "retry_exhausted",
      );
      assert.equal(task.terminalPublishRetryHandle, undefined);
      assert.equal(
        h.errors.length,
        3,
        "persistent failure diagnostics must be bounded with the attempt policy",
      );
    } finally {
      failPublication = false;
      if (task !== undefined) {
        if (task.terminalPublishRetryHandle !== undefined)
          clearTimeout(task.terminalPublishRetryHandle);
        task.terminalPublishRetryHandle = undefined;
        // Baseline-only cleanup: stop its unbounded retry after preserving red evidence.
        if (Reflect.get(task, "terminalPublicationState") === undefined)
          task.terminalPublished = true;
      }
      await cleanup(h.root);
    }
  });

  void it("does not publish an ordinary terminal after a late gate resolves into shutdown", async () => {
    const gate = deferred<void>();
    const terminals: BgTaskSnapshot[] = [];
    const h = await createHarness({
      publishTerminal: (publication) => terminals.push(publication.task),
    });
    const task = await h.registry.startTask(h.ctx, "node late-gate.js", {
      name: "Late Ordinary Gate",
      notifyOnCompletion: true,
      triggerOnCompletion: true,
      terminalPublicationGate: gate.promise,
    });
    try {
      lastSpawn(h).child.close(0, null);
      await waitFor(
        () => task.status === "completed",
        "late-gated ordinary completion",
      );
      assert.equal(terminals.length, 0);

      h.registry.setShuttingDown(true);
      gate.resolve(undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));

      assert.equal(
        terminals.length,
        0,
        "a gate resolving after closure cannot publish",
      );
      assert.notEqual(task.terminalPublished, true);
      assert.equal(Reflect.get(task, "terminalPublicationState"), "abandoned");
      assert.equal(task.terminalPublishRetryHandle, undefined);
      assert.equal(
        task.terminalPublicationGate,
        undefined,
        "closure must release the gate reference",
      );
      assert.equal(task.terminalPublishInFlight, false);
      assert.equal(
        h.notifications.length,
        0,
        "shutdown still suppresses completion notification",
      );
      const metadata = parseJsonObject(
        await readFile(task.metadataAbsPath, "utf8"),
        "late-gated task metadata must remain durable",
      );
      assert.equal(metadata["status"], "completed");
    } finally {
      gate.resolve(undefined);
      await cleanup(h.root);
    }
  });

  void it("resets notified when completion notification delivery fails and records loud metadata errors", async () => {
    const failingNotify = await createHarness({
      sendCompletionNotification: () => {
        throw new Error("send failed");
      },
    });
    try {
      const { task, child } = await startFakeTask(
        failingNotify,
        "Notify Failure",
      );
      child.close(0, null);
      await waitFor(
        () => task.status === "completed",
        "notification failure task completion",
      );
      // S1:投递留痕迁至排水层 —— 发送失败在批量排水时回滚 notified 并单处
      // warn 留痕(调用点不再触发 logger.error),因此等待 warns 而非 errors
      await waitFor(
        () => failingNotify.warns.length === 1,
        "notification failure warn",
      );
      assert.equal(task.notified, false);
      // S1:回滚同时回写持久化元数据(经 metadataWriteChain 串行于 finalize 的
      // 先写之后),故磁盘 notified 最终收敛为 false——等待该回写落盘。
      await waitFor(
        async () =>
          parseJsonObject(
            await readFile(task.metadataAbsPath, "utf8"),
            "notification metadata must be an object",
          )["notified"] === false,
        "notification rollback persisted",
      );
      const metadata = parseJsonObject(
        await readFile(task.metadataAbsPath, "utf8"),
        "notification metadata must be an object",
      );
      assert.equal(metadata["notified"], false);
      assert.match(
        failingNotify.warns.flat().join(" "),
        /notification delivery failed for batch|send failed/,
      );
    } finally {
      await cleanup(failingNotify.root);
    }

    const metadataFailure = await createHarness();
    try {
      const { task, child } = await startFakeTask(
        metadataFailure,
        "Metadata Failure",
      );
      await rm(join(metadataFailure.agentDir, "tasks"), {
        recursive: true,
        force: true,
      });
      child.close(0, null);
      await waitFor(
        () => task.status === "failed",
        "metadata failure task completion",
      );
      await waitFor(
        () => metadataFailure.notifications.length === 1,
        "notification despite metadata failure",
      );
      await waitFor(
        () => metadataFailure.errors.length > 0,
        "metadata failure log",
      );
      assert.equal(task.notified, true);
      assert.match(task.error ?? "", /Terminal metadata write failed/);
      assert.match(
        metadataFailure.errors.flat().join(" "),
        /failed to (write failed terminal|write|update )?metadata|ENOENT/,
      );
    } finally {
      await cleanup(metadataFailure.root);
    }
  });

  void it("ingests split, malformed, and large telemetry records without losing task state", async () => {
    const h = await createHarness();
    try {
      const { task, child } = await startFakeTask(h, "Telemetry Chunks");
      child.writeStdout("not-json-but-user-output\n");
      child.writeStdout('{"type":"background-task-telemetry",');
      assert.equal(task.contextUsage, undefined);

      const byName = Object.fromEntries(
        Array.from({ length: 2500 }, (_, index) => [
          `tool-${String(index)}`,
          1,
        ]),
      );
      const telemetry = JSON.stringify({
        type: "background-task-telemetry",
        contextUsage: {
          tokens: 12_345,
          contextWindow: 200_000,
          percent: 6.1725,
        },
        tokenUsage: {
          input: 10_000,
          output: 2000,
          cacheRead: 300,
          cacheWrite: 45,
          totalTokens: 12_345,
        },
        toolUsage: { total: 2500, failed: 3, byName },
        model: "openai-codex/gpt-5.5",
      });
      assert.ok(
        telemetry.length > 16 * 1024,
        "fixture must exceed the old 16KiB telemetry buffer",
      );
      const telemetryPrefix = '{"type":"background-task-telemetry",';
      assert.ok(telemetry.startsWith(telemetryPrefix));
      const continuation = telemetry.slice(telemetryPrefix.length);
      for (const chunk of [
        continuation.slice(0, 257),
        ...(continuation.slice(257).match(/.{1,113}/gs) ?? []),
        "\n",
      ]) {
        child.writeStdout(chunk);
      }

      assert.deepEqual(task.contextUsage, {
        tokens: 12_345,
        contextWindow: 200_000,
        percent: 6.1725,
      });
      assert.deepEqual(task.tokenUsage, {
        input: 10_000,
        output: 2000,
        cacheRead: 300,
        cacheWrite: 45,
        totalTokens: 12_345,
      });
      const toolUsage = task.toolUsage;
      assert.ok(toolUsage, "valid telemetry should populate tool usage");
      assert.equal(toolUsage.total, 2500);
      assert.equal(toolUsage.failed, 3);
      assert.equal(toolUsage.byName["tool-2499"], 1);
      assert.equal(task.model, "openai-codex/gpt-5.5");

      child.writeStdout('{"type":"background-task-telemetry",bad}\n');
      const retainedToolUsage = task.toolUsage;
      assert.ok(
        retainedToolUsage,
        "malformed telemetry must not clear previous tool usage",
      );
      assert.equal(retainedToolUsage.total, 2500);
      assert.equal(task.model, "openai-codex/gpt-5.5");
      child.close(0, null);
      await waitFor(
        () => task.status === "completed",
        "telemetry task completion",
      );
      let metadata = await readJsonEventually(task.metadataAbsPath);
      for (let attempt = 0; attempt < 20; attempt++) {
        metadata = await readJsonEventually(task.metadataAbsPath);
        if (
          JSON.stringify(metadata["tokenUsage"]) ===
          JSON.stringify(task.tokenUsage)
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.deepEqual(metadata["tokenUsage"], task.tokenUsage);
      const metadataToolUsage = requiredJsonObject(
        metadata["toolUsage"],
        "metadata tool usage must be an object",
      );
      const metadataToolCounts = requiredJsonObject(
        metadataToolUsage["byName"],
        "metadata tool counts must be an object",
      );
      assert.equal(metadataToolCounts["tool-2499"], 1);
      assert.equal(metadata["model"], "openai-codex/gpt-5.5");
    } finally {
      await cleanup(h.root);
    }
  });

  void it("renders wrapped Pi-agent activity transcripts and keeps telemetry out of the output file", async () => {
    const h = await createHarness({ platform: "linux" });
    try {
      const task = await h.registry.startTask(h.ctx, "pi -p hello", {
        name: "Wrapped Agent",
        isAgent: true,
        notifyOnCompletion: false,
      });
      assert.equal(task.telemetryWrapped, true);
      const child = lastSpawn(h).child;

      child.writeStdout(
        '{"type":"background-task-activity","kind":"tool_start","tool":"read","argsSummary":"README.md"}\n',
      );
      // Telemetry split across two stdout chunks must reassemble before parsing.
      child.writeStdout(
        '{"type":"background-task-telemetry","tokenUsage":{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":15},',
      );
      child.writeStdout(
        '"toolUsage":{"total":1,"failed":1,"byName":{"read":1}},"model":"prov/model","contextUsage":{"tokens":15,"contextWindow":1000,"percent":1.5}}\n',
      );
      child.writeStdout(
        '{"type":"background-task-activity","kind":"tool_end","tool":"read","isError":true,"error":"boom"}\n',
      );
      child.writeStdout(
        '{"type":"background-task-activity","kind":"assistant_text","text":"final answer"}\n',
      );
      child.writeStderr("child stderr diagnostic\n");
      // Trailing partial line (no newline) must be flushed verbatim on finalize.
      child.writeStdout("trailing fragment without newline");

      assert.deepEqual(task.tokenUsage, {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
      });
      assert.deepEqual(task.toolUsage, {
        total: 1,
        failed: 1,
        byName: { read: 1 },
      });
      assert.equal(task.model, "prov/model");
      assert.deepEqual(task.contextUsage, {
        tokens: 15,
        contextWindow: 1000,
        percent: 1.5,
      });

      child.close(0, null);
      await waitFor(
        () => task.status === "completed",
        "wrapped-agent completion",
      );

      let output = "";
      await waitFor(() => {
        try {
          output = readFileSync(task.outputAbsPath, "utf8");
        } catch {
          output = "";
        }
        return output.includes("trailing fragment without newline");
      }, "wrapped-agent transcript flushed");

      assert.match(output, /\u2192 read README\.md/);
      assert.match(output, /\u2717 read failed: boom/);
      assert.match(output, /^final answer$/m);
      assert.match(output, /child stderr diagnostic/);
      assert.doesNotMatch(output, /background-task-telemetry/);
      assert.doesNotMatch(output, /background-task-activity/);
      assert.doesNotMatch(output, /"kind"/);
    } finally {
      await cleanup(h.root);
    }
  });

  void it("preserves split multiline XML context telemetry across newline boundaries", async () => {
    const h = await createHarness();
    try {
      const { task, child } = await startFakeTask(h, "XML Telemetry");
      child.writeStdout(
        "prefix\n<background-task-context-usage>\n  <tokens>321</tokens>\n",
      );
      assert.equal(task.contextUsage, undefined);
      child.writeStdout(
        "  <context-window>1000</context-window>\n  <percent>32.1</percent>\n</background-task-context-usage>\n",
      );
      assert.deepEqual(task.contextUsage, {
        tokens: 321,
        contextWindow: 1000,
        percent: 32.1,
      });
      child.close(0, null);
      await waitFor(
        () => task.status === "completed",
        "xml telemetry task completion",
      );
    } finally {
      await cleanup(h.root);
    }
  });

  void it("prunes oldest finished tasks while preserving running tasks", async () => {
    let clock = 1_000;
    const h = await createHarness({
      maxRecentTasks: 3,
      now: () => clock++,
    });
    try {
      const running = await h.registry.startTask(h.ctx, "sleep forever", {
        name: "Still Running",
        notifyOnCompletion: false,
      });
      assert.equal(running.status, "running");

      for (let i = 1; i <= 4; i++) {
        const suffix = String(i);
        const task = await h.registry.startTask(h.ctx, `printf ${suffix}`, {
          name: `Finished ${suffix}`,
          notifyOnCompletion: false,
        });
        lastSpawn(h).child.close(0, null);
        await waitFor(() => task.status === "completed", `finished ${suffix}`);
      }

      await waitFor(
        () => h.registry.allTasks().length <= 3,
        "old finished tasks pruned",
      );
      const names = h.registry
        .allTasks()
        .map((task) => task.name)
        .sort();
      assert.deepEqual(
        names,
        ["Finished 3", "Finished 4", "Still Running"].sort(),
      );
    } finally {
      await cleanup(h.root);
    }
  });

  void it("soft output threshold warns without killing; the task keeps running and completes normally", async () => {
    const h = await createHarness({ softOutputBytes: 4 });
    try {
      const { task, child } = await startFakeTask(h, "Soft Threshold");
      child.writeStdout("0123456789");
      // 超软阈值(4B)只触发一次软告警:不杀任务、不改任务状态、不入 failed
      assert.equal(task.status, "running");
      assert.equal(task.softCapWarned, true);
      assert.equal(task.failedReason, undefined);
      await waitFor(
        () => readFileSync(task.outputAbsPath, "utf8").length >= 10,
        "soft-threshold output flushed",
      );
      const logs = await h.registry.getTaskLogs(task, 4096, true);
      assert.match(logs.text, /soft limit of 4B/u);
      assert.ok(logs.details.totalBytes >= 10);
      // 任务随后正常完成,软告警不污染终态
      child.close(0, null);
      await waitFor(
        () => task.status === "completed",
        "soft-threshold task completion",
      );
      // 终态后输出流已关闭,文件大小稳定,totalBytes 与磁盘输出一致
      const finalLogs = await h.registry.getTaskLogs(task, 4096, true);
      assert.equal(
        finalLogs.details.totalBytes,
        readFileSync(task.outputAbsPath, "utf8").length,
        "bg_logs totalBytes must match the on-disk output size",
      );
      assert.equal(task.status, "completed");
      assert.equal(task.error, undefined);
      assert.equal(task.failedReason, undefined);
    } finally {
      await cleanup(h.root);
    }
  });

  void it("hard output threshold terminates with output_limit and retains the partial file", async () => {
    const h = await createHarness({ maxOutputBytes: 8 });
    try {
      const { task, child } = await startFakeTask(h, "Hard Threshold");
      child.writeStdout("0123456789abcdef");
      child.close(0, null);
      await waitFor(() => task.status === "failed", "hard threshold terminal");
      assert.equal(task.capExceeded, true);
      assert.equal(task.failedReason, "output_limit");
      assert.match(task.error ?? "", /Output exceeded cap of 8B/u);
      // 已写输出文件保留,可审计
      assert.ok(
        existsSync(task.outputAbsPath),
        "partial output must be retained",
      );
      const logs = await h.registry.getTaskLogs(task, 4096, true);
      assert.match(logs.text, /01234567/u);
      assert.doesNotMatch(logs.text, /0123456789abcdef/u);
      assert.equal(
        logs.details.totalBytes,
        readFileSync(task.outputAbsPath, "utf8").length,
      );
    } finally {
      await cleanup(h.root);
    }
  });

  void it("marks ENOSPC stream errors disk_full and retains the already-written file", async () => {
    const h = await createHarness();
    try {
      const { task, child } = await startFakeTask(h, "Enospc Task");
      child.writeStdout("12345");
      await waitFor(
        () => readFileSync(task.outputAbsPath, "utf8").length >= 5,
        "pre-ENOSPC output flushed",
      );
      // 注入输出流 ENOSPC 错误:应终止任务并标记 disk_full
      task.stream?.emit(
        "error",
        errnoError("ENOSPC", "no space left on device"),
      );
      child.close(0, null);
      await waitFor(() => task.status === "failed", "enospc terminal");
      assert.equal(task.failedReason, "disk_full");
      assert.match(task.error ?? "", /no space left on device/u);
      assert.ok(
        existsSync(task.outputAbsPath),
        "written file must be retained after ENOSPC",
      );
      assert.match(readFileSync(task.outputAbsPath, "utf8"), /12345/u);
    } finally {
      await cleanup(h.root);
    }
  });

  void it("migrates terminal status by initiator and records failed reasons", async () => {
    let childRef: FakeChild | undefined;
    const h = await createHarness({
      platform: "linux",
      killGraceMs: 15,
      stopWaitMs: 350,
      killProcess: (_pid, signal) => {
        if (signal === 0) throw errnoError("ESRCH", "owned group is gone");
        if (signal === "SIGTERM") {
          childRef?.close(null, "SIGTERM");
          return true;
        }
        return true;
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const user = await startFakeTask(h, "User Stop");
      await h.registry.stopTask(user.task, "user", undefined, "user");
      assert.equal(user.task.status, "cancelled");
      assert.equal(user.task.stopInitiator, "user");

      const model = await startFakeTask(h, "Model Stop");
      await h.registry.stopTask(model.task, "user", undefined, "model");
      assert.equal(model.task.status, "cancelled");
      assert.equal(model.task.stopInitiator, "model");

      const system = await startFakeTask(h, "System Stop");
      await h.registry.stopTask(system.task, "shutdown", undefined, "system");
      assert.equal(system.task.status, "killed");
      assert.equal(system.task.stopInitiator, "system");

      const exit = await startFakeTask(h, "Exit Failure");
      exit.child.close(3, null);
      await waitFor(
        () => exit.task.status === "failed",
        "exit failure terminal",
      );
      assert.equal(exit.task.failedReason, "exit_error");
      assert.match(exit.task.error ?? "", /Exited with code 3/u);

      const spawnFailure = await startFakeTask(h, "Spawn Failure");
      spawnFailure.child.fail(new Error("spawn hook failed"));
      await waitFor(
        () => spawnFailure.task.status === "failed",
        "spawn failure terminal",
      );
      assert.equal(spawnFailure.task.failedReason, "spawn_error");
      assert.match(spawnFailure.task.error ?? "", /spawn hook failed/u);

      const timed = await h.registry.startTask(h.ctx, "node sleep.js", {
        name: "Timeout Task",
        isAgent: false,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
        timeoutSeconds: 1,
      });
      const timedChild = lastSpawn(h).child;
      await waitFor(() => timed.killKind === "timeout", "timeout armed", 2500);
      timedChild.close(null, "SIGTERM");
      await waitFor(() => timed.status === "failed", "timeout terminal");
      assert.equal(timed.failedReason, "timed_out");
      assert.match(timed.error ?? "", /Timed out after 1s/u);
    } finally {
      h.registry.setShuttingDown(true);
      await cleanup(h.root);
    }
  });

  void it("resolves stop-initiator conflicts with user > model > system", async () => {
    let childRef: FakeChild | undefined;
    const h = await createHarness({
      platform: "linux",
      killGraceMs: 15,
      stopWaitMs: 350,
      killProcess: (_pid, signal) => {
        if (signal === 0) throw errnoError("ESRCH", "owned group is gone");
        if (signal === "SIGTERM") {
          childRef?.close(null, "SIGTERM");
          return true;
        }
        return true;
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const modelThenUser = await startFakeTask(h, "Model Then User");
      const stops = [
        h.registry.stopTask(modelThenUser.task, "user", undefined, "model"),
        h.registry.stopTask(modelThenUser.task, "user", undefined, "user"),
      ];
      const results = await Promise.allSettled(stops);
      for (const result of results)
        assert.equal(result.status, "fulfilled", "model/user stop settles");
      assert.equal(modelThenUser.task.stopInitiator, "user");
      assert.equal(modelThenUser.task.status, "cancelled");

      const systemThenModel = await startFakeTask(h, "System Then Model");
      const stops2 = [
        h.registry.stopTask(systemThenModel.task, "user", undefined, "system"),
        h.registry.stopTask(systemThenModel.task, "user", undefined, "model"),
      ];
      const results2 = await Promise.allSettled(stops2);
      for (const result of results2)
        assert.equal(result.status, "fulfilled", "system/model stop settles");
      assert.equal(systemThenModel.task.stopInitiator, "model");

      const userThenSystem = await startFakeTask(h, "User Then System");
      const stops3 = [
        h.registry.stopTask(userThenSystem.task, "user", undefined, "user"),
        h.registry.stopTask(userThenSystem.task, "user", undefined, "system"),
      ];
      const results3 = await Promise.allSettled(stops3);
      for (const result of results3)
        assert.equal(result.status, "fulfilled", "user/system stop settles");
      assert.equal(userThenSystem.task.stopInitiator, "user");
    } finally {
      h.registry.setShuttingDown(true);
      await cleanup(h.root);
    }
  });

  void it("settles waiter dual channels on terminal and background request; abort per contract", async () => {
    const h = await createHarness();
    try {
      const { task, child } = await startFakeTask(h, "Waiter Task");
      const terminalP = h.registry.waitForTerminal(task.id);
      const backgroundP = h.registry.waitForBackgroundRequest(task.id);

      // 运行中不得提前结算 terminal 通道
      let terminalSettled = false;
      const probe = terminalP.then(() => {
        terminalSettled = true;
      });
      await Promise.race([
        probe,
        new Promise((resolve) => setTimeout(resolve, 25)),
      ]);
      assert.equal(
        terminalSettled,
        false,
        "running task must not settle early",
      );

      // background 请求通道单发结算(可幂等重复请求)
      assert.equal(h.registry.requestBackground(task.id), true);
      const bgSnapshot = await backgroundP;
      assert.equal(bgSnapshot?.id, task.id);
      assert.equal(bgSnapshot?.status, "running");
      assert.equal(h.registry.requestBackground(task.id), true);
      assert.deepEqual(
        await h.registry.waitForBackgroundRequest(task.id),
        bgSnapshot,
      );

      // 终态结算 terminal 通道;已后台化的任务即使终态也返回快照(参照 ZCode 语义)
      child.close(0, null);
      const terminal = await terminalP;
      assert.equal(terminal?.status, "completed");
      assert.equal(terminal?.branchGeneration, 0);
      const backgroundedTerminal = await h.registry.waitForBackgroundRequest(
        task.id,
      );
      assert.equal(backgroundedTerminal?.id, task.id);
      assert.equal(backgroundedTerminal?.status, "completed");

      // 未后台化任务:终态时挂起的 background 等待收尾 undefined
      const plain = await startFakeTask(h, "Plain Terminal Task");
      const plainBackgroundP = h.registry.waitForBackgroundRequest(
        plain.task.id,
      );
      plain.child.close(0, null);
      assert.equal(
        await plainBackgroundP,
        undefined,
        "terminal settles pending background wait as undefined",
      );
      // REVIEW 语义一致性(#5):settleTaskWaiters 在终态且已后台化时同样以快照结算,
      // 与 waitForBackgroundRequest 的立即结算语义对齐(参照 ZCode);该分支与立即
      // 结算在所有可达路径上一致,不产生可观察差异(挂起等待总被 requestBackground
      // 或终态结算先一步收盘)。

      // 已终态任务立即结算快照;未知任务立即结算 undefined 且不可后台化
      const alreadyTerminal = await h.registry.waitForTerminal(task.id);
      assert.equal(alreadyTerminal?.status, "completed");
      assert.equal(await h.registry.waitForTerminal("unknown-id"), undefined);
      assert.equal(
        await h.registry.waitForBackgroundRequest("unknown-id"),
        undefined,
      );
      assert.equal(h.registry.requestBackground("unknown-id"), false);

      // 运行中任务上的等待可被 Abort(参照语义:已终态/未知任务先于 signal 结算)
      const second = await startFakeTask(h, "Abort Task");
      const controller = new AbortController();
      const abortP = h.registry.waitForTerminal(second.task.id, {
        signal: controller.signal,
      });
      controller.abort(new Error("aborted wait"));
      await assert.rejects(abortP, /aborted wait/u);

      // 预中止 signal 立即 reject(双通道)
      const preAborted = new AbortController();
      preAborted.abort(new Error("pre-aborted"));
      await assert.rejects(
        h.registry.waitForTerminal(second.task.id, {
          signal: preAborted.signal,
        }),
        /pre-aborted/u,
      );
      await assert.rejects(
        h.registry.waitForBackgroundRequest(second.task.id, {
          signal: preAborted.signal,
        }),
        /pre-aborted/u,
      );
      second.child.close(0, null);
      await waitFor(
        () => second.task.status === "completed",
        "abort task settles",
      );
    } finally {
      h.registry.setShuttingDown(true);
      await cleanup(h.root);
    }
  });

  void it("derives wake defaults by entry semantic while explicit flags still override", async () => {
    const h = await createHarness();
    try {
      const modelEntry = await h.registry.startTask(h.ctx, "node model.js", {
        name: "Model Entry",
        isAgent: false,
        entrySource: "model",
      });
      assert.equal(modelEntry.notifyOnCompletion, true);
      assert.equal(
        modelEntry.triggerOnCompletion,
        true,
        "model entry defaults to notify plus wake",
      );

      const userEntry = await h.registry.startTask(h.ctx, "node user.js", {
        name: "User Entry",
        isAgent: false,
        entrySource: "user",
      });
      assert.equal(userEntry.notifyOnCompletion, true);
      assert.equal(
        userEntry.triggerOnCompletion,
        false,
        "user entry defaults to notification only",
      );

      const explicit = await h.registry.startTask(h.ctx, "node explicit.js", {
        name: "Explicit Entry",
        isAgent: false,
        entrySource: "user",
        notifyOnCompletion: false,
        triggerOnCompletion: true,
      });
      assert.equal(explicit.notifyOnCompletion, false);
      assert.equal(
        explicit.triggerOnCompletion,
        true,
        "explicit flags win over entry defaults",
      );

      const unmarked = await h.registry.startTask(h.ctx, "node plain.js", {
        name: "Unmarked Entry",
        isAgent: false,
      });
      assert.equal(
        unmarked.triggerOnCompletion,
        false,
        "unmarked entry keeps the legacy default",
      );
    } finally {
      for (const child of h.children) child.child.close(null, "SIGTERM");
      h.registry.setShuttingDown(true);
      await cleanup(h.root);
    }
  });

  void it("fences stale branch-generation frames from waking while fresh frames wake normally", async () => {
    const h = await createHarness();
    try {
      const stale = await startFakeTask(h, "Stale Frame Task");
      assert.equal(stale.task.branchGeneration, 0);
      // 推进注册表代次,模拟 reload 后新激活 epoch 与旧代次帧不匹配
      h.registry.setActiveBranchGeneration(1);
      stale.child.close(0, null);
      await waitFor(
        () => stale.task.status === "completed",
        "stale terminal settlement",
      );
      assert.equal(
        stale.task.staleBranchFrame,
        true,
        "old-generation frame must be marked stale",
      );
      // S1 排水异步化:送达等待以 waitFor 口径断言
      await waitFor(
        () => h.notifications.length === 1,
        "stale frame notification",
      );
      assert.equal(
        h.notifications[0]?.options.triggerTurn,
        false,
        "stale frame must never trigger wake",
      );

      const fresh = await startFakeTask(h, "Fresh Frame Task");
      assert.equal(fresh.task.branchGeneration, 1);
      fresh.child.close(0, null);
      await waitFor(
        () => fresh.task.status === "completed",
        "fresh terminal settlement",
      );
      assert.equal(fresh.task.staleBranchFrame, undefined);
      await waitFor(
        () => h.notifications.length === 2,
        "fresh frame notification",
      );
      assert.equal(
        h.notifications[1]?.options.triggerTurn,
        true,
        "fresh frame keeps wake",
      );
    } finally {
      h.registry.setShuttingDown(true);
      await cleanup(h.root);
    }
  });

  void it("S7 P9: reads legacy metadata with a persisted name field without failure (name 常驻兼容)", async () => {
    const h = await createHarness();
    try {
      // 旧版 JSON 记录恒有 name 字段(derive 结果);启动审计只改写 status,
      // name 不得被清除,后续展示即走 name 分支(行为不变)。
      const dir = join(
        h.agentDir,
        "tasks",
        `${h.ctx.sessionId}-${process.pid}`,
      );
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "blegacy.json"),
        JSON.stringify({
          id: "blegacy",
          name: "Legacy-derived Name",
          command: "echo legacy",
          status: "running",
          outputPath: join(h.agentDir, "tasks", "x", "blegacy.output"),
          cwd: h.cwd,
          startTime: 1,
          bytesWritten: 0,
          isAgent: false,
          surviveReload: false,
          notified: false,
          notifyOnCompletion: false,
          triggerOnCompletion: false,
        }),
        "utf8",
      );
      const audited = await h.registry.auditStartupRecords(h.ctx);
      assert.equal(audited, 1, "legacy running record is audited");
      const record = parseJsonObject(
        await readFile(join(dir, "blegacy.json"), "utf8"),
        "legacy record after audit",
      );
      assert.equal(record["status"], "lost");
      assert.equal(record["name"], "Legacy-derived Name", "name 字段保留");
    } finally {
      h.registry.setShuttingDown(true);
      await cleanup(h.root);
    }
  });

  void it("startup audit flips leftover running records to lost without touching live tasks", async () => {
    const h = await createHarness();
    try {
      const { task } = await startFakeTask(h, "Live Task");
      const dir = join(
        h.agentDir,
        "tasks",
        `${h.ctx.sessionId}-${process.pid}`,
      );
      // 预置旧格式遗留记录(缺失新字段),验证兼容性读取
      const stalePath = join(dir, "bDADA.json");
      await writeFile(
        stalePath,
        JSON.stringify({
          id: "bDADA",
          status: "running",
          command: "echo stale",
          outputPath: ".pi/tasks/x/bDADA.output",
          cwd: h.cwd,
          startTime: 1,
          bytesWritten: 0,
          isAgent: false,
          surviveReload: false,
          notified: false,
          notifyOnCompletion: false,
          triggerOnCompletion: false,
        }),
        "utf8",
      );
      const donePath = join(dir, "bDONE.json");
      await writeFile(
        donePath,
        JSON.stringify({
          id: "bDONE",
          status: "killed",
          command: "echo done",
          outputPath: ".pi/tasks/x/bDONE.output",
          cwd: h.cwd,
          startTime: 2,
          bytesWritten: 0,
          isAgent: false,
          surviveReload: false,
          notified: false,
          notifyOnCompletion: false,
          triggerOnCompletion: false,
        }),
        "utf8",
      );

      const audited = await h.registry.auditStartupRecords(h.ctx);
      assert.equal(audited, 1, "only the stale running record is audited");

      const staleRecord = parseJsonObject(
        await readFile(stalePath, "utf8"),
        "stale record after audit",
      );
      assert.equal(staleRecord["status"], "lost");
      assert.ok(
        Number.isFinite(staleRecord["endTime"]),
        "audited record must gain endTime",
      );
      assert.match(String(staleRecord["error"]), /pi_bg_startup_audit/u);

      const doneRecord = parseJsonObject(
        await readFile(donePath, "utf8"),
        "done record after audit",
      );
      assert.equal(doneRecord["status"], "killed");

      // 幂等:二次审计不再改写任何记录
      assert.equal(await h.registry.auditStartupRecords(h.ctx), 0);

      // 活动任务元数据保持 running,不被审计误伤
      const liveMetadata = parseJsonObject(
        await readFile(task.metadataAbsPath, "utf8"),
        "live metadata after audit",
      );
      assert.equal(liveMetadata["status"], "running");
    } finally {
      h.registry.setShuttingDown(true);
      await cleanup(h.root);
    }
  });

  void it("spawns argv directly without shell mediation on POSIX and keeps group authority capture", async () => {
    const h = await createHarness();
    try {
      const task = await h.registry.startTask(h.ctx, "", {
        argv: ["node", "-e", "process.exit(0)"],
        name: "Direct Exec",
        isAgent: false,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      assert.equal(task.status, "running");
      assert.equal(
        task.command,
        "node -e process.exit(0)",
        "直执行任务的 command 呈现 join 后的 argv",
      );
      const rec = lastSpawn(h);
      assert.equal(rec.shell, "node");
      assert.deepEqual(rec.args, ["-e", "process.exit(0)"]);
      assert.equal(rec.options.shell, undefined, "无 shell 中介");
      assert.equal(rec.options.detached, true, "POSIX 保持 detached");
      assert.equal(
        task.ownedPosixProcessGroupId,
        rec.child.pid,
        "沿用现有 ownedPosixProcessGroupId 捕获语义",
      );
      rec.child.close(0, null);
      await waitFor(() => task.status === "completed", "direct exec settles");
    } finally {
      for (const child of h.children) child.child.close(null, "SIGTERM");
      h.registry.setShuttingDown(true);
      await cleanup(h.root);
    }
  });

  void it("keeps shell-free argv spawn shape and no group capture on Windows", async () => {
    const h = await createHarness({
      platform: "win32",
      env: {
        PATH: "C:\\tools",
        PATHEXT: ".EXE;.CMD",
        ComSpec: "C:\\Windows\\system32\\cmd.exe",
      },
    });
    try {
      const task = await h.registry.startTask(h.ctx, "", {
        // 显式 .exe 路径(非 shim):直达 spawn,不经 cmd.exe
        argv: ["C:\\tools\\node.exe", "--version"],
        name: "Win Direct",
        isAgent: false,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      assert.equal(task.status, "running");
      assert.equal(task.command, "C:\\tools\\node.exe --version");
      const rec = lastSpawn(h);
      assert.equal(rec.shell, "C:\\tools\\node.exe");
      assert.deepEqual(rec.args, ["--version"]);
      assert.equal(rec.options.shell, undefined, "无 shell 中介");
      assert.equal(rec.options.detached, false, "Windows 保持非 detached");
      assert.equal(
        task.ownedPosixProcessGroupId,
        undefined,
        "Windows 不捕获 POSIX 组",
      );
      rec.child.close(0, null);
      await waitFor(() => task.status === "completed", "win direct settles");
    } finally {
      for (const child of h.children) child.child.close(null, "SIGTERM");
      h.registry.setShuttingDown(true);
      await cleanup(h.root);
    }
  });

  void it("rejects argv direct execution combined with surviveReload", async () => {
    const h = await createHarness();
    try {
      await assert.rejects(
        () =>
          h.registry.startTask(h.ctx, "", {
            argv: ["node", "-e", "1"],
            surviveReload: true,
            isAgent: false,
          }),
        /pi_bg_survive_reload_requires_shell_command/u,
      );
      assert.equal(h.children.length, 0, "拒绝路径不得产生子进程");
    } finally {
      h.registry.setShuttingDown(true);
      await cleanup(h.root);
    }
  });

  void it("S2 P4: exposes only absolute output paths and keeps outputAbsPath as an alias", async () => {
    const h = await createHarness();
    try {
      const { task } = await startFakeTask(h, "Absolute Paths");
      assert.equal(task.outputAbsPath, task.outputPath, "别名与绝对路径同值");
      assert.ok(
        task.outputPath.startsWith(h.agentDir),
        "运行时目录位于宿主私有 agent 目录(S3 P5)",
      );
      assert.ok(
        isPathAbsolute(task.outputPath),
        "对外输出路径必须为绝对路径(P4)",
      );
      assert.ok(
        !task.outputPath.startsWith(".pi"),
        "对外路径不得以项目相对 .pi 开头(P4)",
      );
      const snap = h.registry.snapshot(task);
      assert.equal(snap.outputPath, task.outputPath);
      assert.match(snap.outputPath, /\/tasks\/[^/]+\/bunit\d+\.output$/u);
      // /bg-logs 的 details.path 同样为绝对路径
      h.children[0]?.child.close(3, null);
      await waitFor(
        () => task.status === "failed",
        "absolute path task settles",
      );
      const logs = await h.registry.getTaskLogs(task, 4096, true);
      assert.ok(isPathAbsolute(logs.details.path), "bg_logs path 绝对(P4)");
    } finally {
      h.registry.setShuttingDown(true);
      await cleanup(h.root);
    }
  });

  void it("S4 P6: omits <exit-code> for null/undefined and keeps it for numeric exit codes", async () => {
    // S1 捕获式排水:排水缺省为 queueMicrotask,直调 notifyCompletion(及终态
    // 异步入队)后排水未自动运行;显式触发 captured() 后再断言。
    // 通知序:null[0]、manual[1]、zero[2]、three[3]
    let captured: (() => void) | undefined;
    const h = await createHarness({
      scheduleDrain: (drain) => {
        captured = drain;
      },
    });
    try {
      // null:信号终止(close code 恒为 number|null)→ exitCode null → 省略
      const nullTask = await startFakeTask(h, "Exit Code null");
      nullTask.child.close(null, "SIGTERM");
      await waitFor(
        () => nullTask.task.status !== "running",
        "exit-code null terminal",
      );
      await drainCaptured(() => captured, "exit-code null");
      assert.equal(h.notifications.length, 1);
      assert.doesNotMatch(
        h.notifications[0]?.message.content ?? "",
        /<exit-code>/u,
        "null 省略 <exit-code>",
      );

      // undefined:close 事件无法构造 undefined code → 直接驱动私有通知方法(S4 分支面)
      const manual = await h.registry.startTask(h.ctx, "node manual.js", {
        name: "Exit Code undefined",
        isAgent: false,
        notifyOnCompletion: true,
      });
      manual.exitCode = undefined;
      const notifyCompletion = Reflect.get(h.registry, "notifyCompletion") as (
        task: unknown,
      ) => void;
      notifyCompletion.call(h.registry, manual);
      // 直调仅入队,需显式触发排水后通知才送达
      await drainCaptured(() => captured, "exit-code undefined");
      assert.equal(h.notifications.length, 2);
      assert.doesNotMatch(
        h.notifications[1]?.message.content ?? "",
        /<exit-code>/u,
        "undefined 省略 <exit-code>",
      );

      // 数值:0 与 3 → 携带 <exit-code>(通知序:null[0]、manual[1]、zero[2]、three[3])
      const zero = await h.registry.startTask(h.ctx, "node zero.js", {
        name: "Exit Code zero",
        isAgent: false,
        notifyOnCompletion: true,
      });
      lastSpawn(h).child.close(0, null);
      await waitFor(() => zero.status !== "running", "exit-code zero terminal");
      await drainCaptured(() => captured, "exit-code zero");
      assert.equal(h.notifications.length, 3);
      assert.match(
        h.notifications[2]?.message.content ?? "",
        /<exit-code>0<\/exit-code>/u,
        "zero",
      );

      const three = await h.registry.startTask(h.ctx, "node three.js", {
        name: "Exit Code three",
        isAgent: false,
        notifyOnCompletion: true,
      });
      lastSpawn(h).child.close(3, null);
      await waitFor(
        () => three.status !== "running",
        "exit-code three terminal",
      );
      await drainCaptured(() => captured, "exit-code three");
      assert.equal(h.notifications.length, 4);
      assert.match(
        h.notifications[3]?.message.content ?? "",
        /<exit-code>3<\/exit-code>/u,
        "three",
      );
    } finally {
      h.registry.setShuttingDown(true);
      await cleanup(h.root);
    }
  });

  void it("S7 P9: stores name only when explicit; display falls back to full command verbatim", async () => {
    const h = await createHarness();
    try {
      const unnamed = await h.registry.startTask(h.ctx, "cd /a && npm test", {
        isAgent: false,
        notifyOnCompletion: true,
      });
      assert.equal(unnamed.name, undefined, "无显式名 → name 保持 undefined");
      assert.equal(
        h.registry.snapshot(unnamed).name,
        "cd /a && npm test",
        "快照显示名 = 完整命令原样兜底",
      );
      const named = await h.registry.startTask(h.ctx, "npm test", {
        name: "Explicit Job",
        isAgent: false,
        notifyOnCompletion: false,
      });
      assert.equal(named.name, "Explicit Job");
      const described = await h.registry.startTask(h.ctx, "npm test", {
        description: "My Description",
        isAgent: false,
        notifyOnCompletion: false,
      });
      assert.equal(described.name, undefined);
      assert.equal(
        h.registry.snapshot(described).name,
        "My Description",
        "description 为显示链中间兜底",
      );
    } finally {
      h.registry.setShuttingDown(true);
      await cleanup(h.root);
    }
  });

  void it("S7 P9: notification task-name keeps the full command under the 4KiB guard and escapes XML", async () => {
    const h = await createHarness();
    try {
      const huge = await h.registry.startTask(
        h.ctx,
        `${"x".repeat(5 * 1024)}`,
        {
          isAgent: false,
          notifyOnCompletion: true,
        },
      );
      void huge;
      lastSpawn(h).child.close(0, null);
      await waitFor(
        () => h.notifications.length === 1,
        "huge-command notification",
      );
      const content = h.notifications[0]?.message.content ?? "";
      const nameLine = content
        .split("\n")
        .find((line) => line.includes("<task-name>"));
      assert.ok(nameLine, "task-name line present");
      assert.ok(
        nameLine.length <= 4 * 1024 + 64,
        "4KiB 护栏集中施加于通知 task-name 面(含行首缩进与元素包裹)",
      );

      const escaped = await h.registry.startTask(h.ctx, "echo \"<a> & 'b'\"", {
        isAgent: false,
        notifyOnCompletion: true,
      });
      lastSpawn(h).child.close(0, null);
      await waitFor(
        () => h.notifications.length === 2,
        "xml-escape notification",
      );
      const escapedContent = h.notifications[1]?.message.content ?? "";
      // S7:task-name = 完整命令原样 + XML 转义(& 与 < > 均被转义,命令引号原样)
      assert.match(
        escapedContent,
        /<task-name>echo "&lt;a&gt; &amp; 'b'"<\/task-name>/u,
      );
      void escaped;
    } finally {
      h.registry.setShuttingDown(true);
      await cleanup(h.root);
    }
  });

  void it("S6 P8: sync delivery failure rolls back notified and warns once; success sets notified", async () => {
    let sendAttempts = 0;
    const h = await createHarness({
      sendCompletionNotification: () => {
        sendAttempts += 1;
        throw new Error("send failed");
      },
    });
    try {
      const { task, child } = await startFakeTask(h, "Warn Failure");
      child.close(0, null);
      await waitFor(
        () => task.status === "completed",
        "warn failure completes",
      );
      await waitFor(() => h.warns.length > 0, "delivery failure warn recorded");
      assert.equal(task.notified, false, "同步失败回滚 notified");
      assert.equal(sendAttempts, 1);
      assert.match(h.warns.flat().join(" "), /notification delivery failed/u);
      assert.doesNotMatch(
        h.errors.flat().join(" "),
        /notification delivery failed/u,
        "warn 仅放一处,不进入 error 通道重复",
      );
    } finally {
      h.registry.setShuttingDown(true);
      await cleanup(h.root);
    }
  });
});

/** S1 批语义测试:启动任务并允许按用例指定 triggerOnCompletion。 */
async function startBatchTask(
  h: Awaited<ReturnType<typeof createHarness>>,
  name: string,
  triggerOnCompletion = true,
): Promise<{ task: BgTask; child: FakeChild }> {
  const task = await h.registry.startTask(h.ctx, "node batch.js", {
    name,
    isAgent: false,
    notifyOnCompletion: true,
    triggerOnCompletion,
  });
  return { task, child: lastSpawn(h).child };
}

void describe("BackgroundTaskRegistry notification batching", () => {
  void it("S1 批聚合:同一排水段多条终态合成一次发送,块顺序与终态顺序一致", async () => {
    let captured: (() => void) | undefined;
    const h = await createHarness({
      scheduleDrain: (drain) => {
        captured = drain;
      },
    });
    try {
      const first = await startBatchTask(h, "First Batch");
      const second = await startBatchTask(h, "Second Batch");
      const third = await startBatchTask(h, "Third Batch");
      // 连续三任务终态(同一排水段),期间不触发排水;逐个等终态完成以锁定入队
      // (终态)顺序:状态可见即已入队,而队列只在手动排水时取空,故入队序 = 终态序
      first.child.close(0, null);
      await waitFor(() => first.task.status === "completed", "first terminal");
      second.child.close(0, null);
      await waitFor(
        () => second.task.status === "completed",
        "second terminal",
      );
      third.child.close(0, null);
      await waitFor(() => third.task.status === "completed", "third terminal");

      await drainCaptured(() => captured, "three-task batch");
      // 手动排水恰一次 → 恰好 1 次发送
      assert.equal(h.notifications.length, 1);
      const sent = h.notifications[0];
      assert.ok(sent, "batch notification should be captured");
      assert.deepEqual(sent.options, { deliverAs: "steer", triggerTurn: true });
      assert.equal(sent.message.customType, "background-task-notification");
      assert.equal(sent.message.display, true);
      assert.equal(
        sent.message.content,
        [
          buildTaskNotificationContent(first.task),
          buildTaskNotificationContent(second.task),
          buildTaskNotificationContent(third.task),
        ].join("\n\n"),
      );
      assert.equal(
        sent.message.content.split("<background-task-notification>").length - 1,
        3,
        "content 应含 3 个完整通知块",
      );
      assert.equal(first.task.notified, true);
      assert.equal(second.task.notified, true);
      assert.equal(third.task.notified, true);
      assert.equal(h.warns.length, 0);
      // 空队列排水为无害 no-op(队列已取空,再次排水直接返回)
      captured?.();
      assert.equal(h.notifications.length, 1, "空队列排水不得再次发送");
      // details 以批内首任务快照作 UI 展示代表
      assert.equal(sent.message.details.id, first.task.id);
    } finally {
      h.registry.setShuttingDown(true);
      await cleanup(h.root);
    }
  });

  void it("S1 单条兼容:单任务终态一次发送,content 与 helper 单条输出逐字节一致", async () => {
    let captured: (() => void) | undefined;
    const h = await createHarness({
      scheduleDrain: (drain) => {
        captured = drain;
      },
    });
    try {
      const { task, child } = await startBatchTask(h, "Single Task");
      child.close(2, null);
      await waitFor(() => task.status === "failed", "single terminal");
      await drainCaptured(() => captured, "single-task batch");
      assert.equal(h.notifications.length, 1);
      const sent = h.notifications[0];
      assert.ok(sent, "single notification should be captured");
      assert.equal(sent.message.content, buildTaskNotificationContent(task));
      assert.equal(sent.message.details.id, task.id);
      assert.equal(task.notified, true);
    } finally {
      h.registry.setShuttingDown(true);
      await cleanup(h.root);
    }
  });

  void it("S1 triggerTurn 批语义:批内任一 trigger+非陈旧 → true,全 false/stale → false", async () => {
    // 全 false:批内无任何 trigger
    let noTriggerCaptured: (() => void) | undefined;
    const noTrigger = await createHarness({
      scheduleDrain: (drain) => {
        noTriggerCaptured = drain;
      },
    });
    try {
      const a = await startBatchTask(noTrigger, "No Trigger A", false);
      const b = await startBatchTask(noTrigger, "No Trigger B", false);
      a.child.close(0, null);
      b.child.close(0, null);
      await waitFor(
        () => a.task.status === "completed" && b.task.status === "completed",
        "all-false terminals",
      );
      await drainCaptured(() => noTriggerCaptured, "all-false batch");
      assert.equal(noTrigger.notifications.length, 1);
      assert.equal(
        noTrigger.notifications[0]?.options.triggerTurn,
        false,
        "全 false → triggerTurn false",
      );
    } finally {
      noTrigger.registry.setShuttingDown(true);
      await cleanup(noTrigger.root);
    }

    // 任一 trigger+非陈旧 → true
    let anyCaptured: (() => void) | undefined;
    const anyTrigger = await createHarness({
      scheduleDrain: (drain) => {
        anyCaptured = drain;
      },
    });
    try {
      const quiet = await startBatchTask(anyTrigger, "Quiet Task", false);
      const wake = await startBatchTask(anyTrigger, "Wake Task", true);
      quiet.child.close(0, null);
      wake.child.close(0, null);
      await waitFor(
        () =>
          quiet.task.status === "completed" && wake.task.status === "completed",
        "any-trigger terminals",
      );
      await drainCaptured(() => anyCaptured, "any-trigger batch");
      assert.equal(
        anyTrigger.notifications[0]?.options.triggerTurn,
        true,
        "批内任一 trigger → triggerTurn true",
      );
    } finally {
      anyTrigger.registry.setShuttingDown(true);
      await cleanup(anyTrigger.root);
    }

    // trigger 但陈旧帧 → false(与现状按任务决策的组合等价)
    let staleCaptured: (() => void) | undefined;
    const stale = await createHarness({
      scheduleDrain: (drain) => {
        staleCaptured = drain;
      },
    });
    try {
      const staleTask = await startBatchTask(stale, "Stale Wake Task", true);
      // 推进注册表代次,模拟 reload 后新激活 epoch 与旧代次帧不匹配
      stale.registry.setActiveBranchGeneration(1);
      staleTask.child.close(0, null);
      await waitFor(
        () => staleTask.task.status === "completed",
        "stale terminal",
      );
      assert.equal(
        staleTask.task.staleBranchFrame,
        true,
        "old-generation frame must be marked stale",
      );
      await drainCaptured(() => staleCaptured, "stale batch");
      assert.equal(
        stale.notifications[0]?.options.triggerTurn,
        false,
        "陈旧帧 trigger → triggerTurn false",
      );
    } finally {
      stale.registry.setShuttingDown(true);
      await cleanup(stale.root);
    }
  });

  void it("S1 P8 批回滚:投递失败回滚批内全部 notified(含持久化)且 warn 恰一次", async () => {
    let captured: (() => void) | undefined;
    const h = await createHarness({
      scheduleDrain: (drain) => {
        captured = drain;
      },
      sendCompletionNotification: () => {
        throw new Error("send failed");
      },
    });
    try {
      const first = await startBatchTask(h, "Rollback First");
      const second = await startBatchTask(h, "Rollback Second");
      first.child.close(0, null);
      second.child.close(0, null);
      await waitFor(
        () =>
          first.task.status === "completed" &&
          second.task.status === "completed",
        "rollback terminals",
      );
      await drainCaptured(() => captured, "failing batch");
      // 发送失败 → 批内全部回滚 notified=false
      assert.equal(first.task.notified, false);
      assert.equal(second.task.notified, false);
      assert.equal(h.notifications.length, 0);
      assert.equal(h.warns.length, 1, "批量失败仅单处 warn");
      assert.match(
        h.warns.flat().join(" "),
        /notification delivery failed for batch|send failed/,
      );
      // 回滚同步回写持久化元数据,磁盘收敛为 notified=false
      await waitFor(async () => {
        const m = parseJsonObject(
          await readFile(first.task.metadataAbsPath, "utf8"),
          "rollback metadata must be an object",
        );
        return m["notified"] === false;
      }, "notification rollback persisted");
    } finally {
      h.registry.setShuttingDown(true);
      await cleanup(h.root);
    }
  });

  void it("S1 批间隔离:再入队新任务并再次排水 → 独立批次发送、互不回滚", async () => {
    let captured: (() => void) | undefined;
    const h = await createHarness({
      scheduleDrain: (drain) => {
        captured = drain;
      },
    });
    try {
      const first = await startBatchTask(h, "First Batch Task");
      first.child.close(0, null);
      await waitFor(() => first.task.status === "completed", "first terminal");
      await drainCaptured(() => captured, "first batch");
      assert.equal(h.notifications.length, 1);
      assert.equal(first.task.notified, true);

      // 批间隔离:新任务终态入队后再次手动排水 → 第二次发送
      const second = await startBatchTask(h, "Second Batch Task");
      second.child.close(3, null);
      await waitFor(() => second.task.status === "failed", "second terminal");
      await drainCaptured(() => captured, "second batch");
      assert.equal(h.notifications.length, 2);
      const secondSent = h.notifications[1];
      assert.ok(secondSent, "second batch notification should be captured");
      assert.equal(
        secondSent.message.content,
        buildTaskNotificationContent(second.task),
        "第二批只含新任务单块",
      );
      assert.equal(secondSent.message.details.id, second.task.id);
      assert.equal(first.task.notified, true);
      assert.equal(second.task.notified, true);
      assert.equal(h.warns.length, 0, "隔离批次无任何告警");
    } finally {
      h.registry.setShuttingDown(true);
      await cleanup(h.root);
    }
  });
});
