import {
  accessSync,
  constants,
  existsSync,
  statSync,
  type WriteStream,
} from "node:fs";
import { open } from "node:fs/promises";
import {
  basename,
  delimiter,
  extname,
  isAbsolute,
  join,
  resolve,
  win32,
} from "node:path";
import { DEFAULT_MAX_BYTES, formatSize } from "@earendil-works/pi-coding-agent";
import type { BackgroundTaskChildProcess } from "./registry.js";

export const TASK_STATUS_VALUES = [
  "running",
  "completed",
  "failed",
  "cancelled",
  "killed",
  "lost",
] as const;
export const TERMINAL_TASK_STATUS_VALUES = [
  "completed",
  "failed",
  "cancelled",
  "killed",
  "lost",
] as const;

export type TaskStatus = (typeof TASK_STATUS_VALUES)[number];
export type TerminalTaskStatus = (typeof TERMINAL_TASK_STATUS_VALUES)[number];
export type FailedReason =
  "exit_error" | "timed_out" | "output_limit" | "spawn_error" | "disk_full";
/** 停止发起者,冲突优先级 user > model > system。 */
export type StopInitiator = "user" | "model" | "system";
export type KillKind =
  "user" | "timeout" | "output_cap" | "disk_full" | "shutdown";
export type ReloadShellStopKind = KillKind | "handoff_expired";

export type TerminalPublicationState = "pending" | "delivered" | "abandoned";
export type TerminalPublicationAbandonReason =
  | "registry_shutdown"
  | "publisher_closed"
  | "gate_rejected"
  | "retry_exhausted"
  | "retention_limit"
  | "reload_handoff_expired";

export type ReloadSurvivalErrorCode =
  | "pi_bg_survive_reload_invalid"
  | "pi_bg_survive_reload_requires_non_agent"
  | "pi_bg_survive_reload_requires_shell_command"
  | "pi_bg_reload_owner_unavailable"
  | "pi_bg_reload_owner_protocol_incompatible"
  | "pi_bg_reload_owner_activation_conflict"
  | "pi_bg_reload_owner_stale_claim"
  | "pi_bg_reload_handoff_expired";

export class ReloadSurvivalError extends Error {
  constructor(
    readonly code: ReloadSurvivalErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ReloadSurvivalError";
  }
}

export type JsonObject = Readonly<Record<PropertyKey, unknown>>;

export interface TaskContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface TaskTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costTotal?: number;
}

export interface TaskToolUsage {
  total: number;
  failed: number;
  byName: Record<string, number>;
}

export interface ReloadSurvivalSnapshotV1 {
  schemaVersion: "pi-background-tasks.reload-shell.v1";
  authority: "same-process-live-owner";
  hostPid: number;
  sessionId: string;
  cwdRealpath: string;
  launchNonce: string;
  completionId: string;
  spawnedAt: number;
  childPid: number;
  timeoutDeadlineAt?: number | undefined;
  outputCapBytes: number;
  posixProcessGroupId?: number | undefined;
  windowsTreeRootPid?: number | undefined;
  leaseGeneration: number;
  handoffCount: number;
}

export interface ReloadShellIdentityV1 {
  readonly hostPid: number;
  readonly sessionId: string;
  readonly cwdRealpath: string;
}

export interface ReloadShellActivationLeaseV1 {
  readonly protocol: "pi-background-tasks.reload-shell-owner.v1";
  readonly hubNonce: string;
  readonly identityKey: string;
  readonly generation: number;
  readonly activationNonce: string;
}

export interface ReloadShellActivationClaimV1 {
  readonly protocol: "pi-background-tasks.reload-shell-owner.v1";
  readonly hubNonce: string;
  readonly claimNonce: string;
  readonly identity: ReloadShellIdentityV1;
  readonly identityKey: string;
  readonly generation: number;
  readonly activationNonce: string;
  readonly expiresAt?: number | undefined;
  readonly executions: readonly ReloadableShellExecutionV1[];
}

