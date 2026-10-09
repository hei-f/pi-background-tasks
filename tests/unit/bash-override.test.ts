import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type {
  AgentToolResult,
  BashToolDetails,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { resolveDirectExecution } from "../../src/core/common.js";
import type { BgTask } from "../../src/core/common.js";
import {
  bashOverrideExecute,
  createBashOverrideDeps,
  prependCommandPrefix,
  type BashOverrideDeps,
} from "../../src/bash-override.js";

function fakeContext(): ExtensionContext {
  return { cwd: "/tmp/project" } as ExtensionContext;
}

function fakeTask(overrides: Partial<BgTask> = {}): BgTask {
  const base: BgTask = {
    id: "bunit001",
    name: "Background Task",
    command: "",
    description: undefined,
    status: "running",
    outputPath: "/tmp/project/.pi/agent/tasks/x/bunit001.output",
    outputAbsPath: "/tmp/project/.pi/agent/tasks/x/bunit001.output",
    metadataAbsPath: "/tmp/project/.pi/agent/tasks/x/bunit001.json",
    cwd: "/tmp/project",
    startTime: 1,
    exitCode: undefined,
    pid: 4200,
    bytesWritten: 0,
    isAgent: false,
    surviveReload: false,
    notified: false,
    notifyOnCompletion: true,
    triggerOnCompletion: true,
    terminalPublished: false,
    terminalPublicationState: "pending",
    terminalPublishAttempts: 0,
    waiters: [],
  };
  return Object.assign(base, overrides);
}

interface ForegroundCall {
  toolCallId: string;
  params: { command: string; timeout?: number };
  signal: AbortSignal | undefined;
  onUpdate: unknown;
  ctx: ExtensionContext;
}

interface BackgroundCall {
  ctx: ExtensionContext;
  command: string;
  options: Record<string, unknown>;
}

interface Recorder {
  backgroundCalls: BackgroundCall[];
  foregroundCalls: ForegroundCall[];
  hostResult: AgentToolResult<BashToolDetails | undefined>;
}

function makeRecorder(
  hostResult: AgentToolResult<BashToolDetails | undefined>,
): Recorder {
  return {
    backgroundCalls: [],
    foregroundCalls: [],
    hostResult,
  };
}

function makeDeps(
  recorder: Recorder,
  options: { hostCommandPrefix?: string | undefined } = {},
): BashOverrideDeps {
  return {
    startBackgroundTask: async (ctx, command, options) => {
      recorder.backgroundCalls.push({
        ctx,
        command,
        options: { ...options },
      });
      return fakeTask();
    },
    executeForeground: (toolCallId, params, signal, onUpdate, ctx) => {
      recorder.foregroundCalls.push({
        toolCallId,
        params: { ...params },
        signal,
        onUpdate,
        ctx,
      });
      return Promise.resolve(recorder.hostResult);
    },
    hostCommandPrefix: options.hostCommandPrefix,
  };
}

const NO_DETAILS_RESULT: AgentToolResult<BashToolDetails | undefined> = {
  content: [],
  details: undefined,
};

void describe("bash override 分流 (M4)", () => {
  void it("routes run_in_background:true to the background stack with entrySource model", async () => {
    const recorder = makeRecorder(NO_DETAILS_RESULT);
    const deps = makeDeps(recorder);
    const ctx = fakeContext();
    const signal = new AbortController().signal;
    const onUpdate = () => undefined;
    const result = await bashOverrideExecute(
      "call-1",
      { command: "npm test -- --watch", run_in_background: true },
      signal,
      onUpdate,
      ctx,
      deps,
    );
    assert.equal(recorder.backgroundCalls.length, 1, "后台路径单次启动");
    const backgroundCall = recorder.backgroundCalls[0];
    assert.ok(backgroundCall, "background call recorded");
    assert.equal(backgroundCall.ctx, ctx);
    assert.equal(backgroundCall.command, "npm test -- --watch");
    assert.equal(backgroundCall.options["entrySource"], "model");
    // M2 断言落点:模型入口缺省 notify+trigger 由 registry 派生,分流不显式置标志
    assert.equal(
      backgroundCall.options["notifyOnCompletion"],
      undefined,
      "通知缺省由 registry 派生",
    );
    assert.equal(
      backgroundCall.options["triggerOnCompletion"],
      undefined,
      "唤醒缺省由 registry 派生",
    );
    assert.equal(recorder.foregroundCalls.length, 0, "后台路径不触达前台");
    const text = String(
      (result.content as Array<{ text?: string }>)[0]?.text ?? "",
    );
    assert.match(text, /Started background task/u);
    assert.match(text, /Automatic follow-up turn: enabled\./u);
    const details = result.details as { fullOutputPath?: string } | undefined;
    assert.ok(details, "result details present");
    assert.equal(
      details.fullOutputPath,
      "/tmp/project/.pi/agent/tasks/x/bunit001.output",
      "后台结果携带绝对完整输出路径(P4)",
    );
  });

  void it("S7: routes task_name to StartTaskOptions.name with explicit-name priority", async () => {
    const recorder = makeRecorder(NO_DETAILS_RESULT);
    const deps = makeDeps(recorder);
    await bashOverrideExecute(
      "call-named",
      {
        command: "sleep 9",
        task_name: "My Named Job",
        run_in_background: true,
      },
      undefined,
      undefined,
      fakeContext(),
      deps,
    );
    const call = recorder.backgroundCalls[0];
    assert.ok(call, "background call recorded");
    assert.equal(call.options["name"], "My Named Job");
    assert.equal(call.command, "sleep 9", "命名不改写 command");
  });

  void it("P7: background timeout 0 and omitted both mean no deadline; positive maps to timeoutSeconds", async () => {
    const zero = makeRecorder(NO_DETAILS_RESULT);
    const zeroDeps = makeDeps(zero);
    await bashOverrideExecute(
      "call-zero",
      { command: "sleep 9", timeout: 0, run_in_background: true },
      undefined,
      undefined,
      fakeContext(),
      zeroDeps,
    );
    const zeroCall = zero.backgroundCalls[0];
    assert.ok(zeroCall, "zero-call background recorded");
    assert.equal(zeroCall.options["timeoutSeconds"], undefined);

    const omitted = makeRecorder(NO_DETAILS_RESULT);
    const omittedDeps = makeDeps(omitted);
    await bashOverrideExecute(
      "call-omitted",
      { command: "sleep 9", run_in_background: true },
      undefined,
      undefined,
      fakeContext(),
      omittedDeps,
    );
    const omittedCall = omitted.backgroundCalls[0];
    assert.ok(omittedCall, "omitted-call background recorded");
    assert.equal(omittedCall.options["timeoutSeconds"], undefined);

    const positive = makeRecorder(NO_DETAILS_RESULT);
    const positiveDeps = makeDeps(positive);
    await bashOverrideExecute(
      "call-positive",
      { command: "sleep 9", timeout: 30, run_in_background: true },
      undefined,
      undefined,
      fakeContext(),
      positiveDeps,
    );
    const positiveCall = positive.backgroundCalls[0];
    assert.ok(positiveCall, "positive-call background recorded");
    assert.equal(positiveCall.options["timeoutSeconds"], 30);
  });

  void it("S1 P2: prepends hostCommandPrefix with newline splice on the background path", async () => {
    const recorder = makeRecorder(NO_DETAILS_RESULT);
    const deps = makeDeps(recorder, {
      hostCommandPrefix: "shopt -s expand_aliases",
    });
    await bashOverrideExecute(
      "call-prefix",
      { command: "npm test", run_in_background: true },
      undefined,
      undefined,
      fakeContext(),
      deps,
    );
    const call = recorder.backgroundCalls[0];
    assert.ok(call, "background call recorded");
    assert.equal(
      call.command,
      "shopt -s expand_aliases\nnpm test",
      "前缀按宿主前台同款换行拼接(bash.ts:251)",
    );
  });

  void it("S1 P2: createBashOverrideDeps accepts shellPath/commandPrefix and forwards them to the host definition", async () => {
    // 构造期断言:宿主 createBashToolDefinition 第二参接受注入且不抛错
    // (源码溯源断言见 extension 注册面测试;宿主执行面需真实 session ctx,不在
    // 本单测注入面内)。
    const deps = createBashOverrideDeps({
      baseCwd: process.cwd(),
      hostShellPath: "/opt/host/bash",
      hostCommandPrefix: 'alias ll="ls -l"',
      startBackgroundTask: async () => {
        throw new Error("background must not run during wiring assertion");
      },
    });
    assert.equal(deps.hostCommandPrefix, 'alias ll="ls -l"');
    assert.equal(typeof deps.executeForeground, "function");
    const source = readFileSync(
      new URL("../../src/bash-override.ts", import.meta.url),
      "utf8",
    );
    assert.match(source, /createBashToolDefinition\(options\.baseCwd, \{/u);
    assert.match(source, /commandPrefix: options\.hostCommandPrefix/u);
    assert.match(source, /shellPath: options\.hostShellPath/u);
  });

  void it("maps bash timeout seconds to background timeoutSeconds", async () => {
    const recorder = makeRecorder(NO_DETAILS_RESULT);
    const deps = makeDeps(recorder);
    await bashOverrideExecute(
      "call-2",
      { command: "sleep 5", timeout: 30, run_in_background: true },
      undefined,
      undefined,
      fakeContext(),
      deps,
    );
    const call = recorder.backgroundCalls[0];
    assert.ok(call, "background call recorded");
    assert.equal(call.options["timeoutSeconds"], 30);
  });

  void it("passes through the host foreground path unchanged when run_in_background is undefined", async () => {
    const recorder = makeRecorder(NO_DETAILS_RESULT);
    const deps = makeDeps(recorder);
    const ctx = fakeContext();
    const signal = new AbortController().signal;
    const onUpdate = () => undefined;
    const result = await bashOverrideExecute(
      "call-3",
      { command: "echo hi" },
      signal,
      onUpdate,
      ctx,
      deps,
    );
    assert.equal(recorder.backgroundCalls.length, 0, "缺省路径不得进入后台栈");
    assert.equal(recorder.foregroundCalls.length, 1);
    const call = recorder.foregroundCalls[0];
    assert.ok(call, "foreground call recorded");
    assert.equal(call.toolCallId, "call-3");
    assert.deepEqual(call.params, { command: "echo hi" });
    assert.ok(
      !Object.prototype.hasOwnProperty.call(call.params, "run_in_background"),
      "前台参数不得携带新增字段",
    );
    assert.equal(call.signal, signal, "signal 引用透传");
    assert.equal(call.onUpdate, onUpdate, "onUpdate 引用透传");
    assert.equal(call.ctx, ctx, "ctx 引用透传");
    assert.equal(result, recorder.hostResult, "宿主结果引用原样透传");
  });

  void it("treats run_in_background:false exactly like the default foreground path", async () => {
    const recorder = makeRecorder(NO_DETAILS_RESULT);
    const deps = makeDeps(recorder);
    const ctx = fakeContext();
    const result = await bashOverrideExecute(
      "call-4",
      { command: "echo hi", run_in_background: false },
      undefined,
      undefined,
      ctx,
      deps,
    );
    assert.equal(recorder.backgroundCalls.length, 0);
    assert.equal(recorder.foregroundCalls.length, 1);
    const call = recorder.foregroundCalls[0];
    assert.ok(call, "foreground call recorded");
    assert.deepEqual(call.params, { command: "echo hi" });
    assert.equal(call.ctx, ctx);
    assert.equal(result, recorder.hostResult);
  });

  void it("Q1: does not leak task_name into the host foreground params", async () => {
    const recorder = makeRecorder(NO_DETAILS_RESULT);
    const deps = makeDeps(recorder);
    await bashOverrideExecute(
      "call-task-name",
      { command: "echo hi", task_name: "Leaky Name", run_in_background: false },
      undefined,
      undefined,
      fakeContext(),
      deps,
    );
    assert.equal(recorder.backgroundCalls.length, 0, "前台路径不得进入后台栈");
    assert.equal(recorder.foregroundCalls.length, 1);
    const call = recorder.foregroundCalls[0];
    assert.ok(call, "foreground call recorded");
    assert.deepEqual(call.params, { command: "echo hi" });
    assert.ok(
      !Object.prototype.hasOwnProperty.call(call.params, "task_name"),
      "前台参数不得携带 task_name 键",
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(call.params, "run_in_background"),
      "前台参数不得携带 run_in_background 键",
    );
  });
});

void describe("宿主 shellCommandPrefix 前置拼接 (REVIEW N1)", () => {
  void it("prependCommandPrefix splices with a newline and passes through empty/undefined", () => {
    assert.equal(
      prependCommandPrefix("shopt -s expand_aliases", "npm test"),
      "shopt -s expand_aliases\nnpm test",
      "有前缀时按宿主前台同款换行拼接(bash.ts:251)",
    );
    assert.equal(prependCommandPrefix(undefined, "npm test"), "npm test");
    assert.equal(prependCommandPrefix("", "npm test"), "npm test");
  });

  void it("N1: dock「转后台」与 rerun 共用 startTask 前置 = 覆盖版 bash 后台路径同源助手", () => {
    const source = readFileSync(
      new URL("../../src/extension.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /prependCommandPrefix\(/u,
      "extension 引入同一前置助手",
    );
    assert.match(
      source,
      /hostShellSettings\.commandPrefix/u,
      "dock 入口使用宿主自读的 commandPrefix",
    );
    assert.match(
      source,
      /prependCommandPrefix\(\s*hostShellSettings\.commandPrefix\s*,\s*command\s*,?\s*\)/u,
      "startTask helper 内统一前置(Dock「转后台」/rerun 两入口共用)",
    );
    assert.doesNotMatch(
      source,
      /registry\.startTask\(nextRegistryCtx, command,/u,
      "startTask helper 不得再直传未前置的 command",
    );
  });

  void it("N2: rerun 仅当任务确有显式 name 时透传,否则省略", () => {
    const source = readFileSync(
      new URL("../../src/extension.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /name:\s*taskDisplayName\(task\)/u,
      "rerun 不得再以显示名回填 name",
    );
    assert.match(
      source,
      /if\s*\(task\.name\s*!==\s*undefined\)\s*rerunOptions\.name\s*=\s*task\.name;/u,
      "仅显式 name 才透传 rerun",
    );
  });
});

void describe("直接执行 argv 解析 (M4)", () => {
  void it("keeps argv intact with shell-free semantics on POSIX", () => {
    const resolved = resolveDirectExecution(["node", "--test", "--verbose"], {
      platform: "linux",
      env: {},
    });
    assert.equal(resolved.file, "node");
    assert.deepEqual(resolved.args, ["--test", "--verbose"]);
    assert.equal(resolved.windowsVerbatimArguments, false);
  });

  void it("spawns a resolved .exe directly on Windows without shim routing", () => {
    const exePath = "C:\\tools\\node.exe";
    const resolved = resolveDirectExecution(["node", "--version"], {
      platform: "win32",
      env: { PATH: "C:\\tools", PATHEXT: ".EXE;.CMD" },
      exists: (candidate) => {
        const key = candidate.replaceAll("\\", "/");
        return key === exePath.replaceAll("\\", "/");
      },
    });
    assert.equal(resolved.file, exePath);
    assert.deepEqual(resolved.args, ["--version"]);
    assert.equal(resolved.windowsVerbatimArguments, false);
  });

  void it("routes a Windows .cmd shim through cmd.exe with /d /s /c", () => {
    const shimPath = "C:\\tools\\npm.cmd";
    const resolved = resolveDirectExecution(
      ["npm", "install", "pkg with space"],
      {
        platform: "win32",
        env: {
          PATH: "C:\\tools",
          PATHEXT: ".CMD;.EXE",
          ComSpec: "C:\\Windows\\system32\\cmd.exe",
        },
        exists: (candidate) => {
          const key = candidate.replaceAll("\\", "/");
          return key === shimPath.replaceAll("\\", "/");
        },
      },
    );
    assert.equal(resolved.file, "C:\\Windows\\system32\\cmd.exe");
    assert.deepEqual(resolved.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(resolved.windowsVerbatimArguments, true);
    const commandLine = resolved.args[3];
    assert.ok(typeof commandLine === "string", "command line present");
    assert.match(commandLine, /npm\.cmd/u);
    assert.match(commandLine, /pkg with space/u);
    assert.match(
      commandLine,
      /"[^"]*pkg with space[^"]*"/u,
      "带空格参数被引号包裹",
    );
  });

  void it("falls back to ComSpec when none is set and quotes empty arguments", () => {
    const resolved = resolveDirectExecution(["npm", ""], {
      platform: "win32",
      env: { PATH: "C:\\tools", PATHEXT: ".CMD;.EXE" },
      exists: (candidate) => candidate === "C:\\tools\\npm.cmd",
    });
    assert.equal(resolved.file, "cmd.exe", "无 ComSpec 时回退 cmd.exe");
    assert.match(String(resolved.args[3]), /""/u, "空参数以引号形式呈现");
  });

  void it("throws on an empty or missing executable name", () => {
    assert.throws(
      () => resolveDirectExecution([], { platform: "linux", env: {} }),
      /argv\[0\] must be a non-empty executable name/u,
    );
    assert.throws(
      () => resolveDirectExecution(["  "], { platform: "linux", env: {} }),
      /argv\[0\] must be a non-empty executable name/u,
    );
  });
});

void describe("bg_run 退役与 bash 覆盖注册面 (M4)", () => {
  void it("extension no longer registers bg_run and registers the same-name bash override", () => {
    const source = readFileSync(
      new URL("../../src/extension.ts", import.meta.url),
      "utf8",
    );
    assert.ok(!source.includes("name: 'bg_run'"), "bg_run 注册已退役");
    assert.ok(!source.includes("BgRunParams"), "bg_run schema 常量已移除");
    assert.ok(
      source.includes("name: 'bash'") || source.includes('name: "bash"'),
      "同名 bash 覆盖工具已注册",
    );
    assert.ok(
      source.includes("run_in_background"),
      "schema 携带 run_in_background",
    );
    assert.ok(
      source.includes("createBashOverrideDeps"),
      "复用宿主 bash 定义路径",
    );
  });
});
