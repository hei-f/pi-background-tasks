import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatSize, getAgentDir } from "@earendil-works/pi-coding-agent";
import { appendErrorText, boundedErrorMessage, boundedRead, buildTaskNotificationContent, deriveTerminalStatus, errorMessage as errorMessageText, formatAgentActivityLine, formatDuration, isEnospcError, isJsonObject, normalizeTaskName, parseAgentActivity, parseJsonText, resolveDirectExecution, resolveShellPolicy, sanitizePathSegment, shellInvocationForPolicy, shellPolicySnapshot, shellQuote, snapshot, taskDisplayName, truncateChars, writeTaskOutputChunk, ReloadSurvivalError, } from "./common.js";
import { normalizeContextUsage, normalizeModel, normalizeTokenUsage, normalizeToolUsage, parseTelemetryStream, } from "./telemetry.js";
import { writeFileDurable } from "./durable-fs.js";
import { closeAndFsyncOutputStream, writeJsonAtomic } from "./task-durable.js";
import { resolvePiLaunch } from "./pi-launch.js";
import { BackgroundTaskExtensionServiceClosedError, } from "./extension-api.js";
import { createReloadableShellExecutionV1, RELOAD_SHELL_OWNER_PROTOCOL, } from "./reload-shell-owner.js";
import { runWindowsTaskkill, } from "./windows-taskkill.js";
import { collectPosixDescendantPids as collectPosixDescendantPidsDefault, POSIX_DESCENDANT_COLLECT_DELAY_MS, } from "./process-tree.js";
/** 启动审计遗留 running 记录的落盘错误说明前缀。 */
export const STARTUP_AUDIT_ERROR = 'pi_bg_startup_audit: task record was still "running" when a fresh extension activation audited the runtime directory; the process is not revived and the retained output file remains readable at its recorded path';
/** 停止发起者优先级表,user > model > system。 */
const STOP_INITIATOR_PRIORITY = {
    user: 3,
    model: 2,
    system: 1,
};
function stopInitiatorPriority(initiator) {
    return initiator === undefined ? 0 : STOP_INITIATOR_PRIORITY[initiator];
}
export const MAX_OUTPUT_BYTES = Number(process.env["PI_BG_MAX_OUTPUT_BYTES"] ?? 2 * 1024 * 1024 * 1024);
export const SOFT_OUTPUT_BYTES = Number(process.env["PI_BG_SOFT_OUTPUT_BYTES"] ?? 256 * 1024 * 1024);
export const KILL_GRACE_MS = 3000;
export const STOP_WAIT_MS = KILL_GRACE_MS + 1500;
/** TERM 后启动 ps 后代收集的延迟窗口(定义与注入说明见 `process-tree.ts`)。 */
export { POSIX_DESCENDANT_COLLECT_DELAY_MS } from "./process-tree.js";
export const MAX_RECENT_TASKS = 100;
export const TERMINAL_PUBLICATION_MAX_ATTEMPTS = 3;
export const TERMINAL_PUBLICATION_RETRY_MS = 100;
export const TASK_ADMISSION_TIMEOUT_MS = 30_000;
const TERMINAL_PUBLICATION_DIAGNOSTIC_CHARS = 500;
/** S1 排水层批失败告警:批 id 列表的有界上限(防病态大批日志膨胀)。 */
const NOTIFICATION_BATCH_WARN_MAX_CHARS = 200;
/** M5:终态帧完成摘要 summaryTail 的有界上限(64KiB 内;完整日志不自动回传)。 */
export const TERMINAL_SUMMARY_TAIL_BYTES = 64 * 1024;
/** M5:从任务输出文件取有界 tail 作为完成摘要;文件缺失/不可读/无内容时缺省,
 * 不阻塞终态帧发布(完整日志不自动回传,帧内已附输出路径)。 */
async function readTerminalSummaryTail(outputAbsPath) {
    try {
        const read = await boundedRead(outputAbsPath, TERMINAL_SUMMARY_TAIL_BYTES, true);
        const tail = read.content.replace(/\s+$/u, "");
        return tail.length > 0 ? tail : undefined;
    }
    catch {
        // 输出文件缺失/不可读不影响终态发布,摘要缺省
        return undefined;
    }
}
export class BackgroundTaskAdmissionClosedError extends Error {
    code = "pi_background_tasks_admission_closed";
    constructor(kind) {
        super(`Cannot start ${kind} after background task admissions have closed`);
        this.name = "BackgroundTaskAdmissionClosedError";
    }
}
export class BackgroundTaskAdmissionTimeoutError extends Error {
    code = "pi_background_tasks_admission_timeout";
    constructor(kind, timeoutMs) {
        super(`Timed out while preparing ${kind} after ${String(timeoutMs)}ms`);
        this.name = "BackgroundTaskAdmissionTimeoutError";
    }
}
/** REVIEW:显式传入 `argv` 但判定为无效(非空字符串数组、argv[0] 非空可执行名)
 * 时的告警错误;不得静默降级执行另一条命令。 */
export class BackgroundTaskInvalidArgvError extends Error {
    code = "pi_bg_argv_invalid";
    constructor() {
        super("argv direct execution requires a non-empty array whose first element is a non-empty executable name");
        this.name = "BackgroundTaskInvalidArgvError";
    }
}
export const WIN32_CMD_PI_TELEMETRY_UNAVAILABLE_REASON = "win32-cmd-cannot-safely-intercept-pi-argv";
export const NON_POSIX_SHELL_PI_TELEMETRY_UNAVAILABLE_REASON = "user-non-posix-shell-cannot-safely-intercept-pi-argv";
export const DIRECT_EXEC_PI_TELEMETRY_UNAVAILABLE_REASON = "direct-argv-execution-cannot-safely-intercept-pi-argv";
/**
 * 直执行判定(M4):`options.argv` 为有效非空字符串数组(首个元素非空)时启用
 * 直执行变体(直达 spawn、无 shell 中介),否则回退命令字符串的 shell 路径。
 */
