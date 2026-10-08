import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
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
} from "@earendil-works/pi-coding-agent";
import { parseJsonText } from "../../src/core/common.js";
import { isolatedTestEnv } from "../helpers/normalize.js";
import {
  BG_REQUEST_CHANNEL,
  BG_REQUEST_SCHEMA,
  BG_RESPONSE_CHANNEL,
  BG_RESPONSE_SCHEMA,
  type BackgroundTaskExtensionResponse,
} from "../../src/core/extension-api.js";

const backgroundExtensionPath = resolve("extensions/background-tasks.ts");
const scriptedProviderPath = resolve(
  "tests/scripted-provider/scripted-provider-extension.ts",
);
const roots: string[] = [];

type Scenario = "bg-run-follow-up" | "failed-follow-up";

async function harness(scenario: Scenario = "bg-run-follow-up") {
  const root = await mkdtemp(join(tmpdir(), "pi-bg-agent-loop-"));
  roots.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const eventsPath = join(root, "provider-events.jsonl");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  // S3 P5:运行时目录迁宿主私有 getAgentDir()——测试进程内重定向到临时 agent 目录
  const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  const previousScenario = process.env["PI_BG_SCRIPTED_SCENARIO"];
  const previousEvents = process.env["PI_BG_SCRIPTED_EVENTS"];
  const previousApiKey = process.env["PI_BG_SCRIPTED_API_KEY"];
  Object.assign(process.env, isolatedTestEnv, {
    PI_BG_SCRIPTED_SCENARIO: scenario,
    PI_BG_SCRIPTED_EVENTS: eventsPath,
    PI_BG_SCRIPTED_API_KEY: "scripted-api-key",
    NPM_CONFIG_CACHE: join(tmpdir(), "pi-npm-cache"),
  });
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: "pi-bg-scripted",
    defaultModel: "scripted-model",
  });
  const eventBus = createEventBus();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    eventBus,
    additionalExtensionPaths: [scriptedProviderPath, backgroundExtensionPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    noThemes: true,
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
  });
  const modelRegistry = new ModelRegistry(modelRuntime);
  const created = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    modelRuntime,
    noTools: "builtin",
  });
  const scriptedModel = modelRegistry.find("pi-bg-scripted", "scripted-model");
  assert.ok(scriptedModel, "scripted provider model should be registered");
  await created.session.setModel(scriptedModel);
  const restoreEnv = () => {
    restoreEnvValue("PI_BG_SCRIPTED_SCENARIO", previousScenario);
    restoreEnvValue("PI_BG_SCRIPTED_EVENTS", previousEvents);
    restoreEnvValue("PI_BG_SCRIPTED_API_KEY", previousApiKey);
    restoreEnvValue("PI_CODING_AGENT_DIR", previousAgentDir);
  };
  return {
    session: created.session,
    cwd,
    root,
    eventsPath,
    eventBus,
    restoreEnv,
  };
}

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 150));
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

type JsonObject = Record<PropertyKey, unknown>;

interface CustomNotificationEntry {
  type: "custom_message";
  customType: string;
  content: string;
  details: JsonObject;
}

interface EventDrivenContractCheck extends JsonObject {
  systemPrompt: boolean;
  toolDescriptions: boolean;
  launchReceipt: boolean;
}

