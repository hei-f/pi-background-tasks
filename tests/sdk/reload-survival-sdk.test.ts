import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createEventBus,
  type AgentSession,
  type EventBus,
} from '@earendil-works/pi-coding-agent';
import type { BgTaskSnapshot } from '../../src/core/common.js';
import {
  BG_TERMINAL_CHANNEL,
  BG_TERMINAL_SCHEMA,
} from '../../src/core/extension-api.js';
import {
  getProcessReloadShellOwnerV1,
  inspectReloadShellOwnerForTests,
  makeReloadShellIdentity,
} from '../../src/core/reload-shell-owner.js';
import {
  seedLegacyReloadSurvivor,
  type SeedLegacySurvivorOptions,
} from '../helpers/reload-survival-fixture.js';

const extensionPath = resolve('extensions/background-tasks.ts');
const roots: string[] = [];
const originalMaxOutputBytes = process.env['PI_BG_MAX_OUTPUT_BYTES'];
process.env['PI_BG_MAX_OUTPUT_BYTES'] = '1024';
after(() => {
  if (originalMaxOutputBytes === undefined)
    delete process.env['PI_BG_MAX_OUTPUT_BYTES'];
  else process.env['PI_BG_MAX_OUTPUT_BYTES'] = originalMaxOutputBytes;
});

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  assert.ok(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    label,
  );
  return value as JsonRecord;
}

function isTaskSnapshot(value: unknown): value is BgTaskSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  return (
    typeof Reflect.get(value, 'id') === 'string' &&
    typeof Reflect.get(value, 'command') === 'string' &&
    typeof Reflect.get(value, 'status') === 'string' &&
    typeof Reflect.get(value, 'outputPath') === 'string' &&
    typeof Reflect.get(value, 'cwd') === 'string' &&
    typeof Reflect.get(value, 'startTime') === 'number' &&
    typeof Reflect.get(value, 'bytesWritten') === 'number' &&
    typeof Reflect.get(value, 'isAgent') === 'boolean' &&
    typeof Reflect.get(value, 'surviveReload') === 'boolean' &&
    typeof Reflect.get(value, 'notified') === 'boolean' &&
    typeof Reflect.get(value, 'notifyOnCompletion') === 'boolean' &&
    typeof Reflect.get(value, 'triggerOnCompletion') === 'boolean'
  );
}

function taskSnapshot(value: unknown, label = 'task snapshot'): BgTaskSnapshot {
  assert.ok(isTaskSnapshot(value), label);
  return value;
}

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  details: JsonRecord;
}

function toolResult(value: unknown): ToolResult {
  const result = record(value, 'tool result');
  assert.ok(Array.isArray(result['content']));
  return {
    content: result['content'] as Array<{ type: string; text?: string }>,
    details: record(result['details'], 'tool details'),
  };
}

async function execute(
  session: AgentSession,
  name: string,
  args: unknown,
): Promise<ToolResult> {
  const tool = session.getToolDefinition(name);
  assert.ok(tool, `missing tool ${name}`);
  const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
  return toolResult(
    await tool.execute(
      `reload-survival-${name}`,
      prepared,
      undefined,
      undefined,
      session.extensionRunner.createContext(),
    ),
  );
}

function tasksFrom(result: ToolResult): BgTaskSnapshot[] {
  const tasks = result.details['tasks'];
  assert.ok(Array.isArray(tasks));
  return tasks.map((task) => taskSnapshot(task));
}

/**
 * 覆盖版 bash 启动 receipt 文本内的任务 id(`Started background task ... (bXXXX)`),
 * id 恒为 `b` + 8 位十六进制。
 */
function taskIdFromReceipt(text: string): string {
  const match = /\(b[0-9a-f]{8}\)/u.exec(text);
  assert.ok(match, `background task receipt should carry an id`);
  return match[0].slice(1, -1);
}

