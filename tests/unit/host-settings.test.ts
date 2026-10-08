import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  normalizeHostShellPath,
  readHostShellSettings,
  resolveHostShellPath,
} from "../../src/core/host-settings.js";

const home = homedir();

void describe("S1 P2 host settings self-read", () => {
  void it("reads shellPath and shellCommandPrefix from the user-level settings.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-bg-host-settings-"));
    try {
      const agentDir = join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({
          shellPath: "~/bin/custom-shell",
          shellCommandPrefix: "shopt -s expand_aliases",
          unrelated: 42,
        }),
        "utf8",
      );
      const settings = await readHostShellSettings(agentDir);
      assert.equal(settings.shellPath, join(home, "bin", "custom-shell"));
      assert.equal(settings.commandPrefix, "shopt -s expand_aliases");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("degrades silently on missing file, malformed JSON, non-object, and missing fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-bg-host-settings-"));
    try {
      const agentDir = join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      // 文件缺失
      assert.deepEqual(await readHostShellSettings(agentDir), {});
      // JSON 解析失败
      await writeFile(join(agentDir, "settings.json"), "{not json", "utf8");
      assert.deepEqual(await readHostShellSettings(agentDir), {});
      // 非对象
      await writeFile(join(agentDir, "settings.json"), "[1,2]", "utf8");
      assert.deepEqual(await readHostShellSettings(agentDir), {});
      // 字段缺失
      await writeFile(join(agentDir, "settings.json"), "{}", "utf8");
      assert.deepEqual(await readHostShellSettings(agentDir), {});
      // 字段非字符串/空字符串 → 忽略
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({ shellPath: 7, shellCommandPrefix: "" }),
        "utf8",
      );
      assert.deepEqual(await readHostShellSettings(agentDir), {});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("S1 fixture: getShellConfig throw paths (invalid shellPath; Windows without bash) degrade to undefined", async () => {
    // fixture 1:settings.shellPath 存在但宿主 getShellConfig 抛出(有效存在性校验
    // 由宿主职责承载,此处模拟宿主 customShellPath 不存在抛错)
    const missingPathFixture = resolveHostShellPath(
      { shellPath: "/definitely/missing/pi-bg-shell" },
      () => {
        throw new Error("Custom shell path not found");
      },
    );
    assert.equal(missingPathFixture, undefined);
    // fixture 2:Windows 无 Git Bash/无 bash.exe 时 getShellConfig(undefined) 抛错
    const windowsNoBashFixture = resolveHostShellPath({}, () => {
      throw new Error("No bash shell found. Options: ...");
    });
    assert.equal(windowsNoBashFixture, undefined);
    // 正常路径:shellPath 优先;缺省时取 resolver 默认解析
    assert.equal(
      resolveHostShellPath({ shellPath: "/opt/host/bash" }, () => ({
        shell: "ignored",
      })),
      "/opt/host/bash",
    );
    assert.equal(
      resolveHostShellPath({}, () => ({ shell: "/bin/bash" })),
      "/bin/bash",
    );
  });

  void it("normalizes tilde and (on win32 only) git-bash style drive paths", () => {
    assert.equal(normalizeHostShellPath("~"), home);
    assert.equal(
      normalizeHostShellPath("~/bin/bash"),
      join(home, "bin", "bash"),
    );
    assert.equal(normalizeHostShellPath("/usr/bin/bash"), "/usr/bin/bash");
    if (process.platform === "win32") {
      assert.equal(
        normalizeHostShellPath("/c/tools/bash.exe"),
        "C:\\tools\\bash.exe",
      );
      assert.equal(
        normalizeHostShellPath("/mnt/c/tools/bash.exe"),
        "C:\\tools\\bash.exe",
      );
      assert.equal(
        normalizeHostShellPath("C:\\tools\\bash.exe"),
        "C:\\tools\\bash.exe",
      );
    }
  });
});
