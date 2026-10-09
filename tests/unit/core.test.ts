import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import {
  boundedRead,
  deriveCompletionDeliveryGuidance,
  deriveTerminalStatus,
  formatAgentActivityLine,
  parseAgentActivity,
  formatCompactNumber,
  DEFAULT_LOG_BYTES,
  formatDuration,
  formatModelSummary,
  formatSnapshotList,
  MAX_LOG_BYTES,
  normalizeMaxBytes,
  normalizeTaskName,
  sanitizePathSegment,
  shellInvocation,
  TASK_STATUS_VALUES,
  taskDisplayName,
  TERMINAL_TASK_STATUS_VALUES,
  truncateChars,
  type BgTask,
} from "../../src/core/common.js";

/** 最小 BgTask 夹具(仅填 deriveTerminalStatus 等纯函数所需字段)。 */
function fakeBgTask(overrides: Partial<BgTask> = {}): BgTask {
  const base: BgTask = {
    id: "q3test01",
    command: "sleep 9",
    status: "running",
    outputPath: "/tmp/pi-bg/tasks/x/q3test01.output",
    outputAbsPath: "/tmp/pi-bg/tasks/x/q3test01.output",
    metadataAbsPath: "/tmp/pi-bg/tasks/x/q3test01.json",
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

void describe("core", () => {
  void it("normalizes task names and falls back through the display chain", () => {
    assert.equal(normalizeTaskName(' "A   B" '), "A B");
    assert.equal(normalizeTaskName("\n\t"), undefined);
    assert.equal(normalizeTaskName(123), undefined);
    assert.equal(normalizeTaskName("x".repeat(100)), `${"x".repeat(79)}…`);
    assert.equal(
      taskDisplayName({
        description: "Longer description",
        command: "echo ok",
      }),
      "Longer description",
    );
    assert.equal(
      taskDisplayName({ command: "echo one two three four five six" }),
      "echo one two three four five six",
    );
    assert.equal(taskDisplayName({ id: "b123" }), "b123");
  });

  void it("S7: shows explicit name first, then description, then the full command verbatim, then id", () => {
    assert.equal(
      taskDisplayName({
        name: "Explicit Name",
        description: "Desc",
        command: "cd /a && npm test",
      }),
      "Explicit Name",
    );
    assert.equal(
      taskDisplayName({
        description: "Desc",
        command: "cd /a && npm test",
      }),
      "Desc",
    );
    // 完整命令原样兜底:不 compactWhitespace、不截断、不剥前缀
    assert.equal(
      taskDisplayName({ command: "cd /a && npm test" }),
      "cd /a && npm test",
    );
    assert.equal(
      taskDisplayName({ command: 'printf "a  b"\ncat <<EOF\n x\nEOF' }),
      'printf "a  b"\ncat <<EOF\n x\nEOF',
    );
    assert.equal(taskDisplayName({}), "Background task");
  });

  void it("S7: applies the 4KiB guard centrally inside taskDisplayName without touching task.command", () => {
    const huge = "x".repeat(5 * 1024);
    assert.equal(taskDisplayName({ command: huge }).length, 4 * 1024 - 1 + 1);
    assert.equal(taskDisplayName({ command: huge }).endsWith("…"), true);
    assert.equal(taskDisplayName({ name: "Small", command: huge }), "Small");
    const atLimit = "y".repeat(4 * 1024);
    assert.equal(taskDisplayName({ command: atLimit }), atLimit);
  });

  void it("Q3: external kill -9 with null exit code and signal, no killKind, is not completed", () => {
    const task = fakeBgTask();
    // 被外部信号杀死:close 事件 exitCode=null、signal 有值、killKind 未置位
    const result = deriveTerminalStatus(
      task,
      undefined,
      null,
      "SIGKILL",
      DEFAULT_LOG_BYTES,
    );
    assert.notEqual(
      result.status,
      "completed",
      "外部信号杀死不得误判 completed",
    );
    assert.equal(result.status, "failed", "null 落入失败语义分支");
    assert.equal(task.failedReason, "exit_error");
    assert.ok(
      result.error !== undefined && result.error.includes("SIGKILL"),
      "error 保留 signal 信息",
    );
  });

  void it("Q3: exitCode 0 stays completed and nonzero/null stay failed", () => {
    const ok = deriveTerminalStatus(
      fakeBgTask(),
      undefined,
      0,
      null,
      DEFAULT_LOG_BYTES,
    );
    assert.equal(ok.status, "completed");
    const bad = deriveTerminalStatus(
      fakeBgTask(),
      undefined,
      3,
      null,
      DEFAULT_LOG_BYTES,
    );
    assert.equal(bad.status, "failed");
    assert.equal(bad.error, "Exited with code 3");
    const nullExit = deriveTerminalStatus(
      fakeBgTask(),
      undefined,
      null,
      null,
      DEFAULT_LOG_BYTES,
    );
    assert.equal(nullExit.status, "failed");
    assert.equal(nullExit.error, "Exited with code null");
  });

  void it("derives truthful completion delivery for every notification and wake combination", () => {
    assert.deepEqual(deriveCompletionDeliveryGuidance(true, true), {
      mode: "notification-and-wake",
      notificationEnabled: true,
      automaticWakeEnabled: true,
      text: [
        "Terminal notification: enabled.",
        "Automatic follow-up turn: enabled.",
        "Next action: do not poll or sleep merely to wait; continue only independent useful work, otherwise end this turn and wait for <background-task-notification>.",
      ].join("\n"),
    });
    assert.deepEqual(deriveCompletionDeliveryGuidance(true, false), {
      mode: "notification-only",
      notificationEnabled: true,
      automaticWakeEnabled: false,
      text: [
        "Terminal notification: enabled.",
        "Automatic follow-up turn: disabled. The terminal notification will be delivered, but it will not start an agent turn.",
        "Next action: automatic wake-up was explicitly disabled; use bg_status/bg_logs only when deliberate monitoring is required, without tight polling.",
      ].join("\n"),
    });
    const notifyDisabledWithRequestedWake = deriveCompletionDeliveryGuidance(
      false,
      true,
    );
    assert.equal(notifyDisabledWithRequestedWake.mode, "manual-monitoring");
    assert.equal(notifyDisabledWithRequestedWake.notificationEnabled, false);
    assert.equal(notifyDisabledWithRequestedWake.automaticWakeEnabled, false);
    assert.match(
      notifyDisabledWithRequestedWake.text,
      /triggerOnCompletion has no effect/,
    );
    const manual = deriveCompletionDeliveryGuidance(false, false);
    assert.equal(manual.mode, "manual-monitoring");
    assert.match(manual.text, /deliberate manual monitoring/);
    assert.doesNotMatch(manual.text, /triggerOnCompletion has no effect/);
  });

  void it("formats durations, paths, snapshots, and byte limits", () => {
    assert.equal(formatDuration(999), "999ms");
    assert.equal(formatDuration(1000), "1s");
    assert.equal(formatDuration(65_000), "1m5s");
    assert.equal(formatDuration(3_660_000), "1h1m");
    assert.equal(formatCompactNumber(999), "999");
    assert.equal(formatCompactNumber(1250), "1.3k");
    assert.equal(formatCompactNumber(42_000), "42k");
    assert.equal(sanitizePathSegment("a/b c"), "a-b-c");
    assert.equal(sanitizePathSegment("///"), "session");
    // Pin both dialects explicitly. The host default differs by platform:
    // cmd.exe requires the paired outer-quoted form, POSIX passes the command
    // through verbatim, so an unpinned assertion fails on Windows.
    assert.equal(
      shellInvocation("echo ok", "linux", {}).args.includes("echo ok"),
      true,
    );
    assert.deepEqual(
      shellInvocation("echo ok", "win32", { ComSpec: "cmd.exe" }).args,
      ["/d", "/s", "/c", '"echo ok"'],
    );
    assert.equal(normalizeMaxBytes(-1, 123), 1);
    assert.equal(normalizeMaxBytes(Number.NaN, 123), 123);
    assert.equal(normalizeMaxBytes(1.9, 123), 1);
    assert.equal(truncateChars("abcdef", 4), "abc…");
    assert.deepEqual(
      [...TASK_STATUS_VALUES],
      ["running", "completed", "failed", "cancelled", "killed", "lost"],
    );
    // REVIEW 数值项:模型视图日志默认与上限取宿主值与 64KiB 目标的较小者,
    // 宿主导入小于 64KiB 时以宿主为准;normalizeMaxBytes 不得突破该上限。
    assert.equal(MAX_LOG_BYTES, Math.min(DEFAULT_MAX_BYTES, 64 * 1024));
    assert.equal(DEFAULT_LOG_BYTES, MAX_LOG_BYTES);
    assert.ok(MAX_LOG_BYTES >= 1);
    assert.equal(
      normalizeMaxBytes(Number.MAX_SAFE_INTEGER),
      MAX_LOG_BYTES,
      "bounded reads must respect the model-view cap",
    );
    assert.deepEqual(
      [...TERMINAL_TASK_STATUS_VALUES],
      ["completed", "failed", "cancelled", "killed", "lost"],
    );

    const text = formatSnapshotList(
      [
        {
          id: "b12345678",
          name: "Unit Task",
          command: "echo ok",
          status: "completed",
          outputPath: ".pi/tasks/run/b12345678.output",
          cwd: "/tmp",
          startTime: 1000,
          endTime: 2000,
          exitCode: 0,
          bytesWritten: 3,
          isAgent: true,
          surviveReload: false,
          notified: true,
          notifyOnCompletion: true,
          triggerOnCompletion: false,
          contextUsage: {
            tokens: 1250,
            contextWindow: 200_000,
            percent: 0.625,
          },
          tokenUsage: {
            input: 1000,
            output: 200,
            cacheRead: 30,
            cacheWrite: 20,
            totalTokens: 1250,
          },
          toolUsage: { total: 2, failed: 1, byName: { read: 1, bash: 1 } },
          model: "anthropic/claude-sonnet-4",
        },
        {
          id: "b99999999",
          command: "bad",
          status: "failed",
          outputPath: ".pi/tasks/run/b99999999.output",
          cwd: "/tmp",
          startTime: 1000,
          endTime: 2000,
          exitCode: 1,
          bytesWritten: 0,
          isAgent: false,
          surviveReload: false,
          error: "x".repeat(100),
          notified: false,
          notifyOnCompletion: true,
          triggerOnCompletion: true,
        },
        // REVIEW N4:exitCode 严格判空——null 与 undefined 均不得渲染 exit=
        {
          id: "b88888888",
          command: "bad2",
          status: "failed",
          outputPath: ".pi/tasks/run/b88888888.output",
          cwd: "/tmp",
          startTime: 1000,
          endTime: 2000,
          exitCode: null,
          bytesWritten: 0,
          isAgent: false,
          surviveReload: false,
          notified: false,
          notifyOnCompletion: true,
          triggerOnCompletion: true,
        },
      ],
      2000,
    );
    assert.match(text, /Unit Task/);
    assert.match(text, /ctx=0\.6%\/200k/);
    assert.match(text, /model=anthropic\/claude-sonnet-4/);
    assert.match(text, /tokens=1\.3k/);
    assert.match(text, /tools=2 failed=1/);
    assert.match(text, /✗ b99999999 failed/);
    assert.doesNotMatch(
      text,
      /b88888888 .*exit=/u,
      "exitCode null 不得渲染 exit=",
    );
    assert.match(text, /output: \.pi\/tasks/);
    assert.equal(
      formatModelSummary("anthropic/claude-sonnet-4"),
      "model=anthropic/claude-sonnet-4",
    );
    assert.equal(formatModelSummary(undefined), undefined);
    assert.equal(formatModelSummary(""), undefined);
  });

  void it("applies the Windows shell dialect policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-bg-shell-"));
    try {
      const bashPath = join(root, "bash.exe");
      const cmdPath = join(root, "cmd.com");
      await writeFile(bashPath, "", "utf8");
      await writeFile(cmdPath, "", "utf8");

      assert.deepEqual(
        shellInvocation("echo %USERPROFILE%", "win32", {
          SHELL: bashPath,
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
        }),
        {
          shell: "C:\\Windows\\System32\\cmd.exe",
          args: ["/d", "/s", "/c", '"echo %USERPROFILE%"'],
          dialect: "cmd",
          windowsVerbatimArguments: true,
        },
      );
      assert.deepEqual(shellInvocation("dir C:\\work", "win32", {}), {
        shell: "cmd.exe",
        args: ["/d", "/s", "/c", '"dir C:\\work"'],
        dialect: "cmd",
        windowsVerbatimArguments: true,
      });
      assert.deepEqual(
        shellInvocation("printf ok", "win32", {
          PI_BG_SHELL: "bash",
          PI_BG_SHELL_PATH: bashPath,
        }),
        {
          shell: bashPath,
          args: ["-c", "printf ok"],
          dialect: "posix",
          windowsVerbatimArguments: false,
        },
      );
      assert.notDeepEqual(
        shellInvocation("printf ok", "win32", {
          PI_BG_SHELL: "bash",
          PI_BG_SHELL_PATH: bashPath,
        }).args,
        ["-lc", "printf ok"],
      );
      assert.equal(
        shellInvocation("printf ok", "win32", {
          PI_BG_SHELL: "bash",
          PATH: root,
        }).shell,
        bashPath,
      );
      assert.equal(
        shellInvocation("set X=1", "win32", {
          PI_BG_SHELL: "cmd",
          PI_BG_SHELL_PATH: cmdPath,
        }).shell,
        cmdPath,
      );
      for (const value of ["", " bash", "bash ", "zsh"]) {
        assert.throws(
          () => shellInvocation("echo bad", "win32", { PI_BG_SHELL: value }),
          /cmd or bash/,
        );
      }
      assert.throws(
        () =>
          shellInvocation("echo bad", "win32", { PI_BG_SHELL_PATH: bashPath }),
        /requires PI_BG_SHELL/,
      );
      assert.throws(
        () =>
          shellInvocation("echo bad", "win32", {
            PI_BG_SHELL: "bash",
            PI_BG_SHELL_PATH: "bash.exe",
          }),
        /absolute path/,
      );
      assert.deepEqual(
        shellInvocation("echo $SHELL", "linux", {
          SHELL: "/bin/zsh",
          PI_BG_SHELL: "cmd",
          PI_BG_SHELL_PATH: bashPath,
        }),
        {
          shell: "/bin/zsh",
          args: ["-c", "echo $SHELL"],
          dialect: "posix",
          windowsVerbatimArguments: false,
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("parses and formats agent activity transcript lines", () => {
    assert.deepEqual(
      parseAgentActivity({
        type: "background-task-activity",
        kind: "assistant_text",
        text: "Done.\n",
      }),
      { kind: "assistant_text", text: "Done.\n" },
    );
    assert.equal(
      formatAgentActivityLine({
        kind: "assistant_text",
        text: "Looks good\n\n",
      }),
      "Looks good",
    );
    assert.equal(
      formatAgentActivityLine({ kind: "assistant_text", text: "  \n " }),
      undefined,
    );

    assert.equal(
      formatAgentActivityLine({ kind: "reasoning", text: "weighing options" }),
      "\u2026 weighing options",
    );
    assert.equal(
      formatAgentActivityLine({ kind: "reasoning", text: "   " }),
      undefined,
    );

    assert.deepEqual(
      parseAgentActivity({
        type: "background-task-activity",
        kind: "tool_start",
        tool: "read",
        argsSummary: "README.md",
      }),
      { kind: "tool_start", tool: "read", argsSummary: "README.md" },
    );
    assert.equal(
      formatAgentActivityLine({
        kind: "tool_start",
        tool: "read",
        argsSummary: "  src/index.ts  ",
      }),
      "\u2192 read src/index.ts",
    );
    assert.equal(
      formatAgentActivityLine({
        kind: "tool_start",
        tool: "bash",
        argsSummary: "",
      }),
      "\u2192 bash",
    );
    assert.equal(
      formatAgentActivityLine({
        kind: "tool_start",
        tool: "bash",
        argsSummary: "x".repeat(120),
      }),
      `\u2192 bash ${"x".repeat(79)}\u2026`,
    );
    assert.deepEqual(
      parseAgentActivity({
        type: "background-task-activity",
        kind: "tool_start",
        tool: "ls",
      }),
      { kind: "tool_start", tool: "ls", argsSummary: "" },
    );

    assert.deepEqual(
      parseAgentActivity({
        type: "background-task-activity",
        kind: "tool_end",
        tool: "bash",
        isError: true,
        error: "boom",
      }),
      { kind: "tool_end", tool: "bash", isError: true, error: "boom" },
    );
    assert.equal(
      formatAgentActivityLine({
        kind: "tool_end",
        tool: "read",
        isError: false,
      }),
      undefined,
    );
    assert.equal(
      formatAgentActivityLine({
        kind: "tool_end",
        tool: "bash",
        isError: true,
      }),
      "\u2717 bash failed",
    );
    assert.equal(
      formatAgentActivityLine({
        kind: "tool_end",
        tool: "bash",
        isError: true,
        error: "exit 1\nmore",
      }),
      "\u2717 bash failed: exit 1 more",
    );

    assert.equal(parseAgentActivity(null), undefined);
    assert.equal(parseAgentActivity("background-task-activity"), undefined);
    assert.equal(
      parseAgentActivity({
        type: "background-task-telemetry",
        kind: "tool_start",
        tool: "read",
      }),
      undefined,
    );
    assert.equal(
      parseAgentActivity({ type: "background-task-activity", kind: "mystery" }),
      undefined,
    );
    assert.equal(
      parseAgentActivity({
        type: "background-task-activity",
        kind: "tool_start",
      }),
      undefined,
    );
    assert.equal(
      parseAgentActivity({
        type: "background-task-activity",
        kind: "assistant_text",
      }),
      undefined,
    );
    assert.deepEqual(
      parseAgentActivity({
        type: "background-task-activity",
        kind: "tool_end",
        tool: "x",
        isError: false,
        error: "   ",
      }),
      { kind: "tool_end", tool: "x", isError: false },
    );
  });

  void it("boundedRead supports head, tail, truncation, and empty files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-bg-unit-"));
    try {
      const f = join(dir, "out");
      await writeFile(f, "abcdef");
      assert.deepEqual(await boundedRead(f, 3, true), {
        content: "def",
        truncated: true,
        bytesRead: 3,
        totalBytes: 6,
      });
      assert.deepEqual(await boundedRead(f, 3, false), {
        content: "abc",
        truncated: true,
        bytesRead: 3,
        totalBytes: 6,
      });
      assert.deepEqual(await boundedRead(f, 99, false), {
        content: "abcdef",
        truncated: false,
        bytesRead: 6,
        totalBytes: 6,
      });
      const empty = join(dir, "empty");
      await writeFile(empty, "");
      assert.deepEqual(await boundedRead(empty, 3, true), {
        content: "",
        truncated: false,
        bytesRead: 0,
        totalBytes: 0,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