/** 以覆盖版 bash `run_in_background:true` 启动普通(非 opt)任务并立即取回快照。 */
async function launchCoveredBashTask(
  session: AgentSession,
  command: string,
): Promise<BgTaskSnapshot> {
  const receipt = await execute(session, 'bash', {
    command,
    run_in_background: true,
  });
  const text = String(receipt.content[0]?.text ?? '');
  const id = taskIdFromReceipt(text);
  return (await status(session, id)) as BgTaskSnapshot;
}

async function status(
  session: AgentSession,
  id: string,
): Promise<BgTaskSnapshot> {
  const result = await execute(session, 'bg_status', { taskId: id });
  const task = tasksFrom(result)[0];
  assert.ok(task);
  return task;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 15));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitTerminal(
  session: AgentSession,
  id: string,
  timeoutMs = 5000,
): Promise<BgTaskSnapshot> {
  let latest = await status(session, id);
  const deadline = Date.now() + timeoutMs;
  while (latest.status === 'running' && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    latest = await status(session, id);
  }
  assert.notEqual(
    latest.status,
    'running',
    `task ${id} should become terminal`,
  );
  return latest;
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === 'object' &&
      error !== null &&
      Reflect.get(error, 'code') === 'ESRCH'
    );
  }
}

interface Harness {
  root: string;
  cwd: string;
  agentDir: string;
  loader: DefaultResourceLoader;
  session: AgentSession;
  eventBus: EventBus;
}

/**
 * 建立未绑定的会话并注入 `sessionStartEvent` reason 'reload':opt 存活 fixture
 * 必须先于扩展首次激活注册到进程级 hub,随后绑定扩展时以 reload 语义认领。
 */
async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-reload-survival-'));
  roots.push(root);
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const settingsManager = SettingsManager.inMemory();
  const eventBus = createEventBus();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    eventBus,
    additionalExtensionPaths: [extensionPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    noThemes: true,
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
  });
  const created = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    modelRuntime,
    noTools: 'builtin',
    // reload 语义首次激活:认领 hub 中预置的遗留存活任务
    sessionStartEvent: { type: 'session_start', reason: 'reload' },
  });
  return { root, cwd, agentDir, loader, session: created.session, eventBus };
}

async function bindSession(session: AgentSession): Promise<void> {
  await session.bindExtensions({ onError: () => undefined });
}

async function seedSurvivor(
  h: Harness,
  options: SeedLegacySurvivorOptions,
  command: string,
): Promise<BgTaskSnapshot> {
  return seedLegacyReloadSurvivor(h.session, h.cwd, command, options);
}

async function disposeHarness(h: Harness): Promise<void> {
  await h.session.extensionRunner
    .emit({ type: 'session_shutdown', reason: 'quit' })
    .catch(() => undefined);
  h.session.dispose();
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  await rm(h.root, { recursive: true, force: true });
}

function ownerExecution(h: Harness, taskId: string) {
  const identity = makeReloadShellIdentity(
    h.session.sessionId,
    realpathSync(h.cwd),
  );
  const state = inspectReloadShellOwnerForTests(
    getProcessReloadShellOwnerV1(),
    identity,
  );
  return state.executions.find((execution) => execution.task.id === taskId);
}

