/**
 * plume.sessions 的逻辑入口：对话之间互相看一眼、递一句话。
 *
 * - `list_sessions` 看看有谁、在忙还是在等它的人、清单上在做哪一步，`read_session` 读它的记录：不叫醒它、不花它的钱，能查到的不问。
 *   在做哪一步在工具交回清单时记下（钩子 tool.execute），不为列一次表把每个会话的整段记录读出来。
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
 * - 回执照实说对方什么时候读到：对方叫不醒（它的人按了停、被接连叫起到了上限，`LetterReceipt.held`）时说清楚，别让模型以为对方接手了。
 * - 开出来、每轮交回来处的会话（`spawnedFrom.reportBack`）回答来处，答案写在收尾那段回复里，随本体的交回送到：来处寄给它时
 *   换一段处理说明（`REPORTED_GUIDE`）；它在来处的信叫起的那一轮（`session.cause`）又要回寄来处时退回，免得来处收到两份。
 *   它在一轮中途主动问来处照常能寄。信是在它一轮中途读到的，那一轮不算信叫起的，拦不住，只靠处理说明。
 */

import type { LetterFate, LetterInput, LetterReceipt, Plugin, SessionSummary, ToolDefinition, ToolOutput, ToolRun } from "@plume/contract";
import type { SessionsApi } from "./api.ts";
import { checklistStep, currentStep, HISTORY_PROPERTIES, invalidHistoryArgs, READ_LIMIT, readHistory, type HistoryArgs } from "./history.ts";
import { familyOf, listed, reportsTo, resolveSession, sessionAddress, together } from "./peers.ts";
import {
	ANSWER_IN_REPLY,
	LETTER_GUIDE,
	LIST_SESSIONS_DESCRIPTION,
	missed,
	type Missed,
	ORIGIN_SECTION,
	originSection,
	paced,
	READ_SESSION_DESCRIPTION,
	REPORTED_GUIDE,
	ROSTER_SECTION,
	rosterSection,
	SEND_MESSAGE_DESCRIPTION,
	sent,
	TO,
} from "./prompt.ts";
import { PeerPacer } from "./pacing.ts";
import { repositories } from "./repository.ts";

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
		/**
		 * 每个会话清单上正在做的那一项（`checklistStep`），工具交回清单时记下。没记过的（重启以后还没交过清单）、撤回截掉过的，
		 * 列表时从它的记录里读一次再记下。
		 */
		const steps = new Map<string, string | undefined>();
		ctx.sessions.observe(({ sessionId, event }) => {
			if (event.type === "rewound") steps.delete(sessionId);
			if (event.type !== "approval") return;
			if (event.approval) waitingOnUser.add(event.sessionId);
			else waitingOnUser.delete(event.sessionId);
		});
		ctx.sessions.onDeleted((sessionId) => {
			waitingOnUser.delete(sessionId);
			steps.delete(sessionId);
		});
		ctx.hook("tool.execute", async (input, next) => {
			const output = await next(input);
			const step = output.isError ? null : checklistStep(output.details);
			if (step !== null) steps.set(input.sessionId, step);
			return output;
		});
		async function stepOf(sessionId: string): Promise<string | undefined> {
			if (steps.has(sessionId)) return steps.get(sessionId);
			const step = currentStep(await ctx.sessions.messages(sessionId).catch(() => []));
			steps.set(sessionId, step);
			return step;
		}
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

		/** 从 `from` 看得见的会话（见 `peers.ts`），不含自己。 */
		async function reachable(from: SessionSummary, all: readonly SessionSummary[]): Promise<SessionSummary[]> {
			const others = all.filter((session) => listed(session) && session.id !== from.id);
			const repos = await repositories([from.cwd, ...others.map((session) => session.cwd)]);
			return others.filter((session) => together(from, session, repos));
		}

		/** 解析地址：从 `fromId` 看出去，谁是 `to`。只在看得见的会话和自己里找，见 `peers.ts`。 */
		async function lookup(fromId: string, to: string): Promise<Missed | { kind: "found"; from: SessionSummary; target: SessionSummary; to: string }> {
			const all = await ctx.sessions.list();
			const from = all.find((session) => session.id === fromId);
			if (!from) return { kind: "none" };
			const found = resolveSession(to, [from, ...(await reachable(from, all))]);
			if (found.kind === "none") return { kind: "none" };
			if (found.kind === "ambiguous") return { kind: "ambiguous", candidates: found.candidates.map(sessionAddress) };
			const target = found.session;
			if (target.id === from.id) return { kind: "self" };
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
			if (origin && listed(origin)) sections.push({ id: ORIGIN_SECTION, text: originSection(origin.id, reportsTo(self, origin)) });
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
				const others = linked ? familyOf(from, all) : await reachable(from, all);
				const rows = await Promise.all(
					others.map(async (session) => {
						const doing = await stepOf(session.id);
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
				// 来处的信叫起了这一轮，答案写在收尾回复里由本体交回；再寄一封，来处就收到两份。在限速之前退回，不算发过。
				const cause = run.session.cause;
				if (reportsTo(found.from, found.target) && cause?.by === "peer" && cause.from === found.target.id) return { output: ANSWER_IN_REPLY, isError: true };
				const reported = reportsTo(found.target, found.from);
				const posted = post(run.sessionId, found, letter, { text: message, guide: reported ? REPORTED_GUIDE : LETTER_GUIDE });
				if ("refused" in posted) return posted.refused;
				const { receipt } = posted;
				remember(receipt);
				// 旧版本的本体不给 `held`：当作叫得醒，和那时的行为一致。
				const held = receipt.held === true;
				return {
					output: sent(found.to, { queued: receipt.queued, held, reported }),
					details: {
						kind: "session_message",
						to: found.to,
						sessionId: found.target.id,
						letterId: receipt.id,
						queued: receipt.queued,
						...(held ? { held } : {}),
					},
				};
			},
		};

		for (const tool of [listSessions, readSession, sendMessage]) ctx.tools.register(tool);
	},
} satisfies Plugin;
