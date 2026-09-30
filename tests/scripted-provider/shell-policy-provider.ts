import { appendFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type TextContent,
  type ToolCall,
} from '@earendil-works/pi-ai';

const PROVIDER = 'pi-bg-shell-policy';
const MODEL_ID = 'shell-policy-model';
const API = 'pi-bg-shell-policy-api';
const DEFAULT_USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type JsonObject = Record<PropertyKey, unknown>;
type ScriptedBlock = TextContent | ToolCall;
type ScriptedAssistantMessage = Omit<AssistantMessage, 'content' | 'stopReason'> & {
  content: ScriptedBlock[];
  stopReason: 'stop' | 'toolUse';
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: JsonObject): void {
  const path = process.env['PI_BG_SHELL_POLICY_EVENTS'];
  if (path) appendFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}

function guidanceFrom(systemPrompt: string): JsonObject | undefined {
  const match = /activation shell policy (\{[^\n]+\})\./u.exec(systemPrompt);
  if (match?.[1] === undefined) return undefined;
  const parsed: unknown = JSON.parse(match[1]);
  return isObject(parsed) ? parsed : undefined;
}

function messageText(message: unknown): string {
  if (!isObject(message)) return '';
  const content = message['content'];
  return typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((part: unknown) =>
            isObject(part) && typeof part['text'] === 'string'
              ? part['text']
              : isObject(part) && typeof part['type'] === 'string'
                ? part['type']
                : '',
          )
          .join(' ')
      : '';
}

function effectiveSystemPrompt(context: Context): string {
  const legacy = context.systemPrompt;
  if (typeof legacy === 'string' && legacy.length > 0) return legacy;
  const parts: string[] = [];
  for (const knownMessage of context.messages) {
    const message: unknown = knownMessage;
    if (!isObject(message) || message['role'] !== 'system') continue;
    const content = messageText(message);
    if (content.length > 0) parts.push(content);
    if (!isObject(message['sections'])) continue;
    for (const [name, value] of Object.entries(message['sections'])) {
      if (typeof value === 'string') parts.push(`<${name}>\n${value}\n</${name}>`);
    }
  }
  return parts.join('\n\n');
}

/** 覆盖版 bash 后台调用 receipt 文本(M4 起不再有独立 bg_run 工具的 details.task)。 */
function latestBashReceipt(context: Context): string | undefined {
  const result = context.messages
    .filter(
      (message) =>
        message.role === 'toolResult' && 'toolName' in message && message.toolName === 'bash',
    )
    .at(-1);
  return result === undefined ? undefined : messageText(result);
}

/** 最近一次 bg_status 结果内的任务快照。 */
function latestStatusTask(context: Context): JsonObject | undefined {
  const result = context.messages
    .filter(
      (message) =>
        message.role === 'toolResult' &&
        'toolName' in message &&
        message.toolName === 'bg_status',
    )
    .at(-1);
  if (result === undefined || !('details' in result) || !isObject(result.details)) return undefined;
  const tasks = result.details['tasks'];
  if (!Array.isArray(tasks)) return undefined;
  const task = tasks.at(-1);
  return isObject(task) ? task : undefined;
}

/** 从覆盖版 bash receipt 解析 `(bXXXXXXXX)` 任务 id 与输出路径。 */
function parseReceipt(
  text: string | undefined,
): { taskId: string | undefined; outputPath: string | undefined } {
  if (text === undefined) return { taskId: undefined, outputPath: undefined };
  const idMatch = /\(b[0-9a-f]{8}\)/u.exec(text);
  const pathMatch = /Output: (\S+)/u.exec(text);
  return {
    taskId: idMatch?.[0].slice(1, -1),
    outputPath: pathMatch?.[1],
  };
}

function text(value: string): TextContent {
  return { type: 'text', text: value };
}

function toolCall(command: string): ToolCall {
  return {
    type: 'toolCall',
    id: 'shell-policy-bg-run',
    name: 'bash',
    arguments: {
      command,
      run_in_background: true,
    },
  };
}

function statusToolCall(id: string): ToolCall {
  return {
    type: 'toolCall',
    id: 'shell-policy-status',
    name: 'bg_status',
    arguments: { taskId: id },
  };
}