export interface ReloadShellProcessV1 {
  readonly pid?: number | undefined;
  stdout?:
    | {
        on(event: "data", listener: (data: Buffer | string) => void): unknown;
        off?(event: "data", listener: (data: Buffer | string) => void): unknown;
      }
    | null
    | undefined;
  stderr?:
    | {
        on(event: "data", listener: (data: Buffer | string) => void): unknown;
        off?(event: "data", listener: (data: Buffer | string) => void): unknown;
      }
    | null
    | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  off?(event: "error", listener: (error: Error) => void): unknown;
  off?(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

export interface ReloadShellOwnerEventSinkV1 {
  readonly onChanged: (execution: ReloadableShellExecutionV1) => void;
  readonly onTerminal: (execution: ReloadableShellExecutionV1) => void;
}

export type ReloadShellNotificationState =
  "disabled" | "pending" | "sending" | "delivered";

export interface ReloadableShellExecutionV1 {
  readonly protocol: "pi-background-tasks.reload-shell-owner.v1";
  readonly launchNonce: string;
  readonly completionId: string;
  readonly task: BgTask;
  child: ReloadShellProcessV1 | undefined;
  outputStream: WriteStream | undefined;
  readonly spawnedAt: number;
  readonly timeoutDeadlineAt?: number | undefined;
  readonly outputCapBytes: number;
  readonly terminal: Promise<BgTask>;
  readonly requestStop: (
    kind: ReloadShellStopKind,
    reason?: string,
  ) => Promise<BgTask>;
  phase:
    | "starting"
    | "running"
    | "stop_requested"
    | "finalizing"
    | "terminal"
    | "released";
  closeObservation?:
    | {
        code: number | null;
        signal: NodeJS.Signals | null;
        observedAt: number;
      }
    | undefined;
  admissionCommitted: boolean;
  notificationState: ReloadShellNotificationState;
  readonly commitInitialMetadata: (signal?: AbortSignal) => Promise<void>;
  readonly failAdmission: (error: Error) => void;
  readonly setOwnerEventSink: (
    sink: ReloadShellOwnerEventSinkV1 | undefined,
  ) => void;
  readonly markAdmissionCommitted: (
    generation: number,
    handoffCount: number,
  ) => void;
  readonly updateLeaseAudit: (generation: number, handoffCount: number) => void;
  readonly abandonReloadHandoff: () => void;
  readonly beginNotification: (
    lease: ReloadShellActivationLeaseV1,
  ) => string | undefined;
  readonly finishNotification: (token: string, delivered: boolean) => void;
  readonly releaseResources: () => void;
}

export interface ReloadShellHostAdapterV1 {
  readonly activationNonce: string;
  readonly onBound: (lease: ReloadShellActivationLeaseV1) => void;
  readonly onChanged: (execution: ReloadableShellExecutionV1) => void;
  readonly onTerminal: (execution: ReloadableShellExecutionV1) => void;
}

export interface ReloadShellOwnerHubV1 {
  readonly protocol: "pi-background-tasks.reload-shell-owner.v1";
  readonly hubNonce: string;
  beginActivation(
    identity: ReloadShellIdentityV1,
    startReason: string,
    activationNonce: string,
  ): ReloadShellActivationClaimV1;
  commitActivation(
    claim: ReloadShellActivationClaimV1,
    adapter: ReloadShellHostAdapterV1,
  ): ReloadShellActivationLeaseV1;
  abortActivation(claim: ReloadShellActivationClaimV1, error: unknown): void;
  beginReloadHandoff(
    lease: ReloadShellActivationLeaseV1,
  ): readonly ReloadableShellExecutionV1[];
  releaseActivation(lease: ReloadShellActivationLeaseV1): void;
  registerExecution(
    lease: ReloadShellActivationLeaseV1,
    execution: ReloadableShellExecutionV1,
  ): void;
  markAdmissionCommitted(
    lease: ReloadShellActivationLeaseV1,
    execution: ReloadableShellExecutionV1,
  ): void;
  releaseExecution(
    leaseOrClaim: ReloadShellActivationLeaseV1 | ReloadShellActivationClaimV1,
    execution: ReloadableShellExecutionV1,
  ): void;
  isCurrentLease(lease: ReloadShellActivationLeaseV1): boolean;
}

export interface BgTaskSnapshot {
  id: string;
  name?: string | undefined;
  command: string;
  description?: string | undefined;
  status: TaskStatus;
  outputPath: string;
  cwd: string;
  startTime: number;
  endTime?: number | undefined;
  exitCode?: number | null | undefined;
  signal?: string | null | undefined;
  pid?: number | undefined;
  bytesWritten: number;
  isAgent: boolean;
  surviveReload: boolean;
  reloadSurvival?: ReloadSurvivalSnapshotV1 | undefined;
  error?: string | undefined;
  notified: boolean;
  notifyOnCompletion: boolean;
  triggerOnCompletion: boolean;
  timeoutSeconds?: number | undefined;
  contextUsage?: TaskContextUsage | undefined;
  tokenUsage?: TaskTokenUsage | undefined;
  toolUsage?: TaskToolUsage | undefined;
  model?: string | undefined;
  telemetryUnavailableReason?: string | undefined;
  /** 停止发起者:user/model 停止 → cancelled;system 关闭 → killed;<br>冲突按优先级 user > model > system 记录。 */
  stopInitiator?: StopInitiator | undefined;
  /** 注册时所属扩展激活代次,用于跨 reload 迟到结算 fence(旧代次帧标陈旧、不触发唤醒)。 */
  branchGeneration?: number | undefined;
  /** 失败原因(status=failed 时的细分)。 */
  failedReason?: FailedReason | undefined;
  /** Immutable non-secret shell selection for ordinary shell tasks. */
  shellPolicy?: ShellPolicySnapshot | undefined;
}

export interface BgTask extends Omit<BgTaskSnapshot, "name"> {
  /** 显式命名(覆盖版 bash `task_name` 或 dock rerun 透传);无显式名时保持
   * undefined(S7),显示链在 `taskDisplayName` 内以 description > 完整 command > id 兜底。 */
  name?: string | undefined;
  /** S2 向后兼容别名:与绝对 `outputPath` 值相同;历史字段名保留,新代码一律读 outputPath。 */
  outputAbsPath: string;
  metadataAbsPath: string;
  child?: BackgroundTaskChildProcess | undefined;
  /** Immutable in-memory ownership captured from a detached POSIX spawn; never restored from metadata. */
  ownedPosixProcessGroupId?: number | undefined;
  /** One-way latch preventing any later signal after group authority is released. */
  posixProcessGroupSignalAuthorityReleased?: boolean | undefined;
  stream?: WriteStream | undefined;
  timeoutHandle?: NodeJS.Timeout | undefined;
  killKind?: KillKind | undefined;
  killSignalSent?: boolean | undefined;
  killEscalationTimer?: NodeJS.Timeout | undefined;
  capExceeded?: boolean | undefined;
  /** 软阈值告警锁存:仅提示、不杀任务、不改任务状态(不写入快照)。 */
  softCapWarned?: boolean | undefined;
  /** 双通道 waiter 的后台请求锁存:requestBackground 单发置位(不写入快照)。 */
  backgroundRequested?: boolean | undefined;
  /** branchGeneration 迟到结算 fence 命中标记:旧代次帧标陈旧、不触发唤醒(不写入快照)。 */
  staleBranchFrame?: boolean | undefined;
  /** 入口来源标记(模型/用户语义落点,不写入快照)。 */
  entrySource?: "model" | "user" | undefined;
  /** M5:终态发布时从输出文件取的有界 tail 完成摘要(瞬态,不落盘、不进入快照)。 */
  terminalSummaryTail?: string | undefined;
  /**
   * 内存在途失败原因(与正式状态机 FailedReason 全集对齐)。M1 仅由输出流
   * ENOSPC 与硬阈值超限分支设置,值分别为 disk_full 与 output_limit;M2 补齐
   * 退出码、超时与 spawn 失败路径并进入快照持久化。
   */
  failedReason?: FailedReason | undefined;
  finalized?: boolean | undefined;
  /** True only after the terminal EventBus emitter returns successfully; abandonment is never delivery. */
  terminalPublished: boolean;
  terminalPublicationState: TerminalPublicationState;
  terminalPublicationAbandonReason?:
    TerminalPublicationAbandonReason | undefined;
  terminalPublishAttempts: number;
  terminalPublishInFlight?: boolean | undefined;
  /** True only while the synchronous terminal emitter itself is on the stack. */
  terminalEmitInFlight?: boolean | undefined;
  terminalPublishRetryHandle?: NodeJS.Timeout | undefined;
  /** Optional protocol barrier used by EventBus run requests so early child exits cannot publish before the run response is observable. */
  terminalPublicationGate?: Promise<void> | undefined;
  contextUsageBuffer?: string | undefined;
  /** True when this task launched a telemetry-wrapped Pi agent; its stdout carries control lines, not raw output. */
  telemetryWrapped?: boolean | undefined;
  /** Partial trailing stdout line held between chunks while reconstructing wrapped-agent control lines. */
  agentStdoutBuffer?: string | undefined;
  telemetryUnavailableReason?: string | undefined;
  /** In-memory same-process authority for an opted ordinary shell task; never serialized. */
  reloadExecution?: ReloadableShellExecutionV1 | undefined;
  /** Fresh-registry terminal host delivery state for an imported owner execution. */
  reloadHostDeliveryInFlight?: boolean | undefined;
  reloadHostDeliverySettled?: boolean | undefined;
  reloadHostNotificationSettled?: boolean | undefined;
  metadataWriteChain?: Promise<void> | undefined;
  waiters: Array<() => void>;
}

export type CompletionDeliveryMode =
  "notification-and-wake" | "notification-only" | "manual-monitoring";

export interface CompletionDeliveryGuidance {
  readonly mode: CompletionDeliveryMode;
  readonly notificationEnabled: boolean;
  readonly automaticWakeEnabled: boolean;
  readonly text: string;
}

/**
 * Describe the actual parent-agent completion path for one background launch
 * (覆盖版 bash `run_in_background:true` 或 dock「转后台」)。
 * A wake request cannot take effect without the notification that carries it.
 */
export function deriveCompletionDeliveryGuidance(
  notifyOnCompletion: boolean,
  triggerOnCompletion: boolean,
): CompletionDeliveryGuidance {
  if (notifyOnCompletion && triggerOnCompletion) {
    return {
      mode: "notification-and-wake",
      notificationEnabled: true,
      automaticWakeEnabled: true,
      text: [
        "Terminal notification: enabled.",
        "Automatic follow-up turn: enabled.",
        "Next action: do not poll or sleep merely to wait; continue only independent useful work, otherwise end this turn and wait for <background-task-notification>.",
      ].join("\n"),
    };
  }

  if (notifyOnCompletion) {
    return {
      mode: "notification-only",
      notificationEnabled: true,
      automaticWakeEnabled: false,
      text: [
        "Terminal notification: enabled.",
        "Automatic follow-up turn: disabled. The terminal notification will be delivered, but it will not start an agent turn.",
        "Next action: automatic wake-up was explicitly disabled; use bg_status/bg_logs only when deliberate monitoring is required, without tight polling.",
      ].join("\n"),
    };
  }

  return {
    mode: "manual-monitoring",
    notificationEnabled: false,
    automaticWakeEnabled: false,
    text: [
      "Terminal notification: disabled.",
      triggerOnCompletion
        ? "Automatic follow-up turn: disabled because terminal notifications are disabled. triggerOnCompletion has no effect while notifyOnCompletion is false."
        : "Automatic follow-up turn: disabled.",
      "Next action: completion delivery was explicitly disabled; use bg_status/bg_logs only for deliberate manual monitoring, without tight polling.",
    ].join("\n"),
  };
}

export interface BgStatusDetails {
  tasks: BgTaskSnapshot[];
}

export interface BgLogsDetails {
  task: BgTaskSnapshot;
  path: string;
  bytesRead: number;
  totalBytes: number;
  truncated: boolean;
  tail: boolean;
}

export interface BgKillDetails {
  task: BgTaskSnapshot;
  message: string;
}

export interface StartTaskOptions {
  name?: string | undefined;
  description?: string | undefined;
  isAgent?: boolean | undefined;
  timeoutSeconds?: number | undefined;
  notifyOnCompletion?: boolean | undefined;
  triggerOnCompletion?: boolean | undefined;
  surviveReload?: boolean | undefined;
  /**
   * 入口语义落点(M4 落地具体入口):模型入口(覆盖版 bash run_in_background:true)
   * 缺省 notify+trigger;用户入口(dock「转后台」)缺省仅通知。仅作来源标记,
   * dock 动作本体在 M4 实现。
   */
  entrySource?: "model" | "user" | undefined;
  /** @internal EventBus protocol barrier; callers should not set this outside the extension service. */
  terminalPublicationGate?: Promise<void> | undefined;
  /**
   * 直执行变体(M4):直达 spawn、无 shell 中介。argv[0] 为可执行文件,其余为
   * 参数;Windows 下 `.cmd`/`.bat` shim 自动经 `cmd.exe` 路由(shell:false
   * 不能直接 spawn shim)。与 `surviveReload` 互斥:直执行无 shell 语义,
   * 无法跨同进程 reload 保活。
   */
  argv?: string[] | undefined;
}

/** 模型视图 64KiB 有界上限:模型可见日志读取默认与上限取宿主导入的
 * `DEFAULT_MAX_BYTES` 与 64KiB 目标值二者中的较小者——宿主值小于 64KiB 时
 * 以宿主为准(当前宿主为 50KiB,实际生效值即 50KiB);宿主值超过 64KiB 时
 * 本插件按 64KiB 封顶,防止模型视图无界膨胀。
 */
export const MODEL_VIEW_BYTES_CAP = 64 * 1024;
export const DEFAULT_LOG_BYTES = Math.min(
  DEFAULT_MAX_BYTES,
  MODEL_VIEW_BYTES_CAP,
);
export const MAX_LOG_BYTES = Math.min(DEFAULT_MAX_BYTES, MODEL_VIEW_BYTES_CAP);
export const COMMAND_PREVIEW_CHARS = 90;
const parseJsonValue: (text: string) => unknown = globalThis.JSON.parse;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

/** 判别输出流错误是否由磁盘空间耗尽(ENOSPC)引发,用于终止分支选择。 */
export function isEnospcError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    Reflect.get(error, "code") === "ENOSPC"
  );
}

