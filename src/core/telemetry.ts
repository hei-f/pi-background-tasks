import {
  isJsonObject,
  parseJsonText,
  type TaskContextUsage,
  type TaskTokenUsage,
  type TaskToolUsage,
} from './common.js';

/** 遥测解析缓冲上限:跨 chunk 保留未完成的控制行与 XML 尾部,防止解析丢失。 */
const TELEMETRY_BUFFER_CHARS = 512 * 1024;

export interface TelemetryControlPayload {
  readonly type?: unknown;
  readonly contextUsage?: unknown;
  readonly tokenUsage?: unknown;
  readonly toolUsage?: unknown;
  readonly model?: unknown;
}

export interface TelemetryDelta {
  context?: TaskContextUsage | undefined;
  tokens?: TaskTokenUsage | undefined;
  tools?: TaskToolUsage | undefined;
  model?: string | undefined;
}

export function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

export function normalizeContextUsage(
  value: unknown,
): TaskContextUsage | undefined {
  if (!isJsonObject(value)) return undefined;
  const input = value as {
    readonly contextWindow?: unknown;
    readonly tokens?: unknown;
    readonly percent?: unknown;
  };
  const rawContextWindow = input.contextWindow;
  const contextWindow =
    typeof rawContextWindow === 'number' &&
    Number.isFinite(rawContextWindow) &&
    rawContextWindow > 0
      ? Math.floor(rawContextWindow)
      : undefined;
  if (!contextWindow) return undefined;
  const rawTokens = input.tokens;
  const tokens =
    rawTokens === null
      ? null
      : typeof rawTokens === 'number' &&
          Number.isFinite(rawTokens) &&
          rawTokens >= 0
        ? Math.floor(rawTokens)
        : null;
  const rawPercent = input.percent;
  const percent =
    rawPercent === null
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

export function parseContextUsageXml(
  xml: string,
): TaskContextUsage | undefined {
  const readNumber = (tag: string): number | null | undefined => {
    const match = new RegExp(`<${tag}>(.*?)</${tag}>`, 'iu').exec(xml);
    if (match === null) return undefined;
    const raw = match[1]?.trim();
    if (raw === 'null' || raw === '?') return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  return normalizeContextUsage({
    tokens: readNumber('tokens'),
    contextWindow: readNumber('context-window') ?? readNumber('contextWindow'),
    percent: readNumber('percent'),
  });
}

export function normalizeTokenUsage(
  value: unknown,
): TaskTokenUsage | undefined {
  if (!isJsonObject(value)) return undefined;
  const input = value as {
    readonly input?: unknown;
    readonly output?: unknown;
    readonly cacheRead?: unknown;
    readonly cacheWrite?: unknown;
    readonly totalTokens?: unknown;
    readonly costTotal?: unknown;
  };
  const usage: TaskTokenUsage = {
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
  if (
    typeof rawCostTotal === 'number' &&
    Number.isFinite(rawCostTotal) &&
    rawCostTotal >= 0
  )
    usage.costTotal = rawCostTotal;
  return usage.totalTokens > 0 ? usage : undefined;
}

export function normalizeToolUsage(value: unknown): TaskToolUsage | undefined {
  if (!isJsonObject(value)) return undefined;
  const input = value as {
    readonly byName?: unknown;
    readonly failed?: unknown;
    readonly total?: unknown;
  };
  const byName: Record<string, number> = {};
  const rawByName = input.byName;
  if (isJsonObject(rawByName)) {
    for (const [name, count] of Object.entries(rawByName)) {
      const normalized = nonNegativeInteger(count);
      if (normalized > 0) byName[name] = normalized;
    }
  }
  const byNameTotal = Object.values(byName).reduce(
    (sum, count) => sum + count,
    0,
  );
  const failed = nonNegativeInteger(input.failed);
  const total = Math.max(nonNegativeInteger(input.total), byNameTotal, failed);
  return total > 0 || failed > 0 ? { total, failed, byName } : undefined;
}

export function normalizeModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 120 ? trimmed.slice(0, 120) : trimmed;
}

/**
 * 单次输出 chunk 的遥测吞噬(registry 与 reload-shell-owner 两套近逐行重复
 * 收敛的共享实现):解析 JSON/XML 控制行得到最新快照,并保留跨 chunk 尾部
 * 缓冲。吞掉畸形可选遥测,任务输出仍是调试权威。
 */
export function parseTelemetryStream(
  text: string,
  existingBuffer: string,
): { readonly retained: string; readonly latest: TelemetryDelta } {
  const telemetryText = `${existingBuffer}${text}`;
  let latestContext: TaskContextUsage | undefined;
  let latestTokens: TaskTokenUsage | undefined;
  let latestTools: TaskToolUsage | undefined;
  let latestModel: string | undefined;
  for (const line of telemetryText.split(/\r?\n/u)) {
    if (!line.includes('background-task-')) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = parseJsonText(trimmed);
        if (!isJsonObject(parsed)) continue;
        const payload: TelemetryControlPayload = parsed;
        if (payload.type === 'background-task-context-usage') {
          latestContext = normalizeContextUsage(payload) ?? latestContext;
        } else if (payload.type === 'background-task-telemetry') {
          latestContext =
            normalizeContextUsage(payload.contextUsage) ?? latestContext;
          latestTokens = normalizeTokenUsage(payload.tokenUsage) ?? latestTokens;
          latestTools = normalizeToolUsage(payload.toolUsage) ?? latestTools;
          latestModel = normalizeModel(payload.model) ?? latestModel;
        }
      } catch {
        // Ignore malformed optional telemetry; task output remains authoritative for debugging.
      }
    }
  }
  const xmlMatches = telemetryText.matchAll(
    /<background-task-context-usage>[\s\S]*?<\/background-task-context-usage>/giu,
  );
  for (const match of xmlMatches)
    latestContext = parseContextUsageXml(match[0]) ?? latestContext;

  const lastNewline = Math.max(
    telemetryText.lastIndexOf('\n'),
    telemetryText.lastIndexOf('\r'),
  );
  let retained =
    lastNewline >= 0 ? telemetryText.slice(lastNewline + 1) : telemetryText;
  const lower = telemetryText.toLowerCase();
  const lastXmlOpen = lower.lastIndexOf('<background-task-context-usage');
  const lastXmlClose = lower.lastIndexOf('</background-task-context-usage>');
  if (lastXmlOpen > lastXmlClose) retained = telemetryText.slice(lastXmlOpen);
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