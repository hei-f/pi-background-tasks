import { realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { BgTaskSnapshot } from '../../src/core/common.js';
import {
  getProcessReloadShellOwnerV1,
  makeReloadShellIdentity,
} from '../../src/core/reload-shell-owner.js';

export interface SeedLegacySurvivorOptions {
  readonly name: string;
  readonly notifyOnCompletion?: boolean | undefined;
  readonly timeoutSeconds?: number | undefined;
}

/**
 * M4 收口:预置「遗留存活记录」fixture。
 *
 * 覆盖版 bash / dock「转后台」之外不再存在暴露 `surviveReload` 的新启动入口
 * (仅 dock rerun 保留既有任务的标志)。SDK 集成测试仍需要一条真实子进程 +
 * 进程级 reload owner 注册的 opt 存活任务,以验证跨 `AgentSession.reload()`
 * 的让渡/认领/结算路径 —— 本 helper 在扩展首次激活之前,以 reload 语义先把
 * 存活任务装载进与扩展共享的进程级 hub:
 *
 * 1. 测试侧注册表对会话身份 `beginActivation('reload')` 并 commit 租约;
 * 2. 用该租约 `startTask({surviveReload:true})` 启动真实子进程存活任务;
 * 3. `prepareReloadHandoff` 把任务保留在 hub 的 handoff 槽位;
 * 4. 会话随后以 `sessionStartEvent` reason 'reload' 绑定扩展,新激活从 hub
 *    认领并导入该任务 —— 与「旧激活让渡后新激活认领」的真实路径一致。
 *
 * 注意:`src/core/registry.js` 必须惰性导入,使 `MAX_OUTPUT_BYTES` /
 * `SOFT_OUTPUT_BYTES` 模块常量在调用时按当时生效的环境变量求值,与扩展
 * 激活时载入的同一模块实例保持一致(否则存活任务的 outputCap 断言会失配)。
 */
export async function seedLegacyReloadSurvivor(
  session: AgentSession,
  cwd: string,
  command: string,
  options: SeedLegacySurvivorOptions,
): Promise<BgTaskSnapshot> {
  const { BackgroundTaskRegistry } = await import('../../src/core/registry.js');
  const hub = getProcessReloadShellOwnerV1();
  const identity = makeReloadShellIdentity(
    session.sessionId,
    realpathSync(cwd),
  );
  const claim = hub.beginActivation(
    identity,
    'reload',
    randomBytes(16).toString('hex'),
  );
  const seedRegistry = new BackgroundTaskRegistry({
    reloadShellOwner: hub,
    sendCompletionNotification() {},
  });
  // 镜像真实旧激活:存活任务以旧代次编号,导入新激活后代次不匹配即标陈旧
  seedRegistry.setActiveBranchGeneration(claim.generation);
  const adapter = await seedRegistry.stageReloadActivation(claim);
  const lease = hub.commitActivation(claim, adapter);
  const task = await seedRegistry.startTask(
    {
      cwd,
      sessionId: session.sessionId,
      modelRegistry: { getAll: () => [] },
    },
    command,
    {
      name: options.name,
      isAgent: false,
      surviveReload: true,
      notifyOnCompletion: options.notifyOnCompletion ?? true,
      triggerOnCompletion: false,
      ...(options.timeoutSeconds === undefined
        ? {}
        : { timeoutSeconds: options.timeoutSeconds }),
    },
  );
  // 让渡:把存活执行保留在 hub,等待新激活以 reload 语义认领
  seedRegistry.prepareReloadHandoff(lease);
  return task;
}