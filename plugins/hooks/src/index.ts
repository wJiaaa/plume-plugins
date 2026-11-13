/**
 * plume.hooks 的逻辑入口，跑在 agent 进程：在事件发生时跑用户和项目配的命令，把它们的决定接回这一轮。
 *
 * 九个事件各有各的挂点：SessionStart、UserPromptSubmit 在 `prompt.submit`（一轮开始、人的消息写进会话之前），
 * PreToolUse、PostToolUse、PostToolUseFailure 在 `tool.execute`（围着每一次工具调用，审批在它里面），PermissionRequest 在
 * `tool.approve` 的里层（要弹审批卡给人的时候先问它），Stop 在 `step.end`（模型不再调工具、这一轮要收尾时），StopFailure
 * 在一轮以出错、被停下、用满步数、原地打转收场之后（`ctx.sessions.observe` 的 `turnEnd`），SessionEnd 在会话不再活着时
 * （`ctx.sessions.onEnded`）。配置每次现读，设置页经 `ctx.serve` 改它。
 *
 * 用户钩子存在插件数据目录，项目钩子在 `<项目>/.plume/config.json` 的 `hooks` 里、要先在设置页信任过才跑。每条钩子的每次运行
 * 记进运行记录，回复底下的按钮读它。一条钩子坏了不拖垮这一轮：记成失败，这一步照常往下走。
 */

import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { HookLayer, Message, PermissionMode, Plugin, ToolOutput, TurnStop } from "@plume/contract";
import type { HookView, HooksApi, HooksView } from "./api.ts";
import {
	addHook,
	configFile,
	HOOK_EVENTS,
	type HookDraft,
	type HookEntry,
	type HookEventName,
	type HooksConfig,
	hasHook,
	hookEntries,
	projectConfigFile,
	readHooks,
	readProjectHooks,
	removeHook,
	setHookEnabled,
	updateHook,
	writeHooks,
	writeProjectHooks,
} from "./config.ts";
import { MESSAGES } from "./messages.ts";
import { type CommandShellKind, createHookRunner, type HookInput, type HookRun, type HookRunner, hookMatchValues, plumeToolInput } from "./runner.ts";
import { RunStore } from "./runs.ts";
import { trustedHookDigests, trustHookDigests } from "./trust.ts";

/** Stop 钩子连续让它接着干的上限，防止一条永远不满意的钩子把这一轮拖成死循环。 */
const MAX_STOP_HOOK_CONTINUATIONS = 3;
const HOOK_CONTEXT_MAX_CHARS = 24_000;
const PREVIEW_MAX = 4000;
/**
 * 挂在 plume.approval 里面：contract 的钩子 `tool.approve` 文档写明它在 order 1000，只管真要弹给人的层挂在大于 1000 的地方。
 * 权限模式放行了的到不了这里，只有真要弹给人的才问 PermissionRequest。
 */
const PERMISSION_REQUEST_ORDER = 2000;

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** 写给模型的一段附加上下文。 */
function hookContextText(event: HookEventName, contexts: readonly string[]): string | null {
	if (contexts.length === 0) return null;
	const body = contexts.map((context, index) => `#${index + 1}\n${context}`).join("\n\n");
	const text = `${event} hook additional context:\n${body}`;
	return `<system-reminder>\n${text.length > HOOK_CONTEXT_MAX_CHARS ? `${text.slice(0, HOOK_CONTEXT_MAX_CHARS)}...` : text}\n</system-reminder>`;
}

/** 工具前后钩子给模型的附加上下文，接在结果后面。 */
function appendHookContexts(result: ToolOutput, contexts: readonly string[]): ToolOutput {
	if (contexts.length === 0) return result;
	const text = ["[Hook additional context]", ...contexts.map((context, index) => `#${index + 1}\n${context}`)].join("\n");
	return { ...result, output: `${result.output}\n${text}` };
}

function replyText(messages: readonly Message[]): string {
	const last = messages.findLast((message) => message.role === "assistant");
	return last?.role === "assistant" ? last.content.map((part) => (part.type === "text" ? part.text : "")).join("") : "";
}