function directExecutionFromOptions(options, deps) {
    const argv = options.argv;
    if (argv === undefined ||
        !Array.isArray(argv) ||
        argv.length === 0 ||
        typeof argv[0] !== "string" ||
        argv[0].trim().length === 0) {
        return undefined;
    }
    return resolveDirectExecution(argv, {
        cwd: deps.cwd,
        env: deps.env,
        platform: deps.platform,
    });
}
function waiterAbortReason(signal) {
    return signal.reason ?? new Error("Background task wait aborted");
}
/** 判定任务是否已终止(五态终态全集,即非 running)。 */
function isTerminalTaskStatus(status) {
    return status !== "running";
}
function defaultTaskId() {
    return `b${randomBytes(4).toString("hex")}`;
}
export function commandMayLaunchPiAgent(command, env = process.env) {
    if (env["PI_BG_DISABLE_PI_TELEMETRY"] === "1")
        return false;
    return /(^|[\s;&|()])pi(?=\s)(?=[^\n;&|]*(?:\s-p(?:\s|$)|\s--print(?:\s|$)|\s--mode(?:=|\s+)json\b))/m.test(command);
}
export function buildModelWindowIndex(ctx) {
    const byQualifiedId = {};
    const candidatesById = new Map();
    for (const model of ctx.modelRegistry.getAll()) {
        const contextWindow = typeof model.contextWindow === "number" &&
            Number.isFinite(model.contextWindow) &&
            model.contextWindow > 0
            ? Math.floor(model.contextWindow)
            : undefined;
        if (!contextWindow)
            continue;
        byQualifiedId[`${model.provider}/${model.id}`] = contextWindow;
        let candidates = candidatesById.get(model.id);
        if (!candidates) {
            candidates = new Set();
            candidatesById.set(model.id, candidates);
        }
        candidates.add(contextWindow);
    }
    const byId = {};
    for (const [id, windows] of candidatesById) {
        const onlyWindow = windows.values().next();
        if (windows.size === 1 && !onlyWindow.done)
            byId[id] = onlyWindow.value;
    }
    const current = ctx.model;
    return {
        byQualifiedId,
        byId,
        defaultModel: current?.id,
        defaultProvider: current?.provider,
        defaultContextWindow: current?.contextWindow,
    };
}
export function createPiTelemetryWrapperSource(index, launch = resolvePiLaunch()) {
    return `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const index = ${JSON.stringify(index)};
const launch = ${JSON.stringify(launch)};
const WINDOWS_COMMAND_LINE_LIMIT = 32767;

const tokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
let costTotal = 0;
let hasCostTotal = false;
let agentModel;
const toolUsage = { total: 0, failed: 0, byName: {} };
const seenToolCallIds = new Set();
const failedToolCallIds = new Set();

function nonNegativeInteger(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function normalizeUsage(usage) {
  if (!usage) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  const input = nonNegativeInteger(usage.input);
  const output = nonNegativeInteger(usage.output);
  const cacheRead = nonNegativeInteger(usage.cacheRead);
  const cacheWrite = nonNegativeInteger(usage.cacheWrite);
  const explicitTotal = nonNegativeInteger(usage.totalTokens);
  const totalTokens = explicitTotal || (input + output + cacheRead + cacheWrite);
  const cost = usage.cost && typeof usage.cost.total === "number" && Number.isFinite(usage.cost.total) && usage.cost.total >= 0
    ? usage.cost.total
    : undefined;
  return { input, output, cacheRead, cacheWrite, totalTokens, cost };
}

function addTokenUsage(usage) {
  const normalized = normalizeUsage(usage);
  if (!normalized.totalTokens) return normalized;
  tokenUsage.input += normalized.input;
  tokenUsage.output += normalized.output;
  tokenUsage.cacheRead += normalized.cacheRead;
  tokenUsage.cacheWrite += normalized.cacheWrite;
  tokenUsage.totalTokens += normalized.totalTokens;
  if (normalized.cost !== undefined) {
    costTotal += normalized.cost;
    hasCostTotal = true;
  }
  return normalized;
}

function currentTokenUsage() {
  if (!tokenUsage.totalTokens) return undefined;
  const out = { ...tokenUsage };
  if (hasCostTotal) out.costTotal = costTotal;
  return out;
}

function markToolStarted(id, name) {
  const key = id ? String(id) : undefined;
  if (key && seenToolCallIds.has(key)) return;
  if (key) seenToolCallIds.add(key);
  const toolName = name ? String(name) : "unknown";
  toolUsage.total += 1;
  toolUsage.byName[toolName] = (toolUsage.byName[toolName] || 0) + 1;
}

function markToolFailed(id) {
  const key = id ? String(id) : undefined;
  if (key && failedToolCallIds.has(key)) return;
  if (key) failedToolCallIds.add(key);
  toolUsage.failed += 1;
}

function currentToolUsage() {
  if (!toolUsage.total && !toolUsage.failed) return undefined;
  return { total: toolUsage.total, failed: toolUsage.failed, byName: { ...toolUsage.byName } };
}

function renderWindowsArgument(value) {
  if (value.length > 0 && !/[ \\t\"]/.test(value)) return value;
  let rendered = "\\\"";
  let backslashes = 0;
  for (const char of value) {
    if (char === "\\\\") {
      backslashes += 1;
      continue;
    }
    if (char === "\\\"") {
      rendered += "\\\\".repeat(backslashes * 2 + 1);
      rendered += "\\\"";
      backslashes = 0;
      continue;
    }
    if (backslashes > 0) {
      rendered += "\\\\".repeat(backslashes);
      backslashes = 0;
    }
    rendered += char;
  }
  if (backslashes > 0) rendered += "\\\\".repeat(backslashes * 2);
  rendered += "\\\"";
  return rendered;
}

function assertWindowsLimit(stage, args) {
  if (process.platform !== "win32") return;
  const measured = [launch.executable, ...launch.argvPrefix, ...args].map(renderWindowsArgument).join(" ").length + 1;
  if (measured > WINDOWS_COMMAND_LINE_LIMIT) {
    const error = new Error("pi_command_line_too_long: " + stage + " measured UTF-16 command line length " + String(measured) + " exceeds limit " + String(WINDOWS_COMMAND_LINE_LIMIT));
    error.code = "pi_command_line_too_long";
    throw error;
  }
}

function emitUnifiedTelemetry(payload) {
  const out = { type: "background-task-telemetry", ...payload };
  const tokens = currentTokenUsage();
  const tools = currentToolUsage();
  if (tokens && !out.tokenUsage) out.tokenUsage = tokens;
  if (tools && !out.toolUsage) out.toolUsage = tools;
  if (agentModel && !out.model) out.model = agentModel;
  process.stdout.write(JSON.stringify(out) + "\\n");
}

function emitActivity(activity) {
  process.stdout.write(JSON.stringify({ type: "background-task-activity", ...activity }) + "\\n");
}

function summarizeArgs(args) {
  if (!args || typeof args !== "object") return "";
  const pick = (value) => {
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 200);
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return undefined;
  };
  const preferred = ["path", "file_path", "file", "filename", "command", "cmd", "pattern", "query", "url", "name", "value", "text", "message"];
  for (const key of preferred) { const summary = pick(args[key]); if (summary) return summary; }
  for (const key of Object.keys(args)) { const summary = pick(args[key]); if (summary) return summary; }
  return "";
}

function emitAssistantActivity(message) {
  const content = message && Array.isArray(message.content) ? message.content : [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
      emitActivity({ kind: "assistant_text", text: part.text });
    } else if (part.type === "thinking" || part.type === "reasoning") {
      const text = typeof part.text === "string" ? part.text : (typeof part.thinking === "string" ? part.thinking : "");
      if (text.trim()) emitActivity({ kind: "reasoning", text: text });
    }
  }
}

function resolveModelName(fromMessage, fromArgs, providerFromArgs) {
  const message = fromMessage ? String(fromMessage) : "";
  const args = fromArgs ? String(fromArgs) : "";
  const bareOf = (value) => value.includes("/") ? value.split("/").pop() : value;
  if (message && message.includes("/")) return message;
  if (args && args.includes("/") && (!message || bareOf(args) === message)) return args;
  const primary = message || args;
  if (!primary) return undefined;
  if (primary.includes("/")) return primary;
  if (providerFromArgs) return providerFromArgs + "/" + primary;
  if (index.defaultProvider) return index.defaultProvider + "/" + primary;
  return primary;
}

function parseInvocation(argv) {
  const out = [];
  let model;
  let provider;
  let hasMode = false;
  let modeValue;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-p" || arg === "--print") continue;
    if (arg === "--mode") {
      hasMode = true;
      modeValue = argv[i + 1];
      out.push(arg);
      if (i + 1 < argv.length) out.push(argv[++i]);
      continue;
    }
    if (arg.startsWith("--mode=")) {
      hasMode = true;
      modeValue = arg.slice("--mode=".length);
      out.push(arg);
      continue;
    }
    if (arg === "--model" && i + 1 < argv.length) {
      model = argv[i + 1];
      out.push(arg, argv[++i]);
      continue;
    }
    if (arg.startsWith("--model=")) model = arg.slice("--model=".length);
    if (arg === "--provider" && i + 1 < argv.length) {
      provider = argv[i + 1];
      out.push(arg, argv[++i]);
      continue;
    }
    if (arg.startsWith("--provider=")) provider = arg.slice("--provider=".length);
    out.push(arg);
  }
  if (hasMode && modeValue !== "json") return { args: argv, parseJson: false, model, provider };
  if (!hasMode) out.unshift("--mode", "json");
  return { args: out, parseJson: true, model, provider };
}

function resolveWindow(modelFromArgs, providerFromArgs, modelFromMessage) {
  const candidates = [];
  if (modelFromMessage) candidates.push(modelFromMessage);
  if (modelFromArgs) candidates.push(modelFromArgs);
  if (modelFromArgs && providerFromArgs && !modelFromArgs.includes("/")) candidates.push(providerFromArgs + "/" + modelFromArgs);
  if (modelFromArgs && index.defaultProvider && !modelFromArgs.includes("/")) candidates.push(index.defaultProvider + "/" + modelFromArgs);
  if (index.defaultModel && index.defaultProvider) candidates.push(index.defaultProvider + "/" + index.defaultModel);
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (index.byQualifiedId[candidate]) return index.byQualifiedId[candidate];
    const bare = String(candidate).includes("/") ? String(candidate).split("/").pop() : String(candidate);
    if (bare && index.byId[bare]) return index.byId[bare];
  }
  return index.defaultContextWindow || 0;
}

function countToolCallsFromMessage(message) {
  const content = message && Array.isArray(message.content) ? message.content : [];
  for (const part of content) {
    if (part && part.type === "toolCall") markToolStarted(part.id, part.name);
  }
}

function emitMessageTelemetry(message, modelFromArgs, providerFromArgs) {
  const usage = addTokenUsage(message && message.usage);
  const resolvedModel = resolveModelName(message && message.model, modelFromArgs, providerFromArgs);
  if (resolvedModel) agentModel = resolvedModel;
  const contextWindow = resolveWindow(modelFromArgs, providerFromArgs, message && message.model);
  const contextUsage = usage.totalTokens && contextWindow
    ? { tokens: usage.totalTokens, contextWindow, percent: (usage.totalTokens / contextWindow) * 100 }
    : undefined;
  if (contextUsage) process.stdout.write(JSON.stringify({ type: "background-task-context-usage", ...contextUsage }) + "\\n");
  const payload = {};
  if (contextUsage) payload.contextUsage = contextUsage;
  emitUnifiedTelemetry(payload);
}

function emitToolTelemetry() {
  emitUnifiedTelemetry({});
}

const parsed = parseInvocation(process.argv.slice(2));
let child;
let buffer = "";
try {
  const childArgs = [...launch.argvPrefix, ...parsed.args];
  assertWindowsLimit("telemetry-wrapper-pi", parsed.args);
  child = spawn(launch.executable, childArgs, { stdio: ["ignore", "pipe", "pipe"], env: process.env, shell: false, windowsHide: true });
} catch (error) {
  const message = error && typeof error.message === "string" ? error.message : String(error);
  process.stderr.write("[pi-bg telemetry wrapper error: " + message + "]\\n");
  process.exitCode = 1;
}

if (child) {
  if (!parsed.parseJson) {
    child.stdout.pipe(process.stdout);
  } else {
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });
  }
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.on("error", (error) => {
    process.stderr.write("[pi-bg telemetry wrapper error: " + error.message + "]\\n");
  });
  child.on("close", (code, signal) => {
    if (parsed.parseJson && buffer.trim()) processLine(buffer);
    // Never call process.exit() here: the final message telemetry may still be
    // buffered on wrapper stdout, and forced exit can publish a stale context
    // snapshot from the preceding assistant turn. exitCode lets Node drain the
    // pipe; signal termination is deferred through the same stdout barrier.
    process.stdout.write("", () => {
      if (signal) process.kill(process.pid, signal);
      else process.exitCode = code ?? 0;
    });
  });
}

function processLine(line) {
  if (!line.trim()) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    process.stdout.write(line + "\\n");
    return;
  }
  if (event.type === "tool_execution_start") {
    const toolName = event.toolName || event.tool_name || "tool";
    markToolStarted(event.toolCallId || event.tool_call_id, toolName);
    emitActivity({ kind: "tool_start", tool: String(toolName), argsSummary: summarizeArgs(event.args || event.arguments || event.input || event.parameters) });
    emitToolTelemetry();
    return;
  }
  if (event.type === "tool_execution_end") {
    const toolName = event.toolName || event.tool_name || "tool";
    if (event.isError) markToolFailed(event.toolCallId || event.tool_call_id);
    emitActivity({ kind: "tool_end", tool: String(toolName), isError: !!event.isError, error: typeof event.error === "string" ? event.error : undefined });
    emitToolTelemetry();
    return;
  }
  if (event.type === "message_end" && event.message && event.message.role === "assistant") {
    emitAssistantActivity(event.message);
    countToolCallsFromMessage(event.message);
    emitMessageTelemetry(event.message, parsed.model, parsed.provider);
  }
}
`;
}
function noopOnChange() {
    return undefined;
}
export class BackgroundTaskRegistry {
    tasks = new Map();
    runtimeDir;
    shuttingDown = false;
    taskAdmissionsClosed = false;
    activeTaskAdmissions = new Set();
    taskAdmissionDrainWaiters = new Set();
    terminalPublicationClosed = false;
    terminalPublicationCloseReason;
    terminalPublicationClosedSignal;
    resolveTerminalPublicationClosedSignal = () => { };
    spawn;
    killProcess;
    killTree;
    platform;
    env;
    shellPolicy;
    shellPolicyEnv;
    makeTaskIdFn;
    now;
    maxOutputBytes;
    softOutputBytes;
    maxRecentTasks;
    killGraceMs;
    stopWaitMs;
    taskAdmissionTimeoutMs;
    collectPosixDescendantPids;
    logger;
    agentDir;
    onChange;
    sendCompletionNotification;
    publishTerminalPublication;
    posixProcessGroupKillStates = new WeakMap();
    windowsKillStates = new WeakMap();
    terminalPublicationAbandonSignals = new WeakMap();
    reloadShellOwner;
    reloadShellLease;
    reloadShellIdentity;
    /** branchGeneration fence 代次:每次扩展激活(新注册表实例)从 0 重新开始,
     * 经 reload handoff 导入的任务保留旧代次,新代次由扩展激活(claim.generation)推进;
     * 旧代次帧结算时标陈旧、不触发唤醒。 */
    activeBranchGeneration = 0;
    terminalWaiters = new Map();
    backgroundRequestWaiters = new Map();
    /** S1 通知批队列:终态任务引用,微任务排水时合成一条消息发送(无时间窗口)。 */
    pendingNotificationTasks;
    scheduleDrain;
    /**
     * S1:当前批排水的结算 promise。finalize/结单路径据此在本批投递(成功置位或
     * 失败回滚)尘埃落定后再落盘 `notified`,避免「先写快照、后回滚」造成磁盘与
     * 内存不一致(曾致 registry.test.ts 间歇失败)。无在途批时为 undefined。
     */
    pendingNotificationDrain;
    constructor(options) {
        this.terminalPublicationClosedSignal = new Promise((resolve) => {
            this.resolveTerminalPublicationClosedSignal = resolve;
        });
        this.spawn =
            options.spawn ??
                ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions));
        this.killProcess = options.killProcess ?? process.kill.bind(process);
        this.platform = options.platform ?? process.platform;
        this.env = options.env ?? process.env;
        this.shellPolicy = options.shellPolicy;
        this.shellPolicyEnv =
            options.shellPolicy === undefined ? { ...this.env } : undefined;
        const taskkillEnv = this.env;
        this.killTree =
            options.killTree ??
                ((pid, phase, signal) => {
                    const taskkillOptions = signal === undefined
                        ? { env: taskkillEnv }
                        : { env: taskkillEnv, signal };
                    return runWindowsTaskkill(pid, phase, taskkillOptions);
                });
        this.makeTaskIdFn = options.makeTaskId ?? defaultTaskId;
        this.now = options.now ?? Date.now;
        this.maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
        this.softOutputBytes = options.softOutputBytes ?? SOFT_OUTPUT_BYTES;
        this.maxRecentTasks = options.maxRecentTasks ?? MAX_RECENT_TASKS;
        this.killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
        this.stopWaitMs = options.stopWaitMs ?? STOP_WAIT_MS;
        this.collectPosixDescendantPids =
            options.collectPosixDescendantPids ??
                ((rootPid) => collectPosixDescendantPidsDefault(rootPid));
        this.taskAdmissionTimeoutMs = BackgroundTaskRegistry.positiveTimeout(options.taskAdmissionTimeoutMs, TASK_ADMISSION_TIMEOUT_MS, "taskAdmissionTimeoutMs");
        this.logger = options.logger ?? console;
        this.agentDir = options.agentDir ?? getAgentDir();
        this.onChange = options.onChange ?? noopOnChange;
        this.sendCompletionNotification = options.sendCompletionNotification;
        // S1:批排水调度器缺省微任务排水;测试注入捕获式(手动触发排水)
        this.scheduleDrain =
            options.scheduleDrain ?? ((drain) => queueMicrotask(drain));
        this.publishTerminalPublication = options.publishTerminal ?? noopOnChange;
        this.pendingNotificationTasks = [];
        this.reloadShellOwner = options.reloadShellOwner;
    }
    isShuttingDown() {
        return this.shuttingDown;
    }
    resolvedShellPolicy() {
        const existing = this.shellPolicy;
        if (existing !== undefined)
            return existing;
        const resolved = resolveShellPolicy(this.platform, this.shellPolicyEnv ?? this.env, process.cwd());
        this.shellPolicy = resolved;
        return resolved;
    }
    static positiveTimeout(value, fallback, label) {
        const candidate = value ?? fallback;
        if (!Number.isFinite(candidate) || candidate <= 0) {
            throw new Error(`${label} must be a positive finite number`);
        }
        return Math.max(1, Math.floor(candidate));
    }
    beginTaskAdmission(kind) {
        this.assertTaskAdmissionOpen(kind);
        const controller = new AbortController();
        const admission = {
            kind,
            controller,
            deadlineAt: Date.now() + this.taskAdmissionTimeoutMs,
            timeoutMs: this.taskAdmissionTimeoutMs,
            timeoutHandle: undefined,
            released: false,
        };
        admission.timeoutHandle = setTimeout(() => {
            if (admission.released || admission.controller.signal.aborted)
                return;
            admission.controller.abort(new BackgroundTaskAdmissionTimeoutError(admission.kind, admission.timeoutMs));
        }, admission.timeoutMs);
        this.activeTaskAdmissions.add(admission);
        return admission;
    }
    releaseTaskAdmission(admission) {
        if (admission.released)
            return;
        admission.released = true;
        if (admission.timeoutHandle !== undefined) {
            clearTimeout(admission.timeoutHandle);
            admission.timeoutHandle = undefined;
        }
        this.activeTaskAdmissions.delete(admission);
        if (this.activeTaskAdmissions.size !== 0)
            return;
        for (const resolve of this.taskAdmissionDrainWaiters)
            resolve();
        this.taskAdmissionDrainWaiters.clear();
    }
    taskAdmissionError(admission) {
        const reason = admission.controller.signal.reason;
        if (reason instanceof Error)
            return reason;
        if (this.shuttingDown || this.taskAdmissionsClosed) {
            return new BackgroundTaskAdmissionClosedError(admission.kind);
        }
        return new BackgroundTaskAdmissionTimeoutError(admission.kind, admission.timeoutMs);
    }
    surfacedTaskAdmissionError(admission, ...details) {
        const primary = this.taskAdmissionError(admission);
        const meaningful = details.filter((detail) => {
            if (detail === undefined || detail === primary)
                return false;
            if (typeof detail !== "object" || detail === null)
                return true;
            return (Reflect.get(detail, "name") !== "AbortError" &&
                Reflect.get(detail, "code") !== Reflect.get(primary, "code"));
        });
        if (meaningful.length === 0)
            return primary;
        return new AggregateError([primary, ...meaningful], `${primary.message}; admission cancellation or cleanup reported additional failures: ${meaningful.map(BackgroundTaskRegistry.errorMessage).join("; ")}`);
    }
    assertTaskAdmissionOpen(kind, admission) {
        if (admission?.controller.signal.aborted === true)
            throw this.taskAdmissionError(admission);
        if (this.shuttingDown || this.taskAdmissionsClosed) {
            throw new BackgroundTaskAdmissionClosedError(kind);
        }
    }
    async awaitTaskAdmissionBoundary(promise, admission) {
        try {
            const value = await promise;
            this.assertTaskAdmissionOpen(admission.kind, admission);
            return value;
        }
        catch (error) {
            if (admission.controller.signal.aborted &&
                typeof error === "object" &&
                error !== null) {
                const isPlainAbort = Reflect.get(error, "name") === "AbortError";
                const isCleanDurableCancellation = Reflect.get(error, "code") === "durable_file_cancelled" &&
                    Reflect.get(error, "renameCompleted") !== true &&
                    Array.isArray(Reflect.get(error, "cleanupFailures")) &&
                    Reflect.get(error, "cleanupFailures").length === 0;
                if (isPlainAbort || isCleanDurableCancellation) {
                    throw this.taskAdmissionError(admission);
                }
            }
            throw error;
        }
    }
    closeTaskAdmissions() {
        if (this.taskAdmissionsClosed)
            return;
        this.taskAdmissionsClosed = true;
        for (const admission of this.activeTaskAdmissions) {
            if (!admission.controller.signal.aborted) {
                admission.controller.abort(new BackgroundTaskAdmissionClosedError(admission.kind));
            }
        }
    }
    waitForTaskAdmissions() {
        if (this.activeTaskAdmissions.size === 0)
            return Promise.resolve();
        return new Promise((resolve) => {
            this.taskAdmissionDrainWaiters.add(resolve);
        });
    }
    setShuttingDown(value) {
        if (value) {
            this.shuttingDown = true;
            this.closeTaskAdmissions();
            this.closeTerminalPublication("registry_shutdown");
            return;
        }
        // Publication and admission closure belong to one extension activation and
        // are one-way. Pi session replacement creates a fresh registry; an old
        // registry must not be reopened by a late lifecycle continuation.
        if (!this.terminalPublicationClosed && !this.taskAdmissionsClosed)
            this.shuttingDown = false;
    }
    closeTerminalPublication(reason) {
        if (!this.terminalPublicationClosed) {
            this.terminalPublicationClosed = true;
            this.terminalPublicationCloseReason = reason;
            this.resolveTerminalPublicationClosedSignal(reason);
        }
        const effectiveReason = this.terminalPublicationCloseReason ?? reason;
        for (const task of this.tasks.values()) {
            if (task.terminalPublicationState === "pending" &&
                task.terminalEmitInFlight === true) {
                // A synchronous listener can close the service while emit() is still on
                // the stack. Dispose queued work now, but let the emitter's return/throw
                // settle the in-flight attempt exactly once.
                if (task.terminalPublishRetryHandle !== undefined) {
                    clearTimeout(task.terminalPublishRetryHandle);
                    task.terminalPublishRetryHandle = undefined;
                }
                task.terminalPublicationGate = undefined;
                continue;
            }
            const shouldLog = task.terminalPublicationState === "pending" &&
                task.status !== "running" &&
                (task.terminalPublishAttempts > 0 ||
                    task.terminalPublishRetryHandle !== undefined ||
                    task.terminalPublicationGate !== undefined);
            this.abandonTerminalPublication(task, effectiveReason, undefined, shouldLog);
        }
        this.pruneOldTasks();
    }
    allTasks() {
        return [...this.tasks.values()];
    }
    snapshot(task) {
        return snapshot(task);
    }
    /** 推进 branchGeneration fence 代次(扩展激活时以 reload claim generation 调用)。 */
    setActiveBranchGeneration(generation) {
        this.activeBranchGeneration = Math.max(0, Math.floor(generation));
    }
    /**
     * waiter 双通道之一:等待任务达终态。任务不存在或已终态立即结算;
     * AbortSignal 中止时按参照语义 reject(signal.reason)。
     */
    waitForTerminal(id, options) {
        const current = this.tasks.get(id);
        if (current === undefined)
            return Promise.resolve(undefined);
        if (isTerminalTaskStatus(current.status))
            return Promise.resolve(snapshot(current));
        return this.waitForChannel(this.terminalWaiters, id, options);
    }
    /**
     * waiter 双通道之一:等待任务被请求转入后台(requestBackground)。
     * 任务不存在 → undefined;已后台化(含已终态)→ 快照;未后台化已终态 →
     * undefined。当前无生产调用方(EventBus 未来接线时启用,单测仍覆盖),
     * 语义与 settleTaskWaiters 对齐(参照 ZCode 参照实现的立即结算语义)。
     */
    waitForBackgroundRequest(id, options) {
        const current = this.tasks.get(id);
        if (current === undefined)
            return Promise.resolve(undefined);
        if (current.backgroundRequested === true)
            return Promise.resolve(snapshot(current));
        if (isTerminalTaskStatus(current.status))
            return Promise.resolve(undefined);
        return this.waitForChannel(this.backgroundRequestWaiters, id, options);
    }
    /** 请求将任务转入后台(单发),已终态或未知任务返回 false。 */
    requestBackground(id) {
        const task = this.tasks.get(id);
        if (task === undefined || isTerminalTaskStatus(task.status))
            return false;
        if (task.backgroundRequested === true)
            return true;
        task.backgroundRequested = true;
        this.onChange();
        this.resolveBackgroundRequestWaiters(id, snapshot(task));
        return true;
    }
    waitForChannel(waitersByTask, id, options) {
        const signal = options?.signal;
        if (signal?.aborted === true)
            return Promise.reject(waiterAbortReason(signal));
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject, signal };
            if (signal !== undefined) {
                waiter.onAbort = () => {
                    this.removeTaskWaiter(waitersByTask, id, waiter);
                    reject(waiterAbortReason(signal));
                };
                signal.addEventListener("abort", waiter.onAbort, { once: true });
            }
            let waiters = waitersByTask.get(id);
            if (waiters === undefined) {
                waiters = new Set();
                waitersByTask.set(id, waiters);
            }
            waiters.add(waiter);
        });
    }
    resolveTaskWaiters(waitersByTask, id, result) {
        const waiters = waitersByTask.get(id);
        if (waiters === undefined)
            return;
        waitersByTask.delete(id);
        for (const waiter of waiters) {
            if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
                waiter.signal.removeEventListener("abort", waiter.onAbort);
            }
            waiter.resolve(result);
        }
    }
    removeTaskWaiter(waitersByTask, id, waiter) {
        const waiters = waitersByTask.get(id);
        if (waiters === undefined)
            return;
        waiters.delete(waiter);
        if (waiters.size === 0)
            waitersByTask.delete(id);
    }
    resolveTerminalWaiters(id, result) {
        this.resolveTaskWaiters(this.terminalWaiters, id, result);
    }
    resolveBackgroundRequestWaiters(id, result) {
        this.resolveTaskWaiters(this.backgroundRequestWaiters, id, result);
    }
    /**
     * 任务状态变更后的 waiter 结算:达终态时结算 terminal 通道(带快照),
     * 并关闭 background 通道——已后台化即使终态也以快照结算(与
     * waitForBackgroundRequest 立即结算语义对齐,参照 ZCode);未后台化 → undefined。
     * 已后台化未终态时即时结算 background 通道。register/update/导入/终态落点均调用。
     */
    settleTaskWaiters(task) {
        if (isTerminalTaskStatus(task.status)) {
            this.resolveTerminalWaiters(task.id, snapshot(task));
            if (task.backgroundRequested === true) {
                this.resolveBackgroundRequestWaiters(task.id, snapshot(task));
            }
            else {
                this.resolveBackgroundRequestWaiters(task.id, undefined);
            }
            return;
        }
        if (task.backgroundRequested === true) {
            this.resolveBackgroundRequestWaiters(task.id, snapshot(task));
        }
    }
    /**
     * branchGeneration 迟到结算 fence:任务帧代次与注册表当前代次不匹配即标陈旧,
     * 后续唤醒(trigger 型通知)被抑制。
     */
    applyBranchGenerationFence(task) {
        const generation = task.branchGeneration;
        if (generation !== undefined &&
            generation !== this.activeBranchGeneration) {
            task.staleBranchFrame = true;
        }
    }
    hasCurrentReloadLease() {
        const lease = this.reloadShellLease;
        return (lease !== undefined &&
            this.reloadShellOwner?.isCurrentLease(lease) === true);
    }
    async stageReloadActivation(claim) {
        if (claim.protocol !== RELOAD_SHELL_OWNER_PROTOCOL) {
            throw new ReloadSurvivalError("pi_bg_reload_owner_protocol_incompatible", "activation claim does not use the supported reload shell owner protocol");
        }
        const staged = [];
        const ids = new Set();
        for (const execution of claim.executions) {
            if (execution.protocol !== RELOAD_SHELL_OWNER_PROTOCOL ||
                execution.task.reloadExecution !== execution ||
                execution.task.surviveReload !== true) {
                throw new ReloadSurvivalError("pi_bg_reload_owner_protocol_incompatible", "activation claim contains an incompatible reload shell execution");
            }
            if (ids.has(execution.task.id) || this.tasks.has(execution.task.id)) {
                throw new ReloadSurvivalError("pi_bg_reload_owner_activation_conflict", `claimed task id ${execution.task.id} conflicts with the fresh registry`);
            }
            ids.add(execution.task.id);
        }
        try {
            for (const execution of claim.executions) {
                const task = execution.task;
                task.reloadHostDeliveryInFlight = false;
                task.reloadHostDeliverySettled = false;
                task.reloadHostNotificationSettled = false;
                execution.updateLeaseAudit(claim.generation, (task.reloadSurvival?.handoffCount ?? 0) + 1);
                this.tasks.set(task.id, task);
                // 导入即结算:携带终态跨 reload 的旧任务帧在本次导入时结算 waiter 通道
                this.settleTaskWaiters(task);
                staged.push(execution);
            }
            await Promise.all(staged.map(async (execution) => this.writeMetadata(execution.task)));
        }
        catch (error) {
            for (const execution of staged)
                this.tasks.delete(execution.task.id);
            throw error;
        }
        let boundLease;
        return {
            activationNonce: claim.activationNonce,
            onBound: (lease) => {
                if (lease.activationNonce !== claim.activationNonce ||
                    lease.generation !== claim.generation ||
                    lease.identityKey !== claim.identityKey) {
                    throw new ReloadSurvivalError("pi_bg_reload_owner_stale_claim", "committed lease does not match its staged activation claim");
                }
                boundLease = lease;
                this.reloadShellLease = lease;
                this.reloadShellIdentity = claim.identity;
            },
            onChanged: (execution) => {
                const lease = boundLease;
                if (!this.ownsReloadExecution(execution, lease))
                    return;
                this.onChange();
            },
            onTerminal: (execution) => {
                const lease = boundLease;
                if (!this.ownsReloadExecution(execution, lease))
                    return;
                void this.deliverReloadTerminal(execution, lease);
            },
        };
    }
    abortReloadActivation(claim) {
        for (const execution of claim.executions) {
            const task = execution.task;
            if (this.tasks.get(task.id) !== task)
                continue;
            if (task.terminalPublishRetryHandle !== undefined) {
                clearTimeout(task.terminalPublishRetryHandle);
                task.terminalPublishRetryHandle = undefined;
            }
            task.terminalPublicationGate = undefined;
            task.terminalPublishInFlight = false;
            this.tasks.delete(task.id);
            // 中止导入与 remove 等价:结算两类 waiter(未达终态 → undefined)
            this.resolveTerminalWaiters(task.id, undefined);
            this.resolveBackgroundRequestWaiters(task.id, undefined);
        }
        if (this.reloadShellLease?.activationNonce === claim.activationNonce) {
            this.reloadShellLease = undefined;
            this.reloadShellIdentity = undefined;
        }
    }
    prepareReloadHandoff(lease) {
        if (this.reloadShellOwner === undefined ||
            this.reloadShellLease !== lease) {
            throw new ReloadSurvivalError("pi_bg_reload_owner_stale_claim", "registry does not own the requested reload activation lease");
        }
        const executions = this.reloadShellOwner.beginReloadHandoff(lease);
        const tasks = [];
        for (const execution of executions) {
            const task = execution.task;
            if (this.tasks.get(task.id) !== task) {
                throw new ReloadSurvivalError("pi_bg_reload_owner_stale_claim", `registry no longer owns survivor ${task.id}`);
            }
            if (task.terminalPublishRetryHandle !== undefined) {
                clearTimeout(task.terminalPublishRetryHandle);
                task.terminalPublishRetryHandle = undefined;
            }
            task.terminalPublicationGate = undefined;
            task.terminalPublishInFlight = false;
            task.reloadHostDeliveryInFlight = false;
            task.reloadHostDeliverySettled = false;
            task.reloadHostNotificationSettled = false;
            this.tasks.delete(task.id);
            // 让渡即结算:本注册表不再持有该任务,挂起 waiter 以 undefined 收尾
            this.resolveTerminalWaiters(task.id, undefined);
            this.resolveBackgroundRequestWaiters(task.id, undefined);
            tasks.push(task);
        }
        this.reloadShellLease = undefined;
        this.reloadShellIdentity = undefined;
        return Object.freeze(tasks);
    }
    async waitForReloadHostSettlement(timeoutMs = this.stopWaitMs) {
        const deadline = Date.now() + timeoutMs;
        while (true) {
            const unsettled = [...this.tasks.values()].filter((task) => task.reloadExecution?.phase === "terminal" &&
                (task.reloadHostNotificationSettled !== true ||
                    task.terminalPublicationState === "pending"));
            if (unsettled.length === 0)
                return;
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                throw new Error(`Timed out waiting for reload shell host settlement: ${unsettled.map((task) => task.id).join(", ")}`);
            }
            await new Promise((resolve) => setTimeout(resolve, Math.min(10, remaining)));
        }
    }
    releaseReloadActivation(lease) {
        if (this.reloadShellOwner === undefined)
            return;
        if (this.reloadShellLease !== lease ||
            !this.reloadShellOwner.isCurrentLease(lease))
            return;
        this.reloadShellOwner.releaseActivation(lease);
        this.reloadShellLease = undefined;
        this.reloadShellIdentity = undefined;
    }
    currentReloadLease() {
        return this.hasCurrentReloadLease() ? this.reloadShellLease : undefined;
    }
    ownsReloadExecution(execution, lease) {
        return (lease !== undefined &&
            this.reloadShellLease === lease &&
            this.reloadShellOwner?.isCurrentLease(lease) === true &&
            this.tasks.get(execution.task.id) === execution.task &&
            execution.task.reloadExecution === execution);
    }
    async ensureRuntimeDir(ctx) {
        if (this.runtimeDir)
            return this.runtimeDir;
        const sessionId = sanitizePathSegment(ctx.sessionId ?? `session-${String(process.pid)}`);
        const runId = `${sessionId}-${String(process.pid)}`;
        // S3 P5:运行时目录迁宿主私有 agent 目录(`getAgentDir()/tasks/<runId>/`,
        // 与宿主 sessions 同级);旧项目内 `.pi/tasks` 目录不迁移、不删除,README
        // 注明可手动清理。对外路径由此统一为绝对路径(P4)。
        const runtimeDirAbs = join(this.agentDir, "tasks", runId);
        await mkdir(runtimeDirAbs, { recursive: true });
        this.runtimeDir = { abs: runtimeDirAbs };
        return this.runtimeDir;
    }
    /**
     * 启动审计:扩展激活路径遍历 `<getAgentDir()>/tasks/<runId>/` 目录(目录层
     * runId、文件层 `<task-id>.json`),`status=running` 遗留记录一律更新为 `lost`
     * (writeFileDurable 落盘);输出文件保留、不复活进程。当前注册表内活动的
     * `running` 任务(含 reload 让渡的存活执行)不触碰。
     * 返回被改写为 lost 的记录数。
     */
    async auditStartupRecords(ctx) {
        if (this.runtimeDir === undefined)
            await this.ensureRuntimeDir(ctx);
        const dir = this.runtimeDir;
        if (dir === undefined)
            return 0;
        const liveIds = new Set([...this.tasks.values()]
            .filter((task) => task.status === "running")
            .map((task) => task.id));
        const entries = await readdir(dir.abs, { withFileTypes: true });
        let audited = 0;
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith(".json"))
                continue;
            const id = entry.name.slice(0, -".json".length);
            if (liveIds.has(id))
                continue;
            const record = await readFile(join(dir.abs, entry.name), "utf8").catch(() => undefined);
            if (record === undefined)
                continue;
            let parsed;
            try {
                parsed = parseJsonText(record);
            }
            catch {
                // 无法解析的残留文件不具可审计状态,跳过
                continue;
            }
            if (!isJsonObject(parsed))
                continue;
            // 兼容性:旧记录缺失新字段(如 stopInitiator/branchGeneration/failedReason)
            // 按类型默认处理,只按 status 字段判定
            if (parsed["status"] !== "running")
                continue;
            await writeFileDurable(join(dir.abs, entry.name), JSON.stringify({
                ...parsed,
                status: "lost",
                endTime: this.now(),
                error: STARTUP_AUDIT_ERROR,
            }));
            audited++;
        }
        return audited;
    }
    async destroyTaskStream(task) {
        // M3 force-exit:先释放插件持有的子进程输出读端(pipe 读端)。组长/组已死而
        // 孙进程直接持有写端时,读端不销毁则管道永不 EOF,子进程 'close' 永不触发,
        // 任务永久悬挂、宿主被孤儿保活;销毁读端后孤儿后续写入触发 EPIPE/SIGPIPE。
        this.destroyTaskChildOutputSources(task);
        const stream = task.stream;
        if (stream === undefined || stream.closed)
            return;
        await new Promise((resolve) => {
            const closed = () => {
                stream.off("close", closed);
                resolve();
            };
            stream.once("close", closed);
            if (!stream.destroyed)
                stream.destroy();
            if (stream.closed)
                closed();
        });
    }
    /** M3:尽力而为地销毁 child 的 stdout/stderr 读端(Node ReadStream 幂等,失败仅记日志)。 */
    destroyTaskChildOutputSources(task) {
        const child = task.child;
        if (child === undefined)
            return;
        const sources = [
            child.stdout,
            child.stderr,
        ];
        for (const source of sources) {
            if (source?.destroy === undefined)
                continue;
            try {
                source.destroy();
            }
            catch (error) {
                this.logger.error(`[background-tasks] failed to destroy output source for ${task.id}:`, error);
            }
        }
    }
    async discardUnspawnedTask(task, paths) {
        this.tasks.delete(task.id);
        task.finalized = true;
        task.status = "failed";
        if (task.timeoutHandle !== undefined)
            clearTimeout(task.timeoutHandle);
        if (task.killEscalationTimer !== undefined)
            clearTimeout(task.killEscalationTimer);
        await this.destroyTaskStream(task);
        const removals = await Promise.allSettled(paths.map((path) => rm(path, { force: true })));
        const failures = [];
        for (let index = 0; index < removals.length; index++) {
            const result = removals[index];
            if (result?.status !== "rejected")
                continue;
            const path = paths[index] ?? "<unknown admission artifact>";
            failures.push(new Error(`Failed to remove interrupted admission artifact ${path}: ${BackgroundTaskRegistry.errorMessage(result.reason)}`));
        }
        if (failures.length > 0) {
            throw new AggregateError(failures, "Interrupted task admission artifact cleanup failed");
        }
    }
    captureSpawnedChild(task, child) {
        task.child = child;
        task.pid = child.pid;
        if (this.platform !== "win32" &&
            child.pid !== undefined &&
            Number.isSafeInteger(child.pid) &&
            child.pid > 0) {
            // Capture detached-group ownership once, directly from this spawn. Never
            // reconstruct signal authority from mutable task metadata or a later PID.
            task.ownedPosixProcessGroupId = child.pid;
        }
    }
    bindOwnedTaskToAdmission(task, admission) {
        const cancelOwnedTask = () => {
            this.stopOwnedTaskAfterAdmissionCancellation(task, this.taskAdmissionError(admission));
        };
        admission.controller.signal.addEventListener("abort", cancelOwnedTask, {
            once: true,
        });
        if (admission.controller.signal.aborted)
            cancelOwnedTask();
        return () => {
            admission.controller.signal.removeEventListener("abort", cancelOwnedTask);
        };
    }
    stopOwnedTaskAfterAdmissionCancellation(task, error) {
        if (task.status !== "running")
            return;
        task.killKind =
            error instanceof BackgroundTaskAdmissionTimeoutError
                ? "timeout"
                : "shutdown";
        task.error = error.message;
        try {
            this.requestKill(task, "SIGTERM");
        }
        catch (killError) {
            this.logger.error(`[background-tasks] failed to stop ${task.id} after admission cancellation:`, killError);
        }
    }
    async startTask(ctx, command, options = {}) {
        const hasSurvival = Object.prototype.hasOwnProperty.call(options, "surviveReload");
        if (hasSurvival && typeof options.surviveReload !== "boolean") {
            throw new ReloadSurvivalError("pi_bg_survive_reload_invalid", "surviveReload must be a boolean when present");
        }
        const surviveReload = options.surviveReload === true;
        if (surviveReload && options.isAgent === true) {
            throw new ReloadSurvivalError("pi_bg_survive_reload_requires_non_agent", "surviveReload requires isAgent:false");
        }
        const hasDirectArgv = options.argv !== undefined &&
            Array.isArray(options.argv) &&
            options.argv.length > 0 &&
            typeof options.argv[0] === "string" &&
            options.argv[0].trim().length > 0;
        if (options.argv !== undefined && !hasDirectArgv) {
            // REVIEW:显式传 argv 但判定无效时失败告警,不得静默执行另一条命令
            throw new BackgroundTaskInvalidArgvError();
        }
        if (surviveReload && hasDirectArgv) {
            // 直执行无 shell 中介,reload handoff 依赖 shell 语义,二者互斥
            throw new ReloadSurvivalError("pi_bg_survive_reload_requires_shell_command", "argv direct execution has no shell mediation and cannot survive a same-process reload; drop surviveReload or pass a command string");
        }
        const reloadLease = surviveReload ? this.currentReloadLease() : undefined;
        if (surviveReload && reloadLease === undefined) {
            throw new ReloadSurvivalError("pi_bg_reload_owner_unavailable", "no successfully bound same-process reload owner activation is available");
        }
        const admission = this.beginTaskAdmission("a background task");
        try {
            if (surviveReload && reloadLease !== undefined) {
                return await this.startReloadableTaskAdmitted(ctx, command, options, admission, reloadLease);
            }
            return await this.startTaskAdmitted(ctx, command, options, admission);
        }
        finally {
            this.releaseTaskAdmission(admission);
        }
    }
    async startReloadableTaskAdmitted(ctx, command, options, admission, lease) {
        const normalizedCommand = command.trim();
        if (!normalizedCommand)
            throw new Error("Background command is empty");
        if (options.isAgent === true) {
            throw new ReloadSurvivalError("pi_bg_survive_reload_requires_non_agent", "surviveReload requires isAgent:false");
        }
        if (this.reloadShellOwner === undefined ||
            this.reloadShellIdentity === undefined ||
            this.reloadShellLease !== lease ||
            !this.reloadShellOwner.isCurrentLease(lease)) {
            throw new ReloadSurvivalError("pi_bg_reload_owner_unavailable", "reload owner activation became unavailable before launch");
        }
        if (ctx.sessionId !== this.reloadShellIdentity.sessionId) {
            throw new ReloadSurvivalError("pi_bg_reload_owner_stale_claim", "launch context session id does not match the bound reload owner identity");
        }
        this.assertTaskAdmissionOpen("a background task", admission);
        const shellPolicy = this.resolvedShellPolicy();
        const invocation = shellInvocationForPolicy(normalizedCommand, shellPolicy);
        const dir = await this.awaitTaskAdmissionBoundary(this.ensureRuntimeDir(ctx), admission);
        this.assertTaskAdmissionOpen("a background task", admission);
        if (this.reloadShellLease !== lease ||
            !this.reloadShellOwner.isCurrentLease(lease)) {
            throw new ReloadSurvivalError("pi_bg_reload_owner_stale_claim", "reload owner activation changed during task preflight");
        }
        const id = this.makeTaskIdFn();
        const outputAbsPath = join(dir.abs, `${id}.output`);
        const metadataAbsPath = join(dir.abs, `${id}.json`);
        // S2 P4:对外输出路径唯一取 dir.abs(绝对);outputAbsPath 保留为 BgTask 别名
        const outputPath = outputAbsPath;
        const timeoutSeconds = typeof options.timeoutSeconds === "number" &&
            Number.isFinite(options.timeoutSeconds) &&
            options.timeoutSeconds > 0
            ? Math.floor(options.timeoutSeconds)
            : undefined;
        // S7 P9:仅当显式 name 存在时赋值;无显式名保持 undefined,显示链在
        // taskDisplayName 内以 description > 完整 command 原样 > id 兜底
        const taskName = normalizeTaskName(options.name);
        const trimmedDescription = options.description?.trim();
        const description = trimmedDescription && trimmedDescription.length > 0
            ? trimmedDescription
            : undefined;
        const task = {
            id,
            name: taskName,
            command: normalizedCommand,
            description,
            status: "running",
            outputPath,
            outputAbsPath,
            metadataAbsPath,
            cwd: ctx.cwd,
            startTime: this.now(),
            exitCode: undefined,
            pid: undefined,
            bytesWritten: 0,
            isAgent: false,
            surviveReload: true,
            notified: false,
            notifyOnCompletion: options.notifyOnCompletion ?? true,
            // 唤醒默认值按入口语义:模型入口缺省 notify+trigger;其余入口缺省仅通知
            triggerOnCompletion: options.triggerOnCompletion ?? options.entrySource === "model",
            timeoutSeconds,
            terminalPublished: false,
            terminalPublicationState: "pending",
            terminalPublishAttempts: 0,
            terminalPublicationGate: options.terminalPublicationGate,
            shellPolicy: shellPolicySnapshot(shellPolicy),
            waiters: [],
            branchGeneration: this.activeBranchGeneration,
            entrySource: options.entrySource,
        };
        const launchNonce = randomBytes(16).toString("hex");
        this.assertTaskAdmissionOpen("a background task", admission);
        this.tasks.set(id, task);
        let execution;
        let registered = false;
        let committed = false;
        let abortListener;
        try {
            execution = createReloadableShellExecutionV1({
                task,
                identity: this.reloadShellIdentity,
                lease,
                launchNonce,
                invocation,
                spawn: this.spawn,
                killProcess: this.killProcess,
                killTree: this.killTree,
                platform: this.platform,
                env: this.env,
                maxOutputBytes: this.maxOutputBytes,
                softOutputBytes: this.softOutputBytes,
                killGraceMs: this.killGraceMs,
                stopWaitMs: this.stopWaitMs,
                collectPosixDescendantPids: this.collectPosixDescendantPids,
                now: this.now,
                logger: this.logger,
            });
            this.reloadShellOwner.registerExecution(lease, execution);
            registered = true;
            abortListener = () => {
                if (execution === undefined)
                    return;
                const error = this.taskAdmissionError(admission);
                execution.failAdmission(error);
                const kind = error instanceof BackgroundTaskAdmissionTimeoutError
                    ? "timeout"
                    : "shutdown";
                void execution
                    .requestStop(kind, error.message)
                    .catch((stopError) => {
                    this.logger.error(`[background-tasks] failed to stop reloadable task ${task.id} after admission cancellation:`, stopError);
                });
            };
            admission.controller.signal.addEventListener("abort", abortListener, {
                once: true,
            });
            if (admission.controller.signal.aborted)
                abortListener();
            await this.awaitTaskAdmissionBoundary(execution.commitInitialMetadata(admission.controller.signal), admission);
            this.assertTaskAdmissionOpen("a background task", admission);
            if (this.reloadShellLease !== lease ||
                !this.reloadShellOwner.isCurrentLease(lease)) {
                throw new ReloadSurvivalError("pi_bg_reload_owner_stale_claim", "reload owner activation changed before admission commit");
            }
            this.reloadShellOwner.markAdmissionCommitted(lease, execution);
            committed = true;
            this.onChange();
            return task;
        }
        catch (error) {
            const primary = admission.controller.signal.aborted
                ? this.taskAdmissionError(admission)
                : error instanceof Error
                    ? error
                    : new Error(String(error));
            execution?.failAdmission(primary);
            let cleanupError;
            if (execution !== undefined) {
                try {
                    if (task.status === "running") {
                        await execution.requestStop(admission.controller.signal.aborted &&
                            primary instanceof BackgroundTaskAdmissionTimeoutError
                            ? "timeout"
                            : "shutdown", primary.message);
                    }
                }
                catch (stopError) {
                    cleanupError = stopError;
                }
            }
            if (registered && !committed && execution !== undefined) {
                if (this.reloadShellOwner.isCurrentLease(lease)) {
                    this.reloadShellOwner.releaseExecution(lease, execution);
                }
            }
            this.tasks.delete(task.id);
            if (execution === undefined) {
                const removals = await Promise.allSettled([
                    rm(outputAbsPath, { force: true }),
                    rm(metadataAbsPath, { force: true }),
                ]);
                const removalFailure = removals.find((result) => result.status === "rejected");
                if (removalFailure?.status === "rejected")
                    cleanupError = removalFailure.reason;
            }
            if (admission.controller.signal.aborted) {
                throw this.surfacedTaskAdmissionError(admission, error, cleanupError);
            }
            if (cleanupError !== undefined) {
                throw new AggregateError([primary, cleanupError], `Failed to start reloadable background task and cleanup also failed: ${BackgroundTaskRegistry.errorMessage(cleanupError)}`);
            }
            throw new Error(`Failed to start background task: ${primary.message}`);
        }
        finally {
            if (abortListener !== undefined) {
                admission.controller.signal.removeEventListener("abort", abortListener);
            }
        }
    }
    async startTaskAdmitted(ctx, command, options, admission) {
        const directExecution = directExecutionFromOptions(options, {
            cwd: ctx.cwd,
            env: this.env,
            platform: this.platform,
        });
        const normalizedCommand = command.trim();
        if (!normalizedCommand && directExecution === undefined)
            throw new Error("Background command is empty");
        this.assertTaskAdmissionOpen("a background task", admission);
        const displayCommand = directExecution !== undefined && options.argv !== undefined
            ? options.argv.join(" ")
            : normalizedCommand;
        const isAgent = options.isAgent ?? false;
        // 直执行路径无 shell 中介:不解析 shell policy、不构造 shell 调用
        const shellPolicy = directExecution === undefined ? this.resolvedShellPolicy() : undefined;
        const baseInvocation = shellPolicy !== undefined
            ? shellInvocationForPolicy(normalizedCommand, shellPolicy)
            : undefined;
        const piTelemetryRequested = directExecution === undefined &&
            isAgent &&
            commandMayLaunchPiAgent(normalizedCommand, this.env);
        const piTelemetryLaunch = piTelemetryRequested && shellPolicy?.supportsPosixFunctionWrapper === true
            ? resolvePiLaunch({ platform: this.platform })
            : undefined;
        const dir = await this.awaitTaskAdmissionBoundary(this.ensureRuntimeDir(ctx), admission);
        this.assertTaskAdmissionOpen("a background task", admission);
        const id = this.makeTaskIdFn();
        const outputAbsPath = join(dir.abs, `${id}.output`);
        const metadataAbsPath = join(dir.abs, `${id}.json`);
        // S2 P4:对外输出路径唯一取 dir.abs(绝对);outputAbsPath 保留为 BgTask 别名
        const outputPath = outputAbsPath;
        let commandToSpawn = normalizedCommand;
        let wrapperAbsPath;
        try {
            if (piTelemetryRequested &&
                shellPolicy?.supportsPosixFunctionWrapper === true) {
                if (piTelemetryLaunch === undefined)
                    throw new Error("Pi telemetry launch spec was not resolved");
                wrapperAbsPath = join(dir.abs, `${id}.pi-telemetry-wrapper.cjs`);
                try {
                    await writeFile(wrapperAbsPath, createPiTelemetryWrapperSource(buildModelWindowIndex(ctx), piTelemetryLaunch), { encoding: "utf8", signal: admission.controller.signal });
                }
                catch (error) {
                    if (admission.controller.signal.aborted)
                        throw this.taskAdmissionError(admission);
                    throw error;
                }
                this.assertTaskAdmissionOpen("a background task", admission);
                commandToSpawn = `pi() { ${shellQuote(process.execPath)} ${shellQuote(wrapperAbsPath)} "$@"; }\n${normalizedCommand}`;
            }
        }
        catch (error) {
            if (wrapperAbsPath !== undefined)
                await rm(wrapperAbsPath, { force: true });
            throw error;
        }
        const invocation = directExecution !== undefined
            ? directExecution
            : commandToSpawn === normalizedCommand
                ? (baseInvocation ??
                    shellInvocationForPolicy(normalizedCommand, shellPolicy ?? this.resolvedShellPolicy()))
                : shellInvocationForPolicy(commandToSpawn, shellPolicy ?? this.resolvedShellPolicy());
        const timeoutSeconds = typeof options.timeoutSeconds === "number" &&
            Number.isFinite(options.timeoutSeconds) &&
            options.timeoutSeconds > 0
            ? Math.floor(options.timeoutSeconds)
            : undefined;
        // S7 P9:仅当显式 name 存在时赋值;无显式名保持 undefined,显示链在
        // taskDisplayName 内以 description > 完整 command 原样 > id 兜底
        const taskName = normalizeTaskName(options.name);
        const trimmedDescription = options.description?.trim();
        const description = trimmedDescription && trimmedDescription.length > 0
            ? trimmedDescription
            : undefined;
        const task = {
            id,
            name: taskName,
            command: displayCommand,
            description,
            status: "running",
            outputPath,
            outputAbsPath,
            metadataAbsPath,
            cwd: ctx.cwd,
            startTime: this.now(),
            exitCode: undefined,
            pid: undefined,
            bytesWritten: 0,
            isAgent,
            surviveReload: false,
            notified: false,
            notifyOnCompletion: options.notifyOnCompletion ?? true,
            // 唤醒默认值按入口语义:模型入口缺省 notify+trigger;其余入口缺省仅通知
            triggerOnCompletion: options.triggerOnCompletion ?? options.entrySource === "model",
            timeoutSeconds,
            terminalPublished: false,
            terminalPublicationState: "pending",
            terminalPublishAttempts: 0,
            terminalPublicationGate: options.terminalPublicationGate,
            shellPolicy: shellPolicy !== undefined
                ? shellPolicySnapshot(shellPolicy)
                : undefined,
            waiters: [],
            branchGeneration: this.activeBranchGeneration,
            entrySource: options.entrySource,
        };
        if (commandToSpawn !== normalizedCommand)
            task.telemetryWrapped = true;
        if (directExecution !== undefined && isAgent) {
            // 直执行无 shell 中介,无法写入 pi 函数包装器,遥测不可用
            task.telemetryUnavailableReason =
                DIRECT_EXEC_PI_TELEMETRY_UNAVAILABLE_REASON;
        }
        else if (piTelemetryRequested &&
            shellPolicy?.supportsPosixFunctionWrapper !== true) {
            task.telemetryUnavailableReason =
                shellPolicy?.dialect === "cmd"
                    ? WIN32_CMD_PI_TELEMETRY_UNAVAILABLE_REASON
                    : NON_POSIX_SHELL_PI_TELEMETRY_UNAVAILABLE_REASON;
        }
        this.assertTaskAdmissionOpen("a background task", admission);
        this.tasks.set(id, task);
        const stream = createWriteStream(outputAbsPath, {
            flags: "a",
            encoding: "utf8",
        });
        task.stream = stream;
        stream.on("error", (error) => {
            // M3 force-exit:终止流程已锁存(finalized)或销毁引发的尾写错误
            // (ERR_STREAM_DESTROYED)时,不得覆盖权威失败文案(如 Descendant
            // processes may have leaked)与锁存状态;终态化阶段的真实耐久性错误
            // 由 finalizeTask 自身捕获并追加。
            if (task.finalized === true)
                return;
            if (Reflect.get(error, "code") === "ERR_STREAM_DESTROYED")
                return;
            task.error = `Output file write failed: ${error.message}`;
            if (task.status === "running") {
                const diskFull = isEnospcError(error);
                task.killKind = diskFull ? "disk_full" : "output_cap";
                if (diskFull)
                    task.failedReason = "disk_full";
                try {
                    this.requestKill(task, "SIGTERM");
                }
                catch (killError) {
                    void this.finalizeTask(task, "failed", null, undefined, `${task.error}; kill failed: ${killError instanceof Error ? killError.message : String(killError)}`);
                }
            }
        });
        let unbindAdmissionCancellation = () => undefined;
        try {
            this.assertTaskAdmissionOpen("a background task", admission);
            const child = this.spawn("shell" in invocation ? invocation.shell : invocation.file, [...invocation.args], {
                cwd: ctx.cwd,
                detached: this.platform !== "win32",
                stdio: ["ignore", "pipe", "pipe"],
                env: this.env,
                windowsHide: true,
                windowsVerbatimArguments: invocation.windowsVerbatimArguments,
            });
            this.captureSpawnedChild(task, child);
            child.stdout?.on("data", (data) => {
                this.appendChildOutput(task, data, "stdout");
            });
            child.stderr?.on("data", (data) => {
                this.appendChildOutput(task, data, "stderr");
            });
            child.on("error", (error) => {
                this.writeNotice(task, `\n[background task spawn error: ${error.message}]\n`);
                task.failedReason = "spawn_error";
                void this.finalizeTask(task, "failed", null, undefined, error.message);
            });
            child.on("close", (code, signalName) => {
                // M2 状态迁移表(六态迁移表共享判定):user/model 停止 → cancelled;
                // system 关闭 → killed;退出码非 0 / timeout / output_limit / spawn_error /
                // ENOSPC → failed(带细分 reason)
                const terminal = deriveTerminalStatus(task, task.killKind, code, signalName, this.maxOutputBytes);
                void this.finalizeTask(task, terminal.status, code, signalName, terminal.error);
            });
            if (timeoutSeconds !== undefined) {
                task.timeoutHandle = setTimeout(() => {
                    if (task.status !== "running")
                        return;
                    task.killKind = "timeout";
                    task.error = `Timed out after ${String(timeoutSeconds)}s`;
                    this.writeNotice(task, `\n[background task timeout: ${task.error}]\n`);
                    try {
                        this.requestKill(task, "SIGTERM");
                    }
                    catch (error) {
                        void this.finalizeTask(task, "failed", null, undefined, `${task.error}; kill failed: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }, timeoutSeconds * 1000);
            }
            unbindAdmissionCancellation = this.bindOwnedTaskToAdmission(task, admission);
            await this.awaitTaskAdmissionBoundary(this.writeMetadata(task, admission.controller.signal), admission);
            this.assertTaskAdmissionOpen("a background task", admission);
            this.onChange();
            return task;
        }
        catch (error) {
            if (admission.controller.signal.aborted) {
                const admissionError = this.taskAdmissionError(admission);
                let cleanupError;
                if (task.child === undefined) {
                    try {
                        await this.discardUnspawnedTask(task, [
                            outputAbsPath,
                            metadataAbsPath,
                            ...(wrapperAbsPath === undefined ? [] : [wrapperAbsPath]),
                        ]);
                    }
                    catch (cleanupFailure) {
                        cleanupError = cleanupFailure;
                    }
                }
                else {
                    this.stopOwnedTaskAfterAdmissionCancellation(task, admissionError);
                }
                throw this.surfacedTaskAdmissionError(admission, error, cleanupError);
            }
            const message = error instanceof Error ? error.message : String(error);
            this.writeNotice(task, `\n[background task spawn exception: ${message}]\n`);
            await this.finalizeTask(task, "failed", null, undefined, message);
            throw new Error(`Failed to start background task: ${message}`);
        }
        finally {
            unbindAdmissionCancellation();
        }
    }
    resolveTask(idOrPrefix) {
        const id = idOrPrefix.trim();
        if (!id)
            throw new Error("Task ID is required");
        const exact = this.tasks.get(id);
        if (exact)
            return exact;
        const matches = [...this.tasks.values()].filter((task) => task.id.startsWith(id));
        const onlyMatch = matches[0];
        if (matches.length === 1 && onlyMatch)
            return onlyMatch;
        if (matches.length > 1)
            throw new Error(`Ambiguous task ID prefix "${id}": ${matches.map((task) => task.id).join(", ")}`);
        throw new Error(`Unknown background task ID: ${id}`);
    }
    async stopTask(task, kind, reason, initiator) {
        if (task.status !== "running") {
            throw new Error(`Task ${task.id} is ${task.status}, not running`);
        }
        // 停止分派按发起者记录,冲突优先级 user > model > system(参照 ZCode background.ts)
        this.recordStopInitiator(task, initiator);
        if (task.reloadExecution !== undefined) {
            try {
                return await task.reloadExecution.requestStop(kind, reason);
            }
            catch (error) {
                // M3 REVIEW force-exit:reload 幸存执行在 stopWait 超时/证明性失败时,
                // 同样先释放插件持有的输出读端(复用 destroyTaskStream),防孤儿保活宿主;
                // 原抛错语义保持不吞。
                await this.destroyTaskStream(task);
                throw error;
            }
        }
        const stopWaitMs = this.stopWaitMs;
        if (this.platform !== "win32" &&
            task.posixProcessGroupSignalAuthorityReleased === true &&
            this.posixProcessGroupKillStates.get(task) === undefined) {
            const finalized = await this.waitForEnd(task, stopWaitMs);
            if (!finalized) {
                // M3 force-exit:过程组信号权已释放但任务仍未终态化(典型场景:组已死、
                // 孙进程持有管道写端保活宿主),先销毁插件持有的输出读端,再报错。
                await this.destroyTaskStream(task);
                throw new Error(`Task ${task.id} did not finish terminalization within ${formatDuration(stopWaitMs)} after its process group signal authority was released`);
            }
            return task;
        }
        // REVIEW killKind 首停锁存:并发停止时终态与 initiator 优先级迁移表一致,
        // 后到停止不得覆盖先到停止的 killKind(与 requestKill 的 killSignalSent 守卫同一语义)
        if (!task.killSignalSent)
            task.killKind = kind;
        if (reason)
            task.error = reason;
        this.requestKill(task, "SIGTERM");
        let stopped;
        try {
            stopped =
                this.platform === "win32"
                    ? await this.waitForEndOrWindowsForceFailure(task, stopWaitMs)
                    : await this.waitForEndOrPosixForceFailure(task, stopWaitMs);
        }
        catch (error) {
            // M3 force-exit:证明性失败(reject 路径)同样先释放输出读端,防孤儿
            // 保活宿主,再保持原抛出语义。
            await this.destroyTaskStream(task);
            throw error;
        }
        const posixForceFailure = this.posixProcessGroupKillStates.get(task)?.failure;
        if (posixForceFailure !== undefined) {
            // M3 force-exit:防御性复查(waiter 未 reject 但失败已锁存),先释放再抛。
            await this.destroyTaskStream(task);
            throw posixForceFailure;
        }
        const windowsForceFailure = this.windowsKillStates.get(task)?.forceFailure;
        if (windowsForceFailure !== undefined) {
            // M3 force-exit:Windows taskkill 强制失败的同步路径,先释放输出读端再抛错。
            await this.destroyTaskStream(task);
            throw windowsForceFailure;
        }
        if (!stopped) {
            // M3 force-exit:STOP_WAIT_MS 超时仍未退出,释放插件持有的输出读端后报错。
            await this.destroyTaskStream(task);
            throw new Error(`Task ${task.id} did not exit within ${formatDuration(stopWaitMs)} after cancellation`);
        }
        return task;
    }
    /** 记录停止发起者:仅当新发起者优先级高于既有记录时覆盖(user > model > system)。 */
    recordStopInitiator(task, initiator) {
        if (initiator === undefined)
            return;
        if (stopInitiatorPriority(task.stopInitiator) <
            stopInitiatorPriority(initiator)) {
            task.stopInitiator = initiator;
            this.onChange();
        }
    }
    async stopAllRunning(kind, reason, initiator) {
        const running = this.allTasks().filter((task) => task.status === "running");
        const failures = [];
        let stopped = 0;
        await Promise.all(running.map(async (task) => {
            try {
                await this.stopTask(task, kind, reason, initiator);
                stopped++;
            }
            catch (error) {
                failures.push(`${taskDisplayName(task)} (${task.id}): ${error instanceof Error ? error.message : String(error)}`);
            }
        }));
        return { stopped, failures };
    }
    async getTaskLogs(task, maxBytes, tail) {
        if (!existsSync(task.outputAbsPath)) {
            throw new Error(`Output file does not exist for ${task.id}: ${task.outputPath}`);
        }
        const read = await boundedRead(task.outputAbsPath, maxBytes, tail);
        const direction = tail ? "tail" : "head";
        let text = read.content.length > 0 ? read.content : "(no output yet)";
        if (read.truncated) {
            const omitted = read.totalBytes - read.bytesRead;
            const notice = `\n\n[Showing ${direction} ${formatSize(read.bytesRead)} of ${formatSize(read.totalBytes)}; ${formatSize(omitted)} omitted. Full output: ${task.outputPath}]`;
            text = tail ? `${notice}\n\n${text}` : `${text}${notice}`;
        }
        else {
            text += `\n\n[Full output: ${task.outputPath}]`;
        }
        return {
            text,
            details: {
                task: snapshot(task),
                path: task.outputPath,
                bytesRead: read.bytesRead,
                totalBytes: read.totalBytes,
                truncated: read.truncated,
                tail,
            },
        };
    }
    async writeMetadata(task, signal) {
        await this.writeMetadataSnapshot(task, snapshot(task), signal);
    }
    async writeMetadataSnapshot(task, value, signal) {
        const write = async () => {
            await writeJsonAtomic(task.metadataAbsPath, value, signal);
        };
        const previous = task.metadataWriteChain ?? Promise.resolve();
        const next = previous.then(write, write);
        task.metadataWriteChain = next.catch(() => undefined);
        await next;
    }
    ingestTelemetry(task, text) {
        if (!text)
            return;
        const parsed = parseTelemetryStream(text, task.contextUsageBuffer ?? "");
        task.contextUsageBuffer = parsed.retained;
        this.commitTelemetry(task, parsed.latest);
    }
    /** Apply the latest parsed telemetry to a task, persisting metadata and notifying the UI only on change. */
    commitTelemetry(task, next) {
        const before = JSON.stringify({
            contextUsage: task.contextUsage,
            tokenUsage: task.tokenUsage,
            toolUsage: task.toolUsage,
            model: task.model,
        });
        if (next.context !== undefined)
            task.contextUsage = next.context;
        if (next.tokens !== undefined)
            task.tokenUsage = next.tokens;
        if (next.tools !== undefined)
            task.toolUsage = next.tools;
        if (next.model !== undefined)
            task.model = next.model;
        const after = JSON.stringify({
            contextUsage: task.contextUsage,
            tokenUsage: task.tokenUsage,
            toolUsage: task.toolUsage,
            model: task.model,
        });
        if (before !== after) {
            this.onChange();
            void this.writeMetadata(task).catch((error) => {
                this.logger.error(`[background-tasks] failed to write telemetry metadata for ${task.id}:`, error);
            });
        }
    }
    /** 全量持久化输出流的汇聚器。跨越软阈值时写入一次软告警(不杀任务、不改
     * 任务状态);达到硬阈值时终止任务。软/硬阈值写块逻辑收敛到共享的
     * writeTaskOutputChunk。 */
    writeToStream(task, buffer) {
        const capExceeded = writeTaskOutputChunk(task, buffer, {
            softBytes: this.softOutputBytes,
            hardBytes: this.maxOutputBytes,
            onSoftCapWarned: () => {
                this.onChange();
            },
        });
        if (!capExceeded)
            return;
        task.killKind = "output_cap";
        task.failedReason = "output_limit";
        try {
            this.requestKill(task, "SIGTERM");
        }
        catch (error) {
            task.error = `${task.error}; kill failed: ${errorMessageText(error)}`;
            void this.finalizeTask(task, "failed", null, undefined, task.error);
        }
    }
    /** Persist an internally generated notice (spawn/timeout/cap diagnostics) verbatim. */
    writeNotice(task, text) {
        if (!text)
            return;
        this.writeToStream(task, Buffer.from(text, "utf8"));
    }
    appendChildOutput(task, data, source) {
        if (!task.stream || task.stream.destroyed)
            return;
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
        if (buffer.length === 0)
            return;
        if (task.telemetryWrapped) {
            // Wrapped Pi agents stream control lines on stdout (telemetry + activity); child
            // stderr is raw diagnostics and is always passed through to the transcript verbatim.
            if (source === "stdout")
                this.processAgentStdout(task, buffer.toString("utf8"));
            else
                this.writeToStream(task, buffer);
            return;
        }
        this.ingestTelemetry(task, buffer.toString("utf8"));
        this.writeToStream(task, buffer);
    }
    /** Reconstruct wrapped-agent stdout into whole control lines, routing telemetry to metrics and activity to the transcript. */
    processAgentStdout(task, text) {
        const buffered = `${task.agentStdoutBuffer ?? ""}${text}`;
        const lastNewline = buffered.lastIndexOf("\n");
        task.agentStdoutBuffer =
            lastNewline >= 0 ? buffered.slice(lastNewline + 1) : buffered;
        if (lastNewline < 0)
            return;
        const latest = {};
        for (const line of buffered.slice(0, lastNewline).split("\n"))
            this.consumeAgentLine(task, line, latest);
        this.commitTelemetry(task, latest);
    }
    /** Flush a trailing partial wrapped-agent line on finalize so the last transcript fragment is never lost. */
    flushAgentStdout(task) {
        const remainder = task.agentStdoutBuffer;
        if (!remainder)
            return;
        task.agentStdoutBuffer = "";
        const latest = {};
        this.consumeAgentLine(task, remainder, latest);
        this.commitTelemetry(task, latest);
    }
    consumeAgentLine(task, rawLine, latest) {
        const line = rawLine.replace(/\r$/, "");
        const trimmed = line.trim();
        if (!trimmed)
            return;
        if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
            this.writeNotice(task, `${line}\n`);
            return;
        }
        let parsed;
        try {
            parsed = parseJsonText(trimmed);
        }
        catch {
            this.writeNotice(task, `${line}\n`);
            return;
        }
        if (!isJsonObject(parsed)) {
            this.writeNotice(task, `${line}\n`);
            return;
        }
        const record = parsed;
        const type = record.type;
        if (type === "background-task-context-usage") {
            const context = normalizeContextUsage(record);
            if (context)
                latest.context = context;
            return;
        }
        if (type === "background-task-telemetry") {
            const context = normalizeContextUsage(record.contextUsage);
            if (context)
                latest.context = context;
            const tokens = normalizeTokenUsage(record.tokenUsage);
            if (tokens)
                latest.tokens = tokens;
            const tools = normalizeToolUsage(record.toolUsage);
            if (tools)
                latest.tools = tools;
            const model = normalizeModel(record.model);
            if (model)
                latest.model = model;
            return;
        }
        const activity = parseAgentActivity(parsed);
        if (activity) {
            const formatted = formatAgentActivityLine(activity);
            if (formatted)
                this.writeNotice(task, `${formatted}\n`);
            return;
        }
        // Unknown JSON object: pass through to the transcript rather than silently dropping it.
        this.writeNotice(task, `${line}\n`);
    }
    beginPosixProcessGroupKill(task, armGrace) {
        const existing = this.posixProcessGroupKillStates.get(task);
        if (existing !== undefined)
            return existing;
        if (task.posixProcessGroupSignalAuthorityReleased === true) {
            throw new Error(`Task ${task.id} has released its POSIX process-group signal authority`);
        }
        const groupId = task.ownedPosixProcessGroupId;
        if (groupId === undefined) {
            throw new Error(`Task ${task.id} has no owned POSIX process group`);
        }
        let resolveCompletion = () => undefined;
        const completion = new Promise((resolve) => {
            resolveCompletion = resolve;
        });
        // Finish ownership slightly before stopTask's waiter so a force/proof
        // failure is observed as that specific loud error instead of a generic
        // cancellation timeout.
        const reserveMs = Math.min(25, Math.max(1, Math.floor(this.stopWaitMs / 4)));
        const ownershipMs = Math.max(1, this.stopWaitMs - reserveMs);
        const state = {
            groupId,
            completion,
            resolveCompletion,
            deadlineAt: Date.now() + ownershipMs,
            forceAttempted: false,
            settled: false,
        };
        this.posixProcessGroupKillStates.set(task, state);
        if (armGrace) {
            // Publish the sole force owner before TERM. An injected signal can emit
            // close reentrantly; that close must see and await this exact state.
            task.killEscalationTimer = setTimeout(() => {
                task.killEscalationTimer = undefined;
                this.forceOwnedPosixProcessGroup(task, state);
            }, Math.min(this.killGraceMs, ownershipMs));
            // Unlike ordinary housekeeping timers, this owner stays referenced: a
            // departed leader must not let the host exit and strand its owned group.
            // M3:同在 grace 窗口内(生产为 TERM 后 1500ms)安排一次 ps 后代收集,
            // 供 force 阶段对逃逸出组的孙进程逐个补杀;失败退化到组信号路径。
            this.schedulePosixDescendantCollection(state, ownershipMs);
        }
        return state;
    }
    finishPosixProcessGroupKill(task, state, releaseOwnership) {
        if (state.settled)
            return;
        state.settled = true;
        this.clearKillEscalationTimer(task);
        this.clearPosixDescendantCollectTimer(state);
        if (state.verificationTimer !== undefined) {
            clearTimeout(state.verificationTimer);
            state.verificationTimer = undefined;
        }
        task.posixProcessGroupSignalAuthorityReleased = true;
        if (releaseOwnership && task.ownedPosixProcessGroupId === state.groupId) {
            delete task.ownedPosixProcessGroupId;
        }
        state.resolveCompletion();
        const failure = state.failure;
        const listeners = state.failureListeners;
        if (listeners !== undefined) {
            delete state.failureListeners;
            if (failure !== undefined) {
                for (const listener of listeners)
                    listener(failure);
            }
        }
    }
    observeOwnedPosixProcessGroupGone(task, state) {
        if (state.settled)
            return state.failure === undefined;
        try {
            const exists = this.killProcess(-state.groupId, 0);
            state.lastProbeError = exists
                ? undefined
                : new Error(`process-group probe for ${String(state.groupId)} returned false`);
            return false;
        }
        catch (error) {
            if (typeof error === "object" &&
                error !== null &&
                Reflect.get(error, "code") === "ESRCH") {
                this.finishPosixProcessGroupKill(task, state, true);
                return true;
            }
            state.lastProbeError =
                error instanceof Error
                    ? error
                    : new Error(BackgroundTaskRegistry.errorMessage(error));
            return false;
        }
    }
    recordPosixProcessGroupForceFailure(task, state, error) {
        if (state.settled)
            return;
        state.failure = error;
        this.finishPosixProcessGroupKill(task, state, false);
        task.error = BackgroundTaskRegistry.appendTaskError(task.error, error.message);
        this.writeNotice(task, `\n[background task POSIX termination: ${error.message}]\n`);
        this.onChange();
        void this.writeMetadata(task).catch((metadataError) => {
            this.logger.error(`[background-tasks] failed to write POSIX process-group failure metadata for ${task.id}:`, metadataError);
        });
    }
    schedulePosixProcessGroupVerification(task, state) {
        if (state.settled)
            return;
        const remainingMs = state.deadlineAt - Date.now();
        if (remainingMs <= 0) {
            const probeDetail = state.lastProbeError === undefined
                ? ""
                : `; last group probe failed: ${state.lastProbeError.message}`;
            this.recordPosixProcessGroupForceFailure(task, state, new Error(`POSIX process group ${String(state.groupId)} remained present after SIGKILL${probeDetail}. Descendant processes may have leaked.`));
            return;
        }
        state.verificationTimer = setTimeout(() => {
            state.verificationTimer = undefined;
            if (this.observeOwnedPosixProcessGroupGone(task, state))
                return;
            this.schedulePosixProcessGroupVerification(task, state);
        }, Math.min(10, remainingMs));
    }
    forceOwnedPosixProcessGroup(task, state) {
        if (state.settled || state.forceAttempted)
            return;
        // Latch before either probe or signal: both are injected boundaries that can
        // reentrantly emit root close, and no continuation may launch a second KILL.
        state.forceAttempted = true;
        this.clearKillEscalationTimer(task);
        this.clearPosixDescendantCollectTimer(state);
        if (this.observeOwnedPosixProcessGroupGone(task, state))
            return;
        let groupFailure;
        try {
            const forced = this.killProcess(-state.groupId, "SIGKILL");
            if (!forced) {
                groupFailure = new Error(`POSIX process-group SIGKILL returned false for task ${task.id} group ${String(state.groupId)}. Descendant processes may have leaked.`);
            }
        }
        catch (error) {
            if (BackgroundTaskRegistry.isEsrchError(error)) {
                this.finishPosixProcessGroupKill(task, state, true);
                return;
            }
            groupFailure = new Error(`POSIX process-group SIGKILL failed for task ${task.id} group ${String(state.groupId)}: ${BackgroundTaskRegistry.errorMessage(error)}. Descendant processes may have leaked.`);
        }
        // M3:组信号后对窗口内收集到的后代逐个补杀。组内未退者已被组 SIGKILL 覆盖,
        // 逐个补杀专为 setsid / 双 fork 逃逸出组的孙进程收网;与 ZCode 参照一致地
        // 吞掉 ESRCH(自然死亡或被组信号回收),非 ESRCH 失败仅记 notice 并追加到
        // task.error,不替代组存在的证明性结论(组证明仍是权威终止证明)。
        const descendantFailures = this.forceKillCollectedPosixDescendants(state);
        if (descendantFailures.length > 0) {
            const message = `POSIX descendant SIGKILL failed for task ${task.id} group ${String(state.groupId)}: ` +
                `${descendantFailures.join("; ")}. Descendant processes may have leaked.`;
            task.error = BackgroundTaskRegistry.appendTaskError(task.error, message);
            this.writeNotice(task, `\n[background task POSIX termination: ${message}]\n`);
            this.onChange();
            void this.writeMetadata(task).catch((metadataError) => {
                this.logger.error(`[background-tasks] failed to write POSIX descendant-kill failure metadata for ${task.id}:`, metadataError);
            });
        }
        if (groupFailure !== undefined) {
            this.recordPosixProcessGroupForceFailure(task, state, groupFailure);
            return;
        }
        if (this.observeOwnedPosixProcessGroupGone(task, state))
            return;
        this.schedulePosixProcessGroupVerification(task, state);
    }
    /** M3:在 grace 窗口内(生产为 TERM 后 1500ms)安排一次 ps 后代收集。 */
    schedulePosixDescendantCollection(state, ownershipMs) {
        if (state.settled || state.forceAttempted)
            return;
        const delayMs = Math.min(POSIX_DESCENDANT_COLLECT_DELAY_MS, Math.floor(this.killGraceMs / 2), ownershipMs);
        state.descendantCollectTimer = setTimeout(() => {
            state.descendantCollectTimer = undefined;
            if (state.settled || state.forceAttempted)
                return;
            void this.collectPosixDescendantPids(state.groupId)
                .then((pids) => {
                if (state.settled || state.forceAttempted)
                    return;
                state.descendantPids = pids;
            })
                .catch(() => {
                // 收集失败不改变终止流程,退化到组信号路径。
            });
        }, delayMs).unref();
    }
    clearPosixDescendantCollectTimer(state) {
        if (state.descendantCollectTimer !== undefined) {
            clearTimeout(state.descendantCollectTimer);
            state.descendantCollectTimer = undefined;
        }
    }
    /**
     * 对收集到的后代逐个 SIGKILL;返回非 ESRCH 失败明细。
     * ESRCH(后代已自然退出或被同组信号回收)属正常路径,不加失败。
     */
    forceKillCollectedPosixDescendants(state) {
        const descendants = state.descendantPids;
        if (descendants === undefined || descendants.size === 0)
            return [];
        const failures = [];
        for (const pid of descendants) {
            try {
                const forced = this.killProcess(pid, "SIGKILL");
                if (!forced) {
                    failures.push(`pid ${String(pid)} SIGKILL returned false`);
                }
            }
            catch (error) {
                if (BackgroundTaskRegistry.isEsrchError(error))
                    continue;
                failures.push(`pid ${String(pid)} ${BackgroundTaskRegistry.errorMessage(error)}`);
            }
        }
        return failures;
    }
    requestPosixKill(task, signal) {
        const state = this.beginPosixProcessGroupKill(task, signal !== "SIGKILL");
        if (signal === "SIGKILL") {
            task.killSignalSent = true;
            this.forceOwnedPosixProcessGroup(task, state);
            return;
        }
        if (task.killSignalSent)
            return;
        // Publish de-duplication before the signal boundary for the same reason the
        // state/timer is published above: close may be emitted synchronously.
        task.killSignalSent = true;
        const errors = [];
        let killed = false;
        try {
            killed = this.killProcess(-state.groupId, signal);
            if (!killed)
                errors.push(`process group ${signal} returned false`);
        }
        catch (error) {
            if (typeof error === "object" &&
                error !== null &&
                Reflect.get(error, "code") === "ESRCH") {
                this.finishPosixProcessGroupKill(task, state, true);
            }
            else {
                errors.push(`process group kill failed: ${BackgroundTaskRegistry.errorMessage(error)}`);
            }
        }
        if (!killed) {
            try {
                killed = task.child?.kill(signal) === true;
                if (!killed)
                    errors.push(`child ${signal} returned false`);
            }
            catch (error) {
                errors.push(`child kill failed: ${BackgroundTaskRegistry.errorMessage(error)}`);
            }
        }
        if (!killed) {
            // If TERM reached neither target, waiting out grace has no benefit. Keep
            // the same owner but attempt its one force phase immediately.
            if (!state.settled)
                this.forceOwnedPosixProcessGroup(task, state);
            throw new Error(`Could not kill task ${task.id}: ${errors.join("; ")}`);
        }
    }
    async awaitPosixProcessGroupBeforeTerminal(task) {
        if (this.platform === "win32")
            return undefined;
        const state = this.posixProcessGroupKillStates.get(task);
        if (state === undefined) {
            // No tree stop won the race before direct-child finalization. Release
            // signal authority synchronously so a concurrent late stop waits for this
            // terminalization instead of targeting a potentially reused group id.
            task.posixProcessGroupSignalAuthorityReleased = true;
            delete task.ownedPosixProcessGroupId;
            return undefined;
        }
        this.observeOwnedPosixProcessGroupGone(task, state);
        await state.completion;
        return state.failure;
    }
    waitForEndOrPosixForceFailure(task, timeoutMs) {
        const state = this.posixProcessGroupKillStates.get(task);
        if (state === undefined)
            return this.waitForEnd(task, timeoutMs);
        return this.waitForEndOrForceFailure(task, timeoutMs, {
            readFailure: () => state.failure,
            addFailureListener: (listener) => {
                if (state.failureListeners === undefined)
                    state.failureListeners = [];
                state.failureListeners.push(listener);
            },
            removeFailureListener: (listener) => {
                const listeners = state.failureListeners;
                if (listeners === undefined)
                    return;
                const listenerIndex = listeners.indexOf(listener);
                if (listenerIndex >= 0)
                    listeners.splice(listenerIndex, 1);
                if (listeners.length === 0)
                    delete state.failureListeners;
            },
        });
    }
    getWindowsKillState(task) {
        let state = this.windowsKillStates.get(task);
        if (state === undefined) {
            state = {};
            this.windowsKillStates.set(task, state);
        }
        return state;
    }
    static errorMessage(error) {
        return errorMessageText(error);
    }
    /** 判定错误是否进程不存在(errno ESRCH),用于 sig-0 证明与逐后代补杀的吞错边界。 */
    static isEsrchError(error) {
        return (typeof error === "object" &&
            error !== null &&
            Reflect.get(error, "code") === "ESRCH");
    }
    static appendTaskError(existing, next) {
        return appendErrorText(existing, next);
    }
    static describeTaskkillOutcome(outcome) {
        const exitCode = outcome.exitCode === null ? "null" : String(outcome.exitCode);
        const signal = outcome.signal === null ? "null" : outcome.signal;
        const stdout = outcome.stdout.length > 0
            ? ` stdout=${JSON.stringify(outcome.stdout)}`
            : "";
        const stderr = outcome.stderr.length > 0
            ? ` stderr=${JSON.stringify(outcome.stderr)}`
            : "";
        const stdoutTruncated = outcome.stdoutTruncated
            ? " stdout_truncated=true"
            : "";
        const stderrTruncated = outcome.stderrTruncated
            ? " stderr_truncated=true"
            : "";
        return `exit=${exitCode} signal=${signal}${stdout}${stderr}${stdoutTruncated}${stderrTruncated}`;
    }
    isWindowsTaskkillTerminalRace(task) {
        return task.status !== "running" || task.finalized === true;
    }
    clearKillEscalationTimer(task) {
        if (task.killEscalationTimer !== undefined) {
            clearTimeout(task.killEscalationTimer);
            task.killEscalationTimer = undefined;
        }
    }
    recordWindowsTaskkillNotice(task, message) {
        this.writeNotice(task, `\n[background task Windows termination: ${message}]\n`);
    }
    recordWindowsSoftFailure(task, pid, detail) {
        const message = `Windows taskkill /T logical termination request failed for task ${task.id} pid ${String(pid)}: ` +
            `${detail}; force escalation remains scheduled`;
        task.error = BackgroundTaskRegistry.appendTaskError(task.error, message);
        this.recordWindowsTaskkillNotice(task, message);
        this.onChange();
        void this.writeMetadata(task).catch((metadataError) => {
            this.logger.error(`[background-tasks] failed to write Windows taskkill soft-failure metadata for ${task.id}:`, metadataError);
        });
    }
    makeWindowsForceFailure(task, pid, detail) {
        return new Error(`Windows taskkill /T /F force termination failed for task ${task.id} pid ${String(pid)}: ${detail}. Descendant processes may have leaked.`);
    }
    recordWindowsForceFailure(task, error) {
        const state = this.getWindowsKillState(task);
        state.forceFailure = error;
        task.error = BackgroundTaskRegistry.appendTaskError(task.error, error.message);
        this.recordWindowsTaskkillNotice(task, error.message);
        this.onChange();
        void this.writeMetadata(task).catch((metadataError) => {
            this.logger.error(`[background-tasks] failed to write Windows taskkill force-failure metadata for ${task.id}:`, metadataError);
        });
        const listeners = state.forceFailureListeners;
        if (listeners !== undefined) {
            delete state.forceFailureListeners;
            for (const listener of listeners)
                listener(error);
        }
    }
    evaluateWindowsTaskkillOutcome(task, pid, phase, outcome) {
        if (outcome.exitCode === 0)
            return undefined;
        const detail = BackgroundTaskRegistry.describeTaskkillOutcome(outcome);
        if (outcome.exitCode === 128) {
            this.recordWindowsTaskkillNotice(task, `taskkill ${phase} reported process not found for pid ${String(pid)} (${detail}); treating as an already-exited race`);
            return undefined;
        }
        if (this.isWindowsTaskkillTerminalRace(task)) {
            this.recordWindowsTaskkillNotice(task, `taskkill ${phase} finished after the task became terminal for pid ${String(pid)} (${detail}); treating as a terminal race`);
            return undefined;
        }
        if (phase === "terminate") {
            this.recordWindowsSoftFailure(task, pid, detail);
            return undefined;
        }
        return this.makeWindowsForceFailure(task, pid, detail);
    }
    handleWindowsSoftException(task, pid, error, state) {
        const message = BackgroundTaskRegistry.errorMessage(error);
        if (state.forcePromise !== undefined ||
            this.isWindowsTaskkillTerminalRace(task))
            return;
        this.recordWindowsSoftFailure(task, pid, message);
    }
    startWindowsSoftKill(task, pid) {
        const state = this.getWindowsKillState(task);
        if (state.softPromise !== undefined)
            return state.softPromise;
        const controller = new AbortController();
        state.softController = controller;
        let launched;
        try {
            launched = this.killTree(pid, "terminate", controller.signal);
        }
        catch (error) {
            delete state.softController;
            throw new Error(`Could not kill task ${task.id}: Windows taskkill /T failed to start: ${BackgroundTaskRegistry.errorMessage(error)}`);
        }
        const promise = launched
            .then((outcome) => {
            if (state.forcePromise !== undefined ||
                this.isWindowsTaskkillTerminalRace(task))
                return;
            const failure = this.evaluateWindowsTaskkillOutcome(task, pid, "terminate", outcome);
            if (failure !== undefined)
                throw failure;
        })
            .catch((error) => {
            this.handleWindowsSoftException(task, pid, error, state);
        })
            .finally(() => {
            if (state.softController === controller)
                delete state.softController;
        });
        state.softPromise = promise;
        return promise;
    }
    startWindowsForceKill(task, pid) {
        const state = this.getWindowsKillState(task);
        if (state.forcePromise !== undefined)
            return state.forcePromise;
        let resolveForce;
        let rejectForce;
        const forcePromise = new Promise((resolve, reject) => {
            resolveForce = resolve;
            rejectForce = reject;
        });
        if (resolveForce === undefined || rejectForce === undefined) {
            throw new Error("Windows force termination promise could not be initialized");
        }
        const resolveForceReady = resolveForce;
        const rejectForceReady = rejectForce;
        state.forcePromise = forcePromise;
        void forcePromise.catch((error) => {
            this.logger.error(`[background-tasks] Windows force tree termination failed for ${task.id}:`, error);
        });
        this.clearKillEscalationTimer(task);
        if (state.softController !== undefined &&
            !state.softController.signal.aborted) {
            state.softController.abort();
        }
        let launched;
        try {
            launched = this.killTree(pid, "force");
        }
        catch (error) {
            const failure = this.makeWindowsForceFailure(task, pid, `helper failed to start: ${BackgroundTaskRegistry.errorMessage(error)}`);
            delete state.forcePromise;
            this.recordWindowsForceFailure(task, failure);
            rejectForceReady(failure);
            throw failure;
        }
        launched.then((outcome) => {
            const failure = this.evaluateWindowsTaskkillOutcome(task, pid, "force", outcome);
            if (failure !== undefined) {
                this.recordWindowsForceFailure(task, failure);
                rejectForceReady(failure);
                return;
            }
            resolveForceReady();
        }, (error) => {
            if (this.isWindowsTaskkillTerminalRace(task)) {
                this.recordWindowsTaskkillNotice(task, `taskkill force rejected after the task became terminal for pid ${String(pid)} (${BackgroundTaskRegistry.errorMessage(error)}); treating as a terminal race`);
                resolveForceReady();
                return;
            }
            const failure = this.makeWindowsForceFailure(task, pid, BackgroundTaskRegistry.errorMessage(error));
            this.recordWindowsForceFailure(task, failure);
            rejectForceReady(failure);
        });
        return forcePromise;
    }
    requestWindowsKill(task, pid, signal) {
        if (signal === "SIGKILL") {
            this.startWindowsForceKill(task, pid);
            task.killSignalSent = true;
            return;
        }
        this.startWindowsSoftKill(task, pid);
        task.killSignalSent = true;
        if (task.killEscalationTimer !== undefined)
            return;
        task.killEscalationTimer = setTimeout(() => {
            task.killEscalationTimer = undefined;
            if (task.status !== "running")
                return;
            try {
                this.requestKill(task, "SIGKILL");
            }
            catch (error) {
                task.error = BackgroundTaskRegistry.appendTaskError(task.error, `SIGKILL failed: ${error instanceof Error ? error.message : String(error)}`);
                void this.writeMetadata(task).catch((metadataError) => {
                    this.logger.error(`[background-tasks] failed to write metadata for ${task.id}:`, metadataError);
                });
            }
        }, this.killGraceMs).unref();
    }
    requestKill(task, signal = "SIGTERM") {
        if (task.status !== "running") {
            throw new Error(`Task ${task.id} is ${task.status}, not running`);
        }
        if (!task.child) {
            throw new Error(`Task ${task.id} has no child process handle`);
        }
        if (task.killSignalSent && signal === "SIGTERM")
            return;
        if (this.platform === "win32") {
            if (!task.pid)
                throw new Error(`Task ${task.id} has no process id`);
            this.requestWindowsKill(task, task.pid, signal);
            return;
        }
        this.requestPosixKill(task, signal);
    }
    waitForEnd(task, timeoutMs) {
        if (task.status !== "running")
            return Promise.resolve(true);
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                const idx = task.waiters.indexOf(done);
                if (idx >= 0)
                    task.waiters.splice(idx, 1);
                resolve(false);
            }, timeoutMs);
            const done = () => {
                clearTimeout(timeout);
                resolve(true);
            };
            task.waiters.push(done);
        });
    }
    waitForEndOrWindowsForceFailure(task, timeoutMs) {
        const state = this.getWindowsKillState(task);
        return this.waitForEndOrForceFailure(task, timeoutMs, {
            readFailure: () => state.forceFailure,
            addFailureListener: (listener) => {
                if (state.forceFailureListeners === undefined)
                    state.forceFailureListeners = [];
                state.forceFailureListeners.push(listener);
            },
            removeFailureListener: (listener) => {
                const listeners = state.forceFailureListeners;
                if (listeners !== undefined) {
                    const listenerIndex = listeners.indexOf(listener);
                    if (listenerIndex >= 0)
                        listeners.splice(listenerIndex, 1);
                    if (listeners.length === 0)
                        delete state.forceFailureListeners;
                }
            },
        });
    }
    /** M3 REVIEW:等待任务终态或 force 阶段证明性失败(成对完全重复的两个 waiter 收敛的
     * 共享助手;failureSource 提供失败的当前值与失败监听器的订阅/退订)。 */
    waitForEndOrForceFailure(task, timeoutMs, failureSource) {
        const failure = failureSource.readFailure();
        if (failure !== undefined)
            return Promise.reject(failure);
        if (task.status !== "running")
            return Promise.resolve(true);
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timeout);
                const waiterIndex = task.waiters.indexOf(done);
                if (waiterIndex >= 0)
                    task.waiters.splice(waiterIndex, 1);
                failureSource.removeFailureListener(failed);
            };
            const timeout = setTimeout(() => {
                cleanup();
                resolve(false);
            }, timeoutMs);
            const done = () => {
                cleanup();
                resolve(true);
            };
            const failed = (error) => {
                cleanup();
                reject(error);
            };
            task.waiters.push(done);
            failureSource.addFailureListener(failed);
        });
    }
    async awaitWindowsForceBeforeTerminal(task) {
        const state = this.windowsKillStates.get(task);
        if (state === undefined)
            return undefined;
        const forcePromise = state.forcePromise;
        if (forcePromise === undefined)
            return state.forceFailure;
        try {
            await forcePromise;
        }
        catch (error) {
            return error instanceof Error ? error : new Error(String(error));
        }
        return state.forceFailure;
    }
    async deliverReloadTerminal(execution, lease) {
        const task = execution.task;
        if (task.reloadHostDeliveryInFlight || task.reloadHostDeliverySettled) {
            this.maybeReleaseReloadExecution(task);
            return;
        }
        task.reloadHostDeliveryInFlight = true;
        try {
            if (!this.ownsReloadExecution(execution, lease))
                return;
            // M5:完成摘要 — reload 幸存任务输出文件跨 reload 保留,缺省时取有界 tail
            if (task.terminalSummaryTail === undefined) {
                task.terminalSummaryTail = await readTerminalSummaryTail(task.outputAbsPath);
            }
            // reload 路径的迟到结算 fence:旧代次帧标陈旧(不触发唤醒),waiter 双通道结算
            this.applyBranchGenerationFence(task);
            this.settleTaskWaiters(task);
            this.onChange();
            this.publishTerminal(task);
            const deliveryGate = await this.waitForTerminalPublicationGate(task);
            if (!this.ownsReloadExecution(execution, lease))
                return;
            if (deliveryGate.kind === "rejected") {
                this.logger.error(`[background-tasks] completion delivery gate failed for ${task.id}: ${this.terminalPublicationError(deliveryGate.error)}`);
            }
            else if (task.notifyOnCompletion &&
                !task.notified &&
                !this.shuttingDown &&
                execution.notificationState === "pending") {
                const token = execution.beginNotification(lease);
                if (token !== undefined) {
                    try {
                        // S1:notifyCompletion 入队后同步置 notified,finishNotification
                        // (token, true) 于入队后同步执行、恒先行于排水层的实际投递;批排水
                        // 失败仅回滚 notified、不触发重投(notificationState 已置 delivered)
                        // ——与现状丢一次语义等价。
                        this.notifyCompletion(task);
                        execution.finishNotification(token, task.notified);
                    }
                    catch (error) {
                        // S1:notifyCompletion 改为仅入队、不再同步发送,不再抛错;本 catch
                        // 成为防御性保留(未来行为回归亦不吞错),不移除。
                        execution.finishNotification(token, false);
                        this.logger.error(`[background-tasks] notification failed for ${task.id}:`, error);
                    }
                }
            }
            if (!this.ownsReloadExecution(execution, lease))
                return;
            task.reloadHostNotificationSettled = true;
            task.reloadHostDeliverySettled = true;
            try {
                // S1:先等本批排水结算再落盘 notified(与 finalizeTask 同策略)
                await this.awaitPendingNotificationDrain();
                await this.writeMetadata(task);
            }
            catch (error) {
                this.logger.error(`[background-tasks] failed to update survivor notification metadata for ${task.id}:`, error);
            }
        }
        finally {
            task.reloadHostDeliveryInFlight = false;
            this.maybeReleaseReloadExecution(task);
        }
    }
    maybeReleaseReloadExecution(task) {
        const execution = task.reloadExecution;
        const lease = this.reloadShellLease;
        if (execution === undefined ||
            execution.phase !== "terminal" ||
            task.reloadHostNotificationSettled !== true ||
            task.terminalPublicationState === "pending" ||
            !this.ownsReloadExecution(execution, lease) ||
            this.reloadShellOwner === undefined ||
            lease === undefined) {
            return;
        }
        try {
            this.reloadShellOwner.releaseExecution(lease, execution);
        }
        catch (error) {
            if (typeof error !== "object" ||
                error === null ||
                Reflect.get(error, "code") !== "pi_bg_reload_owner_stale_claim") {
                this.logger.error(`[background-tasks] failed to release reload shell execution ${task.id}:`, error);
            }
        }
    }
    terminalPublicationAbandonSignal(task) {
        const existing = this.terminalPublicationAbandonSignals.get(task);
        if (existing !== undefined)
            return existing;
        let resolveSignal = () => { };
        const promise = new Promise((resolve) => {
            resolveSignal = resolve;
        });
        const signal = { promise, resolve: resolveSignal };
        this.terminalPublicationAbandonSignals.set(task, signal);
        return signal;
    }
    publishTerminal(task) {
        if (task.reloadExecution !== undefined && this.tasks.get(task.id) !== task)
            return;
        if (task.terminalPublicationState !== "pending" ||
            task.terminalPublishInFlight)
            return;
        if (this.terminalPublicationClosed) {
            this.abandonTerminalPublication(task, this.terminalPublicationCloseReason ?? "registry_shutdown");
            return;
        }
        task.terminalPublishInFlight = true;
        if (task.terminalPublicationGate === undefined) {
            this.tryPublishTerminalNow(task);
            return;
        }
        void this.publishTerminalWhenReady(task);
    }
    async publishTerminalWhenReady(task) {
        const outcome = await this.waitForTerminalPublicationGate(task);
        if (task.reloadExecution !== undefined &&
            this.tasks.get(task.id) !== task) {
            task.terminalPublishInFlight = false;
            return;
        }
        if (outcome.kind === "closed") {
            this.abandonTerminalPublication(task, outcome.reason);
            return;
        }
        if (outcome.kind === "rejected") {
            this.abandonTerminalPublication(task, "gate_rejected", outcome.error);
            return;
        }
        // The gate and registry closure can settle in the same microtask turn.
        // Re-check after the await so a late gate cannot publish into a disposed
        // activation or revive a task already abandoned by shutdown.
        if (this.terminalPublicationClosed ||
            task.terminalPublicationState !== "pending") {
            this.abandonTerminalPublication(task, this.terminalPublicationCloseReason ?? "registry_shutdown");
            return;
        }
        this.tryPublishTerminalNow(task);
    }
    async waitForTerminalPublicationGate(task) {
        if (this.terminalPublicationClosed) {
            return {
                kind: "closed",
                reason: this.terminalPublicationCloseReason ?? "registry_shutdown",
            };
        }
        if (task.terminalPublicationState === "abandoned") {
            if (task.terminalPublicationAbandonReason === "gate_rejected") {
                return {
                    kind: "rejected",
                    error: new Error("terminal publication gate rejected"),
                };
            }
            return {
                kind: "closed",
                reason: task.terminalPublicationAbandonReason ?? "registry_shutdown",
            };
        }
        const gate = task.terminalPublicationGate;
        if (gate === undefined)
            return { kind: "released" };
        const gateOutcome = gate.then(() => ({ kind: "released" }), (error) => ({ kind: "rejected", error }));
        const closureOutcome = this.terminalPublicationClosedSignal.then((reason) => ({
            kind: "closed",
            reason,
        }));
        const abandonmentOutcome = this.terminalPublicationAbandonSignal(task).promise.then((reason) => ({
            kind: "closed",
            reason,
        }));
        const outcome = await Promise.race([
            gateOutcome,
            closureOutcome,
            abandonmentOutcome,
        ]);
        // Closure wins if it happened before this continuation resumed, regardless
        // of which promise queued its reaction first.
        if (this.terminalPublicationClosed) {
            return {
                kind: "closed",
                reason: this.terminalPublicationCloseReason ?? "registry_shutdown",
            };
        }
        return outcome;
    }
    tryPublishTerminalNow(task) {
        if (task.reloadExecution !== undefined &&
            this.tasks.get(task.id) !== task) {
            task.terminalPublishInFlight = false;
            return;
        }
        if (task.terminalPublicationState !== "pending") {
            task.terminalPublishInFlight = false;
            return;
        }
        if (this.terminalPublicationClosed) {
            task.terminalPublishInFlight = false;
            this.abandonTerminalPublication(task, this.terminalPublicationCloseReason ?? "registry_shutdown");
            this.pruneOldTasks();
            return;
        }
        task.terminalPublishAttempts += 1;
        task.terminalEmitInFlight = true;
        let emitFailed = false;
        let emitError;
        try {
            this.publishTerminalPublication({
                task: snapshot(task),
                summaryTail: task.terminalSummaryTail,
            });
        }
        catch (error) {
            emitFailed = true;
            emitError = error;
        }
        task.terminalEmitInFlight = false;
        task.terminalPublishInFlight = false;
        if (emitFailed) {
            const execution = task.reloadExecution;
            if (execution !== undefined &&
                !this.ownsReloadExecution(execution, this.reloadShellLease)) {
                // The emitter synchronously detached this task into a reload handoff
                // before throwing. Attempt 1 is consumed, but only the fresh owner may
                // retry or decide abandonment on the shared publication ledger.
                return;
            }
            this.handleTerminalPublishFailure(task, emitError);
        }
        else {
            this.markTerminalPublicationDelivered(task);
        }
        this.pruneOldTasks();
    }
    markTerminalPublicationDelivered(task) {
        if (task.terminalPublishRetryHandle !== undefined) {
            clearTimeout(task.terminalPublishRetryHandle);
            task.terminalPublishRetryHandle = undefined;
        }
        task.terminalPublicationGate = undefined;
        task.terminalEmitInFlight = false;
        task.terminalPublishInFlight = false;
        task.terminalPublicationState = "delivered";
        delete task.terminalPublicationAbandonReason;
        task.terminalPublished = true;
        this.maybeReleaseReloadExecution(task);
    }
    abandonTerminalPublication(task, reason, error, log = true) {
        if (task.terminalPublishRetryHandle !== undefined) {
            clearTimeout(task.terminalPublishRetryHandle);
            task.terminalPublishRetryHandle = undefined;
        }
        task.terminalPublicationGate = undefined;
        if (task.terminalEmitInFlight !== true)
            task.terminalPublishInFlight = false;
        if (task.terminalPublicationState === "delivered")
            return;
        if (task.terminalPublicationState === "abandoned")
            return;
        task.terminalPublicationState = "abandoned";
        task.terminalPublicationAbandonReason = reason;
        task.terminalPublished = false;
        this.terminalPublicationAbandonSignal(task).resolve(reason);
        if (log) {
            const detail = error === undefined ? "" : `: ${this.terminalPublicationError(error)}`;
            this.logger.error(`[background-tasks] terminal publication abandoned for ${task.id} (${reason}) after ${String(task.terminalPublishAttempts)}/${String(TERMINAL_PUBLICATION_MAX_ATTEMPTS)} emit attempts${detail}`);
        }
        this.maybeReleaseReloadExecution(task);
    }
    terminalPublicationError(error) {
        return boundedErrorMessage(error, TERMINAL_PUBLICATION_DIAGNOSTIC_CHARS);
    }
    handleTerminalPublishFailure(task, error) {
        task.terminalPublishInFlight = false;
        if (task.terminalPublicationState !== "pending")
            return;
        if (error instanceof BackgroundTaskExtensionServiceClosedError) {
            this.closeTerminalPublication("publisher_closed");
            return;
        }
        if (this.terminalPublicationClosed) {
            this.abandonTerminalPublication(task, this.terminalPublicationCloseReason ?? "registry_shutdown", error);
            this.pruneOldTasks();
            return;
        }
        if (task.terminalPublishAttempts >= TERMINAL_PUBLICATION_MAX_ATTEMPTS) {
            this.abandonTerminalPublication(task, "retry_exhausted", error);
            this.pruneOldTasks();
            return;
        }
        this.logger.error(`[background-tasks] terminal publication failed for ${task.id} (attempt ${String(task.terminalPublishAttempts)}/${String(TERMINAL_PUBLICATION_MAX_ATTEMPTS)}; retrying): ${this.terminalPublicationError(error)}`);
        if (task.terminalPublishRetryHandle !== undefined)
            return;
        task.terminalPublishRetryHandle = setTimeout(() => {
            task.terminalPublishRetryHandle = undefined;
            if (this.terminalPublicationClosed ||
                task.terminalPublicationState !== "pending" ||
                (task.reloadExecution !== undefined && this.tasks.get(task.id) !== task))
                return;
            this.publishTerminal(task);
        }, TERMINAL_PUBLICATION_RETRY_MS);
        task.terminalPublishRetryHandle.unref();
    }
    /**
     * S1:终态任务入批队列,不再同步发送;微任务排水合成一条消息统一投递
     * (deliverAs:'steer' 由宿主按 streaming/triggerTurn 分流)。guard 检查点
     * 保持在入队时;微任务窗口内 shuttingDown 翻转不复查(与现状「调用时检查」
     * 的微小时序差异,接受)。
     */
    notifyCompletion(task) {
        if (!task.notifyOnCompletion || task.notified || this.shuttingDown)
            return;
        // 置位时机不变:入队即锁存 notified,重复终态调用直接短路返回
        task.notified = true;
        // 首个入队(队列为空)即调度排水;队列非空说明本排水段已调度同一次排水。
        // 排水开始即同步取空队列,因此「队列为空」与「无已调度排水」等价。
        const firstOfBatch = this.pendingNotificationTasks.length === 0;
        this.pendingNotificationTasks.push(task);
        if (firstOfBatch) {
            let settleDrain = () => undefined;
            this.pendingNotificationDrain = new Promise((resolve) => {
                settleDrain = resolve;
            });
            const drain = () => {
                try {
                    this.drainNotifications();
                }
                finally {
                    this.pendingNotificationDrain = undefined;
                    settleDrain();
                }
            };
            this.scheduleDrain(drain);
        }
    }
    /**
     * S1:等待当前批排水结算(投递成功置位 / 失败回滚均已落到内存 `notified`),
     * 供 finalize/reload 结单路径在落盘前调用。无在途批时立即返回。
     */
    async awaitPendingNotificationDrain() {
        await this.pendingNotificationDrain;
    }
    /** S1 批排水:取走队列全部任务,合成一条通知发送(单条完整块以 `\n\n` 拼接)。 */
    drainNotifications() {
        const tasks = this.pendingNotificationTasks;
        this.pendingNotificationTasks = [];
        if (tasks.length === 0)
            return;
        const first = tasks[0];
        if (first === undefined)
            return; // 队列长度已校验非空,此处仅类型收窄
        try {
            const content = tasks
                .map((batchTask) => buildTaskNotificationContent(batchTask))
                .join("\n\n");
            // 批语义:批内任一任务为 triggerOnCompletion 且非陈旧帧 → 触发新轮,
            // 与现状按任务逐条决策的组合等价
            const triggerTurn = tasks.some((batchTask) => batchTask.triggerOnCompletion === true &&
                batchTask.staleBranchFrame !== true);
            // 批信息由 content 承载,details 仅取首任务快照作 UI 展示代表;宿主
            // extension 仅透传 sendMessage,无 per-task routing 依赖(通知渲染器按
            // content 块数显示批规模)
            const details = snapshot(first);
            this.sendCompletionNotification({
                customType: "background-task-notification",
                content,
                display: true,
                details,
            }, {
                deliverAs: "steer",
                triggerTurn,
            });
        }
        catch (error) {
            // P8 投递留痕迁移至排水层:批内全部回滚 notified(已结算的其他批不受
            // 影响),单处 warn 留痕(含有界批 id 列表),不重抛——微任务内 rethrow
            // 会触发 unhandledrejection;调用点既有的 logger.error 亦不再触发,
            // 本处 warn 为唯一新增留痕。跨 reload 竞态:旧注册表排水若在 handoff
            // 后运行仍会发送批(任务对象引用存活),叠加新注册表 notified 锁存,
            // 结果恰好一次或丢一次(与现状 P8 丢一次语义等价),无双发路径。
            // try 覆盖取批后的构造+发送全段:构造期纯函数若抛错同样不得逸出微任务。
            for (const batchTask of tasks)
                batchTask.notified = false;
            const batchIds = truncateChars(tasks.map((batchTask) => batchTask.id).join(", "), NOTIFICATION_BATCH_WARN_MAX_CHARS);
            this.logger.warn(`[background-tasks] notification delivery failed for batch [${batchIds}]; notified reset to false: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async finalizeTask(task, status, exitCode, signal, error) {
        if (task.finalized)
            return;
        task.finalized = true;
        if (task.timeoutHandle)
            clearTimeout(task.timeoutHandle);
        if (this.platform === "win32")
            this.clearKillEscalationTimer(task);
        let finalStatus = status;
        let finalError = error;
        const posixForceFailure = await this.awaitPosixProcessGroupBeforeTerminal(task);
        if (posixForceFailure !== undefined) {
            finalStatus = "failed";
            finalError = BackgroundTaskRegistry.appendTaskError(finalError, posixForceFailure.message);
        }
        const windowsForceFailure = await this.awaitWindowsForceBeforeTerminal(task);
        if (windowsForceFailure !== undefined) {
            finalStatus = "failed";
            finalError = BackgroundTaskRegistry.appendTaskError(finalError, windowsForceFailure.message);
        }
        task.exitCode = exitCode;
        task.signal = signal ?? null;
        // Keep status="running" until the final wrapped-agent fragment has been
        // consumed and the output plus terminal metadata are durable. Publishing a
        // terminal state earlier lets bg_status observe the previous assistant
        // turn's context snapshot and recreates the same false-completion race
        // early terminal publication is required to prevent.
        try {
            if (task.telemetryWrapped) {
                // Child-process close can be observed before the wrapper stdout listener has
                // committed its last parsed telemetry batch. Wait for a short quiet window,
                // then flush the trailing partial line, so completed status never races
                // ahead of the final assistant-turn context/token/tool snapshot.
                await new Promise((resolve) => setTimeout(resolve, 25));
                this.flushAgentStdout(task);
            }
            if (task.stream && !task.stream.destroyed)
                await closeAndFsyncOutputStream(task.stream);
        }
        catch (finalizeError) {
            finalStatus = "failed";
            const message = finalizeError instanceof Error
                ? finalizeError.message
                : String(finalizeError);
            finalError = finalError
                ? `${finalError}; final output durability failed: ${message}`
                : `Final output durability failed: ${message}`;
        }
        task.endTime = this.now();
        if (finalError)
            task.error = finalError;
        try {
            await this.writeMetadataSnapshot(task, {
                ...snapshot(task),
                status: finalStatus,
            });
            task.status = finalStatus;
        }
        catch (metadataError) {
            finalStatus = "failed";
            task.status = "failed";
            task.error = `Terminal metadata write failed: ${metadataError instanceof Error ? metadataError.message : String(metadataError)}`;
            this.logger.error(`[background-tasks] failed to write metadata for ${task.id}:`, metadataError);
            await this.writeMetadata(task).catch((retryError) => {
                this.logger.error(`[background-tasks] failed to write failed terminal metadata for ${task.id}:`, retryError);
            });
        }
        // M5:完成摘要 — 输出已关流落盘后从任务输出文件取有界 tail(64KiB 内);
        // 缺失/不可读/无内容时缺省,不阻塞终态发布(完整日志不自动回传,帧内已附输出路径)
        task.terminalSummaryTail = await readTerminalSummaryTail(task.outputAbsPath);
        // M2:迟到结算 fence(旧代次帧标陈旧、不触发唤醒)与 waiter 双通道结算
        this.applyBranchGenerationFence(task);
        this.settleTaskWaiters(task);
        for (const waiter of task.waiters.splice(0))
            waiter();
        this.onChange();
        this.publishTerminal(task);
        const deliveryGate = await this.waitForTerminalPublicationGate(task);
        if (deliveryGate.kind === "rejected") {
            this.logger.error(`[background-tasks] completion delivery gate failed for ${task.id}: ${this.terminalPublicationError(deliveryGate.error)}`);
        }
        else {
            // EventBus disposal abandons only EventBus publication. Notification truth
            // remains independent; notifyCompletion itself suppresses session shutdown.
            // S1:notifyCompletion 现在仅入队(置位 notified),实际投递在微任务排水层;
            // 排水失败由排水层单处 warn 留痕,本处 catch 成为防御性保留,不移除。
            try {
                this.notifyCompletion(task);
            }
            catch (notificationError) {
                this.logger.error(`[background-tasks] notification failed for ${task.id}:`, notificationError);
            }
        }
        try {
            // S1:先等本批排水结算,再落盘 notified——保证持久化值等于投递结果
            // (成功 true / 失败 false),杜绝「先写快照、后回滚」的写序竞态。
            await this.awaitPendingNotificationDrain();
            await this.writeMetadata(task);
        }
        catch (metadataError) {
            this.logger.error(`[background-tasks] failed to update notification metadata for ${task.id}:`, metadataError);
        }
        this.pruneOldTasks();
    }
    pruneOldTasks() {
        if (this.tasks.size <= this.maxRecentTasks)
            return;
        const removable = [...this.tasks.values()]
            .filter((task) => task.status !== "running" && task.terminalEmitInFlight !== true)
            .sort((a, b) => (a.endTime ?? a.startTime) - (b.endTime ?? b.startTime));
        while (this.tasks.size > this.maxRecentTasks && removable.length > 0) {
            const task = removable.shift();
            if (task === undefined)
                continue;
            if (task.terminalPublicationState === "pending") {
                this.abandonTerminalPublication(task, "retention_limit");
            }
            this.tasks.delete(task.id);
        }
    }
}
//# sourceMappingURL=registry.js.map