interface ProviderEvent extends JsonObject {
  callCount?: number;
  summaries?: string[];
  eventDrivenContract?: EventDrivenContractCheck;
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isEventDrivenContractCheck(
  value: unknown,
): value is EventDrivenContractCheck {
  return (
    isJsonObject(value) &&
    typeof value["systemPrompt"] === "boolean" &&
    typeof value["toolDescriptions"] === "boolean" &&
    typeof value["launchReceipt"] === "boolean"
  );
}

function isProviderEvent(value: unknown): value is ProviderEvent {
  return (
    isJsonObject(value) &&
    (value["callCount"] === undefined ||
      typeof value["callCount"] === "number") &&
    (value["summaries"] === undefined || isStringArray(value["summaries"])) &&
    (value["eventDrivenContract"] === undefined ||
      isEventDrivenContractCheck(value["eventDrivenContract"]))
  );
}

function parseProviderEvent(line: string): ProviderEvent {
  const parsed = parseJsonText(line);
  assert.ok(
    isProviderEvent(parsed),
    "scripted provider event must match the provider-event contract",
  );
  return parsed;
}

function isCustomNotificationEntry(
  value: unknown,
): value is CustomNotificationEntry {
  return (
    isJsonObject(value) &&
    value["type"] === "custom_message" &&
    value["customType"] === "background-task-notification" &&
    typeof value["content"] === "string" &&
    isJsonObject(value["details"])
  );
}

function customNotifications(session: AgentSession): CustomNotificationEntry[] {
  const entries: readonly unknown[] = session.sessionManager.getEntries();
  return entries.filter(isCustomNotificationEntry);
}

function requiredAt<T>(
  values: readonly T[],
  index: number,
  message: string,
): T {
  const value = values[index];
  assert.ok(value, message);
  return value;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string") throw new Error(message);
  return value;
}

const ENTRY_TYPE_KEY = "type";
const ENTRY_MESSAGE_KEY = "message";
const ENTRY_ROLE_KEY = "role";
const ENTRY_CONTENT_KEY = "content";
const ENTRY_TEXT_KEY = "text";

function assistantContentParts(session: AgentSession): JsonObject[] {
  return session.sessionManager.getEntries().flatMap((entry) => {
    if (
      !isJsonObject(entry) ||
      entry[ENTRY_TYPE_KEY] !== "message" ||
      !isJsonObject(entry[ENTRY_MESSAGE_KEY]) ||
      entry[ENTRY_MESSAGE_KEY][ENTRY_ROLE_KEY] !== "assistant"
    )
      return [];
    const content: unknown = entry[ENTRY_MESSAGE_KEY][ENTRY_CONTENT_KEY];
    if (!Array.isArray(content)) return [];
    const parts: readonly unknown[] = content;
    return parts.filter(isJsonObject);
  });
}

function assistantTexts(session: AgentSession): string[] {
  return assistantContentParts(session).flatMap((part) =>
    part[ENTRY_TYPE_KEY] === "text" && typeof part[ENTRY_TEXT_KEY] === "string"
      ? [part[ENTRY_TEXT_KEY]]
      : [],
  );
}

function assistantToolNames(session: AgentSession): string[] {
  return assistantContentParts(session).flatMap((part) =>
    part[ENTRY_TYPE_KEY] === "toolCall" && typeof part["name"] === "string"
      ? [part["name"]]
      : [],
  );
}

async function providerEvents(path: string): Promise<ProviderEvent[]> {
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf8");
  return raw.trim() ? raw.trim().split("\n").map(parseProviderEvent) : [];
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

async function disposeHarness(h: Awaited<ReturnType<typeof harness>>) {
  try {
    await h.session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
  } finally {
    h.session.dispose();
    h.restoreEnv();
  }
}

function requireEventResponse(value: unknown): BackgroundTaskExtensionResponse {
  assert.ok(isJsonObject(value), "EventBus response must be an object");
  assert.equal(value["schema_version"], BG_RESPONSE_SCHEMA);
  assert.equal(typeof value["request_id"], "string");
  assert.equal(typeof value["operation"], "string");
  assert.equal(typeof value["ok"], "boolean");
  return value as BackgroundTaskExtensionResponse;
}

function requireOkResult(response: BackgroundTaskExtensionResponse): unknown {
  assert.equal(response.ok, true, response.ok ? "ok" : response.error);
  return response.ok ? response.result : undefined;
}

async function emitEventRequest(
  eventBus: EventBus,
  requestId: string,
  operation: string,
  payload: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<BackgroundTaskExtensionResponse> {
  const pending = new Promise<BackgroundTaskExtensionResponse>(
    (resolveResponse, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(
          new Error(`timed out waiting for EventBus response ${requestId}`),
        );
      }, timeoutMs);
      const unsubscribe = eventBus.on(BG_RESPONSE_CHANNEL, (data) => {
        const frame = requireEventResponse(data);
        if (frame.request_id !== requestId) return;
        clearTimeout(timeout);
        unsubscribe();
        resolveResponse(frame);
      });
    },
  );
  eventBus.emit(BG_REQUEST_CHANNEL, {
    schema_version: BG_REQUEST_SCHEMA,
    request_id: requestId,
    operation,
    payload,
  });
  return pending;
}

/** 以「通知锁存」交付组合启动后台任务(M4 后该组合仅经 EventBus run 请求携带)。 */
async function runWithDelivery(
  eventBus: EventBus,
  requestId: string,
  command: string,
  delivery: { notifyOnCompletion: boolean; triggerOnCompletion: boolean },
): Promise<void> {
  const response = await emitEventRequest(eventBus, requestId, "run", {
    name: requestId,
    command,
    isAgent: false,
    notifyOnCompletion: delivery.notifyOnCompletion,
    triggerOnCompletion: delivery.triggerOnCompletion,
  });
  requireOkResult(response);
}

void describe(
  "scripted-provider completion follow-up behavior",
  { concurrency: false },
  () => {
    void it(
      "BUG-181 covered bash yields without polling and its completion event triggers one real follow-up turn",
      { timeout: 15_000 },
      async () => {
        const h = await harness("bg-run-follow-up");
        try {
          await h.session.prompt("Start the scripted background task.");
          await waitFor(
            () => customNotifications(h.session).length === 1,
            "background notification",
          );
          await waitFor(
            async () => (await providerEvents(h.eventsPath)).length >= 3,
            "third provider call from follow-up",
          );
          await h.session.agent.waitForIdle();

          const events = await providerEvents(h.eventsPath);
          assert.equal(events.length, 3);
          const launchEvent = requiredAt(
            events,
            0,
            "launch provider event should be recorded",
          );
          const launchContract = launchEvent.eventDrivenContract;
          assert.ok(
            launchContract,
            "launch event should record the effective prompt contract",
          );
          assert.equal(launchContract.systemPrompt, true);
          assert.equal(launchContract.toolDescriptions, true);
          const postToolEvent = requiredAt(
            events,
            1,
            "post-tool provider event should be recorded",
          );
          assert.equal(postToolEvent.eventDrivenContract?.launchReceipt, true);
          assert.deepEqual(
            assistantToolNames(h.session),
            ["bash"],
            "ordinary event-driven waiting must not issue bg_status, bg_logs, or a sleep tool",
          );
          const followUpEvent = requiredAt(
            events,
            2,
            "follow-up provider event should be recorded",
          );
          assert.equal(followUpEvent.callCount, 3);
          assert.match(
            (followUpEvent.summaries ?? []).join("\n"),
            /background-task-notification|scripted background task/,
          );
          assert.ok(
            assistantTexts(h.session).some((text) =>
              text.includes(
                "Follow-up turn observed background-task-notification",
              ),
            ),
          );

          const note = requiredAt(
            customNotifications(h.session),
            0,
            "completion notification should be recorded",
          );
          assert.match(note.content, /<task-name>[^<]+<\/task-name>/);
          assert.match(note.content, /<status>completed<\/status>/);
          assert.match(
            note.content,
            /<guidance>Terminal state and output metadata are durable\./,
          );
          assert.match(note.content, /Do not call bg_status to reconfirm/);
          assert.equal(note.details["triggerOnCompletion"], true);
          assert.equal(note.details["notified"], true);
        } finally {
          await disposeHarness(h);
        }
      },
    );

    void it(
      "notifyOnCompletion:false suppresses notification and prevents any completion wakeup",
      { timeout: 15_000 },
      async () => {
        const h = await harness();
        try {
          await h.session.bindExtensions({ onError: () => undefined });
          await runWithDelivery(
            h.eventBus,
            "follow-up-no-notify",
            `node -e ${JSON.stringify("setTimeout(() => {}, 200)")}`,
            { notifyOnCompletion: false, triggerOnCompletion: true },
          );
          await new Promise((resolve) => setTimeout(resolve, 500));
          await h.session.agent.waitForIdle();
          assert.equal(customNotifications(h.session).length, 0);
          assert.equal((await providerEvents(h.eventsPath)).length, 0);
        } finally {
          await disposeHarness(h);
        }
      },
    );

    void it(
      "notifyOnCompletion:true with triggerOnCompletion:false notifies without a provider wakeup",
      { timeout: 15_000 },
      async () => {
        const h = await harness();
        try {
          await h.session.bindExtensions({ onError: () => undefined });
          await runWithDelivery(
            h.eventBus,
            "follow-up-wake-false",
            `node -e ${JSON.stringify("setTimeout(() => {}, 200)")}`,
            { notifyOnCompletion: true, triggerOnCompletion: false },
          );
          await waitFor(
            () => customNotifications(h.session).length === 1,
            "notification-only event",
          );
          await new Promise((resolve) => setTimeout(resolve, 350));
          await h.session.agent.waitForIdle();

          const note = requiredAt(
            customNotifications(h.session),
            0,
            "notification-only completion should be recorded",
          );
          assert.match(note.content, /<task-name>[^<]+<\/task-name>/);
          assert.match(note.content, /<status>completed<\/status>/);
          assert.equal(note.details["triggerOnCompletion"], false);
          assert.equal((await providerEvents(h.eventsPath)).length, 0);
        } finally {
          await disposeHarness(h);
        }
      },
    );

    void it(
      "failed background tasks include error fields and still wake a follow-up turn",
      { timeout: 15_000 },
      async () => {
        const h = await harness("failed-follow-up");
        try {
          await h.session.prompt("Start the failing scripted background task.");
          await waitFor(
            () => customNotifications(h.session).length === 1,
            "failed background notification",
          );
          await waitFor(
            async () => (await providerEvents(h.eventsPath)).length >= 3,
            "failed-task follow-up provider call",
          );
          await h.session.agent.waitForIdle();

          const note = requiredAt(
            customNotifications(h.session),
            0,
            "failed-task notification should be recorded",
          );
          assert.match(note.content, /<task-name>[^<]+<\/task-name>/);
          assert.match(note.content, /<status>failed<\/status>/);
          assert.match(note.content, /<exit-code>7<\/exit-code>/);
          assert.match(note.content, /<error>Exited with code 7<\/error>/);
          assert.equal(note.details["status"], "failed");
          assert.equal(note.details["exitCode"], 7);
          assert.match(
            requiredString(
              note.details["error"],
              "failed notification should include an error string",
            ),
            /Exited with code 7/,
          );

          const events = await providerEvents(h.eventsPath);
          assert.equal(events.length, 3);
          const failedFollowUpEvent = requiredAt(
            events,
            2,
            "failed-task follow-up provider event should be recorded",
          );
          assert.match(
            (failedFollowUpEvent.summaries ?? []).join("\n"),
            /background-task-notification|Failing Scripted|failing scripted background task/,
          );
          assert.ok(
            assistantTexts(h.session).some((text) =>
              text.includes(
                "Follow-up turn observed failed background task notification",
              ),
            ),
          );
        } finally {
          await disposeHarness(h);
        }
      },
    );

    void it(
      "display-only notification path stays latched: it notifies but never triggers a provider follow-up (M4 dock「转后台」语义)",
      { timeout: 15_000 },
      async () => {
        const h = await harness();
        try {
          await h.session.bindExtensions({ onError: () => undefined });
          // M4 起用户入口为 dock「转后台」(entrySource:'user',仅通知不唤醒);
          // 此处以同构的「通知锁存」交付组合断言其语义:通知落盘、无 provider 唤醒。
          await runWithDelivery(
            h.eventBus,
            "follow-up-display-only",
            `node -e ${JSON.stringify("setTimeout(() => {}, 200)")}`,
            { notifyOnCompletion: true, triggerOnCompletion: false },
          );
          await waitFor(
            () => customNotifications(h.session).length === 1,
            "display-only notification",
          );
          await new Promise((resolve) => setTimeout(resolve, 350));
          await h.session.agent.waitForIdle();
          const note = requiredAt(
            customNotifications(h.session),
            0,
            "display-only notification should be recorded",
          );
          assert.match(note.content, /<task-name>[^<]+<\/task-name>/);
          assert.match(note.content, /<status>completed<\/status>/);
          assert.equal(note.details["triggerOnCompletion"], false);
          assert.equal((await providerEvents(h.eventsPath)).length, 0);
        } finally {
          await disposeHarness(h);
        }
      },
    );
  },
);