function viewOf({ id, scope, event, matcher, definition }: HookEntry, trusted?: ReadonlySet<string>, digest?: string): HookView {
	const { type, command, enabled, statusMessage, timeoutMs, ...rest } = definition;
	const custom: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(rest)) if (!["args", "async", "shell", "timeout"].includes(key)) custom[key] = value;
	const timeout =
		definition.type === "command" && definition.timeout !== undefined ? definition.timeout : timeoutMs !== undefined ? Math.round(timeoutMs / 1000) : undefined;
	return {
		id,
		scope,
		event,
		...(matcher ? { matcher } : {}),
		type,
		command,
		...(definition.type === "process" && definition.args ? { args: definition.args } : {}),
		...(definition.type === "command" && definition.async !== undefined ? { async: definition.async } : {}),
		...(definition.type === "command" && definition.shell !== undefined ? { shell: definition.shell } : {}),
		...(timeout !== undefined ? { timeout } : {}),
		...(statusMessage ? { statusMessage } : {}),
		enabled: enabled !== false,
		...(Object.keys(custom).length > 0 ? { custom } : {}),
		...(trusted && digest ? { trusted: trusted.has(digest) } : {}),
	};
}

/** 设置页交来的草稿：渲染进程传来的东西，逐个字段核对。 */
function checkDraft(raw: unknown): HookDraft | null {
	if (!isPlainObject(raw)) return null;
	if (typeof raw.event !== "string" || !(HOOK_EVENTS as readonly string[]).includes(raw.event)) return null;
	if (raw.type !== "command" && raw.type !== "process") return null;
	if (typeof raw.command !== "string" || !raw.command.trim()) return null;
	const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined);
	const args = strings(raw.args);
	return {
		event: raw.event as HookEventName,
		type: raw.type,
		command: raw.command,
		...(typeof raw.matcher === "string" ? { matcher: raw.matcher } : {}),
		...(args ? { args } : {}),
		...(typeof raw.async === "boolean" ? { async: raw.async } : {}),
		...(raw.shell === true || (typeof raw.shell === "string" && raw.shell.trim()) ? { shell: raw.shell as true | string } : {}),
		...(typeof raw.statusMessage === "string" ? { statusMessage: raw.statusMessage } : {}),
		...(typeof raw.timeout === "number" && Number.isFinite(raw.timeout) && raw.timeout > 0 ? { timeout: raw.timeout } : {}),
		...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
		...(isPlainObject(raw.custom) ? { custom: raw.custom } : {}),
	};
}

