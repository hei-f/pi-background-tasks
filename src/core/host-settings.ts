import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, getShellConfig } from "@earendil-works/pi-coding-agent";
import { parseJsonText } from "./common.js";

/**
 * S1 P2:宿主用户级 settings 中与本扩展相关的字段快照。
 * 仅读用户级 settings(路径 = `getAgentDir()/settings.json`,`~/.pi/agent/`);
 * 宿主项目级 settings 合并不在本插件读取面(README 已注明)。
 */
export interface HostShellSettings {
  /** 宿主 `settings.json` 的 `shellPath`(已应用宿主同款 normalizePath 归一化)。 */
  readonly shellPath?: string | undefined;
  /** 宿主 `settings.json` 的 `shellCommandPrefix`(原样返回,不裁剪)。 */
  readonly commandPrefix?: string | undefined;
}

/** Windows 下 Git Bash/MSYS/Cygwin/WSL 风格驱动器路径(`/c/…`、`/mnt/c/…`)转换为
 * Windows 原生路径;与宿主 `normalizePath` 的 `normalizeWindowsShellPath` 同款行为。 */
function normalizeWindowsShellPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\"))
    return value;
  const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(value);
  if (match === null) return value;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${(match[1] ?? "").toUpperCase()}:\\${suffix ?? ""}`;
}

/** `~` 展开(home 根目录与 `~/…` 前缀);与宿主 `normalizePath` 的 tilde 处理同款。 */
function expandTilde(value: string): string {
  const home = homedir();
  if (value === "~") return home;
  if (
    value.startsWith("~/") ||
    (process.platform === "win32" && value.startsWith("~\\"))
  ) {
    return join(home, value.slice(2));
  }
  return value;
}

/**
 * 宿主同款 `normalizePath` 归一化(settings-manager.ts:1012 `getShellPath()` 一趟):
 * 仅做 `~` 展开与 Windows 驱动器路径转换;不做 trim/unicode 空格规整。
 *
 * `file://` 边界:宿主 normalizePath 通用面会做 `file://` 前缀转换,本插件跳过
 * 该步(settings.json 中 `file://` 形式的 shellPath 属畸形配置,插件按原样传入,
 * 经 resolveHostShellPath 的 getShellConfig 存在性校验失败静默降级)→ 与宿主
 * 存在行为分歧,但分歧落点全部收敛于静默降级,安全。
 */
export function normalizeHostShellPath(value: string): string {
  let normalized = value;
  if (process.platform === "win32") {
    normalized = normalizeWindowsShellPath(normalized);
  }
  return expandTilde(normalized);
}

/** 宿主前台 shell 解析器的可注入形状(默认取 @earendil-works/pi-coding-agent 的
 * getShellConfig;单测注入假件覆盖 Windows 无 bash 等平台专属 throw 场景)。 */
export type HostShellConfigResolver = (customShellPath?: string) => {
  readonly shell: string;
};

/**
 * S1 P1+P2:宿主前台 shell 解析 + 全链静默降级(纯函数,可测)。
 * 两条调用路径都可能 throw(customShellPath 不存在;Windows 无 Git Bash/无
 * bash.exe 时 getShellConfig(undefined) 同样 throw)→ 整链 try/catch 静默降级
 * → 返回 undefined,由调用方走 env.SHELL 兜底,插件照常激活(不复现宿主崩溃)。
 * 强制澄清 fixture:无效 shellPath、Windows 无 bash。
 */
export function resolveHostShellPath(
  hostShellSettings: HostShellSettings,
  resolveShell: HostShellConfigResolver = getShellConfig,
): string | undefined {
  try {
    // 显式调用 resolver(即便 shellPath 已存在):宿主 getShellConfig 同时承担
    // 存在性校验——无效 settings.shellPath 以 throw 进入上述静默降级(澄清 fixture 1);
    // 解析成功后 shellPath 仍优先于 resolver 默认结果(P1 链序)。
    const resolved = resolveShell(hostShellSettings.shellPath);
    return hostShellSettings.shellPath ?? resolved.shell;
  } catch {
    return undefined;
  }
}

/**
 * 读取宿主**用户级** `settings.json` 的 `shellPath`/`shellCommandPrefix` 字段。
 * 任何失败(文件缺失/读取失败/JSON 解析失败/字段缺失或非字符串)静默返回空对象,
 * 不告警——读取失败即视为宿主缺省配置,插件照常激活(S1 强制澄清:无效 shellPath
 * 与 Windows 无 bash 的降级路径由 resolveHostShellPath 的 try/catch 承接,此处
 * 不做存在性校验)。
 */
export async function readHostShellSettings(
  agentDir: string = getAgentDir(),
): Promise<HostShellSettings> {
  let text: string;
  try {
    text = await readFile(join(agentDir, "settings.json"), "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = parseJsonText(text);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const record = parsed as Record<string, unknown>;
  const rawShellPath = record["shellPath"];
  const shellPath =
    typeof rawShellPath === "string" && rawShellPath.trim().length > 0
      ? normalizeHostShellPath(rawShellPath)
      : undefined;
  const rawPrefix = record["shellCommandPrefix"];
  const commandPrefix =
    typeof rawPrefix === "string" && rawPrefix.length > 0
      ? rawPrefix
      : undefined;
  return {
    ...(shellPath === undefined ? {} : { shellPath }),
    ...(commandPrefix === undefined ? {} : { commandPrefix }),
  };
}