function assistant(
  content: ScriptedBlock[],
  stopReason: 'stop' | 'toolUse',
): ScriptedAssistantMessage {
  return {
    role: 'assistant',
    content,
    api: API,
    provider: PROVIDER,
    model: MODEL_ID,
    usage: DEFAULT_USAGE,
    stopReason,
    timestamp: Date.now(),
  };
}

function pushMessage(
  stream: AssistantMessageEventStream,
  message: ScriptedAssistantMessage,
): void {
  const partial: AssistantMessage = { ...message, content: [], stopReason: 'pending' };
  stream.push({ type: 'start', partial: { ...partial } });
  message.content.forEach((block, contentIndex) => {
    if (block.type === 'text') {
      const partialText: TextContent = { type: 'text', text: '' };
      partial.content = [...partial.content, partialText];
      stream.push({ type: 'text_start', contentIndex, partial: { ...partial } });
      partialText.text = block.text;
      stream.push({ type: 'text_delta', contentIndex, delta: block.text, partial: { ...partial } });
      stream.push({ type: 'text_end', contentIndex, content: block.text, partial: { ...partial } });
      return;
    }
    if (block.type !== 'toolCall') return;
    const partialTool: ToolCall = { ...block, arguments: {} };
    partial.content = [...partial.content, partialTool];
    stream.push({ type: 'toolcall_start', contentIndex, partial: { ...partial } });
    const json = JSON.stringify(block.arguments);
    stream.push({ type: 'toolcall_delta', contentIndex, delta: json, partial: { ...partial } });
    partialTool.arguments = block.arguments;
    stream.push({ type: 'toolcall_end', contentIndex, toolCall: block, partial: { ...partial } });
  });
  stream.push({ type: 'done', reason: message.stopReason, message });
  stream.end(message);
}

export default function shellPolicyProvider(pi: ExtensionAPI): void {
  let calls = 0;
  pi.registerProvider(PROVIDER, {
    name: 'Shell Policy Scripted Provider',
    baseUrl: 'http://localhost:0',
    apiKey: 'PI_BG_SHELL_POLICY_API_KEY',
    api: API,
    models: [
      {
        id: MODEL_ID,
        name: 'Shell Policy Model',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_000,
        maxTokens: 1024,
      },
    ],
    streamSimple(_model: Model<Api>, context: Context): AssistantMessageEventStream {
      calls += 1;
      const prompt = effectiveSystemPrompt(context);
      const guidance = guidanceFrom(prompt);
      const receipt = latestBashReceipt(context);
      const parsed = parseReceipt(receipt);
      const task = latestStatusTask(context);
      record({
        call: calls,
        guidance,
        peerGuidance: prompt.includes('peer feature guidance survives'),
        taskShellPolicy: task?.['shellPolicy'],
        taskId: task?.['id'] ?? parsed.taskId,
        taskOutputPath: task?.['outputPath'] ?? parsed.outputPath,
        toolResult: context.messages.map(messageText).at(-1),
      });

      let message: ScriptedAssistantMessage;
      if (calls === 1 && guidance?.['dialect'] === 'user-non-posix') {
        message = assistant([toolCall('shell_policy_probe Ω with spaces')], 'toolUse');
      } else if (calls === 1 && guidance?.['dialect'] === 'bash') {
        message = assistant(
          [toolCall(`printf '%s\\n' 'real bash selected Ω with spaces'`)],
          'toolUse',
        );
      } else if (calls === 1) {
        message = assistant([text('Shell policy guidance was unavailable or unexpected.')], 'stop');
      } else if (calls === 2 && parsed.taskId !== undefined) {
        // M4 后模型入口仅暴露覆盖版 bash;经 bg_status 取回任务快照以观测
        // 实际执行采用的 shell policy(仍是点检而非等待原语)。
        message = assistant([statusToolCall(parsed.taskId)], 'toolUse');
      } else {
        message = assistant([text('Shell policy launch receipt observed.')], 'stop');
      }

      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => pushMessage(stream, message));
      return stream;
    },
  });
}