void describe('real Pi reload shell survival', { concurrency: false }, () => {
  void it('keeps one real process/id/nonce/path/policy/output and delivers once across repeated AgentSession.reload()', async () => {
    const previousPolicy = process.env['PI_BG_POSIX_SHELL'];
    process.env['PI_BG_POSIX_SHELL'] = 'sh';
    const h = await harness();
    // M4 形态:新启动入口不再暴露 surviveReload,opt 存活任务只能来自遗留
    // fixture(预置到进程级 hub)或 dock rerun;此处预置后首次绑定即认领。
    const script = [
      'process.stdout.write("before\\n")',
      'setTimeout(() => process.stdout.write("after\\n"), 350)',
      'setTimeout(() => process.exit(0), 750)',
    ].join(';');
    const launched = await seedSurvivor(h, {
      name: 'Reload continuity',
      notifyOnCompletion: true,
    }, `node -e ${JSON.stringify(script)}`);
    // Pi 允许宿主多次追加绑定;反复启动同一 runner/身份必须幂等而非产生重复 owner。
    await bindSession(h.session);
    await h.session.bindExtensions({ onError: () => undefined });
    const terminals: BgTaskSnapshot[] = [];
    const offTerminal = h.eventBus.on(BG_TERMINAL_CHANNEL, (value) => {
      const frame = record(value, 'terminal frame');
      if (frame['schema_version'] === BG_TERMINAL_SCHEMA) {
        terminals.push(taskSnapshot(frame['task'], 'terminal task'));
      }
    });
    try {
      assert.equal(launched.status, 'running');
      assert.equal(launched.surviveReload, true);
      assert.equal(launched.shellPolicy?.policy, 'sh');
      const nonce = launched.reloadSurvival?.launchNonce;
      const completionId = launched.reloadSurvival?.completionId;
      const pid = launched.pid;
      assert.equal(typeof pid, 'number');
      const beforeExecution = ownerExecution(h, launched.id);
      assert.ok(beforeExecution?.child);
      const beforeChild = beforeExecution.child;
      await waitFor(async () => {
        const logs = await execute(h.session, 'bg_logs', {
          taskId: launched.id,
          maxBytes: 4096,
        });
        return String(logs.content[0]?.text ?? '').includes('before');
      }, 'pre-reload output');

      process.env['PI_BG_POSIX_SHELL'] = 'bash';
      process.env['PI_BG_MAX_OUTPUT_BYTES'] = '2048';
      await h.session.reload();
      const afterFirst = await status(h.session, launched.id);
      assert.equal(afterFirst.status, 'running');
      assert.equal(afterFirst.id, launched.id);
      assert.equal(afterFirst.pid, pid);
      assert.equal(afterFirst.outputPath, launched.outputPath);
      assert.equal(afterFirst.reloadSurvival?.launchNonce, nonce);
      assert.equal(afterFirst.reloadSurvival?.completionId, completionId);
      assert.equal(afterFirst.shellPolicy?.policy, 'sh');
      assert.equal(afterFirst.reloadSurvival?.outputCapBytes, 1024);
      assert.equal(ownerExecution(h, launched.id), beforeExecution);
      assert.equal(ownerExecution(h, launched.id)?.child, beforeChild);

      await h.session.reload();
      const afterSecond = await status(h.session, launched.id);
      // 预置 fixture 自带一次初始 claim(hub 代次 1);后经两次 reload 认领:
      // 首次绑定认领代次 2/handoff 1,两次 reload 后为代次 4/handoff 3
      assert.equal(afterSecond.reloadSurvival?.leaseGeneration, 4);
      assert.equal(afterSecond.reloadSurvival?.handoffCount, 3);
      assert.equal(ownerExecution(h, launched.id), beforeExecution);

      const done = await waitTerminal(h.session, launched.id);
      assert.equal(done.status, 'completed');
      assert.equal(done.exitCode, 0);
      assert.equal(done.pid, pid);
      assert.equal(done.reloadSurvival?.launchNonce, nonce);
      const logs = await execute(h.session, 'bg_logs', {
        taskId: launched.id,
        maxBytes: 4096,
      });
      const text = String(logs.content[0]?.text ?? '');
      assert.match(text, /before/u);
      assert.match(text, /after/u);
      assert.equal(
        terminals.filter((task) => task.id === launched.id).length,
        1,
      );
      const notifications = h.session.sessionManager
        .getEntries()
        .filter(
          (entry) =>
            entry.type === 'custom_message' &&
            entry.customType === 'background-task-notification' &&
            record(entry.details, 'notification details')['id'] === launched.id,
        );
      assert.equal(notifications.length, 1);

      // 策略刷新验证:reload 后的新激活按当前环境解析 shell policy;新启动走
      // 覆盖版 bash(不再暴露 surviveReload,默认 kill-on-reload)。
      const rerun = await launchCoveredBashTask(h.session, 'echo current-policy');
      assert.notEqual(rerun.id, launched.id);
      assert.equal(rerun.reloadSurvival, undefined);
      assert.equal(rerun.surviveReload, false);
      assert.equal(rerun.shellPolicy?.policy, 'bash');
      await waitTerminal(h.session, rerun.id);
    } finally {
      process.env['PI_BG_MAX_OUTPUT_BYTES'] = '1024';
      offTerminal();
      if (previousPolicy === undefined) delete process.env['PI_BG_POSIX_SHELL'];
      else process.env['PI_BG_POSIX_SHELL'] = previousPolicy;
      await disposeHarness(h);
    }
  });

  void it('queues an actual nonzero close during a nonzero real reload gap for the fresh activation', async () => {
    const h = await harness();
    const terminals: BgTaskSnapshot[] = [];
    const offTerminal = h.eventBus.on(BG_TERMINAL_CHANNEL, (value) => {
      const frame = record(value, 'terminal frame');
      if (frame['schema_version'] === BG_TERMINAL_SCHEMA)
        terminals.push(taskSnapshot(frame['task']));
    });
    const originalReload = h.loader.reload.bind(h.loader);
    let reloadCalls = 0;
    let releaseGap: (() => void) | undefined;
    const gapEntered = new Promise<void>((resolveGap) => {
      h.loader.reload = async (...args) => {
        reloadCalls += 1;
        if (reloadCalls === 1) {
          resolveGap();
          await new Promise<void>((resolveRelease) => {
            releaseGap = resolveRelease;
          });
        }
        return originalReload(...args);
      };
    });
    try {
      const script =
        'process.stdout.write("gap-before\\n");setTimeout(() => process.exit(7), 120)';
      const launched = await seedSurvivor(h, {
        name: 'Gap terminal',
        notifyOnCompletion: true,
      }, `node -e ${JSON.stringify(script)}`);
      await bindSession(h.session);
      const oldRunner = h.session.extensionRunner;
      const reloadStartedAt = Date.now();
      const reload = h.session.reload();
      await gapEntered;
      await new Promise((resolveWait) => setTimeout(resolveWait, 220));
      const gapElapsed = Date.now() - reloadStartedAt;
      assert.ok(
        gapElapsed >= 150,
        `gap must be nonzero, observed ${String(gapElapsed)}ms`,
      );
      const execution = ownerExecution(h, launched.id);
      assert.ok(execution);
      assert.equal(execution.phase, 'terminal');
      assert.equal(execution.closeObservation?.code, 7);
      assert.equal(
        terminals.filter((task) => task.id === launched.id).length,
        0,
      );

      releaseGap?.();
      await reload;
      assert.notEqual(h.session.extensionRunner, oldRunner);
      const terminal = await waitTerminal(h.session, launched.id);
      assert.equal(terminal.status, 'failed');
      assert.equal(terminal.exitCode, 7);
      assert.match(terminal.error ?? '', /Exited with code 7/u);
      await waitFor(
        () => terminals.filter((task) => task.id === launched.id).length === 1,
        'one fresh terminal frame',
      );
      assert.equal(
        terminals.filter((task) => task.id === launched.id).length,
        1,
      );
      const logs = await execute(h.session, 'bg_logs', {
        taskId: launched.id,
        maxBytes: 4096,
      });
      assert.match(String(logs.content[0]?.text ?? ''), /gap-before/u);
    } finally {
      releaseGap?.();
      h.loader.reload = originalReload;
      offTerminal();
      await disposeHarness(h);
    }
  });

  void it('retains POSIX group authority after reload when the leader exits and a descendant ignores TERM', async () => {
    if (process.platform === 'win32') return;
    const h = await harness();
    let descendantPid: number | undefined;
    try {
      const descendantScript =
        'process.on("SIGTERM",()=>{});process.stdout.write("ready\\n");setInterval(()=>{},1000)';
      const leaderScript = [
        'const {spawn}=require("node:child_process")',
        `const child=spawn(process.execPath,["-e",${JSON.stringify(descendantScript)}],{stdio:["ignore","pipe","ignore"]})`,
        'child.stdout.once("data",()=>process.stdout.write("descendant="+String(child.pid)+"\\n"))',
        'process.on("SIGTERM",()=>process.exit(0))',
        'setInterval(()=>{},1000)',
      ].join(';');
      const launched = await seedSurvivor(h, {
        name: 'Reload tree owner',
        notifyOnCompletion: false,
      }, `node -e ${JSON.stringify(leaderScript)}`);
      await bindSession(h.session);
      await waitFor(async () => {
        const logs = await execute(h.session, 'bg_logs', {
          taskId: launched.id,
          maxBytes: 4096,
        });
        const match = /descendant=(\d+)/u.exec(
          String(logs.content[0]?.text ?? ''),
        );
        if (match?.[1] === undefined) return false;
        descendantPid = Number(match[1]);
        return Number.isSafeInteger(descendantPid) && descendantPid > 0;
      }, 'descendant pid');
      assert.ok(descendantPid !== undefined && pidExists(descendantPid));
      await h.session.reload();
      assert.equal((await status(h.session, launched.id)).status, 'running');

      const killStarted = Date.now();
      const killed = taskSnapshot(
        (await execute(h.session, 'bg_kill', { taskId: launched.id })).details[
          'task'
        ],
        'bg_kill task',
      );
      const elapsed = Date.now() - killStarted;
      // M2 迁移表:bg_kill 为 model 发起停止 → cancelled
      assert.equal(killed.status, 'cancelled');
      assert.ok(
        elapsed >= 2500,
        `tree proof must retain force ownership through grace; observed ${String(elapsed)}ms`,
      );
      assert.equal(pidExists(descendantPid), false);
      await waitFor(
        () => ownerExecution(h, launched.id) === undefined,
        'terminal owner release',
      );
    } finally {
      if (descendantPid !== undefined && pidExists(descendantPid)) {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch {
          // Failure-only rescue; the passing path proves retained group cleanup.
        }
      }
      await disposeHarness(h);
    }
  });

  void it('enforces the original absolute timeout rather than restarting it on reload', async () => {
    const h = await harness();
    try {
      const startedAt = Date.now();
      const launched = await seedSurvivor(h, {
        name: 'Absolute timeout',
        notifyOnCompletion: false,
        timeoutSeconds: 1,
      }, `node -e ${JSON.stringify('setInterval(() => {}, 1000)')}`);
      await bindSession(h.session);
      const deadline = launched.reloadSurvival?.timeoutDeadlineAt;
      assert.equal(typeof deadline, 'number');
      await new Promise((resolveWait) => setTimeout(resolveWait, 650));
      await h.session.reload();
      const terminal = await waitTerminal(h.session, launched.id, 3000);
      const elapsed = (terminal.endTime ?? Date.now()) - startedAt;
      assert.equal(terminal.status, 'failed');
      assert.match(terminal.error ?? '', /Timed out after 1s/u);
      assert.ok(
        elapsed < 1500,
        `reload must not reset timeout; observed ${String(elapsed)}ms`,
      );
      assert.equal(terminal.reloadSurvival?.timeoutDeadlineAt, deadline);
    } finally {
      await disposeHarness(h);
    }
  });

  void it('enforces one cumulative launch-time output cap across a real process reload', async () => {
    const h = await harness();
    try {
      const script = [
        'process.stdout.write("a".repeat(700))',
        'setTimeout(()=>process.stdout.write("b".repeat(700)),500)',
        'setTimeout(()=>{},5000)',
      ].join(';');
      const launched = await seedSurvivor(h, {
        name: 'Cumulative real cap',
        notifyOnCompletion: false,
      }, `node -e ${JSON.stringify(script)}`);
      await bindSession(h.session);
      assert.equal(launched.reloadSurvival?.outputCapBytes, 1024);
      await waitFor(async () => {
        const current = await status(h.session, launched.id);
        return current.bytesWritten >= 700;
      }, 'first real cap segment');
      await h.session.reload();
      const terminal = await waitTerminal(h.session, launched.id, 4000);
      assert.equal(terminal.status, 'failed');
      assert.match(terminal.error ?? '', /Output exceeded cap of 1\.0KB/u);
      assert.equal(terminal.reloadSurvival?.outputCapBytes, 1024);
      const output = await readFile(join(h.cwd, terminal.outputPath), 'utf8');
      assert.equal(output.startsWith('a'.repeat(700)), true);
      assert.equal(output.includes('b'.repeat(324)), true);
      assert.equal(output.includes('b'.repeat(325)), false);
    } finally {
      await disposeHarness(h);
    }
  });

  void it('keeps reload survivors available to fresh /bg-jobs, /bg-logs, and /bg-kill command handlers', async () => {
    const h = await harness();
    try {
      const command = (name: string) => {
        const found = h.session.extensionRunner
          .getRegisteredCommands()
          .find((entry) => entry.invocationName === name);
        assert.ok(found, `missing /${name}`);
        return found;
      };
      const launched = await seedSurvivor(h, {
        name: 'Command survivor',
        notifyOnCompletion: false,
      }, `node -e ${JSON.stringify(
        'process.stdout.write("command-before\\n");setInterval(() => {}, 1000)',
      )}`);
      await bindSession(h.session);
      assert.ok(launched, 'covered-bash-fixture should provide the command survivor');
      assert.equal(launched.surviveReload, true);
      await h.session.reload();
      await command('bg-jobs').handler(
        '',
        h.session.extensionRunner.createCommandContext(),
      );
      await command('bg-logs').handler(
        launched.id,
        h.session.extensionRunner.createCommandContext(),
      );
      await command('bg-kill').handler(
        launched.id,
        h.session.extensionRunner.createCommandContext(),
      );
      const terminal = await waitTerminal(h.session, launched.id);
      // /bg-kill 为 user 发起停止 → cancelled(M2 迁移表)
      assert.equal(terminal.status, 'cancelled');
      assert.equal(
        terminal.reloadSurvival?.launchNonce,
        launched.reloadSurvival?.launchNonce,
      );
    } finally {
      await disposeHarness(h);
    }
  });

  void it('preserves default kill-on-reload, rejects unsupported launches, and never adopts copied JSON', async () => {
    const h = await harness();
    let copiedPid: number | undefined;
    let unrelatedPid: number | undefined;
    try {
      // 遗留 opt 存活任务:预置 fixture 后首次绑定即认领(仅 dock rerun 保留标志,
      // 新启动入口不再暴露 surviveReload)。
      const survivor = await seedSurvivor(h, {
        name: 'Result inapplicable',
        notifyOnCompletion: false,
      }, `node -e ${JSON.stringify('setTimeout(() => {}, 10000)')}`);
      await bindSession(h.session);
      assert.equal(survivor.surviveReload, true);

      // 新启动(覆盖版 bash)不暴露 surviveReload:缺省 kill-on-reload。
      const defaultTask = await launchCoveredBashTask(
        h.session,
        `node -e ${JSON.stringify('setTimeout(() => {}, 10000)')}`,
      );
      assert.equal(defaultTask.surviveReload, false);
      copiedPid = defaultTask.pid;

      // unsupported launches 拒绝:直接驱动 registry.startTask 的校验面
      // (isAgent:true 与 surviveReload 互斥,先于租约检查报错)。
      const { BackgroundTaskRegistry } = await import(
        '../../src/core/registry.js'
      );
      const probeRegistry = new BackgroundTaskRegistry({
        sendCompletionNotification() {},
      });
      await assert.rejects(
        () =>
          probeRegistry.startTask(
            { cwd: h.cwd, sessionId: h.session.sessionId, modelRegistry: { getAll: () => [] } },
            'pi -p nope',
            {
              name: 'Agent refusal',
              isAgent: true,
              surviveReload: true,
            },
          ),
        /pi_bg_survive_reload_requires_non_agent/u,
      );

      await h.session.reload();
      await assert.rejects(
        () => status(h.session, defaultTask.id),
        /Unknown background task ID/u,
      );
      if (copiedPid !== undefined) {
        await waitFor(
          () => !pidExists(copiedPid as number),
          'default reload child exit',
        );
      }

      const copiedMetadata = JSON.parse(
        await readFile(
          join(h.cwd, survivor.outputPath.replace(/\.output$/u, '.json')),
          'utf8',
        ),
      ) as JsonRecord;
      const unrelated = spawn(
        process.execPath,
        ['-e', 'setInterval(()=>{},1000)'],
        { detached: process.platform !== 'win32', stdio: 'ignore' },
      );
      unrelatedPid = unrelated.pid;
      assert.equal(typeof unrelatedPid, 'number');
      copiedMetadata['pid'] = unrelatedPid;
      const copiedAudit = copiedMetadata['reloadSurvival'];
      if (typeof copiedAudit === 'object' && copiedAudit !== null) {
        Reflect.set(copiedAudit, 'childPid', unrelatedPid);
      }
      await execute(h.session, 'bg_kill', { taskId: survivor.id });
      await waitTerminal(h.session, survivor.id);

      // 全新无关会话即使得到逐字节一致的元数据副本也没有采纳路径。
      const other = await harness();
      try {
        const targetDir = join(
          other.cwd,
          '.pi',
          'tasks',
          `${other.session.sessionId}-${String(process.pid)}`,
        );
        await mkdir(targetDir, { recursive: true });
        const copiedPath = join(
          targetDir,
          `${String(copiedMetadata['id'])}.json`,
        );
        await import('node:fs/promises').then(({ writeFile }) =>
          writeFile(
            copiedPath,
            `${JSON.stringify(copiedMetadata, null, 2)}\n`,
            'utf8',
          ),
        );
        const all = await execute(other.session, 'bg_status', {});
        assert.deepEqual(tasksFrom(all), []);
        await assert.rejects(
          () => status(other.session, String(copiedMetadata['id'])),
          /Unknown background task ID/u,
        );
        assert.equal(
          pidExists(unrelatedPid as number),
          true,
          'copied metadata must not signal a live PID',
        );
      } finally {
        await disposeHarness(other);
      }
    } finally {
      if (copiedPid !== undefined && pidExists(copiedPid)) {
        try {
          process.kill(copiedPid, 'SIGKILL');
        } catch {
          // Failure-only rescue; the passing path above proves reload killed it.
        }
      }
      if (unrelatedPid !== undefined && pidExists(unrelatedPid)) {
        if (process.platform === 'win32') {
          const { runWindowsTaskkill } =
            await import('../../src/core/windows-taskkill.js');
          await runWindowsTaskkill(unrelatedPid, 'force');
        } else {
          try {
            process.kill(-unrelatedPid, 'SIGKILL');
          } catch {
            process.kill(unrelatedPid, 'SIGKILL');
          }
        }
        await waitFor(
          () => !pidExists(unrelatedPid as number),
          'unrelated fixture cleanup',
        );
      }
      await disposeHarness(h);
    }
  });

  void it('claims survivors after counted TUI, RPC, print, and JSON SDK bindings', async () => {
    for (const mode of ['tui', 'rpc', 'print', 'json'] as const) {
      const h = await harness();
      try {
        const launched = await seedSurvivor(h, {
          name: `${mode} binding survivor`,
          notifyOnCompletion: false,
        }, `node -e ${JSON.stringify('setTimeout(()=>process.exit(0),300)')}`);
        await h.session.bindExtensions({
          onError: () => undefined,
          mode,
        });
        await h.session.reload();
        const terminal = await waitTerminal(h.session, launched.id);
        assert.equal(
          terminal.status,
          'completed',
          `${mode} counted binding should claim on reload`,
        );
        assert.equal(
          terminal.reloadSurvival?.launchNonce,
          launched.reloadSurvival?.launchNonce,
        );
      } finally {
        await disposeHarness(h);
      }
    }
  });

  void it('characterizes empty binding reload and direct AgentSession.dispose as upstream lifecycle blockers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-bg-reload-blockers-'));
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
    });
    await loader.reload();
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: null,
    });
    const created = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
      modelRuntime,
      noTools: 'builtin',
      sessionStartEvent: { type: 'session_start', reason: 'reload' },
    });
    const session = created.session;
    try {
      // 无成功绑定的 reload owner 时,unsupported launches 拒绝。
      const { BackgroundTaskRegistry } = await import(
        '../../src/core/registry.js'
      );
      const probeRegistry = new BackgroundTaskRegistry({
        sendCompletionNotification() {},
      });
      await assert.rejects(
        () =>
          probeRegistry.startTask(
            {
              cwd,
              sessionId: session.sessionId,
              modelRegistry: { getAll: () => [] },
            },
            'echo no-owner',
            {
              name: 'Bare SDK refusal',
              isAgent: false,
              surviveReload: true,
            },
          ),
        /pi_bg_reload_owner_unavailable/u,
      );

      // 预置空绑定下的存活任务:扩展首次激活以 reload 语义认领后,
      // 空绑定 reload 不再触发新 session_start,执行保持孤儿态。
      const launched = await seedLegacyReloadSurvivor(
        session,
        cwd,
        `node -e ${JSON.stringify('setInterval(() => {}, 1000)')}`,
        { name: 'Empty binding survivor', notifyOnCompletion: false },
      );
      await session.bindExtensions({});
      const oldRunner = session.extensionRunner;
      await session.reload();
      assert.notEqual(
        session.extensionRunner,
        oldRunner,
        'the module/runner is rebuilt',
      );
      const identity = makeReloadShellIdentity(
        session.sessionId,
        realpathSync(cwd),
      );
      const hub = getProcessReloadShellOwnerV1();
      const orphanedByHost = inspectReloadShellOwnerForTests(
        hub,
        identity,
      ).executions.find((execution) => execution.task.id === launched.id);
      assert.ok(
        orphanedByHost,
        'empty binding reload must leave the execution awaiting a missing start',
      );
      assert.equal(orphanedByHost.phase, 'running');

      // Failure-only test cleanup: manually provide the claim the host omitted,
      // stop the real child, and release the structural owner without waiting 30s.
      const claim = hub.beginActivation(identity, 'reload', 'c'.repeat(32));
      const lease = hub.commitActivation(claim, {
        activationNonce: claim.activationNonce,
        onBound() {},
        onChanged() {},
        onTerminal() {},
      });
      await orphanedByHost.requestStop(
        'shutdown',
        'empty-binding characterization cleanup',
      );
      hub.releaseExecution(lease, orphanedByHost);
      hub.releaseActivation(lease);

      // Direct dispose has no awaited session_shutdown in Pi 0.84/0.86. A live
      // default child proves invalidation alone performs no extension cleanup.
      const directDisposeTask = await launchCoveredBashTask(
        session,
        `node -e ${JSON.stringify('setInterval(()=>{},1000)')}`,
      );
      const directDisposePid = directDisposeTask.pid;
      assert.equal(typeof directDisposePid, 'number');
      const runner = session.extensionRunner;
      session.dispose();
      assert.throws(() => runner.createContext().cwd, /stale/u);
      assert.equal(
        pidExists(directDisposePid as number),
        true,
        'direct dispose omits shutdown',
      );
      if (process.platform === 'win32') {
        const { runWindowsTaskkill } =
          await import('../../src/core/windows-taskkill.js');
        await runWindowsTaskkill(directDisposePid as number, 'force');
      } else {
        try {
          process.kill(-(directDisposePid as number), 'SIGKILL');
        } catch {
          process.kill(directDisposePid as number, 'SIGKILL');
        }
      }
      await waitFor(
        () => !pidExists(directDisposePid as number),
        'direct-dispose blocker cleanup',
      );
      // Let the now-stale registry exhaust its bounded publication path while
      // the fixture directory still exists; this is part of the blocker truth.
      await new Promise((resolveWait) => setTimeout(resolveWait, 400));
    } finally {
      session.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});