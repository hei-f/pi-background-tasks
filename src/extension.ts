import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
  ThemeColor,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { Text, type KeyId } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  DEFAULT_LOG_BYTES,
  MAX_LOG_BYTES,
  formatSnapshotList,
  normalizeMaxBytes,
  taskDisplayName,
  truncateChars,
  type BgKillDetails,
  type BgLogsDetails,
  type BgStatusDetails,
  type BgTask,
  type BgTaskSnapshot,
  type ReloadShellActivationClaimV1,
  type ReloadShellActivationLeaseV1,
  type ReloadShellIdentityV1,
  type StartTaskOptions,
  ReloadSurvivalError,
} from "./core/common.js";
import {
  BashOverrideParams,
  bashOverrideRenderCall,
  bashOverrideRenderResult,
  createBashOverrideDeps,
  createBashOverrideExecute,
  prependCommandPrefix,
  type BashOverrideDetails,
} from "./bash-override.js";
import {
  BackgroundTaskRegistry,
  type BackgroundTaskContext,
} from "./core/registry.js";
import {
  getProcessReloadShellOwnerV1,
  makeReloadShellIdentity,
} from "./core/reload-shell-owner.js";
import {
  createShellPolicyGuidanceHandler,
  initializeShellPolicy,
} from "./core/shell-policy.js";
import {
  readHostShellSettings,
  resolveHostShellPath,
} from "./core/host-settings.js";
import {
  installBackgroundTaskExtensionApi,
  type BackgroundTaskExtensionService,
} from "./core/extension-api.js";
import type {
  BackgroundTaskForUi,
  TaskManagerResult,
} from "./ui/background-tasks-manager.js";
import {
  dockShortcutFooterHint,
  parseBackgroundTasksConfig,
} from "./core/config.js";
import {
  LazyModule,
  SynchronousActivationCloseFence,
} from "./core/lazy-module.js";

/**
 * Project-local Pi background task manager.
 *
 * Scope:
 * - M4 同名 `bash` 覆盖:缺省/run_in_background:false 走宿主原生前台路径,
 *   run_in_background:true 进入后台任务栈;独立 `bg_run` 工具已退役不注册。
 * - 用户启动后台任务唯一入口为 dock「转后台」(entrySource:'user',仅通知);
 *   模型入口为覆盖版 bash run_in_background:true(entrySource:'model')。
 * - No Ctrl+B support for backgrounding an already-running built-in bash tool.
 * - Opted ordinary shell jobs can hand their same live process ownership to a
 *   fresh extension activation on real same-process reload only.
 * - No PID/file adoption, process-restart survival, or crash recovery.
 */

const STATUS_INTERVAL_MS = 1000;
const LIGHT_BLUE_BG = "\x1b[48;2;183;223;255m";
const LIGHT_BLUE_FG = "\x1b[38;2;11;70;110m";
const ANSI_RESET = "\x1b[0m";
function lightBlue(value: string): string {
  return `${LIGHT_BLUE_BG}${LIGHT_BLUE_FG}${value}${ANSI_RESET}`;
}

function textContent(text: string) {
  return [{ type: "text" as const, text }];
}

interface TextToolResult {
  content?: ReadonlyArray<{ type: string; text?: string }>;
}

const BgStatusParams = Type.Object({
  taskId: Type.Optional(
    Type.String({
      description:
        "Optional task ID or unambiguous prefix. If omitted, all running/recent tasks are returned.",
    }),
  ),
});

const BgLogsParams = Type.Object({
  taskId: Type.String({ description: "Task ID or unambiguous prefix" }),
  maxBytes: Type.Optional(
    Type.Number({
      description: `Maximum bytes to return, capped at ${formatSize(MAX_LOG_BYTES)}. Default: ${formatSize(DEFAULT_LOG_BYTES)}.`,
    }),
  ),
  tail: Type.Optional(
    Type.Boolean({
      description:
        "Read the tail of the log when true, head when false. Default: true.",
    }),
  ),
});

const BgKillParams = Type.Object({
  taskId: Type.String({ description: "Task ID or unambiguous prefix to stop" }),
});

