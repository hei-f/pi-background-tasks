import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, delimiter, extname, isAbsolute, join, resolve, win32, } from 'node:path';
import { DEFAULT_MAX_BYTES, formatSize } from '@earendil-works/pi-coding-agent';
export const TASK_STATUS_VALUES = [
    'running',
    'completed',
    'failed',
    'cancelled',
    'killed',
    'lost',
];
export const TERMINAL_TASK_STATUS_VALUES = [
    'completed',
    'failed',
    'cancelled',
    'killed',
    'lost',
];
export class ReloadSurvivalError extends Error {
    code;
    constructor(code, message) {
        super(`${code}: ${message}`);
        this.code = code;
        this.name = 'ReloadSurvivalError';
    }
}
/**
 * Describe the actual parent-agent completion path for one background launch
 * (覆盖版 bash `run_in_background:true` 或 dock「转后台」)。
 * A wake request cannot take effect without the notification that carries it.
 */
export function deriveCompletionDeliveryGuidance(notifyOnCompletion, triggerOnCompletion) {
    if (notifyOnCompletion && triggerOnCompletion) {
        return {
            mode: 'notification-and-wake',
            notificationEnabled: true,
            automaticWakeEnabled: true,
            text: [
                'Terminal notification: enabled.',
                'Automatic follow-up turn: enabled.',
                'Next action: do not poll or sleep merely to wait; continue only independent useful work, otherwise end this turn and wait for <background-task-notification>.',
            ].join('\n'),
        };
    }
    if (notifyOnCompletion) {
        return {
            mode: 'notification-only',
            notificationEnabled: true,
            automaticWakeEnabled: false,
            text: [
                'Terminal notification: enabled.',
                'Automatic follow-up turn: disabled. The terminal notification will be delivered, but it will not start an agent turn.',
                'Next action: automatic wake-up was explicitly disabled; use bg_status/bg_logs only when deliberate monitoring is required, without tight polling.',
            ].join('\n'),
        };
    }
    return {
        mode: 'manual-monitoring',
        notificationEnabled: false,
        automaticWakeEnabled: false,
        text: [
            'Terminal notification: disabled.',
            triggerOnCompletion
                ? 'Automatic follow-up turn: disabled because terminal notifications are disabled. triggerOnCompletion has no effect while notifyOnCompletion is false.'
                : 'Automatic follow-up turn: disabled.',
            'Next action: completion delivery was explicitly disabled; use bg_status/bg_logs only for deliberate manual monitoring, without tight polling.',
        ].join('\n'),
    };
}
/** 模型视图 64KiB 有界上限:模型可见日志读取默认与上限取宿主导入的
 * `DEFAULT_MAX_BYTES` 与 64KiB 目标值二者中的较小者——宿主值小于 64KiB 时
 * 以宿主为准(当前宿主为 50KiB,实际生效值即 50KiB);宿主值超过 64KiB 时
 * 本插件按 64KiB 封顶,防止模型视图无界膨胀。
 */