export default {
	name: "plume.hooks",
	// 用户的钩子对每个会话都生效（一轮没好好收场时跑 StopFailure、撤回时整理运行记录）：要看全部会话。
	observe: "all",
	apply(ctx) {
		const text = () => MESSAGES[ctx.locale()];
		const runs = new RunStore(join(ctx.dataDir, "runs"));
		/** SessionStart 跑过的会话，和那时的目录：进程活多久，每个会话就只跑一次；SessionEnd 只给跑过它的会话、在那个目录里跑。 */
		const started = new Map<string, string>();
		/** 这一轮里 Stop 钩子已经让它接着干了几次。每轮开始时清掉。 */
		const continuations = new Map<string, number>();
		/** 每个会话最近一次知道的工作目录：StopFailure 那里只拿到会话 id。 */
		const cwds = new Map<string, string>();
		/** 这一轮的运行记录归到哪：这一轮开口的那条消息在会话里的位置加一，见 `RunStore`。 */
		const turnAt = new Map<string, number>();
		/** 删掉了的会话：晚到的运行记录不再写回去。 */
		const gone = new Set<string>();
		/** 每个会话还没跑完的 StopFailure：SessionEnd 排在它后面，外面先收到「这一轮失败了」再收到「会话结束了」。 */
		const tails = new Map<string, Promise<void>>();
		/**
		 * 每个会话最近一次模型请求时的权限模式、是不是计划模式（只读）、命令跑在哪种 shell：交给脚本的 `permission_mode`、
		 * bash 的 `tool_name`（PowerShell 里跑的是 `PowerShell`）要它们，tool.execute、tool.approve、step.end 的输入里没有，从 model.context 记下。
		 * 工具调用、收尾都跟在发出它们的那次请求后面，记下的就是那次请求的；模型照这次请求点名的 shell 写命令。
		 */
		const requests = new Map<string, { permissionMode: PermissionMode; readOnly: boolean; shell: CommandShellKind }>();
		/** 这个会话的命令跑在哪种 shell；还没发过请求时不知道，bash 按 `Bash` 对。 */
		const shellOf = (sessionId: string) => requests.get(sessionId)?.shell;
		/**
		 * 正在执行的工具调用里等审批花了多少毫秒（键是会话和调用 id）：`duration_ms` 照 Claude Code 不算等审批的时间。
		 * 只有 tool.execute 正在计时的调用才记，计完就删。
		 */
		const waited = new Map<string, number>();
		const callKey = (sessionId: string, callId: string) => `${sessionId}\0${callId}`;

		const record = (sessionId: string) => (run: HookRun) => {
			if (gone.has(sessionId)) return;
			void runs.put(sessionId, { ...run, at: turnAt.get(sessionId) ?? 0 }).catch((error: unknown) => ctx.log.warn(`记不下钩子运行记录：${reasonOf(error)}`));
		};
		/** 这一刻的配置：用户的全部，加上这个目录的项目钩子——没信任的也带上，跑到它们时只记一笔「被拦下」。读不懂的那份当作没有。 */
		const runnerFor = async (sessionId: string, cwd: string): Promise<HookRunner> => {
			const user = await readHooks(ctx.dataDir).catch((error: unknown) => {
				ctx.log.warn(`读取钩子配置失败：${reasonOf(error)}`);
				return { events: {} } satisfies HooksConfig;
			});
			const project = await readProjectHooks(cwd).catch(() => null);
			const trusted =
				project && hookEntries(project, "project").length > 0 ? await trustedHookDigests(ctx.dataDir, cwd).catch(() => new Set<string>()) : new Set<string>();
			return createHookRunner({
				user,
				...(project ? { project: { config: project, trusted } } : {}),
				report: record(sessionId),
				untrustedReason: text().untrustedRun,
			});
		};
		const base = (event: HookEventName, sessionId: string, cwd: string): HookInput => ({
			hookEventName: event,
			sessionId,
			cwd,
			timestamp: new Date().toISOString(),
		});
		/**
		 * 交给脚本的权限模式：Plume 的叫法，计划模式另带 `readOnly`，runner 再翻成 Claude Code 的 `permission_mode`。
		 * 事件自己的输入里有的（审批的权限模式、工具调用是不是只读）用它，没有的用最近一次请求时的；这个会话还没发过请求时不给。
		 */
		const modeOf = (sessionId: string, own: { permissionMode?: PermissionMode; readOnly?: boolean } = {}) => {
			const last = requests.get(sessionId);
			const permissionMode = own.permissionMode ?? last?.permissionMode;
			if (!permissionMode) return {};
			return { permissionMode, ...((own.readOnly ?? last?.readOnly) ? { readOnly: true } : {}) };
		};
		const failedHandling = (sessionId: string, event: HookEventName, error: unknown) => {
			ctx.log.warn(`${event} 钩子处理失败：${reasonOf(error)}`);
			ctx.notice(sessionId, text().handlingFailed(event, reasonOf(error)), "warn");
		};
		/** 同一个会话的收尾钩子一个接一个跑。 */
		const after = (sessionId: string, task: () => Promise<void>): Promise<void> => {
			const next = (tails.get(sessionId) ?? Promise.resolve()).then(task).catch((error: unknown) => ctx.log.warn(`收尾钩子处理失败：${reasonOf(error)}`));
			tails.set(sessionId, next);
			void next.then(() => {
				if (tails.get(sessionId) === next) tails.delete(sessionId);
			});
			return next;
		};
		const cwdOf = async (sessionId: string): Promise<string | undefined> =>
			cwds.get(sessionId) ?? (await ctx.sessions.get(sessionId).catch(() => undefined))?.cwd;

		ctx.hook("prompt.submit", async (input, next) => {
			const { sessionId } = input;
			cwds.set(sessionId, input.cwd);
			continuations.delete(sessionId);
			const runner = await runnerFor(sessionId, input.cwd);
			// 人开口的那一条开一轮；界面替人说的、后台送回来的接着上一轮。没有钩子就不必去数消息。
			if (!runner.empty && (!input.synthetic || !turnAt.has(sessionId))) {
				const count = (await ctx.sessions.messages(sessionId).catch(() => [])).length;
				turnAt.set(sessionId, input.synthetic ? count : count + 1);
			}
			const contexts: string[] = [];
			let startedNow = false;
			try {
				if (!started.has(sessionId)) {
					started.set(sessionId, input.cwd);
					if (runner.has("SessionStart")) {
						const source = input.fresh ? "startup" : "resume";
						const result = await runner.run({ ...base("SessionStart", sessionId, input.cwd), source }, { matchValues: [source], signal: input.signal });
						const context = hookContextText("SessionStart", result.additionalContexts);
						if (context) contexts.push(context);
						startedNow = context !== null;
					}
				}
				if (runner.has("UserPromptSubmit")) {
					const attachmentsSummary = input.attachments.map((name, at) => `${at + 1}:${name}`).join("\n");
					const result = await runner.run(
						{ ...base("UserPromptSubmit", sessionId, input.cwd), prompt: input.text, ...(attachmentsSummary ? { attachmentsSummary } : {}) },
						{ signal: input.signal },
					);
					if (result.decision === "deny") {
						// 这条消息不进会话，刚跑的 SessionStart 给的上下文也就没写下；下一轮再跑一次。
						if (startedNow) started.delete(sessionId);
						return { block: true, reason: result.reason ? text().promptBlocked(result.reason) : text().promptBlockedSilent };
					}
					const context = hookContextText("UserPromptSubmit", result.additionalContexts);
					if (context) contexts.push(context);
				}
			} catch (error) {
				failedHandling(sessionId, "UserPromptSubmit", error);
			}
			const verdict = await next(input);
			if (verdict.block || contexts.length === 0) return verdict;
			return { block: false, context: [...contexts, ...(verdict.context ? [verdict.context] : [])].join("\n\n") };
		});

		ctx.hook("model.context", (input, next) => {
			requests.set(input.sessionId, { permissionMode: input.permissionMode, readOnly: input.readOnly === true, shell: input.shell.kind });
			return next(input);
		});

		ctx.hook("tool.execute", async (input, next) => {
			cwds.set(input.sessionId, input.cwd);
			const runner = await runnerFor(input.sessionId, input.cwd);
			if (!(runner.has("PreToolUse") || runner.has("PostToolUse") || runner.has("PostToolUseFailure"))) return next(input);
			const toolName = input.call.name;
			const shell = shellOf(input.sessionId);
			const matchValues = hookMatchValues(toolName, shell);
			const shellField = shell ? { shell } : {};
			const mode = modeOf(input.sessionId, { readOnly: input.readOnly !== undefined });
			let contexts: string[] = [];
			let execution = input;

			if (runner.has("PreToolUse")) {
				try {
					const result = await runner.run(
						{ ...base("PreToolUse", input.sessionId, input.cwd), ...mode, ...shellField, toolName, toolInput: input.call.args, toolCallId: input.call.id },
						{ matchValues, signal: input.signal },
					);
					contexts = result.additionalContexts;
					if (result.decision === "deny") return appendHookContexts({ output: result.reason || `A hook blocked "${toolName}".`, isError: true }, contexts);
					if (isPlainObject(result.updatedInput)) {
						const args = plumeToolInput(toolName, result.updatedInput, input.call.args, input.cwd);
						execution = { ...execution, call: { ...execution.call, args } };
					}
					if (result.decision === "allow") execution = { ...execution, approved: "PreToolUse" };
					if (result.decision === "ask") {
						// 人答应了才算放行；停下时 ask 答的是 false，宿主按「停下」写结果。
						if (!(await input.ask(result.reason || text().askReason))) return { output: `The user declined "${toolName}".`, isError: true };
						execution = { ...execution, approved: "PreToolUse" };
					}
				} catch (error) {
					failedHandling(input.sessionId, "PreToolUse", error);
				}
			}

			// 计时只算工具自己：PreToolUse 的「要确认」在这之前，里面等审批的时间由 tool.approve 记下、减掉。
			const key = callKey(input.sessionId, input.call.id);
			waited.set(key, 0);
			const startedAt = Date.now();
			let durationMs = 0;
			const result = await next(execution).finally(() => {
				durationMs = Math.max(0, Date.now() - startedAt - (waited.get(key) ?? 0));
				waited.delete(key);
			});
			const failed = result.isError === true;
			const event = failed ? "PostToolUseFailure" : "PostToolUse";
			if (!runner.has(event)) return appendHookContexts(result, contexts);
			try {
				const call = {
					...base(event, input.sessionId, input.cwd),
					...mode,
					...shellField,
					toolName,
					toolInput: execution.call.args,
					toolCallId: input.call.id,
					durationMs,
				};
				const preview = result.output.slice(0, PREVIEW_MAX);
				const hookInput = failed
					? { ...call, error: { message: preview, type: "ToolError" }, isInterrupt: input.signal.aborted }
					: { ...call, toolResponse: { output: result.output, details: result.details }, toolResultPreview: preview };
				const added = await runner.run(hookInput, { matchValues, signal: input.signal });
				return appendHookContexts(result, [...contexts, ...added.additionalContexts]);
			} catch (error) {
				failedHandling(input.sessionId, event, error);
				return appendHookContexts(result, contexts);
			}
		});

		/*
		 * 工具要人确认的时候，先让 PermissionRequest 钩子答：答了就不弹卡，没答（或者这条钩子坏了）才问人。
		 * tool.execute 的层自己要问的（PreToolUse 的「要确认」）不归它；提问、批准计划这些要人给答案的走 run.request，根本不到这里。
		 * 提权只能由人在卡上批：钩子是一段脚本，项目钩子还可能是别人提交进来的，本体不认它的放行、照样弹卡，拒绝照样算。
		 *
		 * 放行带的 `updatedInput` 改了参数时不算放行、照常问人：tool.approve 只能答放不放，换不了这次调用的参数，
		 * 照原参数放行等于放过了钩子没同意的那一版。原样交回的（`jq '.tool_input'`）还是放行。`updatedPermissions`（记规则、换权限模式）
		 * 也没有地方落，不理它，只放这一次。
		 */
		const approve: HookLayer<"tool.approve"> = async (input, next) => {
			if (input.byLayer) return next(input);
			const runner = await runnerFor(input.sessionId, input.cwd);
			if (!runner.has("PermissionRequest")) return next(input);
			try {
				const toolName = input.call.name;
				const shell = shellOf(input.sessionId);
				const result = await runner.run(
					{
						...base("PermissionRequest", input.sessionId, input.cwd),
						...modeOf(input.sessionId, { permissionMode: input.permissionMode }),
						...(shell ? { shell } : {}),
						toolName,
						toolInput: input.call.args,
						toolCallId: input.call.id,
						reason: input.request.reason ?? input.request.title,
						requestId: input.call.id,
					},
					{ matchValues: hookMatchValues(toolName, shell), signal: input.signal },
				);
				if (result.decision === "deny") return "reject";
				const changed =
					isPlainObject(result.updatedInput) && !isDeepStrictEqual(plumeToolInput(toolName, result.updatedInput, input.call.args, input.cwd), input.call.args);
				if (result.decision === "allow" && !changed) return "once";
			} catch (error) {
				failedHandling(input.sessionId, "PermissionRequest", error);
			}
			return next(input);
		};
		ctx.hook(
			"tool.approve",
			async (input, next) => {
				// 等审批的时间（钩子答的、人点的都算）记到正在计时的那次调用上，duration_ms 里减掉。
				const key = callKey(input.sessionId, input.call.id);
				const startedAt = Date.now();
				try {
					return await approve(input, next);
				} finally {
					const sofar = waited.get(key);
					if (sofar !== undefined) waited.set(key, sofar + Date.now() - startedAt);
				}
			},
			{ order: PERMISSION_REQUEST_ORDER },
		);

		ctx.hook("step.end", async (input, next) => {
			const verdict = await next(input);
			// 只在这一轮要正常收尾时问：还有工具结果要交给模型、或者已经因为别的原因结束的，不归 Stop 管。
			if (verdict.continue || verdict.reason) return verdict;
			const runner = await runnerFor(input.sessionId, input.cwd);
			if (!runner.has("Stop")) return verdict;
			const count = continuations.get(input.sessionId) ?? 0;
			try {
				const responseText = input.reply.content.map((part) => (part.type === "text" ? part.text : "")).join("");
				const result = await runner.run(
					{
						...base("Stop", input.sessionId, input.cwd),
						...modeOf(input.sessionId),
						responseText,
						responsePreview: responseText.slice(0, PREVIEW_MAX),
						toolCallCount: 0,
						stopHookActive: count > 0,
					},
					{ signal: input.signal },
				);
				// 只有说了还差什么才接着干：只说「别停」的钩子，接着跑只会得到同一句收尾。
				const say = result.continueStop === true && count < MAX_STOP_HOOK_CONTINUATIONS ? hookContextText("Stop", result.additionalContexts) : null;
				if (!say) return verdict;
				continuations.set(input.sessionId, count + 1);
				return { continue: true, say };
			} catch (error) {
				failedHandling(input.sessionId, "Stop", error);
				return verdict;
			}
		});

		/*
		 * 一轮以出错、被停下、用满步数、原地打转收场之后：只观察，输出不读——这一轮已经结束了，没有什么可拦的。
		 * 不传 `signal`：按了停止的那一轮早就停下了，「被人停下」恰恰是最需要告诉外面的那种结局。
		 */
		const stopFailure = async (sessionId: string, stop: TurnStop) => {
			const cwd = await cwdOf(sessionId);
			if (!cwd) return;
			const runner = await runnerFor(sessionId, cwd);
			if (!runner.has("StopFailure")) return;
			const responseText = replyText(await ctx.sessions.messages(sessionId).catch(() => []));
			await runner.run(
				{
					...base("StopFailure", sessionId, cwd),
					reason: stop.reason,
					...(stop.error ? { error: stop.error } : {}),
					...(responseText ? { responseText } : {}),
				},
				{ matchValues: [stop.reason] },
			);
		};
		ctx.sessions.observe(({ sessionId, event }) => {
			if (event.type === "turnEnd" && event.stop.reason !== "done") void after(sessionId, () => stopFailure(sessionId, event.stop));
			if (event.type === "rewound") {
				// 撤回以后下一轮从新的位置开口，归被撤掉那几轮的记录跟着删。
				turnAt.delete(sessionId);
				void runs.rewind(sessionId, event.count).catch((error: unknown) => ctx.log.warn(`整理钩子运行记录失败：${reasonOf(error)}`));
			}
		});

		/** 会话不再活着：只在 SessionStart 跑过时跑，跑一次，在它当时的目录里。同样只观察、不传 `signal`。 */
		ctx.sessions.onEnded(async (sessionId, reason) => {
			const cwd = started.get(sessionId);
			if (cwd === undefined) return;
			started.delete(sessionId);
			if (reason === "deleted") gone.add(sessionId);
			await after(sessionId, async () => {
				const runner = await runnerFor(sessionId, cwd);
				if (runner.has("SessionEnd")) await runner.run({ ...base("SessionEnd", sessionId, cwd), reason }, { matchValues: [reason] });
			});
		});
		ctx.sessions.onDeleted((sessionId) => {
			gone.add(sessionId);
			for (const map of [continuations, cwds, turnAt, requests]) map.delete(sessionId);
			void runs.forget(sessionId).catch((error: unknown) => ctx.log.warn(`删不掉钩子运行记录：${reasonOf(error)}`));
		});

		/** 设置页的改动一个接一个写，两次点得快也不会互相覆盖。 */
		let writing: Promise<unknown> = Promise.resolve();
		const queue = <T>(task: () => Promise<T>): Promise<T> => {
			const run = writing.then(task);
			writing = run.catch(() => {});
			return run;
		};
		const checkCwd = (cwd: unknown): string | null => {
			if (cwd === null) return null;
			if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new Error(text().noProject);
			return cwd;
		};
		const list = async (cwd: string | null): Promise<HooksView> => {
			const file = configFile(ctx.dataDir);
			let user: HookView[] = [];
			let error: string | undefined;
			try {
				user = hookEntries(await readHooks(ctx.dataDir), "user").map((entry) => viewOf(entry));
			} catch (cause) {
				error = text().fileBroken(file, reasonOf(cause));
			}
			const head = { user, file, ...(error ? { error } : {}) };
			if (!cwd) return { ...head, project: null };
			const projectPath = projectConfigFile(cwd);
			try {
				const entries = hookEntries(await readProjectHooks(cwd), "project");
				const trusted = entries.length > 0 ? await trustedHookDigests(ctx.dataDir, cwd) : new Set<string>();
				return { ...head, project: entries.map((entry) => viewOf(entry, trusted, entry.digest)), projectPath };
			} catch (cause) {
				return { ...head, project: [], projectPath, projectError: reasonOf(cause) };
			}
		};
		/** `id` 指的那条还在、内容也没变：文件在设置页开着时被别处改过，拿旧 `id` 来的改动一律拒绝，不落到人没看过的那条上。 */
		const existing = (config: HooksConfig, id: unknown): string => {
			if (typeof id !== "string" || !hasHook(config, id)) throw new Error(text().notFound);
			return id;
		};
		const change = (scope: unknown, rawCwd: unknown, edit: (config: HooksConfig) => HooksConfig): Promise<HooksView> =>
			queue(async () => {
				const cwd = checkCwd(rawCwd);
				if (scope === "user") {
					let config: HooksConfig;
					try {
						config = await readHooks(ctx.dataDir);
					} catch (error) {
						throw new Error(text().fileBroken(configFile(ctx.dataDir), reasonOf(error)), { cause: error });
					}
					await writeHooks(ctx.dataDir, edit(config));
					return list(cwd);
				}
				if (scope !== "project" || !cwd) throw new Error(text().noProject);
				let config: HooksConfig;
				try {
					config = await readProjectHooks(cwd);
				} catch (error) {
					throw new Error(text().fileBroken(projectConfigFile(cwd), reasonOf(error)), { cause: error });
				}
				const before = new Set(hookEntries(config, "project").map((entry) => entry.digest));
				const next = edit(config);
				await writeProjectHooks(cwd, next);
				/*
				 * 在这台机器上、从设置页亲手写下的项目钩子，就是这台机器的主人写的——不该转头再让他审一遍自己刚打的字。
				 * 只有这次改动新出现的指纹算进来；从别处（拉下来的提交）来的那些照旧要审。
				 */
				const entries = hookEntries(next, "project");
				const fresh = entries.filter((entry) => !before.has(entry.digest)).map((entry) => entry.digest);
				if (fresh.length > 0)
					await trustHookDigests(
						ctx.dataDir,
						cwd,
						fresh,
						entries.map((entry) => entry.digest),
					);
				return list(cwd);
			});

		ctx.serve({
			list: (cwd) => queue(async () => list(checkCwd(cwd))),
			save(scope, cwd, id, raw) {
				const draft = checkDraft(raw);
				if (!draft) return Promise.reject(new Error(text().invalidDraft));
				return change(scope, cwd, (config) => (id === null ? addHook(config, draft) : updateHook(config, existing(config, id), draft)));
			},
			remove: (scope, cwd, id) => change(scope, cwd, (config) => removeHook(config, existing(config, id))),
			setEnabled: (scope, cwd, id, enabled) => change(scope, cwd, (config) => setHookEnabled(config, existing(config, id), enabled === true)),
			trust: (rawCwd, ids) =>
				queue(async () => {
					const cwd = checkCwd(rawCwd);
					if (!cwd) throw new Error(text().noProject);
					const entries = hookEntries(await readProjectHooks(cwd), "project");
					const known = new Set(entries.map((entry) => entry.id));
					if (!Array.isArray(ids) || ids.some((id) => !known.has(id))) throw new Error(text().notFound);
					const wanted = new Set<string>(ids);
					await trustHookDigests(
						ctx.dataDir,
						cwd,
						entries.filter((entry) => wanted.has(entry.id)).map((entry) => entry.digest),
						entries.map((entry) => entry.digest),
					);
					return list(cwd);
				}),
			runs: (sessionId) => runs.list(String(sessionId)),
			async *watch(call) {
				const pending = new Set<string>();
				let wake: (() => void) | undefined;
				const off = runs.onChange((sessionId) => {
					pending.add(sessionId);
					wake?.();
				});
				const stop = () => wake?.();
				call.signal.addEventListener("abort", stop, { once: true });
				try {
					while (!call.signal.aborted) {
						if (pending.size === 0) await new Promise<void>((resolve) => (wake = resolve));
						wake = undefined;
						if (call.signal.aborted) break;
						const changed = [...pending];
						pending.clear();
						yield changed;
					}
				} finally {
					off();
					call.signal.removeEventListener("abort", stop);
				}
			},
		} satisfies HooksApi);
	},
} satisfies Plugin;
