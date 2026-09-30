import { boundedErrorMessage, DEFAULT_LOG_BYTES, normalizeMaxBytes, } from './common.js';
export const BG_REQUEST_CHANNEL = 'pi-background-tasks:request:v1';
export const BG_RESPONSE_CHANNEL = 'pi-background-tasks:response:v1';
export const BG_TERMINAL_CHANNEL = 'pi-background-tasks:terminal:v1';
export const BG_REQUEST_SCHEMA = 'pi-background-tasks.extension-request.v1';
export const BG_RESPONSE_SCHEMA = 'pi-background-tasks.extension-response.v1';
export const BG_TERMINAL_SCHEMA = 'pi-background-tasks.extension-terminal.v1';
export const BG_EXTENSION_SERVICE_CLOSED_CODE = 'pi_background_tasks_eventbus_closed';
export class BackgroundTaskExtensionServiceClosedError extends Error {
    code = BG_EXTENSION_SERVICE_CLOSED_CODE;
    constructor() {
        super('pi-background-tasks EventBus service is closed');
        this.name = 'BackgroundTaskExtensionServiceClosedError';
    }
}
const MAX_ERROR_CHARS = 240;
const MAX_REQUEST_ID_CHARS = 200;
/** REVIEW:EventBus 去重账本容量上限,防止请求 id 账本跨 session 激活无界增长。 */
const MAX_SEEN_REQUEST_IDS = 4096;
export const BG_EXTENSION_CAPABILITIES = Object.freeze({
    api_version: 1,
    run: true,
    run_is_agent: true,
    run_completion_trigger: true,
    status: true,
    logs: true,
    logs_bounded: true,
    kill: true,
});
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasOwn(record, key) {
    return Object.prototype.hasOwnProperty.call(record, key);
}
function assertClosed(record, allowedKeys, label) {
    const allowed = new Set(allowedKeys);
    for (const key of Object.keys(record)) {
        if (!allowed.has(key))
            throw new Error(`${label} contains unknown key ${key}`);
    }
}
function requireRecord(value, label) {
    if (!isRecord(value))
        throw new Error(`${label} must be an object`);
    return value;
}
function requireNonEmptyString(value, label) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${label} must be a non-empty string`);
    }
    return value;
}
function requireBoolean(value, label) {
    if (typeof value !== 'boolean')
        throw new Error(`${label} must be boolean`);
    return value;
}
function requirePositiveInteger(value, label) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        throw new Error(`${label} must be a positive integer`);
    }
    return value;
}
function requireOperation(value, label) {
    if (value === 'capabilities' ||
        value === 'run' ||
        value === 'status' ||
        value === 'logs' ||
        value === 'kill') {
        return value;
    }
    throw new Error(`${label} must be one of capabilities, run, status, logs, kill`);
}
function operationEcho(value) {
    return typeof value === 'string' && value.length > 0 ? value : 'malformed';
}
function requestIdEcho(value) {
    return typeof value === 'string' && value.length > 0 ? value : 'malformed';
}
function parseCapabilitiesPayload(value) {
    const payload = requireRecord(value, 'capabilities.payload');
    assertClosed(payload, [], 'capabilities.payload');
    return {};
}
function parseRunPayload(value) {
    const payload = requireRecord(value, 'run.payload');
    assertClosed(payload, ['name', 'command', 'isAgent', 'timeoutSeconds', 'notifyOnCompletion', 'triggerOnCompletion'], 'run.payload');
    const out = {
        name: requireNonEmptyString(payload['name'], 'run.payload.name'),
        command: requireNonEmptyString(payload['command'], 'run.payload.command'),
        isAgent: requireBoolean(payload['isAgent'], 'run.payload.isAgent'),
        notifyOnCompletion: requireBoolean(payload['notifyOnCompletion'], 'run.payload.notifyOnCompletion'),
        triggerOnCompletion: requireBoolean(payload['triggerOnCompletion'], 'run.payload.triggerOnCompletion'),
    };
    if (hasOwn(payload, 'timeoutSeconds')) {
        out.timeoutSeconds = requirePositiveInteger(payload['timeoutSeconds'], 'run.payload.timeoutSeconds');
    }
    return out;
}
function parseStatusPayload(value) {
    const payload = requireRecord(value, 'status.payload');
    assertClosed(payload, ['taskId'], 'status.payload');
    const out = {};
    if (hasOwn(payload, 'taskId')) {
        out.taskId = requireNonEmptyString(payload['taskId'], 'status.payload.taskId');
    }
    return out;
}
function parseLogsPayload(value) {
    const payload = requireRecord(value, 'logs.payload');
    assertClosed(payload, ['taskId', 'maxBytes', 'tail'], 'logs.payload');
    const out = {
        taskId: requireNonEmptyString(payload['taskId'], 'logs.payload.taskId'),
    };
    if (hasOwn(payload, 'maxBytes')) {
        out.maxBytes = requirePositiveInteger(payload['maxBytes'], 'logs.payload.maxBytes');
    }
    if (hasOwn(payload, 'tail'))
        out.tail = requireBoolean(payload['tail'], 'logs.payload.tail');
    return out;
}
function parseKillPayload(value) {
    const payload = requireRecord(value, 'kill.payload');
    assertClosed(payload, ['taskId'], 'kill.payload');
    return { taskId: requireNonEmptyString(payload['taskId'], 'kill.payload.taskId') };
}
function parsePayload(operation, value) {
    switch (operation) {
        case 'capabilities':
            return parseCapabilitiesPayload(value);
        case 'run':
            return parseRunPayload(value);
        case 'status':
            return parseStatusPayload(value);
        case 'logs':
            return parseLogsPayload(value);
        case 'kill':
            return parseKillPayload(value);
    }
}
function parseRequest(data) {
    if (!isRecord(data)) {
        return {
            requestId: 'malformed',
            operationEcho: 'malformed',
            error: 'request frame must be an object',
        };
    }
    const requestId = requestIdEcho(data['request_id']);
    const opEcho = operationEcho(data['operation']);
    try {
        assertClosed(data, ['schema_version', 'request_id', 'operation', 'payload'], 'request');
        if (data['schema_version'] !== BG_REQUEST_SCHEMA)
            throw new Error('request schema_version mismatch');
        const parsedRequestId = requireNonEmptyString(data['request_id'], 'request.request_id');
        if (parsedRequestId.length > MAX_REQUEST_ID_CHARS) {
            throw new Error(`request.request_id must be at most ${String(MAX_REQUEST_ID_CHARS)} characters`);
        }
        const operation = requireOperation(data['operation'], 'request.operation');
        if (!hasOwn(data, 'payload'))
            throw new Error('request.payload is required');
        const payload = parsePayload(operation, data['payload']);
        return {
            requestId: parsedRequestId,
            operationEcho: operation,
            request: {
                schema_version: BG_REQUEST_SCHEMA,
                request_id: parsedRequestId,
                operation,
                payload,
            },
        };
    }
    catch (error) {
        return { requestId, operationEcho: opEcho, error: errorText(error) };
    }
}
function createTerminalPublicationGate() {
    let released = false;
    let resolveGate = () => { };
    const promise = new Promise((resolve) => {
        resolveGate = resolve;
    });
    return {
        promise,
        async releaseAfterResponse() {
            if (released)
                return;
            released = true;
            // Give response listeners one microtask turn to resolve their request promises
            // and bind the returned task id before an early terminal event is emitted.
            await Promise.resolve();
            resolveGate();
        },
    };
}
function combineTerminalPublicationGates(existing, next) {
    if (existing === undefined)
        return next;
    if (next === undefined)
        return existing;
    return Promise.all([existing, next]).then(() => undefined);
}
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
/** terminal 帧的终态值映射:仅终态任务携带 status(防御性,框架侧只发布终态任务)。 */
function terminalStatusOf(task) {
    const status = task.status;
    if (status === 'completed' ||
        status === 'failed' ||
        status === 'cancelled' ||
        status === 'killed' ||
        status === 'lost') {
        return status;
    }
    return undefined;
}
/** usage 快照的模型用量投影:task.tokenUsage 缺失或无 total 时缺省(unavailable 不伪造 0)。 */
function terminalModelUsageOf(task) {
    const usage = task.tokenUsage;
    if (usage === undefined || usage.totalTokens <= 0)
        return undefined;
    const out = {
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        totalTokens: usage.totalTokens,
    };
    return out;
}
/** terminal 帧 usage 快照:从任务快照聚合,至少一个字段在场才携带。 */
function terminalUsageOf(task) {
    const durationMs = task.endTime !== undefined &&
        Number.isFinite(task.startTime) &&
        Number.isFinite(task.endTime) &&
        task.endTime >= task.startTime
        ? task.endTime - task.startTime
        : undefined;
    const modelUsage = terminalModelUsageOf(task);
    const toolUseCount = task.toolUsage !== undefined && task.toolUsage.total > 0
        ? task.toolUsage.total
        : undefined;
    const usage = {};
    if (durationMs !== undefined)
        usage.durationMs = durationMs;
    if (modelUsage !== undefined) {
        usage.modelUsage = modelUsage;
        usage.totalTokens = modelUsage.totalTokens;
    }
    if (toolUseCount !== undefined)
        usage.toolUseCount = toolUseCount;
    const hasAny = usage.durationMs !== undefined ||
        usage.modelUsage !== undefined ||
        usage.toolUseCount !== undefined ||
        usage.totalTokens !== undefined;
    return hasAny ? usage : undefined;
}
export function boundedBackgroundTaskError(error) {
    // REVIEW:有界错误文案三处重复收敛到共享 boundedErrorMessage
    return boundedErrorMessage(error, MAX_ERROR_CHARS);
}
function errorResponse(requestId, operation, error) {
    return {
        schema_version: BG_RESPONSE_SCHEMA,
        request_id: requestId,
        operation,
        ok: false,
        error: boundedBackgroundTaskError(error),
    };
}
function successResponse(request, result) {
    return {
        schema_version: BG_RESPONSE_SCHEMA,
        request_id: request.request_id,
        operation: request.operation,
        ok: true,
        result,
    };
}
function runPayload(value) {
    return value;
}
function statusPayload(value) {
    return value;
}
function logsPayload(value) {
    return value;
}
function killPayload(value) {
    return value;
}
class InstalledBackgroundTaskExtensionService {
    events;
    registry;
    getContext;
    isShuttingDown;
    logger;
    seenRequestIds = new Set();
    unsubscribe;
    serviceState = 'open';
    constructor(options) {
        this.events = options.events;
        this.registry = options.registry;
        this.getContext = options.getContext;
        this.isShuttingDown = options.isShuttingDown;
        this.logger = options.logger ?? console;
        this.unsubscribe = this.events.on(BG_REQUEST_CHANNEL, (data) => {
            void this.handle(data);
        });
    }
    get state() {
        return this.serviceState;
    }
    /** REVIEW:去重账本按容量上限裁剪,达到上限时清理最旧的 request_id(Set 按插入序迭代)。 */
    recordSeenRequestId(requestId) {
        this.seenRequestIds.add(requestId);
        if (this.seenRequestIds.size > MAX_SEEN_REQUEST_IDS) {
            const oldest = this.seenRequestIds.values().next().value;
            if (oldest !== undefined)
                this.seenRequestIds.delete(oldest);
        }
    }
    isClosed() {
        return this.serviceState === 'closed';
    }
    publishTerminal(publication) {
        if (this.serviceState === 'closed')
            throw new BackgroundTaskExtensionServiceClosedError();
        const task = publication.task;
        const status = terminalStatusOf(task);
        const usage = terminalUsageOf(task);
        const terminal = {
            schema_version: BG_TERMINAL_SCHEMA,
            task,
            originMeta: { backgroundSource: 'bash' },
        };
        if (status !== undefined)
            terminal.status = status;
        if (task.failedReason !== undefined)
            terminal.failedReason = task.failedReason;
        if (task.stopInitiator !== undefined)
            terminal.initiator = task.stopInitiator;
        if (publication.summaryTail !== undefined)
            terminal.summaryTail = publication.summaryTail;
        if (usage !== undefined)
            terminal.usage = usage;
        this.events.emit(BG_TERMINAL_CHANNEL, terminal);
    }
    close() {
        if (this.serviceState === 'closed')
            return;
        this.serviceState = 'closed';
        this.registry.closeTerminalPublication('publisher_closed');
        this.unsubscribe();
    }
    async handle(data) {
        const parsed = parseRequest(data);
        if (parsed.error !== undefined || parsed.request === undefined) {
            this.emitResponse(errorResponse(parsed.requestId, parsed.operationEcho, parsed.error ?? 'malformed request'));
            return;
        }
        const request = parsed.request;
        if (this.seenRequestIds.has(request.request_id)) {
            this.emitResponse(errorResponse(request.request_id, request.operation, `duplicate request_id ${request.request_id}`));
            return;
        }
        this.recordSeenRequestId(request.request_id);
        const terminalGate = request.operation === 'run' || request.operation === 'kill'
            ? createTerminalPublicationGate()
            : undefined;
        try {
            if (this.serviceState === 'closed')
                throw new BackgroundTaskExtensionServiceClosedError();
            if (this.isShuttingDown() || this.registry.isShuttingDown()) {
                throw new Error('pi-background-tasks EventBus service is shutting down');
            }
            const ctx = this.getContext();
            if (ctx === undefined) {
                throw new Error('pi-background-tasks EventBus service is unavailable before session_start');
            }
            const result = await this.execute(ctx, request, terminalGate?.promise);
            if (this.isClosed())
                return;
            if (this.isShuttingDown() || this.registry.isShuttingDown()) {
                throw new Error('pi-background-tasks EventBus service is shutting down');
            }
            this.emitResponse(successResponse(request, result));
        }
        catch (error) {
            // A request accepted before close may report failure, but it must never
            // report post-close success. Requests first emitted after close remain
            // unhandled because the listener has already been removed.
            this.emitResponse(errorResponse(request.request_id, request.operation, error));
        }
        finally {
            await terminalGate?.releaseAfterResponse();
        }
    }
    async execute(ctx, request, terminalPublicationGate) {
        switch (request.operation) {
            case 'capabilities':
                return { ...BG_EXTENSION_CAPABILITIES };
            case 'run': {
                const payload = runPayload(request.payload);
                const options = {
                    name: payload.name,
                    isAgent: payload.isAgent,
                    notifyOnCompletion: payload.notifyOnCompletion,
                    triggerOnCompletion: payload.triggerOnCompletion,
                    terminalPublicationGate,
                };
                if (payload.timeoutSeconds !== undefined)
                    options.timeoutSeconds = payload.timeoutSeconds;
                const task = await this.registry.startTask(ctx, payload.command, options);
                return this.registry.snapshot(task);
            }
            case 'status': {
                const payload = statusPayload(request.payload);
                const tasks = payload.taskId
                    ? [this.registry.resolveTask(payload.taskId)]
                    : this.registry.allTasks();
                return { tasks: tasks.map((task) => this.registry.snapshot(task)) };
            }
            case 'logs': {
                const payload = logsPayload(request.payload);
                const task = this.registry.resolveTask(payload.taskId);
                const logs = await this.registry.getTaskLogs(task, normalizeMaxBytes(payload.maxBytes, DEFAULT_LOG_BYTES), payload.tail ?? true);
                return { ...logs.details, text: logs.text };
            }
            case 'kill': {
                const payload = killPayload(request.payload);
                const task = this.registry.resolveTask(payload.taskId);
                task.terminalPublicationGate = combineTerminalPublicationGates(task.terminalPublicationGate, terminalPublicationGate);
                // EventBus kill 属程序化请求(其他扩展/编排器),按模型入口分派
                await this.registry.stopTask(task, 'user', undefined, 'model');
                const snapshot = this.registry.snapshot(task);
                return {
                    task: snapshot,
                    message: `Killed background task ${snapshot.name ?? snapshot.id} (${snapshot.id}). Output: ${snapshot.outputPath}`,
                };
            }
        }
    }
    emitResponse(response) {
        try {
            this.events.emit(BG_RESPONSE_CHANNEL, response);
        }
        catch (error) {
            this.logger.error('[background-tasks] EventBus response emit failed:', error);
        }
    }
}
export function installBackgroundTaskExtensionApi(options) {
    return new InstalledBackgroundTaskExtensionService(options);
}
//# sourceMappingURL=extension-api.js.map