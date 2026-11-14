/**
 * plume.sessions 的逻辑入口：对话之间互相看一眼、递一句话。
 *
 * - `list_sessions` 看看有谁、在忙还是在等它的人，`read_session` 读它的记录：不叫醒它、不花它的钱，能查到的不问。
 * - `send_message` 发一条消息：单向的，当场返回回执（对方此刻在忙还是闲着）。对方闲着开一轮，忙着在下一步读到；它要回话就再发一条过来。
 *   回执之后的下落（读到了、没送到）记在内存里，界面在工具那一行上标出来：排队中、已送达、已回复、未送达。
 *
 * 信由本体送（`ToolRun.letter`）：本体照实填发件方、在信前面说明它不是用户的话、不构成授权，连着叫醒太多次时留到人开口也归本体。
 * 这里定写什么、发不发：找人（`peers.ts`）、长度、限速和去重（`pacing.ts`）。
 *
 * - 只给侧栏里的会话（顶层的）用：子 Agent、侧边聊天的工具表里藏起来（`model.context`），调到了也拒绝。
 * - 互相开出来的一家子（`spawnedFrom` 连起来的），系统提示词里多一节名册：谁是谁、id 是什么，找人只看它。
 * - 从别的会话开出来的（计划交给新会话执行、开出来的新会话），来源还在侧栏里时系统提示词多一段，告诉它来源在哪、拿不准时先读再问。
 * - 不查权限宽窄：Plume 的权限档是全局的，所有会话一样宽。
 */

import type { LetterFate, LetterInput, LetterReceipt, Plugin, SessionSummary, ToolDefinition, ToolOutput, ToolRun } from "@plume/contract";
import type { SessionsApi } from "./api.ts";
import { currentStep, HISTORY_PROPERTIES, invalidHistoryArgs, READ_LIMIT, readHistory, type HistoryArgs } from "./history.ts";
import { familyOf, listed, resolveSession, sessionAddress, together } from "./peers.ts";
import {
	LETTER_GUIDE,
	LIST_SESSIONS_DESCRIPTION,
	missed,
	type Missed,
	ORIGIN_SECTION,
	originSection,
	paced,
	READ_SESSION_DESCRIPTION,
	ROSTER_SECTION,
	rosterSection,
	SEND_MESSAGE_DESCRIPTION,
	sent,
	TO,
} from "./prompt.ts";
import { PeerPacer } from "./pacing.ts";
import { mainWorktrees } from "./worktree.ts";

const TOOLS = new Set(["list_sessions", "read_session", "send_message"]);
/** 记着多少封信的下落；再多就忘掉最早的（界面上那几封退回「排队中」，只在很久以前的记录里）。 */
const FATES_KEPT = 500;

// i18n-exempt：下面的工具结果都是发给模型的。

const MESSAGE_PARAMETERS = {
	type: "object",
	properties: { to: TO, message: { type: "string", description: "The message: self-contained, short; long content goes in a file whose path you send." } },
	required: ["to", "message"],
	additionalProperties: false,
} as const;