function renderPlainResult(
  result: TextToolResult,
  options: ToolRenderResultOptions,
  theme: Theme,
) {
  void options;
  void theme;
  const text =
    result.content
      ?.map((part) => (part.type === "text" ? (part.text ?? "") : ""))
      .join("\n") ?? "";
  return new Text(text, 0, 0);
}

export default async function backgroundTasksExtension(
  pi: ExtensionAPI,
): Promise<void> {
  const config = parseBackgroundTasksConfig();
  const dockEntryHint = dockShortcutFooterHint(config.dockShortcut);
  // S1 P1+P2:宿主 settings 自读生效 + 前后台 shell 同源化。整条解析链可能 throw
  // (customShellPath 不存在;Win32 无 Git Bash/无 bash.exe 时 getShellConfig(undefined)
  // 同样 throw)→ resolveHostShellPath 内 try/catch 静默降级 → hostShellPath 置
  // undefined 走 env.SHELL 兜底,插件照常激活(不复现宿主崩溃)。仅读用户级
  // settings(项目级合并不在读取面)。
  const hostShellSettings = await readHostShellSettings();
  const hostShellPath = resolveHostShellPath(hostShellSettings);
  const shellPolicy = initializeShellPolicy({ hostShellPath });
  const reloadShellOwner = getProcessReloadShellOwnerV1();
  pi.on("before_agent_start", createShellPolicyGuidanceHandler(shellPolicy));
  const seenTaskIds = new Set<string>();
  let currentCtx: ExtensionContext | undefined;
  let currentRegistryCtx: BackgroundTaskContext | undefined;
  let activationLease: ReloadShellActivationLeaseV1 | undefined;
  let activationIdentity: ReloadShellIdentityV1 | undefined;
  let pendingActivationClaim: ReloadShellActivationClaimV1 | undefined;
  let dockOpen = false;
  let statusInterval: NodeJS.Timeout | undefined;
  let disposed = false;
  let shutdownCleanupStarted = false;
  let reloadHandoffFailed = false;
  let shutdownReason = "shutdown";
  const activationCloseFence = new SynchronousActivationCloseFence();
  const taskManagerLoader = new LazyModule(
    "background-task-manager",
    () => import("./ui/background-tasks-manager.js"),
  );

  const registryContext = (ctx: ExtensionContext): BackgroundTaskContext => ({
    cwd: ctx.cwd,
    sessionId: ctx.sessionManager.getSessionId(),
    modelRegistry: ctx.modelRegistry,
    model: ctx.model,
  });

  const registry = new BackgroundTaskRegistry({
    onChange: () => {
      updateUi();
    },
    sendCompletionNotification: (message, options) => {
      pi.sendMessage(message, options);
    },
    publishTerminal: (publication) => {
      eventService.publishTerminal(publication);
    },
    shellPolicy,
    reloadShellOwner,
  });
  const eventService: BackgroundTaskExtensionService =
    installBackgroundTaskExtensionApi({
      events: pi.events,
      registry,
      getContext: () => currentRegistryCtx,
      isShuttingDown: () => registry.isShuttingDown(),
    });

  const beginSessionShutdown = (reason: string): void => {
    let handoffError: unknown;
    if (!disposed) {
      disposed = true;
      registry.closeTaskAdmissions();
      if (pendingActivationClaim !== undefined) {
        const claim = pendingActivationClaim;
        pendingActivationClaim = undefined;
        registry.abortReloadActivation(claim);
        try {
          reloadShellOwner.abortActivation(
            claim,
            new ReloadSurvivalError(
              "pi_bg_reload_owner_stale_claim",
              "activation shut down while its reload claim was staging",
            ),
          );
        } catch (error) {
          handoffError = error;
        }
      } else if (reason === "reload" && activationLease !== undefined) {
        const lease = activationLease;
        try {
          registry.prepareReloadHandoff(lease);
          activationLease = undefined;
          activationIdentity = undefined;
        } catch (error) {
          reloadHandoffFailed = true;
          handoffError = error;
        }
      }
      registry.setShuttingDown(true);
      eventService.close();
    }
    // Teardown remains active on repeated calls so even a handle assigned by a
    // racing continuation is still disposed rather than hidden by idempotence.
    currentCtx = undefined;
    currentRegistryCtx = undefined;
    if (statusInterval !== undefined) {
      clearInterval(statusInterval);
      statusInterval = undefined;
    }
    if (handoffError !== undefined) throw handoffError;
  };

  // Join the one synchronous all-lane barrier before any facade can register
  // asynchronous cleanup. The core callback performs an eligible reload
  // handoff first; every lazy lane then closes on the same call stack before
  // Pi can await any later cleanup handler.
  activationCloseFence.add(() => {
    beginSessionShutdown(shutdownReason);
  });
  activationCloseFence.add(() => {
    taskManagerLoader.close("session shutdown");
  });
  pi.on("session_shutdown", (event) => {
    shutdownReason = event.reason;
    activationCloseFence.close();
  });

  // This is the first session_start callback. Claim synchronously before the
  // first await, stage/import durably, then expose the fresh host adapter.
  pi.on("session_start", async (event, ctx) => {
    if (disposed) return;
    const nextRegistryCtx = registryContext(ctx);
    const identity = makeReloadShellIdentity(
      nextRegistryCtx.sessionId ?? "",
      realpathSync(ctx.cwd),
    );
    if (activationLease !== undefined && registry.hasCurrentReloadLease()) {
      if (
        activationIdentity?.hostPid !== identity.hostPid ||
        activationIdentity.sessionId !== identity.sessionId ||
        activationIdentity.cwdRealpath !== identity.cwdRealpath
      ) {
        throw new ReloadSurvivalError(
          "pi_bg_reload_owner_activation_conflict",
          "a repeated session_start changed the bound reload owner identity without shutdown",
        );
      }
      currentCtx = ctx;
      currentRegistryCtx = nextRegistryCtx;
      return;
    }
    const activationNonce = randomBytes(16).toString("hex");
    const claim = reloadShellOwner.beginActivation(
      identity,
      event.reason,
      activationNonce,
    );
    pendingActivationClaim = claim;
    // M2 branchGeneration fence:以本激活的 reload 代次推进注册表代次;
    // 导入的旧代次任务帧标陈旧、不触发唤醒
    registry.setActiveBranchGeneration(claim.generation);
    try {
      const adapter = await registry.stageReloadActivation(claim);
      if (pendingActivationClaim !== claim) {
        // The synchronous shutdown barrier already aborted this claim and
        // detached staged records while the durable import awaited.
        registry.abortReloadActivation(claim);
        return;
      }
      if (disposed) {
        registry.abortReloadActivation(claim);
        pendingActivationClaim = undefined;
        reloadShellOwner.abortActivation(
          claim,
          new ReloadSurvivalError(
            "pi_bg_reload_owner_stale_claim",
            "activation was disposed before reload claim commit",
          ),
        );
        return;
      }
      const lease = reloadShellOwner.commitActivation(claim, adapter);
      pendingActivationClaim = undefined;
      activationLease = lease;
      activationIdentity = identity;
      currentCtx = ctx;
      currentRegistryCtx = nextRegistryCtx;
    } catch (error) {
      registry.abortReloadActivation(claim);
      if (pendingActivationClaim === claim) pendingActivationClaim = undefined;
      try {
        reloadShellOwner.abortActivation(claim, error);
      } catch (abortError) {
        if (
          typeof abortError !== "object" ||
          abortError === null ||
          Reflect.get(abortError, "code") !== "pi_bg_reload_owner_stale_claim"
        ) {
          throw new AggregateError(
            [error, abortError],
            "Reload activation claim and abort failed",
          );
        }
      }
      throw error;
    }
  });

  function unseenFinishedTasks(): BgTask[] {
    return registry
      .allTasks()
      .filter((task) => task.status !== "running" && !seenTaskIds.has(task.id));
  }

  function clearFinishedNotices(ctx = currentCtx): number {
    const unseen = unseenFinishedTasks();
    for (const task of unseen) seenTaskIds.add(task.id);
    updateUi(ctx);
    return unseen.length;
  }

  function notifyClearFinishedNotices(ctx: ExtensionContext): void {
    currentCtx = ctx;
    const cleared = clearFinishedNotices(ctx);
    if (!ctx.hasUI) return;
    ctx.ui.notify(
      cleared > 0
        ? `Cleared ${String(cleared)} finished background task notice${cleared === 1 ? "" : "s"}.`
        : "No finished background task notices to clear.",
      cleared > 0 ? "info" : "warning",
    );
  }

  function updateUi(ctx = currentCtx): void {
    if (registry.isShuttingDown() || !ctx) return;
    try {
      if (!ctx.hasUI) return;
      const allTasks = registry.allTasks();
      const running = allTasks.filter((task) => task.status === "running");
      const unseenFailed = allTasks.filter(
        (task) => task.status === "failed" && !seenTaskIds.has(task.id),
      );
      const unseenStopped = allTasks.filter(
        (task) =>
          (task.status === "killed" || task.status === "cancelled") &&
          !seenTaskIds.has(task.id),
      );
      const unseenDone = allTasks.filter(
        (task) => task.status === "completed" && !seenTaskIds.has(task.id),
      );
      const unseenFinishedCount =
        unseenFailed.length + unseenStopped.length + unseenDone.length;
      ctx.ui.setWidget("background-tasks", undefined);
      if (running.length === 0 && unseenFinishedCount === 0) {
        ctx.ui.setStatus("background-tasks", undefined);
        return;
      }

      const parts: string[] = [];
      if (running.length > 0) parts.push(`${String(running.length)} running`);
      if (unseenFailed.length > 0)
        parts.push(`${String(unseenFailed.length)} failed`);
      if (unseenStopped.length > 0)
        parts.push(`${String(unseenStopped.length)} stopped`);
      if (unseenDone.length > 0)
        parts.push(`${String(unseenDone.length)} done`);
      const entryHint = dockOpen
        ? "focused"
        : `${dockEntryHint}${unseenFinishedCount > 0 ? " · /bg-clear" : ""}`;
      const segments = [...parts, entryHint];
      const label = ` bg ${segments.join(" · ")} `;
      ctx.ui.setStatus("background-tasks", lightBlue(label));
    } catch (error) {
      console.error(
        `[background-tasks] UI update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      currentCtx = undefined;
    }
  }

  async function startTask(
    ctx: ExtensionContext,
    command: string,
    options: StartTaskOptions = {},
  ): Promise<BgTask> {
    currentCtx = ctx;
    const nextRegistryCtx = registryContext(ctx);
    currentRegistryCtx = nextRegistryCtx;
    // REVIEW N1:与覆盖版 bash 后台路径同源(prependCommandPrefix 的 `<prefix>\n
    // <command>` 换行拼接,宿主前台 bash.ts:251 对齐)——dock「转后台」与 rerun
    // 两入口统一前置宿主 shellCommandPrefix;无前缀时原样提交。
    const prefixedCommand = prependCommandPrefix(
      hostShellSettings.commandPrefix,
      command,
    );
    return registry.startTask(nextRegistryCtx, prefixedCommand, options);
  }

  async function openTaskManager(
    ctx: ExtensionCommandContext | ExtensionContext,
    initialTaskId?: string,
  ): Promise<void> {
    currentCtx = ctx;
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "Background task manager requires an interactive Pi UI. Use /bg-jobs, /bg-logs, or the bg_status/bg_logs tools in non-interactive mode.",
        "error",
      );
      return;
    }
    const { BackgroundTasksManager } = await taskManagerLoader.run(
      (runtime) => runtime,
    );
    dockOpen = true;
    updateUi(ctx);
    try {
      await ctx.ui.custom<TaskManagerResult>(
        (tui, theme, _keybindings, done) => {
          const managerOptions = {
            getTasks: () => registry.allTasks(),
            stopTask: async (task: BackgroundTaskForUi) => {
              // dock k 快捷键 → initiator=user
              await registry.stopTask(
                registry.resolveTask(task.id),
                "user",
                undefined,
                "user",
              );
              updateUi(ctx);
            },
            stopAllRunning: async () => {
              const result = await registry.stopAllRunning(
                "user",
                undefined,
                "user",
              );
              updateUi(ctx);
              return result;
            },
            rerunTask: async (task: BackgroundTaskForUi) => {
              const rerunOptions: StartTaskOptions = {
                isAgent: task.isAgent,
                surviveReload: task.surviveReload,
                notifyOnCompletion: true,
                triggerOnCompletion: false,
              };
              // REVIEW N2:仅当任务确有显式 name 时透传;无显式名任务省略 name,
              // 新任务(registry 创建点仅显式名赋值)沿完整 command 原样兜底,
              // 避免 rerun 后显示名退化为 80 字符截断版。
              if (task.name !== undefined) rerunOptions.name = task.name;
              if (task.description !== undefined)
                rerunOptions.description = task.description;
              if (task.timeoutSeconds !== undefined)
                rerunOptions.timeoutSeconds = task.timeoutSeconds;
              const rerun = await startTask(ctx, task.command, rerunOptions);
              updateUi(ctx);
              return rerun;
            },
            startBackgroundTask: async (command: string) => {
              // dock「转后台」用户入口 → entrySource:'user':仅通知、不唤醒
              const task = await startTask(ctx, command, {
                entrySource: "user",
              });
              updateUi(ctx);
              return task;
            },
            showOutputPath: (task: BackgroundTaskForUi) => {
              ctx.ui.notify(
                `Output path for ${taskDisplayName(task)} (${task.id}):\n${task.outputPath}`,
                "info",
              );
            },
            markSeen: (taskId: string) => {
              seenTaskIds.add(taskId);
              updateUi(ctx);
            },
            markFinishedSeen: (taskIds: string[]) => {
              for (const taskId of taskIds) seenTaskIds.add(taskId);
              updateUi(ctx);
            },
            isSeen: (taskId: string) => seenTaskIds.has(taskId),
          };
          if (initialTaskId)
            return new BackgroundTasksManager(tui, theme, done, {
              ...managerOptions,
              initialTaskId,
            });
          return new BackgroundTasksManager(tui, theme, done, managerOptions);
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "bottom-center",
            width: "96%",
            minWidth: 64,
            maxHeight: "60%",
            margin: { bottom: 1, left: 1, right: 1 },
          },
        },
      );
    } finally {
      dockOpen = false;
      updateUi(ctx);
    }
  }

  pi.registerMessageRenderer<BgTaskSnapshot>(
    "background-task-notification",
    (message, _options, theme) => {
      const task = message.details;
      const status = task?.status ?? "completed";
      const color: ThemeColor =
        status === "completed"
          ? "success"
          : status === "failed"
            ? "error"
            : status === "killed" || status === "cancelled" || status === "lost"
              ? "warning"
              : "accent";
      const id = task?.id ?? "background task";
      const name = task ? taskDisplayName(task) : "Background task";
      const output = task?.outputPath
        ? `\n${theme.fg("dim", `Output: ${task.outputPath}`)}`
        : "";
      const error = task?.error ? `\n${theme.fg("error", task.error)}` : "";
      return new Text(
        `${theme.fg(color, `[bg ${status}]`)} ${theme.fg("accent", name)} ${theme.fg("dim", `(${id})`)}${output}${error}`,
        0,
        0,
      );
    },
  );

  pi.on("session_start", async (_event, ctx) => {
    // Pi replacement binds a fresh extension instance. Never revive this old
    // activation if a late lifecycle dispatch reaches it after shutdown.
    if (disposed) return;
    registry.setShuttingDown(false);
    currentCtx = ctx;
    const nextRegistryCtx = currentRegistryCtx ?? registryContext(ctx);
    currentRegistryCtx = nextRegistryCtx;
    await registry.ensureRuntimeDir(nextRegistryCtx);
    // M2 启动审计:遍历运行目录,遗留 running 记录标 lost;审计失败不阻断激活
    try {
      await registry.auditStartupRecords(nextRegistryCtx);
    } catch (error) {
      console.error(
        `[background-tasks] startup audit failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (disposed) return;
    updateUi(ctx);
    if (disposed) return;
    if (statusInterval !== undefined) clearInterval(statusInterval);
    if (disposed) return;
    const nextStatusInterval = setInterval(() => {
      updateUi();
    }, STATUS_INTERVAL_MS);
    if (disposed) {
      clearInterval(nextStatusInterval);
      return;
    }
    statusInterval = nextStatusInterval;
  });

  pi.on("session_shutdown", async (event, ctx) => {
    // REVIEW:beginSessionShutdown 在 reload handoff 失败时置位 reloadHandoffFailed
    // 并以 handoffError 抛错。清理块放入 finally,保证 running 任务仍被停止、宿主
    // 句柄仍被释放;原抛错语义在清理完成后还原,不被吞掉(清理自身失败时以
    // AggregateError 保留两者)。
    let shutdownError: unknown;
    try {
      beginSessionShutdown(event.reason);
    } catch (error) {
      shutdownError = error;
    }
    const cleanup = (async (): Promise<void> => {
      if (shutdownCleanupStarted) return;
      shutdownCleanupStarted = true;
      try {
        // Admission closure aborts cooperative preflight and the drain retains
        // ownership until subprocess/file/managed cleanup settles. Any admitted
        // child is inserted synchronously before spawn and is visible below.
        await registry.waitForTaskAdmissions();
        const running = registry
          .allTasks()
          .filter((task) => task.status === "running");
        if (running.length === 0) return;

        const failures: string[] = [];
        await Promise.all(
          running.map(async (task) => {
            try {
              await registry.stopTask(
                task,
                "shutdown",
                `Killed during Pi session shutdown (${event.reason})`,
                "system",
              );
            } catch (error) {
              const message = `${task.id}: ${error instanceof Error ? error.message : String(error)}`;
              failures.push(message);
              console.error(
                `[background-tasks] shutdown cleanup failed for ${message}`,
              );
            }
          }),
        );
        if (failures.length > 0 && ctx.hasUI) {
          ctx.ui.notify(
            `Background task cleanup failed:\n${failures.join("\n")}`,
            "error",
          );
        }
      } finally {
        eventService.close();
        if (
          (event.reason !== "reload" || reloadHandoffFailed) &&
          activationLease !== undefined
        ) {
          try {
            await registry.waitForReloadHostSettlement();
          } catch (error) {
            console.error(
              "[background-tasks] reload owner host settlement failed during shutdown:",
              error,
            );
          }
          registry.releaseReloadActivation(activationLease);
          activationLease = undefined;
          activationIdentity = undefined;
        }
      }
    })();
    try {
      await cleanup;
    } catch (error) {
      if (shutdownError === undefined) throw error;
      if (shutdownError !== error) {
        throw new AggregateError(
          [shutdownError, error],
          "Session shutdown handoff and cleanup both failed",
        );
      }
    }
    if (shutdownError !== undefined) throw shutdownError;
  });

  pi.registerCommand("bg-clear", {
    description: "Clear finished background task footer notices",
    handler: (_args, ctx) => {
      notifyClearFinishedNotices(ctx);
      return Promise.resolve();
    },
  });

  if (config.dockShortcut === "shift+down") {
    pi.registerShortcut("shift+down" satisfies KeyId, {
      description: "Open focused background task footer dock",
      handler: async (ctx) => {
        await openTaskManager(ctx);
      },
    });
  }

  if (config.dockShortcut === "ctrl+alt+b") {
    pi.registerShortcut("ctrl+alt+b" satisfies KeyId, {
      description: "Open focused background task footer dock",
      handler: async (ctx) => {
        await openTaskManager(ctx);
      },
    });
  }

  pi.registerShortcut("ctrl+alt+c" satisfies KeyId, {
    description:
      "Clear finished background task footer notices (terminal-dependent fallback for /bg-clear)",
    handler: (ctx) => {
      notifyClearFinishedNotices(ctx);
    },
  });

  pi.registerCommand("bg-jobs", {
    description: "List running and recent background tasks: /bg-jobs",
    handler: (_args, ctx) => {
      currentCtx = ctx;
      ctx.ui.notify(
        formatSnapshotList(
          registry.allTasks().map((task) => registry.snapshot(task)),
        ),
        "info",
      );
      updateUi(ctx);
      return Promise.resolve();
    },
  });

  pi.registerCommand("bg-logs", {
    description:
      "Show bounded output from a background task: /bg-logs <id> [maxBytes]",
    getArgumentCompletions: (prefix) => {
      const matches = registry
        .allTasks()
        .filter((task) => task.id.startsWith(prefix.trim()))
        .slice(0, 20)
        .map((task) => ({
          value: task.id,
          label: `${task.id} ${taskDisplayName(task)}`,
          description: `${task.status} — ${truncateChars(task.command, 60)}`,
        }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      try {
        currentCtx = ctx;
        const [id, bytes] = args.trim().split(/\s+/, 2);
        const task = registry.resolveTask(id ?? "");
        const maxBytes = normalizeMaxBytes(Number(bytes), DEFAULT_LOG_BYTES);
        const logs = await registry.getTaskLogs(task, maxBytes, true);
        ctx.ui.notify(logs.text, "info");
      } catch (error) {
        ctx.ui.notify(
          `Background logs error: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("bg-kill", {
    description: "Stop a running background task: /bg-kill <id>",
    getArgumentCompletions: (prefix) => {
      const matches = registry
        .allTasks()
        .filter(
          (task) =>
            task.status === "running" && task.id.startsWith(prefix.trim()),
        )
        .slice(0, 20)
        .map((task) => ({
          value: task.id,
          label: `${task.id} ${taskDisplayName(task)}`,
          description: truncateChars(task.command, 70),
        }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      try {
        currentCtx = ctx;
        const task = registry.resolveTask(args.trim());
        // /bg-kill 命令 → initiator=user
        await registry.stopTask(task, "user", undefined, "user");
        ctx.ui.notify(
          `Killed ${taskDisplayName(task)} (${task.id}). Output: ${task.outputPath}`,
          "info",
        );
        updateUi(ctx);
      } catch (error) {
        ctx.ui.notify(
          `Background kill error: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  // M4:注册同名小写 `bash` 工具覆盖宿主原生 bash(命中宿主工具注册表 Map
  // 同名覆盖)。execute 分流由 bash-override.ts 执行:缺省/run_in_background:false
  // → 宿主原生前台路径(createLocalBashOperations,逐行等价);run_in_background:true
  // → 插件后台栈(entrySource:'model',完成通知缺省 notify+trigger)。
  // 渲染器沿用宿主 bash 自带渲染,不新增渲染器。
  const bashOverrideDeps = createBashOverrideDeps({
    baseCwd: process.cwd(),
    // S1 P1+P2 宿主同源注入:前台经 createBashToolDefinition 第二参对齐
    // 宿主 _buildRuntime(agent-session.ts:3243-3254);后台经 shell 策略链与
    // commandPrefix 前置生效
    hostShellPath,
    hostCommandPrefix: hostShellSettings.commandPrefix,
    startBackgroundTask: async (ctx, command, options) => {
      currentCtx = ctx;
      currentRegistryCtx = registryContext(ctx);
      return registry.startTask(currentRegistryCtx, command, options);
    },
  });
  pi.registerTool<typeof BashOverrideParams, BashOverrideDetails, unknown>({
    name: "bash",
    label: "bash",
    description:
      "Execute a bash command in the current working directory (identical to the built-in bash tool). Returns stdout and stderr; output is truncated to a bounded tail and the full output path is included when truncated. Optionally provide a timeout in seconds. Set run_in_background:true to detach the command as a durable background task instead: the call returns immediately with a task id and output path; default completion delivery sends <background-task-notification> and starts a follow-up agent turn.",
    promptSnippet:
      "Execute bash commands (ls, grep, find, etc.); set run_in_background:true to detach long-running work",
    promptGuidelines: [
      "Run short commands with bash as usual. Use run_in_background:true for commands expected to run for a long time, such as test suites, dev servers, watchers, or builds.",
      "With run_in_background:true the call returns immediately with a task id and output path; default completion delivery sends <background-task-notification> and starts a follow-up agent turn, so do not sleep or poll merely to wait.",
      "Treat <background-task-notification> as durable terminal truth. Do not call bg_status to reconfirm it; call bg_logs only when the task output is needed.",
      "Use bg_status/bg_logs only when the user explicitly requests an update, automatic notification or wake-up was deliberately disabled, there is concrete evidence the task is hung, or a terminal notification arrived and output details are needed.",
    ],
    parameters: BashOverrideParams,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    execute: createBashOverrideExecute(bashOverrideDeps),
    renderCall: bashOverrideRenderCall,
    renderResult: bashOverrideRenderResult,
  });

  pi.registerTool<typeof BgStatusParams, BgStatusDetails>({
    name: "bg_status",
    label: "Background Status",
    description:
      "Inspect one background task or list all running/recent background tasks. This is a point-in-time inspection tool, not a waiting primitive.",
    promptSnippet:
      "Inspect point-in-time status for one or all background tasks; never poll it as a wait loop",
    promptGuidelines: [
      "Use bg_status for deliberate point-in-time inspection, not as a waiting primitive.",
      "A running result is not an instruction to poll again. Do not repeatedly call bg_status while an automatic terminal notification is pending.",
      "Use bg_status when the user explicitly requests an update, automatic completion handling was disabled, or concrete evidence suggests a task is hung; terminal notifications do not need reconfirmation.",
    ],
    parameters: BgStatusParams,
    execute(_toolCallId, params) {
      const selected = params.taskId
        ? [registry.resolveTask(params.taskId)]
        : registry.allTasks();
      const snapshots = selected.map((task) => registry.snapshot(task));
      return Promise.resolve({
        content: textContent(formatSnapshotList(snapshots)),
        details: { tasks: snapshots },
      });
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("bg_status"))}${args.taskId ? ` ${theme.fg("accent", args.taskId)}` : ""}`,
        0,
        0,
      );
    },
    renderResult: renderPlainResult,
  });

  pi.registerTool<typeof BgLogsParams, BgLogsDetails>({
    name: "bg_logs",
    label: "Background Logs",
    description: `Read bounded output from a background task for deliberate inspection; this is not a waiting primitive. Output is capped at ${formatSize(MAX_LOG_BYTES)} for model safety and points to the full output file when truncated.`,
    promptSnippet:
      "Read bounded task output when needed; never tail it repeatedly as a wait loop",
    promptGuidelines: [
      "Use bg_logs with a modest maxBytes value only when task output is needed, without flooding context.",
      "Do not repeatedly call bg_logs to wait for completion while an automatic terminal notification is pending.",
      "Use bg_status first only when a deliberate inspection requires the current task state; do not reconfirm a terminal notification.",
    ],
    parameters: BgLogsParams,
    async execute(_toolCallId, params) {
      const task = registry.resolveTask(params.taskId);
      const logs = await registry.getTaskLogs(
        task,
        normalizeMaxBytes(params.maxBytes),
        params.tail ?? true,
      );
      return {
        content: textContent(logs.text),
        details: logs.details,
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("bg_logs "))}${theme.fg("accent", args.taskId)}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details;
      let text = `${theme.fg("accent", taskDisplayName(details.task))} ${theme.fg("dim", `(${details.task.id})`)} ${theme.fg("muted", details.tail ? "tail" : "head")} ${formatSize(details.bytesRead)} / ${formatSize(details.totalBytes)}`;
      if (details.truncated) text += theme.fg("warning", " (truncated)");
      text += `\n${theme.fg("dim", `Full output: ${details.path}`)}`;
      if (expanded) {
        const output = result.content
          .map((content) =>
            content.type === "text" ? content.text : "[image content]",
          )
          .join("\n");
        text += `\n${theme.fg("toolOutput", output.split("\n").slice(0, 30).join("\n"))}`;
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool<typeof BgKillParams, BgKillDetails>({
    name: "bg_kill",
    label: "Background Kill",
    description:
      "Stop a running background task by ID. Fails loudly if the task is unknown or already finished.",
    promptSnippet: "Stop a running background task by ID",
    promptGuidelines: [
      "Use bg_kill when the user asks to stop a background task or when a background command launched via run_in_background:true (or the dock「转后台」entry) is no longer needed.",
    ],
    parameters: BgKillParams,
    async execute(_toolCallId, params) {
      const task = registry.resolveTask(params.taskId);
      // bg_kill 工具(模型入口)→ initiator=model
      await registry.stopTask(task, "user", undefined, "model");
      const message = `Killed background task ${taskDisplayName(task)} (${task.id}). Output: ${task.outputPath}`;
      return {
        content: textContent(message),
        details: { task: registry.snapshot(task), message },
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("bg_kill "))}${theme.fg("accent", args.taskId)}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const { task } = result.details;
      return new Text(
        `${theme.fg("warning", "■ killed")} ${theme.fg("accent", taskDisplayName(task))} ${theme.fg("dim", `(${task.id})`)}\n${theme.fg("dim", `Output: ${task.outputPath}`)}`,
        0,
        0,
      );
    },
  });
}
