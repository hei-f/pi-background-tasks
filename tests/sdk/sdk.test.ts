import { describe, it, afterEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ModelRuntime,
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type EventBus,
  type ExtensionAPI,
  type ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
import {
  parseJsonText,
  type BgTaskSnapshot,
  type TaskStatus,
} from '../../src/core/common.js';
import { BackgroundTaskRegistry } from '../../src/core/registry.js';
import {
  BG_EXTENSION_CAPABILITIES,
  BG_REQUEST_CHANNEL,
  BG_REQUEST_SCHEMA,
  BG_RESPONSE_CHANNEL,
  BG_RESPONSE_SCHEMA,
  BG_TERMINAL_CHANNEL,
  BG_TERMINAL_SCHEMA,
  type BackgroundTaskExtensionResponse,
  type BackgroundTaskExtensionTerminal,
} from '../../src/core/extension-api.js';
import backgroundTasksExtension from '../../src/extension.js';

const extensionPath = resolve('extensions/background-tasks.ts');
const scriptedProviderPath = resolve(
  'tests/scripted-provider/scripted-provider-extension.ts',
);
const roots: string[] = [];

function skipWin32PosixPiTelemetry(t: TestContext): boolean {
  if (process.platform !== 'win32') return false;
  t.skip(
    'POSIX-shell Pi telemetry wrapping is not applicable on win32 cmd tasks by design',
  );
  return true;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function resolvePiCli(): string | undefined {
  const which = spawnSync('bash', ['-lc', 'command -v pi'], {
    encoding: 'utf8',
  });
  return which.status === 0 ? which.stdout.trim() || undefined : undefined;
}

interface SdkHarnessOptions {
  eventBus?: EventBus | undefined;
}

async function harness(options: SdkHarnessOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-sdk-'));
  roots.push(root);
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [extensionPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    noThemes: true,
    ...(options.eventBus === undefined ? {} : { eventBus: options.eventBus }),
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
  });
  const modelRegistry = new ModelRegistry(modelRuntime);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    modelRuntime,
    noTools: 'builtin',
  });
  return { session, cwd, modelRegistry, modelRuntime };
}

type JsonObject = Record<PropertyKey, unknown>;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface TestToolContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface TestToolDetails extends JsonObject {
  task?: unknown;
  tasks?: unknown;
}

interface TestToolResult {
  content: TestToolContent[];
  details: TestToolDetails;
}

interface CustomNotificationEntry {
  type: 'custom_message';
  customType: string;
  content: string;
  details: JsonObject;
}