export default {
	name: "plume.sessions",
	// 任何会话都可能在等人批准：要知道每个会话有没有弹着卡，看全部会话。
	observe: "all",
	apply(ctx) {
		const pacer = new PeerPacer();
		/** 正弹着审批卡、等它的人批准或回答的会话：`list_sessions` 照实说它在等人，免得别的会话以为它卡住了。 */
		const waitingOnUser = new Set<string>();
		ctx.sessions.observe(({ event }) => {
			if (event.type !== "approval") return;
			if (event.approval) waitingOnUser.add(event.sessionId);
			else waitingOnUser.delete(event.sessionId);
		});
		ctx.sessions.onDeleted((sessionId) => waitingOnUser.delete(sessionId));
		/** 寄出的信的下落（`LetterFate`），按信的 id；界面据此在工具那一行标出没送到的。 */
		const fates = new Map<string, LetterFate["status"]>();
		const remember = (receipt: LetterReceipt) =>
			void receipt.read.then((fate) => {
				fates.set(receipt.id, fate.status);
				if (fates.size > FATES_KEPT) fates.delete(fates.keys().next().value!);
			});
		const api: SessionsApi = {
			async fates(ids) {
				return Object.fromEntries(ids.flatMap((id) => (fates.has(String(id)) ? [[String(id), fates.get(String(id))!]] : [])));
			},
		};
		ctx.serve(api);

		/** 解析地址：从 `fromId` 看出去，谁是 `to`。 */
		async function lookup(fromId: string, to: string): Promise<Missed | { kind: "found"; from: SessionSummary; target: SessionSummary; to: string }> {
			const all = await ctx.sessions.list();
			const from = all.find((session) => session.id === fromId);
			if (!from) return { kind: "none" };
			const found = resolveSession(to, all.filter(listed));
			if (found.kind === "none") return { kind: "none" };
			if (found.kind === "ambiguous") return { kind: "ambiguous", candidates: found.candidates.map(sessionAddress) };
			const target = found.session;
			if (target.id === from.id) return { kind: "self" };
			if (!together(from, target, await mainWorktrees([from.cwd, target.cwd]))) return { kind: "unreachable", to: sessionAddress(target) };
			return { kind: "found", from, target, to: sessionAddress(target) };
		}

		/** 只给侧栏里的会话用；子会话、插件的独立会话里调到时的那句。 */
		function refusedHere(run: ToolRun): ToolOutput | undefined {
			return run.session.kind !== "top"
				? { output: "These tools only work in a main conversation, not in a sub-agent, side chat or plugin-owned session.", isError: true }
				: undefined;
		}

		ctx.hook("model.context", async (input, next) => {
			if (input.session.kind !== "top") return next({ ...input, tools: input.tools.filter((tool) => !TOOLS.has(tool.name)) });
			const all = await ctx.sessions.list();
			const self = all.find((session) => session.id === input.sessionId);
			if (!self) return next(input);
			const sections = [...input.sections];
			const spawnedFrom = self.spawnedFrom;
			const origin = spawnedFrom && all.find((session) => session.id === spawnedFrom.sessionId);
			if (origin && listed(origin)) sections.push({ id: ORIGIN_SECTION, text: originSection(origin.id) });
			const family = familyOf(self, all);
			if (family.length > 0)
				sections.push({
					id: ROSTER_SECTION,
					text: rosterSection(
						family.map((member) => ({
							label: member.spawnedFrom?.name ?? sessionAddress(member),
							id: member.id,
							...(member.id === spawnedFrom?.sessionId
								? { relation: "parent" as const }
								: member.spawnedFrom?.sessionId === self.id
									? { relation: "child" as const }
									: {}),
						})),
					),
				});
			return next(sections.length === input.sections.length ? input : { ...input, sections });
		});

		/** 寄信前：校验参数、找人。 */
		async function addressed(
			args: Record<string, unknown>,
			run: ToolRun,
			missingTo: string,
		): Promise<
			| { refused: ToolOutput }
			| { message: string; found: Extract<Awaited<ReturnType<typeof lookup>>, { kind: "found" }>; letter: NonNullable<ToolRun["letter"]> }
		> {
			const refused = refusedHere(run);
			if (refused || !run.letter) return { refused: refused ?? { output: "These tools only work in a main conversation.", isError: true } };
			const to = String(args.to ?? "").trim();
			const message = typeof args.message === "string" ? args.message.trim() : "";
			if (!to) return { refused: { output: missingTo, isError: true } };
			if (!message) return { refused: { output: "`message` is required.", isError: true } };
			const found = await lookup(run.sessionId, to);
			if (found.kind !== "found") return { refused: { output: missed(found, to), isError: true } };
			return { message, found, letter: run.letter };
		}

		/**
		 * 过了限速就寄出去；拦下了返回退回的话。本体拒寄时（对方刚好不在了）抛的错是给模型的话，原样交回，
		 * 不算发过一封。
		 */
		function post(
			fromId: string,
			found: { target: SessionSummary; from: SessionSummary; to: string },
			letter: NonNullable<ToolRun["letter"]>,
			input: Omit<LetterInput, "from">,
		): { refused: ToolOutput } | { receipt: LetterReceipt } {
			const refusal = pacer.check(fromId, found.target.id, input.text);
			if (refusal) return { refused: { output: paced(refusal, found.to, input.text.length), isError: true } };
			let receipt: LetterReceipt;
			try {
				receipt = letter(found.target.id, { ...input, from: sessionAddress(found.from) });
			} catch (error) {
				return { refused: { output: error instanceof Error ? error.message : String(error), isError: true } };
			}
			pacer.spend(fromId, found.target.id, input.text);
			return { receipt };
		}

		const listSessions: ToolDefinition = {
			name: "list_sessions",
			description: LIST_SESSIONS_DESCRIPTION,
			parameters: {
				type: "object",
				properties: { linked: { type: "boolean", description: "Only the sessions linked to this one (started from one another)." } },
				additionalProperties: false,
			},
			async execute(args, run) {
				const refused = refusedHere(run);
				if (refused) return refused;
				const linked = args.linked === true;
				const none = linked ? "No session is linked to this one." : "No other conversation is in this project or folder right now.";
				const all = await ctx.sessions.list();
				const from = all.find((session) => session.id === run.sessionId);
				if (!from) return { output: none };
				const others = linked ? familyOf(from, all) : all.filter((session) => listed(session) && session.id !== from.id);
				const mains = linked ? new Map<string, string[]>() : await mainWorktrees([from.cwd, ...others.map((session) => session.cwd)]);
				const rows = await Promise.all(
					others
						.filter((session) => linked || together(from, session, mains))
						.map(async (session) => {
							const doing = currentStep(await ctx.sessions.messages(session.id).catch(() => []));
							const state = waitingOnUser.has(session.id) ? "waiting for its user" : session.running ? "working" : "idle";
							const name = session.spawnedFrom?.name ? [`name: ${session.spawnedFrom.name}`] : [];
							return [sessionAddress(session), session.id, ...name, state, session.cwd, ...(doing ? [`on: ${doing}`] : [])].join(" · ");
						}),
				);
				return { output: rows.length > 0 ? rows.join("\n") : none };
			},
		};

		/*
		 * 想知道对方做到哪、之前定过什么，答案多半已经在它的记录里。读不打断它、不花它的钱。
		 * 和侧边聊天的 `read_main_chat` 同一个读法。
		 */
		const readSession: ToolDefinition = {
			name: "read_session",
			description: READ_SESSION_DESCRIPTION,
			parameters: { type: "object", properties: { to: TO, ...HISTORY_PROPERTIES }, required: ["to"], additionalProperties: false },
			async execute(args, run) {
				const refused = refusedHere(run);
				if (refused) return refused;
				const { to: wanted, ...page } = args;
				const to = String(wanted ?? "").trim();
				if (!to) return { output: "`to` is required: an address from list_sessions.", isError: true };
				const invalid = invalidHistoryArgs(page);
				if (invalid) return { output: invalid, isError: true };
				const found = await lookup(run.sessionId, to);
				if (found.kind !== "found") return { output: missed(found, to), isError: true };
				return { output: readHistory(found.target.id, await ctx.sessions.messages(found.target.id), page as HistoryArgs, READ_LIMIT) };
			},
		};

		const sendMessage: ToolDefinition = {
			name: "send_message",
			description: SEND_MESSAGE_DESCRIPTION,
			parameters: MESSAGE_PARAMETERS,
			async execute(args, run) {
				const ready = await addressed(args, run, "`to` is required: a session id, or an address from list_sessions.");
				if ("refused" in ready) return ready.refused;
				const { message, found, letter } = ready;
				const posted = post(run.sessionId, found, letter, { text: message, guide: LETTER_GUIDE });
				if ("refused" in posted) return posted.refused;
				remember(posted.receipt);
				return {
					output: sent(found.to, posted.receipt.queued),
					details: { kind: "session_message", to: found.to, sessionId: found.target.id, letterId: posted.receipt.id, queued: posted.receipt.queued },
				};
			},
		};

		for (const tool of [listSessions, readSession, sendMessage]) ctx.tools.register(tool);
	},
} satisfies Plugin;
