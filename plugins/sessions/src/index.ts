/**
 * plume.sessions 的逻辑入口：对话之间互相看一眼、递话、拿回答。
 * 按意图分成五件工具，不靠一个参数区分：
 *
 * - `list_sessions` 看看有谁，`read_session` 读它的记录：不叫醒它、不花它的钱，能查到的不问。
 * - `ask_session` 问：寄一封请求，当场返回。对方闲着开一轮，忙着在两步之间读到；答复不在这次调用里等，以后作为一封
 *   `answer` 信送回来。对方要用 `reply_session` 回；没回、没读到、删掉了，由 `router.ts` 代答。
 * - `reply_session` 回：对方问过来、已经读到、还没答的几封一起答。
 * - `notify_session` 告诉：一句通知，没有答复。
 *
 * 信由本体送（`ToolRun.letter`）：本体照实填发件方、在信前面说明它不是用户的话、不构成授权。这里定写什么、发不发：
 * 找人（`peers.ts`）、限速和链长（`pacing.ts`）、记账和代答（`router.ts`）。
 *
 * - 只给侧栏里的会话（顶层的）用：子 Agent、侧边聊天的工具表里藏起来（`model.context`），调到了也拒绝。
 * - 不查权限宽窄：Plume 的权限档是全局的，所有会话一样宽。
 */

import type { LetterInput, LetterReceipt, Plugin, SessionSummary, ToolDefinition, ToolOutput, ToolRun } from "@plume/contract";
import { currentStep, HISTORY_PROPERTIES, invalidHistoryArgs, READ_LIMIT, readHistory, type HistoryArgs } from "./history.ts";
import { listed, resolveSession, sessionAddress, together } from "./peers.ts";
import {
	ASK_SESSION_DESCRIPTION,
	asked,
	LIST_SESSIONS_DESCRIPTION,
	missed,
	type Missed,
	notified,
	NOTIFY_SESSION_DESCRIPTION,
	paced,
	READ_SESSION_DESCRIPTION,
	replied,
	REPLY_SESSION_DESCRIPTION,
	TO,
} from "./prompt.ts";
import { ANSWERS_GUIDE, NOTICES_GUIDE, PeerRouter, REQUESTS_GUIDE } from "./router.ts";
import { mainWorktrees } from "./worktree.ts";

const TOOLS = new Set(["list_sessions", "read_session", "ask_session", "reply_session", "notify_session"]);

// i18n-exempt：下面的工具结果都是发给模型的。

const MESSAGE_PARAMETERS = (what: string) =>
	({
		type: "object",
		properties: { to: TO, message: { type: "string", description: what } },
		required: ["to", "message"],
	}) as const;