interface UiNotification {
  message: string;
  type?: 'info' | 'warning' | 'error';
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'killed' ||
    value === 'cancelled' ||
    value === 'lost'
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function isBgTaskSnapshot(value: unknown): value is BgTaskSnapshot {
  return (
    isJsonObject(value) &&
    typeof value['id'] === 'string' &&
    typeof value['command'] === 'string' &&
    isTaskStatus(value['status']) &&
    typeof value['outputPath'] === 'string' &&
    typeof value['cwd'] === 'string' &&
    typeof value['startTime'] === 'number' &&
    typeof value['bytesWritten'] === 'number' &&
    typeof value['isAgent'] === 'boolean' &&
    typeof value['notified'] === 'boolean' &&
    typeof value['notifyOnCompletion'] === 'boolean' &&
    typeof value['triggerOnCompletion'] === 'boolean'
  );
}

function isTestToolContent(value: unknown): value is TestToolContent {
  return isJsonObject(value) && typeof value['type'] === 'string';
}

function isTestToolResult(value: unknown): value is TestToolResult {
  return (
    isJsonObject(value) &&
    Array.isArray(value['content']) &&
    value['content'].every(isTestToolContent) &&
    isJsonObject(value['details'])
  );
}

function isCustomNotificationEntry(
  value: unknown,
): value is CustomNotificationEntry {
  return (
    isJsonObject(value) &&
    value['type'] === 'custom_message' &&
    value['customType'] === 'background-task-notification' &&
    typeof value['content'] === 'string' &&
    isJsonObject(value['details'])
  );
}


function requiredTask(value: unknown, message: string): BgTaskSnapshot {
  assert.ok(isBgTaskSnapshot(value), message);
  return value;
}


function tasksFromResult(result: TestToolResult): BgTaskSnapshot[] {
  const tasks = result.details.tasks;
  assert.ok(Array.isArray(tasks), 'tool result should include a task list');
  return tasks.map((task) =>
    requiredTask(task, 'task list entry should be a background task snapshot'),
  );
}

function firstTask(result: TestToolResult): BgTaskSnapshot {
  const task = tasksFromResult(result)[0];
  assert.ok(
    task,
    'tool result should include at least one background task snapshot',
  );
  return task;
}

function resultText(result: TestToolResult): string {
  const content = result.content[0];
  assert.ok(content, 'tool result should include a content item');
  if (typeof content.text !== 'string') {
    throw new Error('tool result first content item should include text');
  }
  return content.text;
}

/** 覆盖版 bash receipt 文本内的任务 id(`Started background task ... (bXXXX)`)。 */
function taskIdFromReceipt(text: string): string {
  const match = /\(b[0-9a-f]{8}\)/u.exec(text);
  assert.ok(match, 'background task receipt should carry an id');
  return match[0].slice(1, -1);
}

/**
 * 以覆盖版 bash `run_in_background:true` 启动后台任务并立即取回快照:
 * M4 起模型入口只暴露 `{command, timeout, run_in_background}` 三个参数,
 * receipt 文本携带任务 id,快照经 `bg_status` 取回。
 */
async function launchBackgroundTask(
  session: AgentSession,
  command: string,
  timeout?: number,
): Promise<BgTaskSnapshot> {
  const receipt = await exec(session, 'bash', {
    command,
    run_in_background: true,
    ...(timeout === undefined ? {} : { timeout }),
  });
  const id = taskIdFromReceipt(resultText(receipt));
  const status = await exec(session, 'bg_status', { taskId: id });
  return firstTask(status);
}

async function exec(
  session: AgentSession,
  name: string,
  params: unknown,
): Promise<TestToolResult> {
  const tool = session.getToolDefinition(name);
  assert.ok(tool, `missing tool ${name}`);
  const result: unknown = await tool.execute(
    `call-${name}`,
    params,
    undefined,
    undefined,
    session.extensionRunner.createContext(),
  );
  assert.ok(
    isTestToolResult(result),
    `${name} should return a tool result object`,
  );
  return result;
}

async function wait(
  session: AgentSession,
  id: string,
  iterations = 100,
): Promise<BgTaskSnapshot> {
  for (let i = 0; i < iterations; i++) {
    const s = await exec(session, 'bg_status', { taskId: id });
    const t = firstTask(s);
    if (t.status !== 'running') return t;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timeout');
}

function customNotifications(session: AgentSession): CustomNotificationEntry[] {
  const entries: readonly unknown[] = session.sessionManager.getEntries();
  return entries.filter(isCustomNotificationEntry);
}

async function readJsonEventually(path: string): Promise<JsonObject> {
  let last = '';
  for (let i = 0; i < 20; i++) {
    last = await readFile(path, 'utf8').catch(() => '');
    if (last.trim())
      return parseJsonObject(last, 'metadata JSON should be an object');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return parseJsonObject(last, 'metadata JSON should be an object');
}

async function readJsonWithStatus(
  path: string,
  status: string,
): Promise<JsonObject> {
  let metadata = await readJsonEventually(path);
  for (let attempt = 0; attempt < 40; attempt++) {
    metadata = await readJsonEventually(path);
    if (metadata['status'] === status) return metadata;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return metadata;
}

function requireEventResponse(value: unknown): BackgroundTaskExtensionResponse {
  assert.ok(isJsonObject(value), 'EventBus response must be an object');
  assert.equal(value['schema_version'], BG_RESPONSE_SCHEMA);
  assert.equal(typeof value['request_id'], 'string');
  assert.equal(typeof value['operation'], 'string');
  assert.equal(typeof value['ok'], 'boolean');
  const hasResult = Object.prototype.hasOwnProperty.call(value, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(value, 'error');
  assert.notEqual(
    hasResult,
    hasError,
    'EventBus response must contain exactly one of result/error',
  );
  return value as BackgroundTaskExtensionResponse;
}

function requireOkResult(response: BackgroundTaskExtensionResponse): unknown {
  assert.equal(response.ok, true, response.ok ? 'ok' : response.error);
  return response.ok ? response.result : undefined;
}

function requireTerminal(value: unknown): BackgroundTaskExtensionTerminal {
  assert.ok(isJsonObject(value), 'EventBus terminal must be an object');
  const keys = Object.keys(value);
  assert.ok(
    keys.includes('schema_version') && keys.includes('task'),
    'terminal frame must carry schema_version and task',
  );
  assert.equal(value['schema_version'], BG_TERMINAL_SCHEMA);
  // M5 向后兼容字段(originMeta/status/failedReason/initiator/summaryTail/usage)
  // 均为可选;originMeta 为 bash 后台来源标识
  assert.equal(
    (value['originMeta'] as JsonObject | undefined)?.['backgroundSource'],
    'bash',
  );
  return {
    schema_version: BG_TERMINAL_SCHEMA,
    task: requiredTask(value['task'], 'terminal task'),
  };
}

// The EventBus kill response is only emitted after stopTask resolves. On Windows
// the two-stage taskkill flow issues a logical terminate request first and waits
// the full KILL_GRACE_MS window (3000 ms) before forcing, so a kill response
// cannot arrive inside the POSIX budget. POSIX keeps the tight budget so a
// genuine hang still fails fast there.
const EVENT_RESPONSE_TIMEOUT_MS = process.platform === 'win32' ? 10_000 : 1500;

function waitForEventResponse(
  eventBus: EventBus,
  requestId: string,
): Promise<BackgroundTaskExtensionResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for EventBus response ${requestId}`));
    }, EVENT_RESPONSE_TIMEOUT_MS);
    const unsubscribe = eventBus.on(BG_RESPONSE_CHANNEL, (data) => {
      const response = requireEventResponse(data);
      if (response.request_id !== requestId) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(response);
    });
  });
}

async function emitEventRequest(
  eventBus: EventBus,
  requestId: string,
  operation: string,
  payload: Record<string, unknown>,
): Promise<BackgroundTaskExtensionResponse> {
  const pending = waitForEventResponse(eventBus, requestId);
  eventBus.emit(BG_REQUEST_CHANNEL, {
    schema_version: BG_REQUEST_SCHEMA,
    request_id: requestId,
    operation,
    payload,
  });
  return pending;
}

// Matches EVENT_RESPONSE_TIMEOUT_MS: a killed task only reaches a terminal state
// after the Windows grace window elapses, so the same platform budget applies.
const TERMINAL_SNAPSHOT_POLL_MS = 25;
const TERMINAL_SNAPSHOT_ATTEMPTS =
  EVENT_RESPONSE_TIMEOUT_MS / TERMINAL_SNAPSHOT_POLL_MS;

async function waitForTerminalSnapshot(
  terminals: readonly BgTaskSnapshot[],
  taskId: string,
): Promise<BgTaskSnapshot> {
  for (let attempt = 0; attempt < TERMINAL_SNAPSHOT_ATTEMPTS; attempt++) {
    const terminal = terminals.find((task) => task.id === taskId);
    if (terminal) return terminal;
    await new Promise((resolve) =>
      setTimeout(resolve, TERMINAL_SNAPSHOT_POLL_MS),
    );
  }
  throw new Error(`timed out waiting for terminal ${taskId}`);
}

async function cleanupRoot(root: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
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

afterEach(async () => {
  for (const r of roots.splice(0)) await cleanupRoot(r);
});

function makeStatusUi(
  baseUi: ExtensionUIContext,
  statuses: Array<string | undefined>,
  notifications: UiNotification[],
): ExtensionUIContext {
  return {
    ...baseUi,
    notify: (message, type) => {
      const notification: UiNotification = { message };
      if (type !== undefined) notification.type = type;
      notifications.push(notification);
    },
    setStatus: (_key, text) => {
      statuses.push(text);
    },
  };
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}

void describe('sdk', () => {
  void it('registers commands, tools, shortcuts, renderers, and runs with output and metadata files', async () => {
    const { session, cwd } = await harness();
    try {
      for (const tool of ['bash', 'bg_status', 'bg_logs', 'bg_kill'])
        assert.ok(session.getActiveToolNames().includes(tool), tool);
      assert.ok(
        !session.getActiveToolNames().includes('bg_run'),
        'bg_run tool should be retired (M4)',
      );
      const bashTool = session.getToolDefinition('bash');
      assert.ok(bashTool, 'covered bash tool should be registered');
      const bashParams: unknown = bashTool.parameters;
      assert.ok(isJsonObject(bashParams), 'bash schema should be an object');
      const required = bashParams['required'];
      assert.ok(
        Array.isArray(required) && required.includes('command'),
        'covered bash schema must require command',
      );
      const properties = bashParams['properties'];
      const runInBackgroundSchema = isJsonObject(properties)
        ? properties['run_in_background']
        : undefined;
      assert.match(
        JSON.stringify(runInBackgroundSchema),
        /background task/,
        'bash schema must carry the optional run_in_background field',
      );
      const cmds = session.extensionRunner
        .getRegisteredCommands()
        .map((c) => c.invocationName);
      for (const cmd of ['bg-jobs', 'bg-logs', 'bg-kill', 'bg-clear'])
        assert.ok(cmds.includes(cmd), cmd);
      assert.ok(
        session.extensionRunner.getMessageRenderer(
          'background-task-notification',
        ),
      );
      const shortcuts = session.extensionRunner.getShortcuts({});
      assert.ok(shortcuts.has('shift+down'));
      assert.ok(shortcuts.has('ctrl+alt+c'));

      const receipt = await exec(session, 'bash', {
        command: 'echo sdk-ok',
        run_in_background: true,
      });
      const id = taskIdFromReceipt(resultText(receipt));
      const t = await wait(session, id);
      assert.equal(t.status, 'completed');
      const derivedName = t.name;
      assert.ok(derivedName && derivedName.length > 0, 'derived task name should exist');
      assert.equal(t.isAgent, false);
      assert.ok(existsSync(join(cwd, t.outputPath)));
      const metadataPath = join(
        cwd,
        t.outputPath.replace(/\.output$/, '.json'),
      );
      assert.ok(existsSync(metadataPath));
      const metadata = await readJsonWithStatus(metadataPath, 'completed');
      assert.equal(metadata['status'], 'completed');
      assert.equal(metadata['name'], derivedName);
      assert.equal(metadata['isAgent'], false);
      const logs = await exec(session, 'bg_logs', {
        taskId: t.id,
        maxBytes: 100,
      });
      assert.match(resultText(logs), /sdk-ok/);
      await assert.rejects(
        () => exec(session, 'bg_kill', { taskId: t.id }),
        /not running/,
      );
    } finally {
      await session.extensionRunner.emit({
        type: 'session_shutdown',
        reason: 'quit',
      });
      session.dispose();
    }
  });

  void it('BUG-181 exposes an event-driven prompt contract and truthful launch receipts', async () => {
    const eventBus = createEventBus();
    const { session } = await harness({ eventBus });
    try {
      await session.extensionRunner.emit({
        type: 'session_start',
        reason: 'startup',
      });
      const ctx = session.extensionRunner.createContext();
      const systemPrompt = ctx.getSystemPrompt();
      assert.match(
        systemPrompt,
        /do not sleep or poll merely to wait/,
      );
      assert.match(systemPrompt, /starts a follow-up agent turn/);
      assert.match(
        systemPrompt,
        /A running result is not an instruction to poll again/,
      );
      assert.match(
        systemPrompt,
        /Do not repeatedly call bg_logs to wait for completion/,
      );
      assert.match(
        systemPrompt,
        /Treat <background-task-notification> as durable terminal truth/,
      );
      assert.doesNotMatch(
        systemPrompt,
        /After bg_run, use bg_status and bg_logs to inspect progress/,
      );

      const bash = session.getToolDefinition('bash');
      const bgStatus = session.getToolDefinition('bg_status');
      const bgLogs = session.getToolDefinition('bg_logs');
      assert.ok(
        bash && bgStatus && bgLogs,
        'covered bash and background inspection tools should be registered',
      );
      // 「不 sleep/poll 等待」指引位于系统提示(promptGuidelines);工具描述
      // 层面断言覆盖版 bash 的等价宿主语义与后台入口字段
      assert.match(
        bash.description,
        /identical to the built-in bash tool/,
      );
      assert.match(bash.description, /run_in_background:true/);
      assert.match(bgStatus.description, /not a waiting primitive/);
      assert.match(bgLogs.description, /not a waiting primitive/);

      // shellQuote emits POSIX single quotes, which cmd.exe does not understand.
      const longCommand = `node -e ${JSON.stringify('setTimeout(() => {}, 10000)')}`;

      // 覆盖版 bash 模型入口缺省绑定 notify+trigger:receipt 文本即交付指引。
      const receipt = await exec(session, 'bash', {
        command: longCommand,
        run_in_background: true,
      });
      const receiptText = resultText(receipt);
      assert.ok(
        receiptText.includes('Terminal notification: enabled.'),
        'default model entry receipt should enable terminal notification',
      );
      assert.ok(
        receiptText.includes('Automatic follow-up turn: enabled.'),
        'default model entry receipt should enable automatic follow-up',
      );
      assert.ok(
        receiptText.includes('Next action: do not poll or sleep'),
        'default model entry receipt should instruct not to poll',
      );
      assert.equal(
        Reflect.get(receipt, 'terminate'),
        undefined,
        'covered bash background launch must remain non-terminating',
      );

      // 交付组合的 snapshot 真值经 EventBus run 请求验证(覆盖版 bash 不再
      // 暴露 notifyOnCompletion/triggerOnCompletion 参数;run 请求闭包 schema
      // 要求两布尔必填,「缺省」即显式 notify=true + trigger=false;receipt
      // 文本组合由单测 deriveCompletionDeliveryGuidance 覆盖)。
      const cases = [
        {
          name: 'Default Delivery',
          notifyOnCompletion: true,
          triggerOnCompletion: false,
          expectedNotify: true,
          expectedTrigger: false,
        },
        {
          name: 'Notification Only',
          notifyOnCompletion: true,
          triggerOnCompletion: false,
          expectedNotify: true,
          expectedTrigger: false,
        },
        {
          name: 'Disabled Requested Wake',
          notifyOnCompletion: false,
          triggerOnCompletion: true,
          expectedNotify: false,
          expectedTrigger: true,
        },
        {
          name: 'Manual Delivery',
          notifyOnCompletion: false,
          triggerOnCompletion: false,
          expectedNotify: false,
          expectedTrigger: false,
        },
      ] as const;

      for (const testCase of cases) {
        const payload: Record<string, unknown> = {
          name: testCase.name,
          command: longCommand,
          isAgent: false,
          notifyOnCompletion: testCase.notifyOnCompletion,
          triggerOnCompletion: testCase.triggerOnCompletion,
        };
        const run = await emitEventRequest(
          eventBus,
          `sdk-delivery-${testCase.name.replaceAll(' ', '-')}`,
          'run',
          payload,
        );
        const task = requiredTask(requireOkResult(run), 'delivery run task');
        assert.equal(task.notifyOnCompletion, testCase.expectedNotify);
        assert.equal(task.triggerOnCompletion, testCase.expectedTrigger);
      }
    } finally {
      await session.extensionRunner.emit({
        type: 'session_shutdown',
        reason: 'quit',
      });
      session.dispose();
    }
  });

  void it('serves real extension EventBus requests and terminal events through the shared registry', async () => {
    const eventBus = createEventBus();
    const terminals: BgTaskSnapshot[] = [];
    const eventOrder: string[] = [];
    const unsubscribeResponseOrder = eventBus.on(
      BG_RESPONSE_CHANNEL,
      (data) => {
        const response = requireEventResponse(data);
        if (
          response.request_id === 'sdk-run' ||
          response.request_id === 'sdk-kill'
        ) {
          eventOrder.push(`response:${response.request_id}`);
        }
      },
    );
    const unsubscribeTerminal = eventBus.on(BG_TERMINAL_CHANNEL, (data) => {
      const task = requireTerminal(data).task;
      terminals.push(task);
      eventOrder.push(`terminal:${task.id}:${task.status}`);
    });
    const { session, cwd } = await harness({ eventBus });
    try {
      await session.extensionRunner.emit({
        type: 'session_start',
        reason: 'startup',
      });
      const caps = await emitEventRequest(
        eventBus,
        'sdk-cap',
        'capabilities',
        {},
      );
      assert.deepEqual(requireOkResult(caps), BG_EXTENSION_CAPABILITIES);

      const run = await emitEventRequest(eventBus, 'sdk-run', 'run', {
        name: 'EventBus Echo',
        command: 'echo api-ok',
        isAgent: false,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const task = requiredTask(requireOkResult(run), 'run result task');
      assert.equal(task.name, 'EventBus Echo');
      assert.ok(
        task.status === 'running' || task.status === 'completed',
        `immediate run response status should be a valid launch snapshot, got ${task.status}`,
      );
      assert.ok(existsSync(join(cwd, task.outputPath)));
      const terminal = await waitForTerminalSnapshot(terminals, task.id);
      assert.equal(terminal.status, 'completed');
      assert.equal(terminals.filter((entry) => entry.id === task.id).length, 1);
      assert.ok(
        eventOrder.findIndex(
          (entry) => entry === `terminal:${task.id}:completed`,
        ) > eventOrder.indexOf('response:sdk-run'),
        'completed terminal must follow the correlated run response',
      );

      const logs = await emitEventRequest(eventBus, 'sdk-logs', 'logs', {
        taskId: task.id,
        maxBytes: 100,
        tail: true,
      });
      const logsResult = requiredJsonObject(
        requireOkResult(logs),
        'logs result must be an object',
      );
      assert.match(String(logsResult['text']), /api-ok/u);
      assert.equal(requiredTask(logsResult['task'], 'logs task').id, task.id);
      assert.equal(logsResult['tail'], true);

      const status = await emitEventRequest(eventBus, 'sdk-status', 'status', {
        taskId: task.id,
      });
      const statusResult = requiredJsonObject(
        requireOkResult(status),
        'status result must be an object',
      );
      const statusTasks = statusResult['tasks'];
      assert.ok(Array.isArray(statusTasks), 'status tasks should be an array');
      assert.equal(
        requiredTask(statusTasks[0], 'status task').status,
        'completed',
      );

      const sleep = await emitEventRequest(eventBus, 'sdk-sleep', 'run', {
        name: 'EventBus Sleep',
        // `exec` is a POSIX shell builtin and shellQuote emits POSIX quoting;
        // neither is valid under cmd.exe. Node's own quoting handles both.
        command: `node -e ${JSON.stringify('setTimeout(() => {}, 5000)')}`,
        isAgent: false,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const sleepTask = requiredTask(requireOkResult(sleep), 'sleep run task');
      const kill = await emitEventRequest(eventBus, 'sdk-kill', 'kill', {
        taskId: sleepTask.id,
      });
      const killResult = requiredJsonObject(
        requireOkResult(kill),
        'kill result must be an object',
      );
      // M2 迁移表:user/model 发起停止 → cancelled(system 关闭 → killed)
      assert.equal(
        requiredTask(killResult['task'], 'kill task').status,
        'cancelled',
      );
      const sleepTerminal = await waitForTerminalSnapshot(
        terminals,
        sleepTask.id,
      );
      assert.equal(sleepTerminal.status, 'cancelled');
      assert.equal(
        terminals.filter((entry) => entry.id === sleepTask.id).length,
        1,
      );
      assert.ok(
        eventOrder.findIndex(
          (entry) => entry === `terminal:${sleepTask.id}:cancelled`,
        ) > eventOrder.indexOf('response:sdk-kill'),
        'cancelled terminal must follow the kill response',
      );

      const malformed = await emitEventRequest(
        eventBus,
        'sdk-malformed',
        'run',
        {
          name: 'Bad EventBus Run',
          command: 'echo nope',
          isAgent: false,
          timeoutSeconds: null,
          notifyOnCompletion: true,
          triggerOnCompletion: true,
        },
      );
      assert.equal(malformed.ok, false);
      assert.match(malformed.ok ? '' : malformed.error, /positive integer/u);

      const unknown = await emitEventRequest(
        eventBus,
        'sdk-unknown',
        'mystery',
        {},
      );
      assert.equal(unknown.ok, false);
      assert.equal(unknown.operation, 'mystery');

      const firstDuplicate = await emitEventRequest(
        eventBus,
        'sdk-dup',
        'capabilities',
        {},
      );
      assert.equal(firstDuplicate.ok, true);
      const duplicate = await emitEventRequest(
        eventBus,
        'sdk-dup',
        'capabilities',
        {},
      );
      assert.equal(duplicate.ok, false);
      assert.match(
        duplicate.ok ? '' : duplicate.error,
        /duplicate request_id/u,
      );
    } finally {
      unsubscribeTerminal();
      unsubscribeResponseOrder();
      await session.extensionRunner.emit({
        type: 'session_shutdown',
        reason: 'quit',
      });
      session.dispose();
    }
  });

  void it('uses AgentSession.reload() to invalidate old runners and bind fresh EventBus activations', async () => {
    const eventBus = createEventBus();
    const responses: BackgroundTaskExtensionResponse[] = [];
    const terminals: BgTaskSnapshot[] = [];
    const unsubscribeResponses = eventBus.on(BG_RESPONSE_CHANNEL, (data) => {
      responses.push(requireEventResponse(data));
    });
    const unsubscribeTerminals = eventBus.on(BG_TERMINAL_CHANNEL, (data) => {
      terminals.push(requireTerminal(data).task);
    });
    const { session } = await harness({ eventBus });
    let bound = false;
    try {
      await session.bindExtensions({ onError: () => undefined });
      bound = true;
      for (let cycle = 1; cycle <= 2; cycle++) {
        const oldRunner = session.extensionRunner;
        const oldContext = oldRunner.createContext();
        const runningRequestId = `real-reload-${String(cycle)}-running`;
        const running = await emitEventRequest(
          eventBus,
          runningRequestId,
          'run',
          {
            name: `Real Reload Running ${String(cycle)}`,
            command: `node -e ${JSON.stringify('setTimeout(() => {}, 10000)')}`,
            isAgent: false,
            notifyOnCompletion: false,
            triggerOnCompletion: false,
          },
        );
        const runningTask = requiredTask(
          requireOkResult(running),
          'real reload running task',
        );
        assert.equal(runningTask.status, 'running');

        await session.reload();
        assert.notEqual(
          session.extensionRunner,
          oldRunner,
          'reload must install a fresh runner',
        );
        assert.throws(
          () => oldContext.cwd,
          /stale after session replacement or reload/u,
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(
          terminals.filter((task) => task.id === runningTask.id).length,
          0,
          'reload-killed tasks must not publish on the disposed activation',
        );

        const quickRequestId = `real-reload-${String(cycle)}-quick`;
        const quick = await emitEventRequest(eventBus, quickRequestId, 'run', {
          name: `Real Reload Quick ${String(cycle)}`,
          command: 'echo reload-ok',
          isAgent: false,
          notifyOnCompletion: false,
          triggerOnCompletion: false,
        });
        const quickTask = requiredTask(
          requireOkResult(quick),
          'real reload quick task',
        );
        await waitForTerminalSnapshot(terminals, quickTask.id);
        assert.equal(
          responses.filter((response) => response.request_id === quickRequestId)
            .length,
          1,
          'only the freshly bound activation may answer after reload',
        );
        assert.equal(
          terminals.filter((task) => task.id === quickTask.id).length,
          1,
          'the fresh activation must publish exactly one ordinary terminal',
        );
      }
    } finally {
      unsubscribeTerminals();
      unsubscribeResponses();
      if (bound) {
        await session.extensionRunner.emit({
          type: 'session_shutdown',
          reason: 'quit',
        });
      }
      session.dispose();
    }
  });

  void it('keeps an overlapping late session_start continuation from recreating status resources', async () => {
    type LifecycleHandler = (
      event: Record<string, unknown>,
      ctx: JsonObject,
    ) => unknown;
    const root = await mkdtemp(join(tmpdir(), 'pi-bg-late-session-start-'));
    roots.push(root);
    const cwd = join(root, 'project');
    await mkdir(cwd, { recursive: true });
    const handlers = new Map<string, LifecycleHandler[]>();
    const pi: ExtensionAPI = Object.assign(Object.create(null), {
      events: createEventBus(),
      on(name: string, handler: LifecycleHandler) {
        const registered = handlers.get(name) ?? [];
        registered.push(handler);
        handlers.set(name, registered);
        return () => undefined;
      },
      registerTool() {},
      registerCommand() {},
      registerShortcut() {},
      registerMessageRenderer() {},
      sendMessage() {},
      getThinkingLevel() {
        return 'off';
      },
      getActiveTools() {
        return [];
      },
      setActiveTools() {},
    });
    const ctx: JsonObject = {
      cwd,
      sessionManager: { getSessionId: () => 'late-session-start' },
      modelRegistry: { getAll: () => [] },
      model: undefined,
      hasUI: false,
      mode: 'print',
      ui: { setStatus() {}, setWidget() {}, notify() {} },
    };
    const dispatch = async (
      name: string,
      event: Record<string, unknown>,
    ): Promise<void> => {
      for (const handler of [...(handlers.get(name) ?? [])])
        await handler(event, ctx);
    };
    await backgroundTasksExtension(pi);

    const originalEnsureRuntimeDir =
      BackgroundTaskRegistry.prototype.ensureRuntimeDir;
    const enteredEnsure = deferred<void>();
    const releaseEnsure = deferred<void>();
    const activeIntervals = new Set<ReturnType<typeof setInterval>>();
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      const handle = realSetInterval(...args);
      activeIntervals.add(handle);
      return handle;
    }) as typeof setInterval;
    globalThis.clearInterval = ((handle?: ReturnType<typeof setInterval>) => {
      if (handle !== undefined) activeIntervals.delete(handle);
      return realClearInterval(handle);
    }) as typeof clearInterval;
    BackgroundTaskRegistry.prototype.ensureRuntimeDir = async function (
      context,
    ) {
      enteredEnsure.resolve(undefined);
      await releaseEnsure.promise;
      return originalEnsureRuntimeDir.call(this, context);
    };

    try {
      const start = dispatch('session_start', {
        type: 'session_start',
        reason: 'startup',
      });
      await enteredEnsure.promise;
      await dispatch('session_shutdown', {
        type: 'session_shutdown',
        reason: 'reload',
      });
      assert.equal(
        activeIntervals.size,
        0,
        'shutdown must clear all pre-existing intervals',
      );

      releaseEnsure.resolve(undefined);
      await start;
      assert.equal(
        activeIntervals.size,
        0,
        'the old session_start continuation must not create a post-shutdown interval',
      );
    } finally {
      releaseEnsure.resolve(undefined);
      for (const handle of activeIntervals) realClearInterval(handle);
      activeIntervals.clear();
      BackgroundTaskRegistry.prototype.ensureRuntimeDir =
        originalEnsureRuntimeDir;
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    }
  });

  void it('supports status/log prefix resolution, all-task listing, head/tail truncation, and ambiguous/unknown ID errors', async () => {
    const { session } = await harness();
    try {
      // The head/tail assertions below are byte-exact, so the command must
      // emit exactly six bytes with no trailing newline. `printf` is
      // POSIX-only and `echo` appends a newline, so use node directly.
      const first = await launchBackgroundTask(
        session,
        `node -e ${JSON.stringify('process.stdout.write("abcdef")')}`,
      );
      const second = await launchBackgroundTask(
        session,
        `node -e ${JSON.stringify('process.stdout.write("123456")')}`,
      );
      const firstDone = await wait(session, first.id);
      await wait(session, second.id);
      const all = await exec(session, 'bg_status', {});
      assert.ok(tasksFromResult(all).length >= 2);
      const byPrefix = await exec(session, 'bg_status', {
        taskId: firstDone.id.slice(0, 5),
      });
      assert.equal(firstTask(byPrefix).id, firstDone.id);
      await assert.rejects(
        () => exec(session, 'bg_status', { taskId: 'b' }),
        /Ambiguous task ID prefix/,
      );
      await assert.rejects(
        () => exec(session, 'bg_status', { taskId: 'bdeadbeef' }),
        /Unknown background task ID/,
      );
      const head = await exec(session, 'bg_logs', {
        taskId: firstDone.id,
        maxBytes: 3,
        tail: false,
      });
      assert.match(resultText(head), /^abc/);
      assert.match(resultText(head), /Showing head/);
      const tail = await exec(session, 'bg_logs', {
        taskId: firstDone.id,
        maxBytes: 3,
        tail: true,
      });
      assert.match(resultText(tail), /def/);
      assert.match(resultText(tail), /Showing tail/);
      await assert.rejects(
        () => exec(session, 'bg_logs', { taskId: 'bdeadbeef' }),
        /Unknown background task ID/,
      );
    } finally {
      await session.extensionRunner.emit({
        type: 'session_shutdown',
        reason: 'quit',
      });
      session.dispose();
    }
  });

  void it('kills running tasks and rejects unknown or completed kills loudly', async () => {
    const { session } = await harness();
    try {
      const task = await launchBackgroundTask(
        session,
        `node -e ${JSON.stringify('setTimeout(() => {}, 10000)')}`,
      );
      const k = await exec(session, 'bg_kill', { taskId: task.id.slice(0, 6) });
      // M2 迁移表:工具(bg_kill)为 model 发起停止 → cancelled
      assert.match(resultText(k), /Killed|cancelled|Cancelled/);
      const t = await wait(session, task.id);
      assert.equal(t.status, 'cancelled');
      await assert.rejects(
        () => exec(session, 'bg_kill', { taskId: t.id }),
        /not running/,
      );
      await assert.rejects(
        () => exec(session, 'bg_kill', { taskId: 'bdeadbeef' }),
        /Unknown background task ID/,
      );
    } finally {
      await session.extensionRunner.emit({
        type: 'session_shutdown',
        reason: 'quit',
      });
      session.dispose();
    }
  });

  void it('fails timed-out tasks loudly', async () => {
    const { session } = await harness();
    try {
      // 覆盖版 bash 的 `timeout` 秒参映射为后台 timeoutSeconds。
      const task = await launchBackgroundTask(
        session,
        `node -e ${JSON.stringify('setTimeout(() => {}, 5000)')}`,
        1,
      );
      const t = await wait(session, task.id, 80);
      assert.equal(t.status, 'failed');
      assert.match(t.error ?? '', /Timed out after 1s/);
      const logs = await exec(session, 'bg_logs', {
        taskId: t.id,
        maxBytes: 1000,
      });
      assert.match(resultText(logs), /background task timeout/);
    } finally {
      await session.extensionRunner.emit({
        type: 'session_shutdown',
        reason: 'quit',
      });
      session.dispose();
    }
  });

  void it('records completion notifications exactly once when enabled and suppresses them when disabled', async () => {
    const eventBus = createEventBus();
    const { session } = await harness({ eventBus });
    try {
      await session.extensionRunner.emit({
        type: 'session_start',
        reason: 'startup',
      });
      // 交付选项在 M4 后仅经 EventBus run 请求携带(覆盖版 bash 不再暴露)。
      const notifiedRun = await emitEventRequest(
        eventBus,
        'sdk-notified',
        'run',
        {
          name: 'Notify SDK',
          // The payload deliberately contains <, > and & to exercise escaping
          // of task output. Those are cmd.exe redirection and separator
          // metacharacters, so the literal must not appear in the command
          // line; it is rebuilt from character codes inside the child instead.
          command: `node -e ${JSON.stringify(
            'process.stdout.write(String.fromCharCode(60)+"ok"+String.fromCharCode(62,38)+"done")',
          )}`,
          isAgent: false,
          notifyOnCompletion: true,
          triggerOnCompletion: false,
        },
      );
      const notified = requiredTask(
        requireOkResult(notifiedRun),
        'notified run task',
      );
      const hiddenRun = await emitEventRequest(eventBus, 'sdk-hidden', 'run', {
        name: 'No Notify SDK',
        command: 'echo quiet',
        isAgent: false,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const hiddenTask = requiredTask(
        requireOkResult(hiddenRun),
        'hidden run task',
      );
      await wait(session, notified.id);
      await wait(session, hiddenTask.id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const notes = customNotifications(session);
      assert.equal(notes.length, 1);
      const note = notes[0];
      assert.ok(note, 'completion notification should be recorded');
      assert.match(note.content, /<task-name>Notify SDK<\/task-name>/);
      assert.match(note.content, /<status>completed<\/status>/);
      assert.match(note.content, /&quot;|Notify SDK/);
      assert.equal(note.details['notified'], true);
      const status = await exec(session, 'bg_status', {
        taskId: hiddenTask.id,
      });
      assert.equal(firstTask(status).notified, false);
    } finally {
      await session.extensionRunner.emit({
        type: 'session_shutdown',
        reason: 'quit',
      });
      session.dispose();
    }
  });

  void it('captures only task-owned explicit telemetry in snapshots and metadata', async () => {
    const eventBus = createEventBus();
    const { session, cwd } = await harness({ eventBus });
    try {
      await session.extensionRunner.emit({
        type: 'session_start',
        reason: 'startup',
      });
      assert.ok(
        !session.getActiveToolNames().includes('bg_run'),
        'bg_run tool should be retired (M4)',
      );
      // 显式 agent 标记在 M4 后仅经 EventBus run 请求携带(覆盖版 bash 不暴露
      // isAgent);父上下文 getContextUsage 不被采集,快照只含任务自有遥测。
      const script = `console.log(JSON.stringify({ type: "background-task-telemetry", model: "test-provider/test-model", contextUsage: { tokens: 50000, contextWindow: 200000, percent: 25 }, tokenUsage: { input: 1000, output: 200, cacheRead: 30, cacheWrite: 20, totalTokens: 1250 }, toolUsage: { total: 2, failed: 1, byName: { read: 1, bash: 1 } } })); console.log("context");`;
      const command = `node -e ${JSON.stringify(script)}`;
      const run = await emitEventRequest(eventBus, 'sdk-context', 'run', {
        name: 'Context SDK',
        command,
        isAgent: true,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      assert.ok(
        isJsonObject(requireOkResult(run)),
        'run should return a snapshot result',
      );
      const t = await wait(
        session,
        requiredTask(requireOkResult(run), 'context run task').id,
      );
      assert.deepEqual(t.contextUsage, {
        tokens: 50_000,
        contextWindow: 200_000,
        percent: 25,
      });
      assert.deepEqual(t.tokenUsage, {
        input: 1000,
        output: 200,
        cacheRead: 30,
        cacheWrite: 20,
        totalTokens: 1250,
      });
      assert.deepEqual(t.toolUsage, {
        total: 2,
        failed: 1,
        byName: { read: 1, bash: 1 },
      });
      assert.equal(t.model, 'test-provider/test-model');
      const status = await exec(session, 'bg_status', { taskId: t.id });
      assert.match(resultText(status), /ctx=25\.0%\/200k/);
      assert.match(resultText(status), /model=test-provider\/test-model/);
      assert.match(resultText(status), /tokens=1\.3k/);
      assert.match(resultText(status), /tools=2 failed=1/);
      const metadataPath = join(
        cwd,
        t.outputPath.replace(/\.output$/, '.json'),
      );
      let metadata = parseJsonObject(
        await readFile(metadataPath, 'utf8'),
        'telemetry metadata should be an object',
      );
      for (let attempt = 0; attempt < 40; attempt++) {
        metadata = parseJsonObject(
          await readFile(metadataPath, 'utf8'),
          'telemetry metadata should be an object',
        );
        if (metadata['contextUsage'] !== undefined) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.deepEqual(metadata['contextUsage'], {
        tokens: 50_000,
        contextWindow: 200_000,
        percent: 25,
      });
      assert.deepEqual(metadata['tokenUsage'], t.tokenUsage);
      assert.deepEqual(metadata['toolUsage'], t.toolUsage);
      assert.equal(metadata['model'], 'test-provider/test-model');

      const legacyRun = await emitEventRequest(
        eventBus,
        'sdk-legacy-context',
        'run',
        {
          name: 'Legacy Context SDK',
          command: `node -e ${JSON.stringify('console.log(JSON.stringify({ type: "background-task-context-usage", tokens: 42, contextWindow: 1000, percent: 4.2 }))')}`,
          isAgent: false,
          notifyOnCompletion: false,
          triggerOnCompletion: false,
        },
      );
      const legacyTask = await wait(
        session,
        requiredTask(requireOkResult(legacyRun), 'legacy run task').id,
      );
      assert.deepEqual(legacyTask.contextUsage, {
        tokens: 42,
        contextWindow: 1000,
        percent: 4.2,
      });
      assert.equal(legacyTask.tokenUsage, undefined);

      const noTelemetryRun = await emitEventRequest(
        eventBus,
        'sdk-no-context',
        'run',
        {
          name: 'No Context SDK',
          command: 'echo no-context',
          isAgent: false,
          notifyOnCompletion: false,
          triggerOnCompletion: false,
        },
      );
      const noTelemetryTask = await wait(
        session,
        requiredTask(requireOkResult(noTelemetryRun), 'no-context run task').id,
      );
      assert.equal(noTelemetryTask.contextUsage, undefined);
      assert.equal(noTelemetryTask.tokenUsage, undefined);
      assert.equal(noTelemetryTask.toolUsage, undefined);
      assert.equal(noTelemetryTask.model, undefined);
    } finally {
      await session.extensionRunner.emit({
        type: 'session_shutdown',
        reason: 'quit',
      });
      session.dispose();
    }
  });

  void it('wraps explicitly marked background Pi agents and captures context telemetry', async (t) => {
    if (skipWin32PosixPiTelemetry(t)) return;
    const eventBus = createEventBus();
    const { session, cwd } = await harness({ eventBus });
    const oldPath = process.env['PATH'];
    try {
      await session.extensionRunner.emit({
        type: 'session_start',
        reason: 'startup',
      });
      const bin = join(cwd, 'bin');
      await mkdir(bin, { recursive: true });
      const fakePi = join(bin, 'pi');
      await writeFile(
        fakePi,
        `#!/usr/bin/env node
const args = process.argv.slice(2);
if (!args.includes("--mode") || args[args.indexOf("--mode") + 1] !== "json") {
  console.error("expected --mode json: " + JSON.stringify(args));
  process.exit(3);
}
if (args.includes("-p") || args.includes("--print")) {
  console.error("print flag should be removed: " + JSON.stringify(args));
  process.exit(4);
}
const firstMessage = {
  role: "assistant",
  model: "openai-codex/gpt-5.5",
  usage: { input: 1000, output: 200, cacheRead: 30, cacheWrite: 20, totalTokens: 1250 },
  content: [{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "README.md" } }],
  stopReason: "toolUse",
  timestamp: Date.now()
};
const secondMessage = {
  role: "assistant",
  model: "openai-codex/gpt-5.5",
  usage: { input: 300, output: 50, cacheRead: 0, cacheWrite: 10, totalTokens: 360 },
  content: [{ type: "text", text: "fake child final" }],
  stopReason: "stop",
  timestamp: Date.now()
};
console.log(JSON.stringify({ type: "message_end", message: firstMessage }));
console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "call-read", toolName: "read", args: { path: "README.md" } }));
console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "call-read", toolName: "read", result: {}, isError: false }));
console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "call-bash", toolName: "bash", args: { command: "false" } }));
console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "call-bash", toolName: "bash", result: {}, isError: true }));
console.log(JSON.stringify({ type: "message_end", message: secondMessage }));
`,
        'utf8',
      );
      await chmod(fakePi, 0o755);
      process.env['PATH'] = `${bin}${delimiter}${oldPath ?? ''}`;

      const runRequest = await emitEventRequest(
        eventBus,
        'sdk-wrapped-pi',
        'run',
        {
          name: 'Wrapped Pi Agent',
          command: 'pi --model openai-codex/gpt-5.5 -p hello',
          isAgent: true,
          notifyOnCompletion: false,
          triggerOnCompletion: false,
        },
      );
      const t = await wait(
        session,
        requiredTask(requireOkResult(runRequest), 'wrapped pi run task').id,
      );
      assert.equal(t.status, 'completed');
      assert.deepEqual(t.contextUsage, {
        tokens: 360,
        contextWindow: 272000,
        percent: (360 / 272000) * 100,
      });
      assert.deepEqual(t.tokenUsage, {
        input: 1300,
        output: 250,
        cacheRead: 30,
        cacheWrite: 30,
        totalTokens: 1610,
      });
      assert.deepEqual(t.toolUsage, {
        total: 2,
        failed: 1,
        byName: { read: 1, bash: 1 },
      });
      assert.equal(t.model, 'openai-codex/gpt-5.5');
      const status = await exec(session, 'bg_status', { taskId: t.id });
      assert.match(resultText(status), /model=openai-codex\/gpt-5\.5/);
      assert.match(resultText(status), /tokens=1\.6k/);
      assert.match(resultText(status), /tools=2 failed=1/);
      const logs = await exec(session, 'bg_logs', {
        taskId: t.id,
        maxBytes: 4000,
        tail: false,
      });
      const logText = resultText(logs);
      assert.match(logText, /\u2192 read README\.md/);
      assert.match(logText, /\u2717 bash failed/);
      assert.match(logText, /fake child final/);
      assert.doesNotMatch(logText, /background-task-telemetry/);
      assert.doesNotMatch(logText, /background-task-context-usage/);
      assert.doesNotMatch(logText, /background-task-activity/);
      const metadataPath = join(
        cwd,
        t.outputPath.replace(/\.output$/, '.json'),
      );
      const metadata = parseJsonObject(
        await readFile(metadataPath, 'utf8'),
        'wrapped Pi metadata should be an object',
      );
      assert.deepEqual(metadata['contextUsage'], t.contextUsage);
      assert.deepEqual(metadata['tokenUsage'], t.tokenUsage);
      assert.deepEqual(metadata['toolUsage'], t.toolUsage);
      assert.equal(metadata['model'], 'openai-codex/gpt-5.5');
    } finally {
      restoreEnvValue('PATH', oldPath);
      await session.extensionRunner.emit({
        type: 'session_shutdown',
        reason: 'quit',
      });
      session.dispose();
    }
  });

  void it(
    'wraps an explicitly marked real child Pi and counts JSON token/tool telemetry',
    { timeout: 20_000 },
    async (t) => {
      if (process.platform === 'win32') {
        t.skip(
          'POSIX shell env-prefix child-pi telemetry smoke is not portable to Windows',
        );
        return;
      }
      const piCli = resolvePiCli();
      if (!piCli) {
        t.skip(
          'pi CLI is not available on PATH for real child-pi telemetry smoke',
        );
        return;
      }
      const eventBus = createEventBus();
      const { session, cwd } = await harness({ eventBus });
      try {
        await session.extensionRunner.emit({
          type: 'session_start',
          reason: 'startup',
        });
        const childAgentDir = join(cwd, 'child-agent');
        const childSessionDir = join(cwd, 'child-sessions');
        await mkdir(childAgentDir, { recursive: true });
        await mkdir(childSessionDir, { recursive: true });
        const envPrefix = Object.entries({
          PI_BG_SCRIPTED_SCENARIO: 'json-tool-telemetry',
          PI_BG_SCRIPTED_API_KEY: 'scripted-api-key',
          PI_CODING_AGENT_DIR: childAgentDir,
          PI_CODING_AGENT_SESSION_DIR: childSessionDir,
          PI_OFFLINE: '1',
          PI_SKIP_VERSION_CHECK: '1',
          PI_TELEMETRY: '0',
          CI: '1',
          PATH: `${dirname(piCli)}${delimiter}${process.env['PATH'] ?? ''}`,
        })
          .map(([key, value]) => `${key}=${shellQuote(value)}`)
          .join(' ');
        const command = `${envPrefix} pi --offline --no-session --no-extensions -e ${shellQuote(scriptedProviderPath)} --no-skills --no-prompt-templates --no-context-files --model pi-bg-scripted/scripted-model -p ${shellQuote('exercise real json tool telemetry')}`;
        const runRequest = await emitEventRequest(
          eventBus,
          'sdk-real-pi-telemetry',
          'run',
          {
            name: 'Real Pi Telemetry',
            command,
            isAgent: true,
            notifyOnCompletion: false,
            triggerOnCompletion: false,
          },
        );
        const t = await wait(
          session,
          requiredTask(requireOkResult(runRequest), 'real pi run task').id,
          240,
        );
        assert.equal(t.status, 'completed');
        assert.deepEqual(t.tokenUsage, {
          input: 20,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 30,
          costTotal: 0,
        });
        assert.deepEqual(t.toolUsage, {
          total: 2,
          failed: 1,
          byName: { scripted_echo: 2 },
        });
        assert.equal(t.model, 'pi-bg-scripted/scripted-model');
        const status = await exec(session, 'bg_status', { taskId: t.id });
        assert.match(
          resultText(status),
          /model=pi-bg-scripted\/scripted-model/,
        );
        assert.match(resultText(status), /tokens=30/);
        assert.match(resultText(status), /tools=2 failed=1/);
        const logs = await exec(session, 'bg_logs', {
          taskId: t.id,
          maxBytes: 8000,
          tail: false,
        });
        const logText = resultText(logs);
        assert.match(logText, /JSON tool telemetry complete/);
        assert.match(logText, /scripted_echo/);
        assert.doesNotMatch(logText, /background-task-telemetry/);
      } finally {
        await session.extensionRunner.emit({
          type: 'session_shutdown',
          reason: 'quit',
        });
        session.dispose();
      }
    },
  );

  void it('keeps finished footer notices until explicit /bg-clear', async () => {
    const { session } = await harness();
    const statuses: Array<string | undefined> = [];
    const notifications: UiNotification[] = [];
    session.extensionRunner.setUIContext(
      makeStatusUi(
        session.extensionRunner.getUIContext(),
        statuses,
        notifications,
      ),
    );
    try {
      const done = await launchBackgroundTask(session, 'echo done');
      await wait(session, done.id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.match(statuses.at(-1) ?? '', /bg 1 done · Shift↓ · \/bg-clear/);

      const shortcuts = session.extensionRunner.getShortcuts({});
      assert.ok(shortcuts.has('ctrl+alt+c'));
      const clearCommand = session.extensionRunner
        .getRegisteredCommands()
        .find((cmd) => cmd.invocationName === 'bg-clear');
      assert.ok(clearCommand);
      await clearCommand.handler(
        '',
        session.extensionRunner.createCommandContext(),
      );
      assert.equal(statuses.at(-1), undefined);
      assert.match(notifications.at(-1)?.message ?? '', /Cleared 1 finished/);

      const running = await launchBackgroundTask(
        session,
        `node -e ${JSON.stringify('setTimeout(() => {}, 10000)')}`,
      );
      const secondDone = await launchBackgroundTask(session, 'echo two');
      await wait(session, secondDone.id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.match(
        statuses.at(-1) ?? '',
        /1 running · 1 done · Shift↓ · \/bg-clear/,
      );
      await clearCommand.handler(
        '',
        session.extensionRunner.createCommandContext(),
      );
      assert.match(statuses.at(-1) ?? '', /bg 1 running · Shift↓/);
      assert.doesNotMatch(statuses.at(-1) ?? '', /done|\/bg-clear/);
      await exec(session, 'bg_kill', { taskId: running.id });
    } finally {
      await session.extensionRunner.emit({
        type: 'session_shutdown',
        reason: 'quit',
      });
      session.dispose();
    }
  });

  void it('reports failed/stopped/done footer combinations and focused dock status', async () => {
    const { session } = await harness();
    const statuses: Array<string | undefined> = [];
    const notifications: UiNotification[] = [];
    session.extensionRunner.setUIContext(
      makeStatusUi(
        session.extensionRunner.getUIContext(),
        statuses,
        notifications,
      ),
    );
    try {
      const failed = await launchBackgroundTask(
        session,
        'node -e "process.exit(2)"',
      );
      await wait(session, failed.id);
      const stopped = await launchBackgroundTask(
        session,
        `node -e ${JSON.stringify('setTimeout(() => {}, 10000)')}`,
      );
      const stoppedTask = stopped;
      await exec(session, 'bg_kill', { taskId: stoppedTask.id });
      await wait(session, stoppedTask.id);
      const done = await launchBackgroundTask(session, 'echo done');
      await wait(session, done.id);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.match(
        statuses.at(-1) ?? '',
        /1 failed · 1 stopped · 1 done · Shift↓ · \/bg-clear/,
      );

      const running = await launchBackgroundTask(
        session,
        `node -e ${JSON.stringify('setTimeout(() => {}, 10000)')}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.match(
        statuses.at(-1) ?? '',
        /1 running · 1 failed · 1 stopped · 1 done · Shift↓ · \/bg-clear/,
      );
      const shortcuts = session.extensionRunner.getShortcuts({});
      const shiftDown = shortcuts.get('shift+down');
      assert.ok(shiftDown, 'Shift+Down shortcut should be registered');
      await shiftDown.handler(session.extensionRunner.createContext());
      assert.ok(
        statuses.some(
          (status) =>
            status?.includes(
              'bg 1 running · 1 failed · 1 stopped · 1 done · focused',
            ) ?? false,
        ),
      );
      await exec(session, 'bg_kill', { taskId: running.id });
      assert.equal(notifications.length, 0);
    } finally {
      await session.extensionRunner.emit({
        type: 'session_shutdown',
        reason: 'quit',
      });
      session.dispose();
    }
  });

  void it('covered bash drops bg_run legacy preparation and rejects empty background commands', async () => {
    const { session } = await harness();
    try {
      const tool = session.getToolDefinition('bash');
      assert.ok(tool, 'covered bash tool should be registered');
      assert.equal(
        tool.prepareArguments,
        undefined,
        'covered bash no longer exposes bg_run legacy argument preparation',
      );
      await assert.rejects(
        () => exec(session, 'bash', { command: '', run_in_background: true }),
        /Background command is empty/,
      );
      const task = await launchBackgroundTask(session, 'echo ok');
      const completed = await wait(session, task.id);
      assert.equal(completed.status, 'completed');
    } finally {
      await session.extensionRunner.emit({
        type: 'session_shutdown',
        reason: 'quit',
      });
      session.dispose();
    }
  });

  void it('fails spawn errors loudly and writes failure metadata', async () => {
    const previousShell = process.env['SHELL'];
    const previousComSpec = process.env['ComSpec'];
    if (process.platform === 'win32') {
      process.env['ComSpec'] = 'C:\\definitely\\missing\\pi-bg-shell.exe';
    } else {
      process.env['SHELL'] = '/definitely/missing/pi-bg-shell';
    }
    const { session, cwd } = await harness();
    try {
      const task = await launchBackgroundTask(session, 'echo nope');
      const t = await wait(session, task.id);
      assert.equal(t.status, 'failed');
      assert.match(t.error ?? '', /ENOENT|no such file/i);
      const metadataPath = join(
        cwd,
        t.outputPath.replace(/\.output$/, '.json'),
      );
      const metadata = await readJsonWithStatus(metadataPath, 'failed');
      assert.equal(metadata['status'], 'failed');
    } finally {
      restoreEnvValue('SHELL', previousShell);
      restoreEnvValue('ComSpec', previousComSpec);
      await session.extensionRunner.emit({
        type: 'session_shutdown',
        reason: 'quit',
      });
      session.dispose();
    }
  });

  void it('cleans up multiple running tasks on shutdown', async () => {
    const { session } = await harness();
    const one = await launchBackgroundTask(
      session,
      `node -e ${JSON.stringify('setTimeout(() => {}, 10000)')}`,
    );
    const two = await launchBackgroundTask(
      session,
      `node -e ${JSON.stringify('setTimeout(() => {}, 10000)')}`,
    );
    await session.extensionRunner.emit({
      type: 'session_shutdown',
      reason: 'quit',
    });
    const s1 = await exec(session, 'bg_status', { taskId: one.id });
    const s2 = await exec(session, 'bg_status', { taskId: two.id });
    assert.equal(firstTask(s1).status, 'killed');
    assert.equal(firstTask(s2).status, 'killed');
    assert.match(firstTask(s1).error ?? '', /shutdown/);
    session.dispose();
  });
});
