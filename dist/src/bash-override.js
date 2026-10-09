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
 * 配置侧行为(S1 自读生效):宿主用户级 settings.json 的 shellPath/
 * shellCommandPrefix 由扩展激活时自读并注入——读取/解析失败静默降级为宿主
 * 缺省(不告警);前台与后台 shell/命令前缀同源。仅读用户级 settings,宿主项目级
 * 合并不在插件读取面。
 */
import { createBashToolDefinition, } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { deriveCompletionDeliveryGuidance, taskDisplayName, } from "./core/common.js";
const COMMAND_FIELD_DESCRIPTION = "Shell command to execute";
const TIMEOUT_FIELD_DESCRIPTION = "Timeout in seconds (optional, no default timeout)";
const TASK_NAME_FIELD_DESCRIPTION = "Optional explicit task name shown in the dock, /bg-jobs, the startup receipt, and the completion notification (max 200 characters). Omitted names fall back to the full command.";
const RUN_IN_BACKGROUND_FIELD_DESCRIPTION = "Optional. Set true to detach this command into the durable background task stack: the call returns immediately with a task id and output path, and terminal state is delivered automatically as <background-task-notification>, injected into the current turn while the agent is streaming or starting a follow-up turn when idle; concurrent terminal states merge into one notification. In background mode timeout is a hard-kill deadline in seconds after which the task is force-terminated (0 or omitted = no deadline); foreground timeout semantics are unchanged. Omit or set false for normal foreground execution identical to the built-in bash tool.";
/**
 * 覆盖版 bash 参数 schema:原 `{command, timeout}` 字段语义与 constrained
 * sampling 保持不变,新增可选 `run_in_background` 与 `task_name` 字段,旧调用方
 * 无需兼容改动。
 */
export const BashOverrideParams = Type.Object({
    command: Type.String({ description: COMMAND_FIELD_DESCRIPTION }),
    timeout: Type.Optional(Type.Number({ description: TIMEOUT_FIELD_DESCRIPTION })),
    task_name: Type.Optional(Type.String({
        description: TASK_NAME_FIELD_DESCRIPTION,
        maxLength: 200,
    })),
    run_in_background: Type.Optional(Type.Boolean({ description: RUN_IN_BACKGROUND_FIELD_DESCRIPTION })),
});
/** S1 P2/REVIEW N1:宿主 shellCommandPrefix 换行拼接前置(与宿主前台
 * bash.ts:251 的 `<prefix>\n<command>` 拼接逐行对齐);前缀缺失或为空串时
 * 原样返回。默认前台路径经宿主 createBashToolDefinition 第二参自行生效,
 * 本助手服务于后台路径(覆盖版 bash 后台分支与 dock「转后台」/rerun 两入口共用)。 */
export function prependCommandPrefix(prefix, command) {
    if (prefix === undefined || prefix.length === 0)
        return command;
    return `${prefix}\n${command}`;
}
/** 以宿主内置 bash 工具定义为前台执行参照,建立默认分流执行器。 */
export function createBashOverrideDeps(options) {
    // S1 P2 前台同源:与宿主 _buildRuntime 的 `bash: { commandPrefix, shellPath }`
    // (agent-session.ts:3243-3254)逐行对齐;字段缺失时保持宿主缺省解析。
    const hostDefinition = createBashToolDefinition(options.baseCwd, {
        ...(options.hostCommandPrefix === undefined
            ? {}
            : { commandPrefix: options.hostCommandPrefix }),
        ...(options.hostShellPath === undefined
            ? {}
            : { shellPath: options.hostShellPath }),
    });
    return {
        startBackgroundTask: options.startBackgroundTask,
        executeForeground: (toolCallId, params, signal, onUpdate, ctx) => hostDefinition.execute(toolCallId, params, signal, onUpdate, ctx),
        hostCommandPrefix: options.hostCommandPrefix,
    };
}
/** 绑定依赖后的 5 参 execute(与宿主 ToolDefinition.execute 形状一致)。 */
export function createBashOverrideExecute(deps) {
    return (toolCallId, params, signal, onUpdate, ctx) => bashOverrideExecute(toolCallId, params, signal, onUpdate, ctx, deps);
}
/**
 * execute 分流:缺省/`false` 走宿主前台路径(参数透传等价宿主原生 bash),
 * `true` 走插件后台栈。
 */
export async function bashOverrideExecute(toolCallId, params, signal, onUpdate, ctx, deps) {
    if (params.run_in_background === true) {
        const backgroundOptions = {
            // 模型入口语义:M2 断言覆盖版 bash 缺省 notify+trigger
            entrySource: "model",
        };
        // S7 P9 命名:显式 task_name 优先(入参 ≤200 字符,存储归一沿用
        // normalizeTaskName 80);无显式名 → task.name 保持 undefined,显示链走
        // 完整 command 原样兜底。
        if (typeof params.task_name === "string" && params.task_name.length > 0) {
            backgroundOptions.name = params.task_name;
        }
        // P7 后台 timeout 语义:0/缺省 = 不限时(不设 timeoutSeconds);> 0 = 强杀截止
        if (params.timeout !== undefined && params.timeout > 0) {
            backgroundOptions.timeoutSeconds = params.timeout;
        }
        // S1 P2 commandPrefix 前置:与宿主前台拼接逐行对齐(bash.ts:251)
        const command = prependCommandPrefix(deps.hostCommandPrefix, params.command);
        const task = await deps.startBackgroundTask(ctx, command, backgroundOptions);
        const guidance = deriveCompletionDeliveryGuidance(task.notifyOnCompletion, task.triggerOnCompletion);
        return {
            content: [
                {
                    type: "text",
                    text: [
                        `Started background task ${taskDisplayName(task)} (${task.id})`,
                        `Status: ${task.status}`,
                        `PID: ${String(task.pid ?? "unknown")}`,
                        `Output: ${task.outputPath}`,
                        guidance.text,
                    ].join("\n"),
                },
            ],
            details: { fullOutputPath: task.outputPath },
        };
    }
    // 前台路径:剔除新增字段(run_in_background/task_name)后透传宿主原生执行,
    // 逐行等价;task_name 属后台命名语义,不得残留进 foregroundParams 泄漏给宿主
    const { run_in_background: _omit, task_name: _omitName, ...foregroundParams } = params;
    return deps.executeForeground(toolCallId, foregroundParams, signal, onUpdate, ctx);
}
// 宿主 bash 定义自带渲染器(createShellRenderers),沿用之,不新增渲染器;
// 渲染输入参数类型较宿主 schema 多一个可选字段,仅做形状上的收窄转换,
// 宿主渲染器并不读取 `run_in_background`。
const hostBashDefinition = createBashToolDefinition(process.cwd());
export const bashOverrideRenderCall = hostBashDefinition.renderCall;
export const bashOverrideRenderResult = hostBashDefinition.renderResult;
//# sourceMappingURL=bash-override.js.map