export default {
	name: "plume.sessions",
	apply(ctx) {
		const router = new PeerRouter((sessionId) => ctx.sessions.messages(sessionId), ctx.log);
		/** 正弹着审批卡、等它的人批准或回答的会话：`list_sessions` 照实说它在等人，免得别的会话以为它卡住了。 */
		const waitingOnUser = new Set<string>();
		ctx.sessions.observe((observation) => {
			const { event } = observation;
			if (event.type === "turnEnd") router.turnEnded(observation.sessionId, event.stop);
			if (event.type === "approval") {
				if (event.approval) waitingOnUser.add(event.sessionId);
				else waitingOnUser.delete(event.sessionId);
			}
		});
		ctx.sessions.onDeleted((sessionId) => {
			waitingOnUser.delete(sessionId);
			router.deleted(sessionId);
		});
		ctx.hook("prompt.submit", async (input, next) => {
			if (!input.synthetic) router.personSpoke(input.sessionId);
			return next(input);
		});

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
		async function refusedHere(sessionId: string): Promise<ToolOutput | undefined> {
			const self = (await ctx.sessions.list()).find((session) => session.id === sessionId);
			return self?.parentId || self?.owner
				? { output: "These tools only work in a main conversation, not in a sub-agent, side chat or plugin-owned session.", isError: true }
				: undefined;
		}

		ctx.hook("model.context", async (input, next) => {
			const self = (await ctx.sessions.list()).find((session) => session.id === input.sessionId);
			if (self?.parentId || self?.owner) return next({ ...input, tools: input.tools.filter((tool) => !TOOLS.has(tool.name)) });
			return next(input);
		});

		/** 寄信的三件共用的开头：校验参数、找人。 */
		async function addressed(
			args: Record<string, unknown>,
			run: ToolRun,
			missingTo: string,
		): Promise<
			| { refused: ToolOutput }
			| { message: string; found: Extract<Awaited<ReturnType<typeof lookup>>, { kind: "found" }>; letter: NonNullable<ToolRun["letter"]> }
		> {
			const refused = await refusedHere(run.sessionId);
			if (refused || !run.letter) return { refused: refused ?? { output: "These tools only work in a main conversation.", isError: true } };
			const to = String(args.to ?? "").trim();
			const message = typeof args.message === "string" ? args.message.trim() : "";
			if (!to) return { refused: { output: missingTo, isError: true } };
			if (!message) return { refused: { output: "`message` is required.", isError: true } };
			const found = await lookup(run.sessionId, to);
			if (found.kind !== "found") return { refused: { output: missed(found, to), isError: true } };
			return { message, found, letter: run.letter };
		}

		/** 过了限速就寄出去；拦下了返回退回的话。 */
		function post(
			fromId: string,
			found: { target: SessionSummary; from: SessionSummary; to: string },
			letter: NonNullable<ToolRun["letter"]>,
			input: Omit<LetterInput, "from" | "chain">,
		): { refused: ToolOutput } | { receipt: LetterReceipt; chain: string[] } {
			const chain = router.chain(fromId);
			const refusal = router.admit(fromId, found.target.id, input.text, chain);
			if (refusal) return { refused: { output: paced(refusal, found.to, input.text.length, chain.length), isError: true } };
			const receipt = letter(found.target.id, { ...input, from: sessionAddress(found.from), chain });
			router.sent(receipt, found.target.id, chain);
			return { receipt, chain };
		}

		const listSessions: ToolDefinition = {
			name: "list_sessions",
			description: LIST_SESSIONS_DESCRIPTION,
			parameters: { type: "object", properties: {} },
			async execute(_args, run) {
				const refused = await refusedHere(run.sessionId);
				if (refused) return refused;
				const all = await ctx.sessions.list();
				const from = all.find((session) => session.id === run.sessionId);
				if (!from) return { output: "No other conversation is in this project or folder right now." };
				const others = all.filter((session) => listed(session) && session.id !== from.id);
				const mains = await mainWorktrees([from.cwd, ...others.map((session) => session.cwd)]);
				const rows = await Promise.all(
					others
						.filter((session) => together(from, session, mains))
						.map(async (session) => {
							const doing = currentStep(await ctx.sessions.messages(session.id).catch(() => []));
							const state = waitingOnUser.has(session.id) ? "waiting for its user" : session.running ? "busy" : "idle";
							return [sessionAddress(session), state, session.cwd, ...(doing ? [`on: ${doing}`] : [])].join(" · ");
						}),
				);
				return { output: rows.length > 0 ? rows.join("\n") : "No other conversation is in this project or folder right now." };
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
				const refused = await refusedHere(run.sessionId);
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

		const askSession: ToolDefinition = {
			name: "ask_session",
			description: ASK_SESSION_DESCRIPTION,
			parameters: MESSAGE_PARAMETERS("The request."),
			async execute(args, run) {
				const ready = await addressed(args, run, "`to` is required: an address from list_sessions.");
				if ("refused" in ready) return ready.refused;
				const { message, found, letter } = ready;
				const posted = post(run.sessionId, found, letter, { text: message, request: true, guide: REQUESTS_GUIDE });
				if ("refused" in posted) return posted.refused;
				router.asked(posted.receipt, { text: message, chain: posted.chain, asker: run.sessionId, target: { id: found.target.id, address: found.to } });
				return { output: asked(found.to, found.target.running), details: { kind: "session_ask", to: found.to, sessionId: found.target.id } };
			},
		};

		/*
		 * 回答问过来的会话：它发给这边、已经读到、还没答的几封一起答。没有待答的信也照送，当作通知、照通知的规矩查：
		 * 先回一句「稍后做」、做完再回结果，第二句就落在这里，报错只会让模型换成 `notify_session` 再发一遍。
		 */
		const replySession: ToolDefinition = {
			name: "reply_session",
			description: REPLY_SESSION_DESCRIPTION,
			parameters: MESSAGE_PARAMETERS("The answer."),
			async execute(args, run) {
				const ready = await addressed(args, run, "`to` is required: the `from` address of the request you are answering.");
				if ("refused" in ready) return ready.refused;
				const { message, found, letter } = ready;
				const re = router.answerable(run.sessionId, found.target.id);
				const posted = post(
					run.sessionId,
					found,
					letter,
					re.length > 0 ? { text: message, answer: "replied", re, guide: ANSWERS_GUIDE } : { text: message, guide: NOTICES_GUIDE },
				);
				if ("refused" in posted) return posted.refused;
				if (re.length > 0) router.replied(run.sessionId, found.target.id);
				return { output: replied(found.to, re.length), details: { kind: "session_reply", to: found.to, sessionId: found.target.id } };
			},
		};

		const notifySession: ToolDefinition = {
			name: "notify_session",
			description: NOTIFY_SESSION_DESCRIPTION,
			parameters: MESSAGE_PARAMETERS("The notice."),
			async execute(args, run) {
				const ready = await addressed(args, run, "`to` is required: an address from list_sessions.");
				if ("refused" in ready) return ready.refused;
				const { message, found, letter } = ready;
				const posted = post(run.sessionId, found, letter, { text: message, guide: NOTICES_GUIDE });
				if ("refused" in posted) return posted.refused;
				return { output: notified(found.to, found.target.running), details: { kind: "session_notify", to: found.to, sessionId: found.target.id } };
			},
		};

		for (const tool of [listSessions, readSession, askSession, replySession, notifySession]) ctx.tools.register(tool);
	},
} satisfies Plugin;