export function parseJsonText(text: string): unknown {
  return parseJsonValue(text);
}

export function sanitizePathSegment(value: string): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "session";
}

export function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function truncateChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function normalizeTaskName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = compactWhitespace(stripMatchingQuotes(value));
  if (!normalized) return undefined;
  return truncateChars(normalized, 80);
}

/** 防病态超长命令的显示护栏:仅作用于 `taskDisplayName` 的完整命令兜底分支,
 * 4KiB 内命令保持原样(不 compactWhitespace、不按词截断、不剥前缀);显式
 * name/description 已由 normalizeTaskName 归一到 80 字符,不触达本护栏。 */
export const TASK_DISPLAY_NAME_MAX_CHARS = 4 * 1024;

/** 完整 `task.command` 原样兜底(ZCode 命名方案):空/纯空白命令视为无兜底,
 * 超长命令仅在 4KiB 护栏内裁剪。 */
function fullCommandDisplayName(
  command: string | undefined,
): string | undefined {
  if (command === undefined || command.length === 0) return undefined;
  if (command.trim().length === 0) return undefined;
  if (command.length <= TASK_DISPLAY_NAME_MAX_CHARS) return command;
  return truncateChars(command, TASK_DISPLAY_NAME_MAX_CHARS);
}

export function taskDisplayName(task: {
  name?: string | undefined;
  description?: string | undefined;
  command?: string | undefined;
  id?: string | undefined;
}): string {
  return (
    normalizeTaskName(task.name) ??
    normalizeTaskName(task.description) ??
    fullCommandDisplayName(task.command) ??
    task.id ??
    "Background task"
  );
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60)
    return `${String(minutes)}m${remSeconds > 0 ? `${String(remSeconds)}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${String(hours)}h${remMinutes > 0 ? `${String(remMinutes)}m` : ""}`;
}

export function formatCompactNumber(count: number): string {
  const normalized = Math.max(0, Math.floor(count));
  if (normalized < 1000) return normalized.toString();
  if (normalized < 10000) return `${(normalized / 1000).toFixed(1)}k`;
  if (normalized < 1000000) return `${String(Math.round(normalized / 1000))}k`;
  if (normalized < 10000000) return `${(normalized / 1000000).toFixed(1)}M`;
  return `${String(Math.round(normalized / 1000000))}M`;
}

export function formatContextUsageSummary(
  usage?: TaskContextUsage,
): string | undefined {
  if (usage?.contextWindow === undefined || usage.contextWindow <= 0)
    return undefined;
  const window = formatCompactNumber(usage.contextWindow);
  if (usage.percent === null || usage.tokens === null) return `ctx=?/${window}`;
  return `ctx=${usage.percent.toFixed(1)}%/${window}`;
}

export function formatTokenUsageSummary(
  usage?: TaskTokenUsage,
): string | undefined {
  if (!usage || usage.totalTokens <= 0) return undefined;
  return `tokens=${formatCompactNumber(usage.totalTokens)}`;
}

export function formatToolUsageSummary(
  usage?: TaskToolUsage,
): string | undefined {
  if (!usage || (usage.total <= 0 && usage.failed <= 0)) return undefined;
  const failed = usage.failed > 0 ? ` failed=${String(usage.failed)}` : "";
  return `tools=${String(usage.total)}${failed}`;
}

export function formatModelSummary(model?: string): string | undefined {
  if (!model) return undefined;
  return `model=${model}`;
}

/**
 * Human-readable activity transcript for telemetry-wrapped Pi agents.
 *
 * The wrapper emits one `background-task-activity` control line per meaningful
 * child-agent event (assistant text, reasoning, tool start, tool end) so the
 * registry can render "what the agent is actually doing" into the task output
 * file instead of leaking raw telemetry JSON. Both the parser and the formatter
 * are pure so the visible transcript is fully unit-testable.
 */
export const AGENT_ACTIVITY_TYPE = "background-task-activity";
const AGENT_ACTIVITY_DETAIL_MAX = 80;

export type AgentActivity =
  | { kind: "assistant_text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_start"; tool: string; argsSummary: string }
  | { kind: "tool_end"; tool: string; isError: boolean; error?: string };

interface AgentActivityPayload extends JsonObject {
  readonly type?: unknown;
  readonly kind?: unknown;
  readonly text?: unknown;
  readonly tool?: unknown;
  readonly argsSummary?: unknown;
  readonly isError?: unknown;
  readonly error?: unknown;
}

function readActivityString(
  record: AgentActivityPayload,
  key: "text" | "tool" | "argsSummary" | "error",
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/** Narrow a parsed `background-task-activity` control payload into a typed {@link AgentActivity}. */
export function parseAgentActivity(
  payload: unknown,
): AgentActivity | undefined {
  if (!isJsonObject(payload)) return undefined;
  const record: AgentActivityPayload = payload;
  if (record.type !== AGENT_ACTIVITY_TYPE) return undefined;
  const kind = record.kind;
  if (kind === "assistant_text" || kind === "reasoning") {
    const text = readActivityString(record, "text");
    if (text === undefined) return undefined;
    return { kind, text };
  }
  if (kind === "tool_start") {
    const tool = readActivityString(record, "tool");
    if (!tool) return undefined;
    return {
      kind,
      tool,
      argsSummary: readActivityString(record, "argsSummary") ?? "",
    };
  }
  if (kind === "tool_end") {
    const tool = readActivityString(record, "tool");
    if (!tool) return undefined;
    const activity: AgentActivity = {
      kind,
      tool,
      isError: record.isError === true,
    };
    const error = readActivityString(record, "error");
    if (error !== undefined && error.trim().length > 0) activity.error = error;
    return activity;
  }
  return undefined;
}

/**
 * Render an {@link AgentActivity} into a single transcript line, or `undefined`
 * when the event carries nothing worth showing (blank text, a successful tool
 * end). Successful tool ends are intentionally silent: the matching `→` start
 * line already announced the call, and the next line implies completion.
 */
export function formatAgentActivityLine(
  activity: AgentActivity,
): string | undefined {
  if (activity.kind === "assistant_text") {
    const text = activity.text.replace(/\s+$/u, "");
    return text.trim().length > 0 ? text : undefined;
  }
  if (activity.kind === "reasoning") {
    const text = activity.text.replace(/\s+$/u, "");
    return text.trim().length > 0 ? `\u2026 ${text}` : undefined;
  }
  if (activity.kind === "tool_start") {
    const summary = compactWhitespace(activity.argsSummary);
    const suffix =
      summary.length > 0
        ? ` ${truncateChars(summary, AGENT_ACTIVITY_DETAIL_MAX)}`
        : "";
    return `\u2192 ${activity.tool}${suffix}`;
  }
  if (!activity.isError) return undefined;
  const detail = activity.error
    ? `: ${truncateChars(compactWhitespace(activity.error), AGENT_ACTIVITY_DETAIL_MAX)}`
    : "";
  return `\u2717 ${activity.tool} failed${detail}`;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export type ShellDialect = "cmd" | "posix" | "user-non-posix";
export type ShellPolicyDialect = ShellDialect | "bash";
export type ShellPolicyName = "inherit" | "bash" | "sh" | "cmd";

/** Non-secret launch facts persisted for ordinary shell tasks. */
export interface ShellPolicySnapshot {
  readonly policy: ShellPolicyName;
  readonly executable: string;
  readonly argvPrefix: readonly string[];
  readonly dialect: ShellPolicyDialect;
}

/** One immutable shell selection shared by guidance and every ordinary spawn in an activation. */
export interface ResolvedShellPolicy extends ShellPolicySnapshot {
  readonly supportsPosixFunctionWrapper: boolean;
  readonly windowsVerbatimArguments: boolean;
}

export interface ShellInvocation {
  shell: string;
  args: string[];
  dialect: ShellDialect;
  windowsVerbatimArguments: boolean;
}

export class ShellInvocationError extends Error {
  readonly code = "pi_bg_shell_invalid";

  constructor(message: string) {
    super(`pi_bg_shell_invalid: ${message}`);
    this.name = "ShellInvocationError";
  }
}

type ShellCandidateResult =
  | { readonly found: true }
  | { readonly found: false; readonly diagnostic: string };

const POSIX_FUNCTION_SHELLS = new Set([
  "sh",
  "dash",
  "ash",
  "ksh",
  "ksh93",
  "mksh",
  "pdksh",
  "zsh",
  "yash",
  "posh",
]);

function failShellInvocation(message: string): never {
  throw new ShellInvocationError(message);
}

function shellErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function freezeShellPolicy(
  policy: Omit<ResolvedShellPolicy, "argvPrefix"> & {
    argvPrefix: readonly string[];
  },
): ResolvedShellPolicy {
  return Object.freeze({
    ...policy,
    argvPrefix: Object.freeze([...policy.argvPrefix]),
  });
}

export function shellPolicySnapshot(
  policy: ResolvedShellPolicy,
): ShellPolicySnapshot {
  return Object.freeze({
    policy: policy.policy,
    executable: policy.executable,
    argvPrefix: Object.freeze([...policy.argvPrefix]),
    dialect: policy.dialect,
  });
}

function isWindowsExecutablePath(path: string): boolean {
  const extension = extname(path).toLowerCase();
  return extension === ".exe" || extension === ".com";
}

function validateWindowsShellPath(path: string, label: string): string {
  if (path.length === 0) failShellInvocation(`${label} is empty`);
  if (!isAbsolute(path) && !win32.isAbsolute(path)) {
    failShellInvocation(`${label} must be an absolute path`);
  }
  if (!isWindowsExecutablePath(path)) {
    failShellInvocation(`${label} must point to a .exe or .com file`);
  }
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch (error) {
    failShellInvocation(`${label} stat failed: ${shellErrorMessage(error)}`);
  }
  if (!stats.isFile())
    failShellInvocation(`${label} must point to a regular file`);
  return path;
}

function inspectWindowsShellCandidate(path: string): ShellCandidateResult {
  if (!isWindowsExecutablePath(path)) {
    return { found: false, diagnostic: `${path} is not a .exe or .com path` };
  }
  try {
    const stats = statSync(path);
    if (stats.isFile()) return { found: true };
    return { found: false, diagnostic: `${path} is not a regular file` };
  } catch (error) {
    return { found: false, diagnostic: `${path}: ${shellErrorMessage(error)}` };
  }
}

function windowsPathValue(env: NodeJS.ProcessEnv): string {
  return env["PATH"] ?? env["Path"] ?? env["path"] ?? "";
}

function resolveWindowsBash(env: NodeJS.ProcessEnv): string {
  const pathValue = windowsPathValue(env);
  const diagnostics: string[] = [];
  for (const dir of pathValue.split(";").filter((entry) => entry.length > 0)) {
    for (const name of ["bash.exe", "bash.com"]) {
      const candidate = join(dir, name);
      const result = inspectWindowsShellCandidate(candidate);
      if (result.found) return candidate;
      diagnostics.push(result.diagnostic);
    }
  }
  const suffix = diagnostics.length > 0 ? `: ${diagnostics.join("; ")}` : "";
  failShellInvocation(
    `PI_BG_SHELL=bash could not resolve bash.exe or bash.com on PATH${suffix}`,
  );
}

function validatePosixShellPath(path: string, label: string): string {
  if (path.length === 0) failShellInvocation(`${label} is empty`);
  if (!isAbsolute(path))
    failShellInvocation(`${label} must be an absolute path`);
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch (error) {
    failShellInvocation(`${label} stat failed: ${shellErrorMessage(error)}`);
  }
  if (!stats.isFile())
    failShellInvocation(`${label} must point to a regular file`);
  try {
    accessSync(path, constants.X_OK);
  } catch (error) {
    failShellInvocation(
      `${label} must be executable: ${shellErrorMessage(error)}`,
    );
  }
  return path;
}

function inspectPosixShellCandidate(path: string): boolean {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePosixExecutable(
  name: "bash" | "sh",
  env: NodeJS.ProcessEnv,
  activationCwd: string,
): string {
  const binCandidate = `/bin/${name}`;
  if (inspectPosixShellCandidate(binCandidate)) return binCandidate;
  const pathValue = env["PATH"] ?? "";
  for (const entry of pathValue.split(delimiter)) {
    if (entry.length === 0) continue;
    const directory = isAbsolute(entry) ? entry : resolve(activationCwd, entry);
    const candidate = join(directory, name);
    if (inspectPosixShellCandidate(candidate)) return candidate;
  }
  failShellInvocation(
    `PI_BG_POSIX_SHELL=${name} could not resolve executable ${binCandidate} or ${name} on PATH`,
  );
}

function inheritedPosixDialect(executable: string): ShellPolicyDialect {
  const name = basename(executable).toLowerCase();
  if (name === "bash") return "bash";
  return POSIX_FUNCTION_SHELLS.has(name) ? "posix" : "user-non-posix";
}

/**
 * Resolve one activation-stable policy. New POSIX variables are intentionally
 * ignored on Windows.
 *
 * S1 P1 同源化的宿主注入面:`hostShellPath` 为宿主前台 shell 解析结果
 * (settings.shellPath 或 getShellConfig 默认解析),POSIX `inherit` 分支中
 * 有效(非空)时优先于 `env.SHELL`;纯函数保持可测,扩展入口把宿主解析结果
 * 经 `initializeShellPolicy` 注入。Win32 分支不消费该参数(前后台 Win32 对称性
 * 见 README 平台边界注记)。
 */
export function resolveShellPolicy(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  activationCwd: string = process.cwd(),
  hostShellPath?: string | undefined,
): ResolvedShellPolicy {
  if (platform === "win32") {
    const requestedShell = env["PI_BG_SHELL"];
    const requestedPath = env["PI_BG_SHELL_PATH"];
    if (requestedShell === undefined) {
      if (requestedPath !== undefined)
        failShellInvocation("PI_BG_SHELL_PATH requires PI_BG_SHELL");
      const comSpec = env["ComSpec"];
      return freezeShellPolicy({
        policy: "cmd",
        executable: comSpec && comSpec.length > 0 ? comSpec : "cmd.exe",
        argvPrefix: ["/d", "/s", "/c"],
        dialect: "cmd",
        supportsPosixFunctionWrapper: false,
        windowsVerbatimArguments: true,
      });
    }
    if (requestedShell !== "cmd" && requestedShell !== "bash") {
      failShellInvocation("PI_BG_SHELL must be exactly cmd or bash");
    }
    const explicitPath =
      requestedPath !== undefined
        ? validateWindowsShellPath(requestedPath, "PI_BG_SHELL_PATH")
        : undefined;
    if (requestedShell === "cmd") {
      const comSpec = env["ComSpec"];
      return freezeShellPolicy({
        policy: "cmd",
        executable:
          explicitPath ?? (comSpec && comSpec.length > 0 ? comSpec : "cmd.exe"),
        argvPrefix: ["/d", "/s", "/c"],
        dialect: "cmd",
        supportsPosixFunctionWrapper: false,
        windowsVerbatimArguments: true,
      });
    }
    return freezeShellPolicy({
      policy: "bash",
      executable: explicitPath ?? resolveWindowsBash(env),
      argvPrefix: ["-c"],
      dialect: "bash",
      supportsPosixFunctionWrapper: true,
      windowsVerbatimArguments: false,
    });
  }

  const configuredPolicy = env["PI_BG_POSIX_SHELL"];
  if (
    configuredPolicy !== undefined &&
    configuredPolicy !== "inherit" &&
    configuredPolicy !== "bash" &&
    configuredPolicy !== "sh"
  ) {
    failShellInvocation(
      "PI_BG_POSIX_SHELL must be exactly inherit, bash, or sh",
    );
  }
  const policy = configuredPolicy ?? "inherit";
  const configuredPath = env["PI_BG_POSIX_SHELL_PATH"];
  if (policy === "inherit") {
    if (configuredPath !== undefined) {
      failShellInvocation(
        "PI_BG_POSIX_SHELL_PATH requires PI_BG_POSIX_SHELL=bash or PI_BG_POSIX_SHELL=sh",
      );
    }
    const inherited = env["SHELL"];
    const executable =
      hostShellPath !== undefined && hostShellPath.length > 0
        ? hostShellPath
        : inherited && inherited.length > 0
          ? inherited
          : "/bin/sh";
    const dialect = inheritedPosixDialect(executable);
    return freezeShellPolicy({
      policy,
      executable,
      argvPrefix: ["-c"],
      dialect,
      supportsPosixFunctionWrapper: dialect === "bash" || dialect === "posix",
      windowsVerbatimArguments: false,
    });
  }

  const executable =
    configuredPath !== undefined
      ? validatePosixShellPath(configuredPath, "PI_BG_POSIX_SHELL_PATH")
      : resolvePosixExecutable(policy, env, activationCwd);
  return freezeShellPolicy({
    policy,
    executable,
    argvPrefix: ["-c"],
    dialect: policy === "bash" ? "bash" : "posix",
    supportsPosixFunctionWrapper: true,
    windowsVerbatimArguments: false,
  });
}

export function shellInvocationForPolicy(
  command: string,
  policy: ResolvedShellPolicy,
): ShellInvocation {
  const dialect: ShellDialect =
    policy.dialect === "bash" ? "posix" : policy.dialect;
  return {
    shell: policy.executable,
    args:
      policy.dialect === "cmd"
        ? [...policy.argvPrefix, `"${command}"`]
        : [...policy.argvPrefix, command],
    dialect,
    windowsVerbatimArguments: policy.windowsVerbatimArguments,
  };
}

export function shellInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ShellInvocation {
  return shellInvocationForPolicy(command, resolveShellPolicy(platform, env));
}

/** Windows `.cmd`/`.bat` shim 扩展名集合(shell:false 不能直接 spawn shim)。 */
const WINDOWS_COMMAND_SHIM_EXTENSIONS: ReadonlySet<string> = new Set([
  ".cmd",
  ".bat",
]);
const DEFAULT_WINDOWS_PATHEXT: readonly string[] = [
  ".COM",
  ".EXE",
  ".BAT",
  ".CMD",
];

/** 单条直执行规格:可执行文件、参数与 cmd 下 verbatim 开关。 */
export interface ResolvedDirectExecution {
  readonly file: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments: boolean;
}

/** Windows 环境变量键存在大小写变体(例如 PATH/Path/path);docs 门禁要求 env
 * 键为字面量,因此显式枚举候选键而不是运行期循环匹配。
 */
function windowsPathextValue(env: NodeJS.ProcessEnv): string | undefined {
  const value = env["PATHEXT"] ?? env["PathExt"] ?? env["pathext"];
  return typeof value === "string" ? value : undefined;
}

function windowsComSpecValue(env: NodeJS.ProcessEnv): string | undefined {
  const value = env["ComSpec"] ?? env["COMSPEC"] ?? env["comspec"];
  return typeof value === "string" ? value : undefined;
}

function windowsExtensionCandidates(
  file: string,
  pathExts: readonly string[],
): string[] {
  if (extname(file)) return [file];
  return [
    file,
    ...pathExts.map((extension) => `${file}${extension.toLowerCase()}`),
  ];
}

function isWindowsCommandShim(path: string): boolean {
  return WINDOWS_COMMAND_SHIM_EXTENSIONS.has(extname(path).toLowerCase());
}

function resolveWindowsDirectExecutionFile(
  file: string,
  options: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    exists: (path: string) => boolean;
  },
): string {
  const raw = windowsPathextValue(options.env);
  const pathExts =
    raw && raw.length > 0
      ? raw
          .split(";")
          .map((extension) => extension.trim())
          .filter((extension) => extension.length > 0)
      : [...DEFAULT_WINDOWS_PATHEXT];
  const fileCandidates = windowsExtensionCandidates(file, pathExts);
  let candidates: string[];
  if (file.includes("\\") || file.includes("/") || win32.isAbsolute(file)) {
    const basePath =
      !win32.isAbsolute(file) && options.cwd
        ? win32.resolve(options.cwd, file)
        : win32.normalize(file);
    candidates = windowsExtensionCandidates(basePath, pathExts);
  } else {
    const pathValue = windowsPathValue(options.env);
    candidates = pathValue
      .split(win32.delimiter)
      .filter((entry) => entry.length > 0)
      .flatMap((dir) =>
        fileCandidates.map((candidate) => win32.join(dir, candidate)),
      );
  }
  return candidates.find((candidate) => options.exists(candidate)) ?? file;
}

function quoteCmdArgument(value: string): string {
  if (value.length === 0) return '""';
  if (!/[\s"%&()<>^|]/.test(value)) return value;
  return `"${value.replace(/(["%&()<>^|])/g, "^$1")}"`;
}

