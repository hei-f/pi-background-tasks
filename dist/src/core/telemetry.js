import { isJsonObject, parseJsonText, } from './common.js';
/** 遥测解析缓冲上限:跨 chunk 保留未完成的控制行与 XML 尾部,防止解析丢失。 */
const TELEMETRY_BUFFER_CHARS = 512 * 1024;
export function nonNegativeInteger(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : 0;
}
export function normalizeContextUsage(value) {
    if (!isJsonObject(value))
        return undefined;
    const input = value;
    const rawContextWindow = input.contextWindow;
    const contextWindow = typeof rawContextWindow === 'number' &&
        Number.isFinite(rawContextWindow) &&
        rawContextWindow > 0
        ? Math.floor(rawContextWindow)
        : undefined;
    if (!contextWindow)
        return undefined;
    const rawTokens = input.tokens;
    const tokens = rawTokens === null
        ? null
        : typeof rawTokens === 'number' &&
            Number.isFinite(rawTokens) &&
            rawTokens >= 0
            ? Math.floor(rawTokens)
            : null;
    const rawPercent = input.percent;
    const percent = rawPercent === null
        ? null
        : typeof rawPercent === 'number' &&
            Number.isFinite(rawPercent) &&
            rawPercent >= 0
            ? rawPercent
            : tokens === null
                ? null
                : (tokens / contextWindow) * 100;
    return { tokens, contextWindow, percent };
}
export function parseContextUsageXml(xml) {
    const readNumber = (tag) => {
        const match = new RegExp(`<${tag}>(.*?)</${tag}>`, 'iu').exec(xml);
        if (match === null)
            return undefined;
        const raw = match[1]?.trim();
        if (raw === 'null' || raw === '?')
            return null;
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : undefined;
    };
    return normalizeContextUsage({
        tokens: readNumber('tokens'),
        contextWindow: readNumber('context-window') ?? readNumber('contextWindow'),
        percent: readNumber('percent'),
    });
}
export function normalizeTokenUsage(value) {
    if (!isJsonObject(value))
        return undefined;
    const input = value;
    const usage = {
        input: nonNegativeInteger(input.input),
        output: nonNegativeInteger(input.output),
        cacheRead: nonNegativeInteger(input.cacheRead),
        cacheWrite: nonNegativeInteger(input.cacheWrite),
        totalTokens: nonNegativeInteger(input.totalTokens),
    };
    if (usage.totalTokens <= 0)
        usage.totalTokens =
            usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    const rawCostTotal = input.costTotal;
    if (typeof rawCostTotal === 'number' &&
        Number.isFinite(rawCostTotal) &&
        rawCostTotal >= 0)
        usage.costTotal = rawCostTotal;
    return usage.totalTokens > 0 ? usage : undefined;
}
export function normalizeToolUsage(value) {
    if (!isJsonObject(value))
        return undefined;
    const input = value;
    const byName = {};
    const rawByName = input.byName;
    if (isJsonObject(rawByName)) {
        for (const [name, count] of Object.entries(rawByName)) {
            const normalized = nonNegativeInteger(count);
            if (normalized > 0)
                byName[name] = normalized;
        }
    }
    const byNameTotal = Object.values(byName).reduce((sum, count) => sum + count, 0);
    const failed = nonNegativeInteger(input.failed);
    const total = Math.max(nonNegativeInteger(input.total), byNameTotal, failed);
    return total > 0 || failed > 0 ? { total, failed, byName } : undefined;
}
export function normalizeModel(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    if (!trimmed)
        return undefined;
    return trimmed.length > 120 ? trimmed.slice(0, 120) : trimmed;
}
/**
 * 单次输出 chunk 的遥测吞噬(registry 与 reload-shell-owner 两套近逐行重复
 * 收敛的共享实现):解析 JSON/XML 控制行得到最新快照,并保留跨 chunk 尾部
 * 缓冲。吞掉畸形可选遥测,任务输出仍是调试权威。
 */
export function parseTelemetryStream(text, existingBuffer) {
    const telemetryText = `${existingBuffer}${text}`;
    let latestContext;
    let latestTokens;
    let latestTools;
    let latestModel;
    for (const line of telemetryText.split(/\r?\n/u)) {
        if (!line.includes('background-task-'))
            continue;
        const trimmed = line.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            try {
                const parsed = parseJsonText(trimmed);
                if (!isJsonObject(parsed))
                    continue;
                const payload = parsed;
                if (payload.type === 'background-task-context-usage') {
                    latestContext = normalizeContextUsage(payload) ?? latestContext;
                }
                else if (payload.type === 'background-task-telemetry') {
                    latestContext =
                        normalizeContextUsage(payload.contextUsage) ?? latestContext;
                    latestTokens = normalizeTokenUsage(payload.tokenUsage) ?? latestTokens;
                    latestTools = normalizeToolUsage(payload.toolUsage) ?? latestTools;
                    latestModel = normalizeModel(payload.model) ?? latestModel;
                }
            }
            catch {
                // Ignore malformed optional telemetry; task output remains authoritative for debugging.
            }
        }
    }
    const xmlMatches = telemetryText.matchAll(/<background-task-context-usage>[\s\S]*?<\/background-task-context-usage>/giu);
    for (const match of xmlMatches)
        latestContext = parseContextUsageXml(match[0]) ?? latestContext;
    const lastNewline = Math.max(telemetryText.lastIndexOf('\n'), telemetryText.lastIndexOf('\r'));
    let retained = lastNewline >= 0 ? telemetryText.slice(lastNewline + 1) : telemetryText;
    const lower = telemetryText.toLowerCase();
    const lastXmlOpen = lower.lastIndexOf('<background-task-context-usage');
    const lastXmlClose = lower.lastIndexOf('</background-task-context-usage>');
    if (lastXmlOpen > lastXmlClose)
        retained = telemetryText.slice(lastXmlOpen);
    return {
        retained: retained.slice(-TELEMETRY_BUFFER_CHARS),
        latest: {
            context: latestContext,
            tokens: latestTokens,
            tools: latestTools,
            model: latestModel,
        },
    };
}
//# sourceMappingURL=telemetry.js.map