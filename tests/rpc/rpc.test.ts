import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseJsonText } from "../../src/core/common.js";
import { piLaunchArgv, resolvePiLaunch } from "../../src/core/pi-launch.js";
import { isolatedTestEnv } from "../helpers/normalize.js";

// npm installs `pi` as a pi.cmd shim on Windows, and a shell-less spawn does not
// consult PATHEXT, so spawning the bare name fails with ENOENT. Production solves
// this by resolving the Pi package bin and launching it through Node; reusing that
// resolver keeps the harness aligned with real launch behaviour on every platform.
const piLaunch = resolvePiLaunch();

const extensionPath = resolve("extensions/background-tasks.ts");

interface Pending {
  resolve: (event: object) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function field(value: object, key: string): unknown {
  const property: unknown = Reflect.get(value, key);
  return property;
}

function parseJsonValue(text: string): unknown {
  return parseJsonText(text);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string")
    throw new TypeError(`${label} must be a string`);
  return value;
}

function eventMessage(event: object): string {
  const message = field(event, "message");
  return typeof message === "string" ? message : "";
}

class RPC {
  events: object[] = [];
  buf = "";
  seq = 0;
  pending = new Map<string, Pending>();
  stderr = "";
  proc: ChildProcessWithoutNullStreams;

  constructor(
    public cwd: string,
    env: Record<string, string> = {},
  ) {
    this.proc = spawn(
      piLaunch.executable,
      piLaunchArgv(piLaunch, [
        "--mode",
        "rpc",
        "--no-session",
        "--offline",
        "--no-extensions",
        "-e",
        extensionPath,
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-tools",
      ]),
      {
        cwd,
        env: {
          ...process.env,
          ...isolatedTestEnv,
          NPM_CONFIG_CACHE: join(tmpdir(), "pi-npm-cache"),
          ...env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.on(chunk.toString());
    });
    this.proc.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
  }

  on(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      const parsed = parseJsonValue(line);
      assert.ok(isObject(parsed), "RPC event must be an object");
      this.events.push(parsed);
      const eventId = field(parsed, "id");
      if (
        field(parsed, "type") === "response" &&
        typeof eventId === "string" &&
        this.pending.has(eventId)
      ) {
        const pending = this.pending.get(eventId);
        assert.ok(pending);
        this.pending.delete(eventId);
        clearTimeout(pending.timer);
        pending.resolve(parsed);
      }
    }
  }

  send(cmd: object): Promise<object> {
    this.seq += 1;
    const id = `r${String(this.seq)}`;
    return new Promise<object>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(this.stderr || `RPC timeout for ${JSON.stringify(cmd)}`),
        );
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(`${JSON.stringify({ ...cmd, id })}\n`);
    });
  }

  async wait(
    pred: (event: object) => boolean,
    timeoutMs = 10_000,
  ): Promise<object> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = this.events.find(pred);
      if (found) return found;
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    }
    throw new Error(
      `timeout ${this.stderr}\nEvents: ${JSON.stringify(this.events.slice(-10), null, 2)}`,
    );
  }

  async prompt(message: string): Promise<object> {
    return this.send({ type: "prompt", message });
  }

  stop(): Promise<void> {
    this.proc.kill("SIGTERM");
    return Promise.resolve();
  }
}

// A killed child releases its handles asynchronously on Windows, so a directory
// removal issued immediately after stop can still observe the open handle and
// fail with EBUSY, ENOTEMPTY, or EPERM. This is a bounded retry of a transient
// condition, not a fallback: the final attempt still throws, and no other error
// is retried.
const REMOVABLE_AFTER_RETRY = /EBUSY|ENOTEMPTY|EPERM/;

async function removeRootWhenReleased(root: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!REMOVABLE_AFTER_RETRY.test(message) || attempt === 9) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function withRpc(
  fn: (rpc: RPC, cwd: string) => Promise<void>,
  env: Record<string, string> = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-bg-rpc-"));
  const cwd = join(root, "project");
  await mkdir(cwd, { recursive: true });
  const rpc = new RPC(cwd, env);
  try {
    await fn(rpc, cwd);
  } finally {
    await rpc.stop();
    await removeRootWhenReleased(root);
  }
}

function notifyWith(re: RegExp): (event: object) => boolean {
  return (event) =>
    field(event, "type") === "extension_ui_request" &&
    re.test(eventMessage(event));
}

function commandNames(event: object): string[] {
  const data = field(event, "data");
  assert.ok(isObject(data));
  const commands = field(data, "commands");
  assert.ok(Array.isArray(commands));
  return commands.map((command) => {
    assert.ok(isObject(command));
    const name = field(command, "name");
    return requireString(name, "command name");
  });
}

void describe("rpc", () => {
  void it("discovers commands and covers /bg-jobs + /bg-logs slash flow", async () => {
    await withRpc(async (rpc) => {
      const c = await rpc.send({ type: "get_commands" });
      assert.equal(field(c, "success"), true);
      const names = commandNames(c);
      for (const name of ["bg-clear", "bg-jobs", "bg-kill", "bg-logs"])
        assert.ok(names.includes(name), name);
      await rpc.prompt("/bg-jobs");
      await rpc.wait(
        notifyWith(/No background tasks in this Pi extension runtime/),
      );
      await rpc.prompt("/bg-logs bdeadbeef 100");
      await rpc.wait(notifyWith(/Unknown background task ID/));
      await rpc.prompt("/bg-clear");
      await rpc.wait(
        notifyWith(/No finished background task notices to clear/),
      );
    });
  });

  void it("reports slash command input errors loudly", async () => {
    await withRpc(async (rpc) => {
      await rpc.prompt("/bg-logs bdeadbeef 100");
      await rpc.wait(
        notifyWith(/Background logs error:[\s\S]*Unknown background task ID/),
      );
      await rpc.prompt("/bg-kill bdeadbeef");
      await rpc.wait(
        notifyWith(/Background kill error:[\s\S]*Unknown background task ID/),
      );
    });
  });
});