/**
 * 直执行解析(M4,逐行仿 ZCode `execution-command.ts:118-139`):argv[0] 直达
 * 可执行文件、无 shell 中介;Windows 下按 PATHEXT/PATH 解析实际文件,
 * `.cmd`/`.bat` shim 自动路由 `cmd.exe /d /s /c`(shell:false 不能直接
 * spawn shim),普通 `.exe` 保持 shell-free argv 执行。POSIX 保持裸名,
 * 由 libuv 按 PATH 解析。
 */
export function resolveDirectExecution(
  argv: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    exists?: (path: string) => boolean;
    platform?: NodeJS.Platform;
  } = {},
): ResolvedDirectExecution {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const file = argv[0];
  if (typeof file !== "string" || file.trim().length === 0) {
    throw new Error(
      "Direct execution argv[0] must be a non-empty executable name",
    );
  }
  const args = argv.slice(1);
  if (platform !== "win32") {
    return { file, args, windowsVerbatimArguments: false };
  }
  const resolvedFile = resolveWindowsDirectExecutionFile(file, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env,
    exists: options.exists ?? existsSync,
  });
  if (!isWindowsCommandShim(resolvedFile)) {
    return { file: resolvedFile, args, windowsVerbatimArguments: false };
  }
  const commandLine = [resolvedFile, ...args].map(quoteCmdArgument).join(" ");
  const comSpec = windowsComSpecValue(env);
  return {
    file: comSpec && comSpec.length > 0 ? comSpec : "cmd.exe",
    args: ["/d", "/s", "/c", commandLine],
    windowsVerbatimArguments: true,
  };
}

