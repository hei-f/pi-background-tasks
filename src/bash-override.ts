/**
 * M4 同名 `bash` 工具覆盖模块。
 *
 * 插件注册同名小写 `bash` 工具,命中宿主工具注册表的 Map 同名覆盖
 * (`agent-session.ts` 的 `toolRegistry.set(tool.name, tool)`):
 * - schema 在宿主 `{command, timeout}` 之上增加可选的 `run_in_background`;
 * - `run_in_background:true` → 插件后台任务栈(`registry.startTask`,
 *   `entrySource:'model'`,M2 已预置完成通知缺省 notify+trigger);
 * - 缺省/`false` → 100% 复用宿主公开 `createBashToolDefinition` 的前台执行
 *   路径(宿主内置 bash 自身即经 `createLocalBashOperations` 执行,参数透传
 *   与宿主原生路径逐行等价,含 stdin 传输/detached/128+signal 语义)。
 *
 * 渲染器不新增:沿用宿主 bash 工具自带的渲染器(宿主按工具名的渲染路径)。
 * 配置侧差异边界:宿主交互设置里的自定义 shellPath/commandPrefix 对扩展
 * 不可见,覆盖版前台路径使用宿主默认本地 shell 解析,等价宿主缺省配置。
 */
import {
  createBashToolDefinition,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type BashToolDetails,
  type ExtensionContext,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import {
  deriveCompletionDeliveryGuidance,
  taskDisplayName,
  type BgTask,
  type StartTaskOptions,
} from './core/common.js';

const COMMAND_FIELD_DESCRIPTION = 'Shell command to execute';
const TIMEOUT_FIELD_DESCRIPTION =
  'Timeout in seconds (optional, no default timeout)';
const RUN_IN_BACKGROUND_FIELD_DESCRIPTION =
  'Optional. Set true to detach this command into the durable background task stack: the call returns immediately with a task id and output path, and terminal state is delivered automatically as <background-task-notification> which also starts a follow-up agent turn. Omit or set false for normal foreground execution identical to the built-in bash tool.';

/**
 * 覆盖版 bash 参数 schema:原 `{command, timeout}` 字段语义与 constrained
 * sampling 保持不变,新增可选 `run_in_background` 字段,旧调用方无需兼容改动。
 */
export const BashOverrideParams = Type.Object({
  command: Type.String({ description: COMMAND_FIELD_DESCRIPTION }),
  timeout: Type.Optional(
    Type.Number({ description: TIMEOUT_FIELD_DESCRIPTION }),
  ),
  run_in_background: Type.Optional(
    Type.Boolean({ description: RUN_IN_BACKGROUND_FIELD_DESCRIPTION }),
  ),
});

export type BashOverrideParamsValue = Static<typeof BashOverrideParams>;

/** 前台执行结果 detail 沿用宿主 `BashToolDetails`。 */
export type BashOverrideDetails = BashToolDetails | undefined;

/** 分流执行依赖:后台落点与前台宿主执行路径(单测注入假件保持可测)。 */
export interface BashOverrideDeps {
  startBackgroundTask: (
    ctx: ExtensionContext,
    command: string,
    options: StartTaskOptions,
  ) => Promise<BgTask>;
  executeForeground: (
    toolCallId: string,
    params: { command: string; timeout?: number },
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
    ctx: ExtensionContext,
  ) => Promise<AgentToolResult<BashToolDetails | undefined>>;
}

export interface BashOverrideOptions {
  /** ctx 缺失时的兜底工作目录(宿主 runner 通常总是注入 ctx.cwd)。 */
  baseCwd: string;
  startBackgroundTask: (
    ctx: ExtensionContext,
    command: string,
    options: StartTaskOptions,
  ) => Promise<BgTask>;
}

/** 以宿主内置 bash 工具定义为前台执行参照,建立默认分流执行器。 */
export function createBashOverrideDeps(
  options: BashOverrideOptions,
): BashOverrideDeps {
  const hostDefinition = createBashToolDefinition(options.baseCwd);
  return {
    startBackgroundTask: options.startBackgroundTask,
    executeForeground: (toolCallId, params, signal, onUpdate, ctx) =>
      hostDefinition.execute(toolCallId, params, signal, onUpdate, ctx),
  };
}

/** 绑定依赖后的 5 参 execute(与宿主 ToolDefinition.execute 形状一致)。 */
export function createBashOverrideExecute(deps: BashOverrideDeps) {
  return (
    toolCallId: string,
    params: BashOverrideParamsValue,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
    ctx: ExtensionContext,
  ) => bashOverrideExecute(toolCallId, params, signal, onUpdate, ctx, deps);
}

/**
 * execute 分流:缺省/`false` 走宿主前台路径(参数透传等价宿主原生 bash),
 * `true` 走插件后台栈。
 */
export async function bashOverrideExecute(
  toolCallId: string,
  params: BashOverrideParamsValue,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
  ctx: ExtensionContext,
  deps: BashOverrideDeps,
): Promise<AgentToolResult<BashToolDetails | undefined>> {
  if (params.run_in_background === true) {
    const backgroundOptions: StartTaskOptions = {
      // 模型入口语义:M2 断言覆盖版 bash 缺省 notify+trigger
      entrySource: 'model',
    };
    if (params.timeout !== undefined) {
      backgroundOptions.timeoutSeconds = params.timeout;
    }
    const task = await deps.startBackgroundTask(
      ctx,
      params.command,
      backgroundOptions,
    );
    const guidance = deriveCompletionDeliveryGuidance(
      task.notifyOnCompletion,
      task.triggerOnCompletion,
    );
    return {
      content: [
        {
          type: 'text' as const,
          text: [
            `Started background task ${taskDisplayName(task)} (${task.id})`,
            `Status: ${task.status}`,
            `PID: ${String(task.pid ?? 'unknown')}`,
            `Output: ${task.outputPath}`,
            guidance.text,
          ].join('\n'),
        },
      ],
      details: { fullOutputPath: task.outputPath },
    };
  }
  // 前台路径:剔除新增字段后透传宿主原生执行,逐行等价
  const { run_in_background: _omit, ...foregroundParams } = params;
  return deps.executeForeground(
    toolCallId,
    foregroundParams,
    signal,
    onUpdate,
    ctx,
  );
}

// 宿主 bash 定义自带渲染器(createShellRenderers),沿用之,不新增渲染器;
// 渲染输入参数类型较宿主 schema 多一个可选字段,仅做形状上的收窄转换,
// 宿主渲染器并不读取 `run_in_background`。
const hostBashDefinition = createBashToolDefinition(process.cwd());

type BashOverrideRenderCall = NonNullable<
  ToolDefinition<
    typeof BashOverrideParams,
    BashOverrideDetails,
    unknown
  >['renderCall']
>;
type BashOverrideRenderResult = NonNullable<
  ToolDefinition<
    typeof BashOverrideParams,
    BashOverrideDetails,
    unknown
  >['renderResult']
>;

export const bashOverrideRenderCall: BashOverrideRenderCall =
  hostBashDefinition.renderCall as BashOverrideRenderCall;

export const bashOverrideRenderResult: BashOverrideRenderResult =
  hostBashDefinition.renderResult as BashOverrideRenderResult;