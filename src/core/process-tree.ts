import { spawn as defaultSpawn, type SpawnOptions } from 'node:child_process';

/** ps 一次扫描的限时窗口(与 ZCode 参照实现常量一致)。 */
export const POSIX_PROCESS_LOOKUP_TIMEOUT_MS = 500;

/**
 * TERM 后启动 ps 后代收集的延迟窗口(生产默认 3000ms grace 下为 TERM 后 1500ms,
 * 即 grace 的一半);与 registry/reload-shell-owner 注入的 killGraceMs 按比例缩放,
 * 保证「TERM → 收集窗口 → 组 SIGKILL+逐后代 SIGKILL」时序在任意注入窗口下成立。
 */
export const POSIX_DESCENDANT_COLLECT_DELAY_MS = 1500;

interface ProcessTableChild {
  stdout?:
    | {
        on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
      }
    | null
    | undefined;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

export type ProcessTableSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ProcessTableChild;

type ProcessTableReader = () => Promise<string>;

/**
 * 收集 rootPid 的全部后代进程 pid。
 *
 * 一次 `ps -A -o pid= -o ppid=` 扫描解析出父子关系后按 BFS 收集后代;
 * 500ms 限时(`Promise.race`),ps 失败或超时返回空集(退化到组信号路径)。
 * 实现仿 ZCode `apps/zcode-cli/packages/adapters/src/exec/process-tree.ts:63-100`,
 * 逐行对照评审见里程碑交付说明。两个边界与 ZCode 参照保持一致:
 * - 进程自然死亡(收集后、逐杀前退出)→ 杀进程时 ESRCH 抛错,由调用方吞掉;
 * - pid 复用(TOCTOU)→ 与 ZCode 同等暴露:组 SIGKILL 仍是主清理路径,逐个
 *   补杀只覆盖逃逸出组的进程,扫描到补杀的窗口(参考时序约 1.5s)远小于
 *   pid 回绕周期,实际风险可忽略。
 */
export async function collectPosixDescendantPids(
  rootPid: number,
  readTable: ProcessTableReader = () => readPosixProcessTable(defaultSpawn),
  timeoutMs: number = POSIX_PROCESS_LOOKUP_TIMEOUT_MS,
): Promise<Set<number>> {
  let stdout: string;
  let timeoutTimer: NodeJS.Timeout | undefined;
  try {
    // 限时竞速:ps 挂起时定时器保持引用直至触发,保证竞速必然结算(相较 ZCode
    // 参照的 unref 定时器:裸事件循环下 unref 定时器不触发会让竞速永久悬挂);
    // ps 正常返回后立即清除定时器,不留把宿主保活 500ms 的挂起句柄。
    const timeoutPromise = new Promise<string>((resolve) => {
      timeoutTimer = setTimeout(() => resolve(''), timeoutMs);
    });
    const tablePromise = readTable();
    stdout = await Promise.race([tablePromise, timeoutPromise]);
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
  } catch {
    // ps 失败时按空后代集合退化,根进程组信号仍会继续;同时清除限时定时器,
    // 不留悬挂句柄。
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    return new Set();
  }
  return parsePosixProcessTable(stdout, rootPid);
}

/**
 * 解析 ps 输出(`pid ppid` 每行一记录)并按父子关系 BFS 收集根的后代。
 * 与 ZCode 参照的解析块逐行对应;单独导出以便单测用 fixture 直接断言,
 * 生产路径行为与参照实现保持一致。
 */
export function parsePosixProcessTable(
  stdout: string,
  rootPid: number,
): Set<number> {
  const childrenByParent = new Map<number, number[]>();
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }

  const descendants = new Set<number>();
  const queue = [rootPid];
  while (queue.length > 0) {
    const next = queue.shift();
    // 队列非空守卫保证 shift 永远有界;此分支仅满足类型检查,不改变行为
    if (next === undefined) break;
    const parentPid = next;
    for (const pid of childrenByParent.get(parentPid) ?? []) {
      if (pid <= 1 || pid === rootPid || descendants.has(pid)) continue;
      descendants.add(pid);
      queue.push(pid);
    }
  }
  return descendants;
}

function readPosixProcessTable(
  spawnProcess: ProcessTableSpawn,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let processTable: ProcessTableChild;
    try {
      processTable = spawnProcess('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], {
        cwd: '/',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    processTable.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk;
    });
    processTable.once('error', reject);
    processTable.once('close', () => resolve(stdout));
  });
}