export function normalizeMaxBytes(
  value: unknown,
  fallback = DEFAULT_LOG_BYTES,
): number {
  const raw =
    typeof value === "number" && Number.isFinite(value)
      ? Math.floor(value)
      : fallback;
  return Math.max(1, Math.min(MAX_LOG_BYTES, raw));
}

/** 错误对象 → 文案(不裁剪、不复写空白;与 registry/reload 既有 errorMessage 语义一致)。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 追加错误文案:空已有/已含 next 时不重复追加,以 `; ` 连接(registry/reload 两处
 * appendError 语义一致)。 */
export function appendErrorText(
  existing: string | undefined,
  next: string,
): string {
  if (existing === undefined || existing.length === 0) return next;
  if (existing.includes(next)) return existing;
  return `${existing}; ${next}`;
}

/** 有界错误文案:折叠空白并裁剪到 maxChars 字符内,以省略号收尾(extension-api
 * 的 boundedBackgroundTaskError 与 reload 的 boundedError、registry 的
 * terminalPublicationError 三处收敛的统一实现)。 */
export function boundedErrorMessage(error: unknown, maxChars: number): string {
  const text = errorMessage(error).replace(/\s+/gu, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

/**
 * 六态迁移表统一判定(registry close 路径与 reload-shell-owner terminalStatus
 * 两套重复收敛):user/model 停止 → cancelled;system 关闭 → killed;timeout/
 * output_cap/disk_full/handoff_expired/退出码非 0 → failed(带细分 reason);
 * 终止后退出码 0 → completed。`handoff_expired` 为 reload 幸存路径独有分支。
 * 行为与两处既有实现逐分支等价;failedReason 副作用与既有实现一致。
 */
export function deriveTerminalStatus(
  task: BgTask,
  killKind: ReloadShellStopKind | undefined,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  maxOutputBytes: number,
): { status: TaskStatus; error?: string | undefined } {
  if (killKind === "user") return { status: "cancelled" };
  if (killKind === "shutdown") return { status: "killed" };
  if (killKind === "timeout") {
    task.failedReason = "timed_out";
    return {
      status: "failed",
      error: task.error ?? `Timed out after ${String(task.timeoutSeconds)}s`,
    };
  }
  if (killKind === "output_cap") {
    task.failedReason = "output_limit";
    return {
      status: "failed",
      error:
        task.error ?? `Output exceeded cap of ${formatSize(maxOutputBytes)}`,
    };
  }
  if (killKind === "disk_full") {
    // 磁盘满终止:已写输出文件保留,便于审计
    task.failedReason = "disk_full";
    return {
      status: "failed",
      error:
        task.error ??
        `Output file write failed because the disk is full (ENOSPC); partial output is retained at ${task.outputPath}`,
    };
  }
  if (killKind === "handoff_expired") {
    return {
      status: "failed",
      error:
        task.error ??
        "pi_bg_reload_handoff_expired: reload shell execution was not claimed before its handoff deadline",
    };
  }
  // REVIEW Q3:仅字面 exitCode === 0 判 completed。被外部信号杀死(close 的
  // exitCode 为 null、signal 有值、无 killKind)不再是「completed」误判——null
  // 落入下方失败分支,error 含 signal 信息(`Exited with code null (SIGKILL)`)。
  if (exitCode === 0) return { status: "completed" };
  task.failedReason = "exit_error";
  return {
    status: "failed",
    error: `Exited with code ${exitCode === null ? "null" : String(exitCode)}${signal ? ` (${signal})` : ""}`,
  };
}

/**
 * 软/硬输出阈值写块助手(registry 输出写入段与 reload-shell-owner 写缓冲段
 * 两套重复收敛):跨软阈值写入一次软告警(不杀任务、不改状态、不计入累计字节,
 * 避免提示文本自身触发硬阈值);按硬阈值截断写入累计;首次跨硬阈值时置位
 * capExceeded、写终止 notice 后返回 true,由调用方执行终止动作并给出细分原因。
 */
export function writeTaskOutputChunk(
  task: BgTask,
  buffer: Buffer,
  options: {
    readonly softBytes: number;
    readonly hardBytes: number;
    readonly onSoftCapWarned: () => void;
  },
): boolean {
  if (!task.stream || task.stream.destroyed) return false;
  if (buffer.length === 0) return false;

  const nextBytes = task.bytesWritten + buffer.length;
  if (nextBytes > options.softBytes && !task.softCapWarned) {
    task.softCapWarned = true;
    const warning =
      `\n\n[background task warning: output exceeded soft limit of ` +
      `${formatSize(options.softBytes)}; task continues running]\n`;
    task.stream.write(warning);
    options.onSoftCapWarned();
  }

  if (nextBytes <= options.hardBytes) {
    task.stream.write(buffer);
    task.bytesWritten = nextBytes;
    return false;
  }

  const remaining = Math.max(0, options.hardBytes - task.bytesWritten);
  if (remaining > 0) {
    task.stream.write(buffer.subarray(0, remaining));
    task.bytesWritten += remaining;
  }

  if (task.capExceeded) return false;
  task.capExceeded = true;
  task.error = `Output exceeded cap of ${formatSize(options.hardBytes)}; terminating task`;
  const notice = `\n\n[background task error: ${task.error}]\n`;
  task.stream.write(notice);
  task.bytesWritten += Buffer.byteLength(notice, "utf8");
  return true;
}

export function snapshot(task: BgTask): BgTaskSnapshot {
  return {
    id: task.id,
    name: taskDisplayName(task),
    command: task.command,
    description: task.description,
    status: task.status,
    outputPath: task.outputPath,
    cwd: task.cwd,
    startTime: task.startTime,
    endTime: task.endTime,
    exitCode: task.exitCode,
    signal: task.signal,
    pid: task.pid,
    bytesWritten: task.bytesWritten,
    isAgent: task.isAgent,
    surviveReload: task.surviveReload === true,
    reloadSurvival: task.reloadSurvival,
    error: task.error,
    notified: task.notified,
    notifyOnCompletion: task.notifyOnCompletion,
    triggerOnCompletion: task.triggerOnCompletion,
    timeoutSeconds: task.timeoutSeconds,
    contextUsage: task.contextUsage,
    tokenUsage: task.tokenUsage,
    toolUsage: task.toolUsage,
    model: task.model,
    telemetryUnavailableReason: task.telemetryUnavailableReason,
    stopInitiator: task.stopInitiator,
    branchGeneration: task.branchGeneration,
    failedReason: task.failedReason,
    shellPolicy: task.shellPolicy,
  };
}

export function formatSnapshotList(
  tasks: BgTaskSnapshot[],
  now = Date.now(),
): string {
  if (tasks.length === 0)
    return "No background tasks in this Pi extension runtime.";
  return tasks
    .map((task) => {
      const statusIcon =
        task.status === "running"
          ? "▶"
          : task.status === "completed"
            ? "✓"
            : task.status === "killed" || task.status === "cancelled"
              ? "■"
              : "✗";
      const age = formatDuration((task.endTime ?? now) - task.startTime);
      const code =
        task.exitCode === undefined || task.exitCode === null
          ? ""
          : ` exit=${String(task.exitCode)}`;
      const pid = task.pid !== undefined ? ` pid=${String(task.pid)}` : "";
      const error = task.error ? ` error=${truncateChars(task.error, 80)}` : "";
      const telemetry = [
        formatContextUsageSummary(task.contextUsage),
        formatModelSummary(task.model),
        formatTokenUsageSummary(task.tokenUsage),
        formatToolUsageSummary(task.toolUsage),
      ]
        .filter(Boolean)
        .join(" ");
      const telemetryText = telemetry ? ` ${telemetry}` : "";
      return `${statusIcon} ${task.id} ${task.status} ${age}${code}${pid}${telemetryText} — ${truncateChars(taskDisplayName(task), COMMAND_PREVIEW_CHARS)}${error}\n    output: ${task.outputPath}`;
    })
    .join("\n");
}

export async function boundedRead(
  filePath: string,
  maxBytes: number,
  tail: boolean,
): Promise<{
  content: string;
  truncated: boolean;
  bytesRead: number;
  totalBytes: number;
}> {
  const stats = statSync(filePath);
  const totalBytes = stats.size;
  const bytesToRead = Math.min(totalBytes, maxBytes);
  if (bytesToRead === 0)
    return { content: "", truncated: false, bytesRead: 0, totalBytes };

  const file = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const position = tail ? Math.max(0, totalBytes - bytesToRead) : 0;
    const { bytesRead } = await file.read(buffer, 0, bytesToRead, position);
    return {
      content: buffer.subarray(0, bytesRead).toString("utf8"),
      truncated: totalBytes > bytesRead,
      bytesRead,
      totalBytes,
    };
  } finally {
    await file.close();
  }
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