export const MODEL_VIEW_BYTES_CAP = 64 * 1024;
export const DEFAULT_LOG_BYTES = Math.min(DEFAULT_MAX_BYTES, MODEL_VIEW_BYTES_CAP);
export const MAX_LOG_BYTES = Math.min(DEFAULT_MAX_BYTES, MODEL_VIEW_BYTES_CAP);
export const COMMAND_PREVIEW_CHARS = 90;
const parseJsonValue = globalThis.JSON.parse;
export function isJsonObject(value) {
    return typeof value === 'object' && value !== null;
}
/** 判别输出流错误是否由磁盘空间耗尽(ENOSPC)引发,用于终止分支选择。 */
export function isEnospcError(error) {
    return (typeof error === 'object' &&
        error !== null &&
        Reflect.get(error, 'code') === 'ENOSPC');
}
export function parseJsonText(text) {
    return parseJsonValue(text);
}
export function sanitizePathSegment(value) {
    const sanitized = value
        .replace(/[^a-zA-Z0-9_.-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return sanitized || 'session';
}
export function stripMatchingQuotes(value) {
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
export function compactWhitespace(value) {
    return value.replace(/\s+/g, ' ').trim();
}
export function truncateChars(value, maxChars) {
    if (value.length <= maxChars)
        return value;
    return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}
export function normalizeTaskName(value) {
    if (typeof value !== 'string')
        return undefined;
    const normalized = compactWhitespace(stripMatchingQuotes(value));
    if (!normalized)
        return undefined;
    return truncateChars(normalized, 80);
}
export function deriveTaskNameFromCommand(command) {
    const normalized = compactWhitespace(stripMatchingQuotes(command));
    if (!normalized)
        return 'Background task';
    const packageScript = /^(npm|pnpm|yarn|bun)\s+(?:(run)\s+)?([^\s;&|]+)/.exec(normalized);
    if (packageScript) {
        const runner = packageScript[1] ?? 'npm';
        const run = packageScript[2] !== undefined ? ' run' : '';
        const script = packageScript[3] ?? '';
        return truncateChars(`${runner}${run} ${script}`, 48);
    }
    const words = normalized.split(/\s+/).slice(0, 5).join(' ');
    return truncateChars(words.length > 0 ? words : normalized, 48);
}
export function taskDisplayName(task) {
    const commandName = task.command && task.command.length > 0
        ? deriveTaskNameFromCommand(task.command)
        : undefined;
    return (normalizeTaskName(task.name) ??
        normalizeTaskName(task.description) ??
        commandName ??
        task.id ??
        'Background task');
}
export function formatDuration(ms) {
    if (ms < 1000)
        return `${String(ms)}ms`;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60)
        return `${String(seconds)}s`;
    const minutes = Math.floor(seconds / 60);
    const remSeconds = seconds % 60;
    if (minutes < 60)
        return `${String(minutes)}m${remSeconds > 0 ? `${String(remSeconds)}s` : ''}`;
    const hours = Math.floor(minutes / 60);
    const remMinutes = minutes % 60;
    return `${String(hours)}h${remMinutes > 0 ? `${String(remMinutes)}m` : ''}`;
}
export function formatCompactNumber(count) {
    const normalized = Math.max(0, Math.floor(count));
    if (normalized < 1000)
        return normalized.toString();
    if (normalized < 10000)
        return `${(normalized / 1000).toFixed(1)}k`;
    if (normalized < 1000000)
        return `${String(Math.round(normalized / 1000))}k`;
    if (normalized < 10000000)
        return `${(normalized / 1000000).toFixed(1)}M`;
    return `${String(Math.round(normalized / 1000000))}M`;
}
export function formatContextUsageSummary(usage) {
    if (usage?.contextWindow === undefined || usage.contextWindow <= 0)
        return undefined;
    const window = formatCompactNumber(usage.contextWindow);
    if (usage.percent === null || usage.tokens === null)
        return `ctx=?/${window}`;
    return `ctx=${usage.percent.toFixed(1)}%/${window}`;
}
export function formatTokenUsageSummary(usage) {
    if (!usage || usage.totalTokens <= 0)
        return undefined;
    return `tokens=${formatCompactNumber(usage.totalTokens)}`;
}
export function formatToolUsageSummary(usage) {
    if (!usage || (usage.total <= 0 && usage.failed <= 0))
        return undefined;
    const failed = usage.failed > 0 ? ` failed=${String(usage.failed)}` : '';
    return `tools=${String(usage.total)}${failed}`;
}
export function formatModelSummary(model) {
    if (!model)
        return undefined;
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
export const AGENT_ACTIVITY_TYPE = 'background-task-activity';
const AGENT_ACTIVITY_DETAIL_MAX = 80;
function readActivityString(record, key) {
    const value = record[key];
    return typeof value === 'string' ? value : undefined;
}
/** Narrow a parsed `background-task-activity` control payload into a typed {@link AgentActivity}. */
export function parseAgentActivity(payload) {
    if (!isJsonObject(payload))
        return undefined;
    const record = payload;
    if (record.type !== AGENT_ACTIVITY_TYPE)
        return undefined;
    const kind = record.kind;
    if (kind === 'assistant_text' || kind === 'reasoning') {
        const text = readActivityString(record, 'text');
        if (text === undefined)
            return undefined;
        return { kind, text };
    }
    if (kind === 'tool_start') {
        const tool = readActivityString(record, 'tool');
        if (!tool)
            return undefined;
        return {
            kind,
            tool,
            argsSummary: readActivityString(record, 'argsSummary') ?? '',
        };
    }
    if (kind === 'tool_end') {
        const tool = readActivityString(record, 'tool');
        if (!tool)
            return undefined;
        const activity = {
            kind,
            tool,
            isError: record.isError === true,
        };
        const error = readActivityString(record, 'error');
        if (error !== undefined && error.trim().length > 0)
            activity.error = error;
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
export function formatAgentActivityLine(activity) {
    if (activity.kind === 'assistant_text') {
        const text = activity.text.replace(/\s+$/u, '');
        return text.trim().length > 0 ? text : undefined;
    }
    if (activity.kind === 'reasoning') {
        const text = activity.text.replace(/\s+$/u, '');
        return text.trim().length > 0 ? `\u2026 ${text}` : undefined;
    }
    if (activity.kind === 'tool_start') {
        const summary = compactWhitespace(activity.argsSummary);
        const suffix = summary.length > 0
            ? ` ${truncateChars(summary, AGENT_ACTIVITY_DETAIL_MAX)}`
            : '';
        return `\u2192 ${activity.tool}${suffix}`;
    }
    if (!activity.isError)
        return undefined;
    const detail = activity.error
        ? `: ${truncateChars(compactWhitespace(activity.error), AGENT_ACTIVITY_DETAIL_MAX)}`
        : '';
    return `\u2717 ${activity.tool} failed${detail}`;
}
export function shellQuote(value) {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}
export class ShellInvocationError extends Error {
    code = 'pi_bg_shell_invalid';
    constructor(message) {
        super(`pi_bg_shell_invalid: ${message}`);
        this.name = 'ShellInvocationError';
    }
}
const POSIX_FUNCTION_SHELLS = new Set([
    'sh',
    'dash',
    'ash',
    'ksh',
    'ksh93',
    'mksh',
    'pdksh',
    'zsh',
    'yash',
    'posh',
]);
function failShellInvocation(message) {
    throw new ShellInvocationError(message);
}
function shellErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function freezeShellPolicy(policy) {
    return Object.freeze({
        ...policy,
        argvPrefix: Object.freeze([...policy.argvPrefix]),
    });
}
export function shellPolicySnapshot(policy) {
    return Object.freeze({
        policy: policy.policy,
        executable: policy.executable,
        argvPrefix: Object.freeze([...policy.argvPrefix]),
        dialect: policy.dialect,
    });
}
function isWindowsExecutablePath(path) {
    const extension = extname(path).toLowerCase();
    return extension === '.exe' || extension === '.com';
}
function validateWindowsShellPath(path, label) {
    if (path.length === 0)
        failShellInvocation(`${label} is empty`);
    if (!isAbsolute(path) && !win32.isAbsolute(path)) {
        failShellInvocation(`${label} must be an absolute path`);
    }
    if (!isWindowsExecutablePath(path)) {
        failShellInvocation(`${label} must point to a .exe or .com file`);
    }
    let stats;
    try {
        stats = statSync(path);
    }
    catch (error) {
        failShellInvocation(`${label} stat failed: ${shellErrorMessage(error)}`);
    }
    if (!stats.isFile())
        failShellInvocation(`${label} must point to a regular file`);
    return path;
}
function inspectWindowsShellCandidate(path) {
    if (!isWindowsExecutablePath(path)) {
        return { found: false, diagnostic: `${path} is not a .exe or .com path` };
    }
    try {
        const stats = statSync(path);
        if (stats.isFile())
            return { found: true };
        return { found: false, diagnostic: `${path} is not a regular file` };
    }
    catch (error) {
        return { found: false, diagnostic: `${path}: ${shellErrorMessage(error)}` };
    }
}
function windowsPathValue(env) {
    return env['PATH'] ?? env['Path'] ?? env['path'] ?? '';
}
function resolveWindowsBash(env) {
    const pathValue = windowsPathValue(env);
    const diagnostics = [];
    for (const dir of pathValue.split(';').filter((entry) => entry.length > 0)) {
        for (const name of ['bash.exe', 'bash.com']) {
            const candidate = join(dir, name);
            const result = inspectWindowsShellCandidate(candidate);
            if (result.found)
                return candidate;
            diagnostics.push(result.diagnostic);
        }
    }
    const suffix = diagnostics.length > 0 ? `: ${diagnostics.join('; ')}` : '';
    failShellInvocation(`PI_BG_SHELL=bash could not resolve bash.exe or bash.com on PATH${suffix}`);
}
function validatePosixShellPath(path, label) {
    if (path.length === 0)
        failShellInvocation(`${label} is empty`);
    if (!isAbsolute(path))
        failShellInvocation(`${label} must be an absolute path`);
    let stats;
    try {
        stats = statSync(path);
    }
    catch (error) {
        failShellInvocation(`${label} stat failed: ${shellErrorMessage(error)}`);
    }
    if (!stats.isFile())
        failShellInvocation(`${label} must point to a regular file`);
    try {
        accessSync(path, constants.X_OK);
    }
    catch (error) {
        failShellInvocation(`${label} must be executable: ${shellErrorMessage(error)}`);
    }
    return path;
}
function inspectPosixShellCandidate(path) {
    try {
        const stats = statSync(path);
        if (!stats.isFile())
            return false;
        accessSync(path, constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
function resolvePosixExecutable(name, env, activationCwd) {
    const binCandidate = `/bin/${name}`;
    if (inspectPosixShellCandidate(binCandidate))
        return binCandidate;
    const pathValue = env['PATH'] ?? '';
    for (const entry of pathValue.split(delimiter)) {
        if (entry.length === 0)
            continue;
        const directory = isAbsolute(entry) ? entry : resolve(activationCwd, entry);
        const candidate = join(directory, name);
        if (inspectPosixShellCandidate(candidate))
            return candidate;
    }
    failShellInvocation(`PI_BG_POSIX_SHELL=${name} could not resolve executable ${binCandidate} or ${name} on PATH`);
}
function inheritedPosixDialect(executable) {
    const name = basename(executable).toLowerCase();
    if (name === 'bash')
        return 'bash';
    return POSIX_FUNCTION_SHELLS.has(name) ? 'posix' : 'user-non-posix';
}
/** Resolve one activation-stable policy. New POSIX variables are intentionally ignored on Windows. */
export function resolveShellPolicy(platform = process.platform, env = process.env, activationCwd = process.cwd()) {
    if (platform === 'win32') {
        const requestedShell = env['PI_BG_SHELL'];
        const requestedPath = env['PI_BG_SHELL_PATH'];
        if (requestedShell === undefined) {
            if (requestedPath !== undefined)
                failShellInvocation('PI_BG_SHELL_PATH requires PI_BG_SHELL');
            const comSpec = env['ComSpec'];
            return freezeShellPolicy({
                policy: 'cmd',
                executable: comSpec && comSpec.length > 0 ? comSpec : 'cmd.exe',
                argvPrefix: ['/d', '/s', '/c'],
                dialect: 'cmd',
                supportsPosixFunctionWrapper: false,
                windowsVerbatimArguments: true,
            });
        }
        if (requestedShell !== 'cmd' && requestedShell !== 'bash') {
            failShellInvocation('PI_BG_SHELL must be exactly cmd or bash');
        }
        const explicitPath = requestedPath !== undefined
            ? validateWindowsShellPath(requestedPath, 'PI_BG_SHELL_PATH')
            : undefined;
        if (requestedShell === 'cmd') {
            const comSpec = env['ComSpec'];
            return freezeShellPolicy({
                policy: 'cmd',
                executable: explicitPath ?? (comSpec && comSpec.length > 0 ? comSpec : 'cmd.exe'),
                argvPrefix: ['/d', '/s', '/c'],
                dialect: 'cmd',
                supportsPosixFunctionWrapper: false,
                windowsVerbatimArguments: true,
            });
        }
        return freezeShellPolicy({
            policy: 'bash',
            executable: explicitPath ?? resolveWindowsBash(env),
            argvPrefix: ['-c'],
            dialect: 'bash',
            supportsPosixFunctionWrapper: true,
            windowsVerbatimArguments: false,
        });
    }
    const configuredPolicy = env['PI_BG_POSIX_SHELL'];
    if (configuredPolicy !== undefined &&
        configuredPolicy !== 'inherit' &&
        configuredPolicy !== 'bash' &&
        configuredPolicy !== 'sh') {
        failShellInvocation('PI_BG_POSIX_SHELL must be exactly inherit, bash, or sh');
    }
    const policy = configuredPolicy ?? 'inherit';
    const configuredPath = env['PI_BG_POSIX_SHELL_PATH'];
    if (policy === 'inherit') {
        if (configuredPath !== undefined) {
            failShellInvocation('PI_BG_POSIX_SHELL_PATH requires PI_BG_POSIX_SHELL=bash or PI_BG_POSIX_SHELL=sh');
        }
        const inherited = env['SHELL'];
        const executable = inherited && inherited.length > 0 ? inherited : '/bin/sh';
        const dialect = inheritedPosixDialect(executable);
        return freezeShellPolicy({
            policy,
            executable,
            argvPrefix: ['-c'],
            dialect,
            supportsPosixFunctionWrapper: dialect === 'bash' || dialect === 'posix',
            windowsVerbatimArguments: false,
        });
    }
    const executable = configuredPath !== undefined
        ? validatePosixShellPath(configuredPath, 'PI_BG_POSIX_SHELL_PATH')
        : resolvePosixExecutable(policy, env, activationCwd);
    return freezeShellPolicy({
        policy,
        executable,
        argvPrefix: ['-c'],
        dialect: policy === 'bash' ? 'bash' : 'posix',
        supportsPosixFunctionWrapper: true,
        windowsVerbatimArguments: false,
    });
}
export function shellInvocationForPolicy(command, policy) {
    const dialect = policy.dialect === 'bash' ? 'posix' : policy.dialect;
    return {
        shell: policy.executable,
        args: policy.dialect === 'cmd'
            ? [...policy.argvPrefix, `"${command}"`]
            : [...policy.argvPrefix, command],
        dialect,
        windowsVerbatimArguments: policy.windowsVerbatimArguments,
    };
}
export function shellInvocation(command, platform = process.platform, env = process.env) {
    return shellInvocationForPolicy(command, resolveShellPolicy(platform, env));
}
/** Windows `.cmd`/`.bat` shim 扩展名集合(shell:false 不能直接 spawn shim)。 */
const WINDOWS_COMMAND_SHIM_EXTENSIONS = new Set([
    '.cmd',
    '.bat',
]);
const DEFAULT_WINDOWS_PATHEXT = [
    '.COM',
    '.EXE',
    '.BAT',
    '.CMD',
];
/** Windows 环境变量键存在大小写变体(例如 PATH/Path/path);docs 门禁要求 env
 * 键为字面量,因此显式枚举候选键而不是运行期循环匹配。
 */
function windowsPathextValue(env) {
    const value = env['PATHEXT'] ?? env['PathExt'] ?? env['pathext'];
    return typeof value === 'string' ? value : undefined;
}
function windowsComSpecValue(env) {
    const value = env['ComSpec'] ?? env['COMSPEC'] ?? env['comspec'];
    return typeof value === 'string' ? value : undefined;
}
function windowsExtensionCandidates(file, pathExts) {
    if (extname(file))
        return [file];
    return [file, ...pathExts.map((extension) => `${file}${extension.toLowerCase()}`)];
}
function isWindowsCommandShim(path) {
    return WINDOWS_COMMAND_SHIM_EXTENSIONS.has(extname(path).toLowerCase());
}
function resolveWindowsDirectExecutionFile(file, options) {
    const raw = windowsPathextValue(options.env);
    const pathExts = raw && raw.length > 0
        ? raw
            .split(';')
            .map((extension) => extension.trim())
            .filter((extension) => extension.length > 0)
        : [...DEFAULT_WINDOWS_PATHEXT];
    const fileCandidates = windowsExtensionCandidates(file, pathExts);
    let candidates;
    if (file.includes('\\') || file.includes('/') || win32.isAbsolute(file)) {
        const basePath = !win32.isAbsolute(file) && options.cwd
            ? win32.resolve(options.cwd, file)
            : win32.normalize(file);
        candidates = windowsExtensionCandidates(basePath, pathExts);
    }
    else {
        const pathValue = windowsPathValue(options.env);
        candidates = pathValue
            .split(win32.delimiter)
            .filter((entry) => entry.length > 0)
            .flatMap((dir) => fileCandidates.map((candidate) => win32.join(dir, candidate)));
    }
    return candidates.find((candidate) => options.exists(candidate)) ?? file;
}
function quoteCmdArgument(value) {
    if (value.length === 0)
        return '""';
    if (!/[\s"%&()<>^|]/.test(value))
        return value;
    return `"${value.replace(/(["%&()<>^|])/g, '^$1')}"`;
}
/**
 * 直执行解析(M4,逐行仿 ZCode `execution-command.ts:118-139`):argv[0] 直达
 * 可执行文件、无 shell 中介;Windows 下按 PATHEXT/PATH 解析实际文件,
 * `.cmd`/`.bat` shim 自动路由 `cmd.exe /d /s /c`(shell:false 不能直接
 * spawn shim),普通 `.exe` 保持 shell-free argv 执行。POSIX 保持裸名,
 * 由 libuv 按 PATH 解析。
 */
export function resolveDirectExecution(argv, options = {}) {
    const platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    const file = argv[0];
    if (typeof file !== 'string' || file.trim().length === 0) {
        throw new Error('Direct execution argv[0] must be a non-empty executable name');
    }
    const args = argv.slice(1);
    if (platform !== 'win32') {
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
    const commandLine = [resolvedFile, ...args].map(quoteCmdArgument).join(' ');
    const comSpec = windowsComSpecValue(env);
    return {
        file: comSpec && comSpec.length > 0 ? comSpec : 'cmd.exe',
        args: ['/d', '/s', '/c', commandLine],
        windowsVerbatimArguments: true,
    };
}
export function normalizeMaxBytes(value, fallback = DEFAULT_LOG_BYTES) {
    const raw = typeof value === 'number' && Number.isFinite(value)
        ? Math.floor(value)
        : fallback;
    return Math.max(1, Math.min(MAX_LOG_BYTES, raw));
}
/** 错误对象 → 文案(不裁剪、不复写空白;与 registry/reload 既有 errorMessage 语义一致)。 */
export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/** 追加错误文案:空已有/已含 next 时不重复追加,以 `; ` 连接(registry/reload 两处
 * appendError 语义一致)。 */
export function appendErrorText(existing, next) {
    if (existing === undefined || existing.length === 0)
        return next;
    if (existing.includes(next))
        return existing;
    return `${existing}; ${next}`;
}
/** 有界错误文案:折叠空白并裁剪到 maxChars 字符内,以省略号收尾(extension-api
 * 的 boundedBackgroundTaskError 与 reload 的 boundedError、registry 的
 * terminalPublicationError 三处收敛的统一实现)。 */
export function boundedErrorMessage(error, maxChars) {
    const text = errorMessage(error).replace(/\s+/gu, ' ').trim();
    if (text.length <= maxChars)
        return text;
    return `${text.slice(0, maxChars - 1)}…`;
}
/**
 * 六态迁移表统一判定(registry close 路径与 reload-shell-owner terminalStatus
 * 两套重复收敛):user/model 停止 → cancelled;system 关闭 → killed;timeout/
 * output_cap/disk_full/handoff_expired/退出码非 0 → failed(带细分 reason);
 * 终止后退出码 0 → completed。`handoff_expired` 为 reload 幸存路径独有分支。
 * 行为与两处既有实现逐分支等价;failedReason 副作用与既有实现一致。
 */
export function deriveTerminalStatus(task, killKind, exitCode, signal, maxOutputBytes) {
    if (killKind === 'user')
        return { status: 'cancelled' };
    if (killKind === 'shutdown')
        return { status: 'killed' };
    if (killKind === 'timeout') {
        task.failedReason = 'timed_out';
        return {
            status: 'failed',
            error: task.error ?? `Timed out after ${String(task.timeoutSeconds)}s`,
        };
    }
    if (killKind === 'output_cap') {
        task.failedReason = 'output_limit';
        return {
            status: 'failed',
            error: task.error ?? `Output exceeded cap of ${formatSize(maxOutputBytes)}`,
        };
    }
    if (killKind === 'disk_full') {
        // 磁盘满终止:已写输出文件保留,便于审计
        task.failedReason = 'disk_full';
        return {
            status: 'failed',
            error: task.error ??
                `Output file write failed because the disk is full (ENOSPC); partial output is retained at ${task.outputPath}`,
        };
    }
    if (killKind === 'handoff_expired') {
        return {
            status: 'failed',
            error: task.error ??
                'pi_bg_reload_handoff_expired: reload shell execution was not claimed before its handoff deadline',
        };
    }
    if ((exitCode ?? 0) === 0)
        return { status: 'completed' };
    task.failedReason = 'exit_error';
    return {
        status: 'failed',
        error: `Exited with code ${exitCode === null ? 'null' : String(exitCode)}${signal ? ` (${signal})` : ''}`,
    };
}
/**
 * 软/硬输出阈值写块助手(registry 输出写入段与 reload-shell-owner 写缓冲段
 * 两套重复收敛):跨软阈值写入一次软告警(不杀任务、不改状态、不计入累计字节,
 * 避免提示文本自身触发硬阈值);按硬阈值截断写入累计;首次跨硬阈值时置位
 * capExceeded、写终止 notice 后返回 true,由调用方执行终止动作并给出细分原因。
 */
export function writeTaskOutputChunk(task, buffer, options) {
    if (!task.stream || task.stream.destroyed)
        return false;
    if (buffer.length === 0)
        return false;
    const nextBytes = task.bytesWritten + buffer.length;
    if (nextBytes > options.softBytes && !task.softCapWarned) {
        task.softCapWarned = true;
        const warning = `\n\n[background task warning: output exceeded soft limit of ` +
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
    if (task.capExceeded)
        return false;
    task.capExceeded = true;
    task.error = `Output exceeded cap of ${formatSize(options.hardBytes)}; terminating task`;
    const notice = `\n\n[background task error: ${task.error}]\n`;
    task.stream.write(notice);
    task.bytesWritten += Buffer.byteLength(notice, 'utf8');
    return true;
}
export function snapshot(task) {
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
export function formatSnapshotList(tasks, now = Date.now()) {
    if (tasks.length === 0)
        return 'No background tasks in this Pi extension runtime.';
    return tasks
        .map((task) => {
        const statusIcon = task.status === 'running'
            ? '▶'
            : task.status === 'completed'
                ? '✓'
                : task.status === 'killed' || task.status === 'cancelled'
                    ? '■'
                    : '✗';
        const age = formatDuration((task.endTime ?? now) - task.startTime);
        const code = task.exitCode !== undefined ? ` exit=${String(task.exitCode)}` : '';
        const pid = task.pid !== undefined ? ` pid=${String(task.pid)}` : '';
        const error = task.error ? ` error=${truncateChars(task.error, 80)}` : '';
        const telemetry = [
            formatContextUsageSummary(task.contextUsage),
            formatModelSummary(task.model),
            formatTokenUsageSummary(task.tokenUsage),
            formatToolUsageSummary(task.toolUsage),
        ]
            .filter(Boolean)
            .join(' ');
        const telemetryText = telemetry ? ` ${telemetry}` : '';
        return `${statusIcon} ${task.id} ${task.status} ${age}${code}${pid}${telemetryText} — ${truncateChars(taskDisplayName(task), COMMAND_PREVIEW_CHARS)}${error}\n    output: ${task.outputPath}`;
    })
        .join('\n');
}
export async function boundedRead(filePath, maxBytes, tail) {
    const stats = statSync(filePath);
    const totalBytes = stats.size;
    const bytesToRead = Math.min(totalBytes, maxBytes);
    if (bytesToRead === 0)
        return { content: '', truncated: false, bytesRead: 0, totalBytes };
    const file = await open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(bytesToRead);
        const position = tail ? Math.max(0, totalBytes - bytesToRead) : 0;
        const { bytesRead } = await file.read(buffer, 0, bytesToRead, position);
        return {
            content: buffer.subarray(0, bytesRead).toString('utf8'),
            truncated: totalBytes > bytesRead,
            bytesRead,
            totalBytes,
        };
    }
    finally {
        await file.close();
    }
}
export function escapeXml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
//# sourceMappingURL=common.js.map