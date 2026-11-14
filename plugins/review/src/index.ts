/**
 * plume.review 的逻辑入口：`/review`，和它交出去的只读审阅会话。
 *
 * - `/review [目标] [--effort …] [--comment]` 展开成整段审阅流程（`review.ts`），气泡里只画人敲的那一句。
 * - 写代码的会话不审自己：它填一份交接单、调 `review_session`，这里当场在同一个项目里开一个审阅会话（`ctx.sessions.launch`，
 *   `spawnedFrom` 记着这次调用），第一句是交接单（`brief.ts`），这一轮以 `terminate` 停下。人敲 `/review` 就是同意，不经卡片。
 *   开不出来时这次调用报错，模型当场知道。
 * - 交接单里的计划向服务 `session.plan`（内置插件 plume.plan 提供）要这个会话照着做的那份，不读交计划那次调用的结果。
 * - 审阅会话的第一轮开头（`prompt.submit`）：认出交接单，把流程正文接在它后面给模型（气泡里只有交接单），
 *   原会话在别的目录里跑（工作树）时把审阅会话也挪过去，未提交的改动只在那里。
 * - 审阅会话经自己的 `ask_implementer` 问原会话修哪几条，原会话经 `answer_review` 答：各是一封单向的信（`ToolRun.letter`），
 *   不靠别的插件。`ask_implementer` 只列给审阅会话，`answer_review` 只列给交出过审阅的会话。一个审阅会话只问一次：在等答复时、
 *   答过以后再调都拒绝（见 `asking`）。
 * - 只读：审阅会话和它派出的子会话写文件的调用一律拒绝（`tool.execute`），直到原会话答复了修哪几条——
 *   审阅会话的记录里有原会话寄来的信。命令不压只读沙箱，留给权限档：`verify` 要写缓存。
 * - 审阅会话做完（一轮收场时没在等原会话的答复、派出去的事都回来了）把最后那段回复（报告）交回原会话，只交一次；被人停下的那一轮不交。
 * - 子会话（子 Agent、侧边聊天）里藏起 `review_session`、调到了也拒绝，它们在当前会话里跑整条流水线（正文第 0 步）。
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Message, Plugin, SessionScope, TurnStop, ToolKind } from "@plume/contract";
import { reviewPrompt, reviewRequest, sessionAddress } from "./brief.ts";
import { MESSAGES } from "./messages.ts";
import { type BodyTools, REVIEW_ARGUMENT_HINT, REVIEW_SESSION_OPENING, reportText, reviewBody, reviewRequest as commandText } from "./review.ts";
import { ANSWER_REVIEW, ASK_IMPLEMENTER, REVIEW_SESSION, type ReviewSessionDetails } from "./types.ts";

// i18n-exempt：工具说明、参数和结果是发给模型的话。
const DESCRIPTION =
	"Hand this conversation's review to a new read-only review session; its report comes back here. Use only as step H of the `/review` instructions says to.";

const PARAMETERS = {
	type: "object",
	properties: {
		background: { type: "string" },
		decisions: { type: "string" },
		implementation: { type: "string" },
		files: {
			type: "array",
			items: { type: "object", properties: { path: { type: "string" }, change: { type: "string" } }, required: ["path", "change"] },
		},
		out_of_scope: { type: "string" },
		unverified: { type: "string" },
		focus: { type: "string" },
		target: { type: "string" },
		effort: { type: "string", enum: ["low", "medium", "high"] },
	},
	additionalProperties: false,
} as const;

/**
 * 会写文件的调用，为什么。写、改文件的工具按注册它的插件声明的种类（`ToolDefinition.kind` 的 `create`、`modify`）认，不认名字。
 * 跑命令的不在这里：审阅会话的命令留给权限档，它派的 `verify` 要跑测试、写缓存。
 */
function edits(kind: ToolKind | undefined): string | undefined {
	return kind === "create" || kind === "modify" ? "it edits files" : undefined;
}

// i18n-exempt：发给模型的工具结果。
function refusal(tool: string, why: string): string {
	return (
		`Review session: ${why}, so "${tool}" did not run. A review session reads until the conversation that wrote the ` +
		`change has said which findings to fix: finish the report, ask it with \`${ASK_IMPLEMENTER}\` (step F) and end your turn. Once its answer arrives, edits are allowed.`
	);
}

// i18n-exempt：发给模型的话。
const ASK_DESCRIPTION =
	"Review session only: ask the conversation that wrote the change and handed you this review which findings to fix, as step F of the `/review` instructions says. " +
	"Ask only once. It returns at once; its answer arrives here later as a message by itself and starts your next turn, so end your turn after asking.";

/** 原会话读到这封问话时附的处理说明：信是单向的，答要另调 `answer_review`。 */
// i18n-exempt：发给模型的话。
const ASK_GUIDE =
	"The message is from the review session you handed off with review_session: decide which of its findings to fix as step H.4 of the `/review` instructions says, " +
	`then send the numbers to fix and a short reason for each one left with \`${ANSWER_REVIEW}\`.`;

// i18n-exempt：发给模型的话。
const ANSWER_DESCRIPTION =
	"Answer the review session you handed off with review_session, after it asked which of its findings to fix (step H.4 of the `/review` instructions): " +
	"the numbers to fix and, for each one left, the reason in a few words. Send it once, after you have decided every finding; it returns at once and the review session makes the fixes.";

/** 审阅会话读到原会话答复时附的说明。 */
// i18n-exempt：发给模型的话。
const ANSWER_GUIDE = "This is the implementing conversation's decision on which findings to fix: fix exactly the findings it named (step F, item 4).";

/** 审阅会话记着从哪个会话交过来、原会话当时在哪个目录、报告交回去了没有。 */
interface Review {
	parentId: string;
	cwd: string;
	reported?: true;
}

export default {
	name: "plume.review",
	inject: ["session.plan"],
	// 报告在审阅会话做完的那一轮收场时交回：要看到它每一轮的收场。
	observe: "all",
	async apply(ctx) {
		const text = () => MESSAGES[ctx.locale()];
		const plans = ctx.use("session.plan");
		/** 正文点名的别的插件的工具，按它们声明的类别现找，不认名字。 */
		const bodyTools = (): BodyTools => {
			const tools = ctx.tools.list();
			const named = (category: "delegate" | "question") => tools.find((tool) => tool.category === category)?.name;
			return { delegate: named("delegate"), question: named("question") };
		};
		// 哪些会话是审阅会话：重启以后只读照旧，所以存在数据目录里。
		const reviewsFile = join(ctx.dataDir, "reviews.json");
		const reviews = new Map<string, Review>(
			Object.entries(
				await readFile(reviewsFile, "utf8").then(
					(raw) => JSON.parse(raw) as Record<string, Review>,
					() => ({}),
				),
			),
		);
		let saving: Promise<void> = Promise.resolve();
		const save = () => {
			const body = JSON.stringify(Object.fromEntries(reviews));
			saving = saving
				.then(async () => {
					await writeFile(`${reviewsFile}.tmp`, body);
					await rename(`${reviewsFile}.tmp`, reviewsFile);
				})
				// i18n-exempt：日志
				.catch((error: unknown) => ctx.log.warn(`审阅会话的记录没存上：${String(error)}`));
		};
		const remember = (sessionId: string, review: Review) => {
			if (reviews.has(sessionId)) return;
			reviews.set(sessionId, review);
			save();
		};
		/** 开出去、第一轮还没开头的交接单：`prompt.submit` 按第一句话认出是哪一份（`launch` 返回之前第一轮可能已经开头了）。 */
		const pending = new Map<string, Review>();
		/**
		 * 这次运行里经 `ask_implementer` 问过原会话的审阅会话。第 F 步只问一次：答复叫起审阅会话的下一轮，等的时候再问只会把原会话
		 * 多叫起几轮、答好几遍。不存盘：应用退出后还没答的请求不会再有答复（见 `LetterReceipt`），重启以后可以重问；答过的看记录里的答复。
		 */
		const asking = new Set<string>();
		ctx.sessions.onDeleted((sessionId) => {
			asking.delete(sessionId);
			if (reviews.delete(sessionId)) save();
		});

		/** 这次调用受哪个审阅会话管：它自己，或派出它的那个（子 Agent）。 */
		function reviewOf(session: SessionScope): string | undefined {
			if (reviews.has(session.id)) return session.id;
			const parentId = session.kind === "child" ? session.parentId : undefined;
			return parentId && reviews.has(parentId) ? parentId : undefined;
		}

		/** 原会话答复了修哪几条：审阅会话的记录里有原会话寄来的信。 */
		async function fixesAllowed(reviewId: string): Promise<boolean> {
			const parentId = reviews.get(reviewId)?.parentId;
			const messages = await ctx.sessions.messages(reviewId).catch((): Message[] => []);
			return messages.some((message) => message.role === "user" && (message.peer ?? []).some((letter) => letter.sessionId === parentId));
		}

		/** 这个会话交出过、还在的审阅会话，新的在后。 */
		const reviewsOf = (parentId: string) => [...reviews].flatMap(([id, review]) => (review.parentId === parentId ? [id] : []));

		ctx.commands.provide({
			list: () => [{ name: "review", description: text().command, argumentHint: REVIEW_ARGUMENT_HINT }],
			expand: (_name, rest) => ({ text: commandText(rest, bodyTools()), displayText: rest ? `/review ${rest}` : "/review" }),
		});

		ctx.hook("model.context", async (input, next) => {
			// 子会话和插件的独立会话都不是侧栏里那段对话，交不出审阅；问原会话只有审阅会话自己用得上。
			// 一个会话是不是审阅会话在它第一轮开头（`prompt.submit`）就定了，工具表在会话里不变，前缀缓存留得住。
			// 答审阅会话的那件只列给交出过审阅的会话：交出去的那一轮就收场了，多出来的这件只断一次缓存。
			const hidden = new Set([
				...(input.session.kind !== "top" ? [REVIEW_SESSION] : []),
				...(reviews.has(input.session.id) ? [] : [ASK_IMPLEMENTER]),
				...(reviewsOf(input.session.id).length > 0 ? [] : [ANSWER_REVIEW]),
			]);
			return next({ ...input, tools: input.tools.filter((tool) => !hidden.has(tool.name)) });
		});

		ctx.hook("prompt.submit", async (input, next) => {
			const verdict = await next(input);
			if (verdict.block || !input.fresh || !input.text.startsWith(REVIEW_SESSION_OPENING)) return verdict;
			const review = pending.get(input.text);
			if (!review) return verdict;
			pending.delete(input.text);
			remember(input.sessionId, review);
			const body = reviewBody(bodyTools());
			return {
				block: false,
				context: verdict.context ? `${verdict.context}\n\n${body}` : body,
				// 和原会话同一个目录：它在自己的工作树里时，未提交的改动只在那里。
				...(verdict.cwd !== undefined ? { cwd: verdict.cwd } : review.cwd !== input.cwd ? { cwd: review.cwd } : {}),
			};
		});

		ctx.hook("tool.execute", async (input, next) => {
			const why = edits(ctx.tools.list().find((tool) => tool.name === input.call.name)?.kind);
			if (!why) return next(input);
			const reviewId = reviewOf(input.session);
			if (!reviewId || (await fixesAllowed(reviewId))) return next(input);
			return { output: refusal(input.call.name, why), isError: true };
		});

		/**
		 * 审阅会话一轮收场时，做完了就把最后那段回复（报告）交回原会话，只交一次：问了原会话、答复还没到的那一轮是在等，
		 * 派出去的子智能体、一次性的后台命令还没回来（`background`）的那一轮结论还在后面。它留下的监视、开发服务器、约好的唤醒不挡。
		 * 被人停下的那一轮不交，出错、跑到上限的照样交，标成没跑完。交回时叫醒原会话：它交出审阅后就停下等着了。
		 */
		async function turnEnded(id: string, stop: TurnStop): Promise<void> {
			const review = reviews.get(id);
			if (!review || review.reported || stop.reason === "aborted" || stop.reason === "interrupted") return;
			const summary = await ctx.sessions.get(id);
			if (!summary || summary.background) return;
			if (asking.has(id) && !(await fixesAllowed(id))) return;
			const messages = await ctx.sessions.messages(id);
			const status = stop.reason === "done" ? "done" : "failed";
			const title = summary.title;
			// 对话里那一行由宿主画成「来自关联会话 · 标题」，点了到审阅会话（宿主填它的 id）。
			if (
				!ctx.sessions.reportBack(id, reportText({ sessionId: id, title, status, reply: lastReply(messages) }), { delivery: { id, title, status }, wake: true })
			)
				return;
			review.reported = true;
			save();
		}
		ctx.sessions.observe(({ sessionId, event }) => {
			// i18n-exempt：日志
			if (event.type === "turnEnd")
				void turnEnded(sessionId, event.stop).catch((error: unknown) => ctx.log.warn(`审阅会话 ${sessionId} 的报告没交回去：${String(error)}`));
		});

		ctx.tools.register({
			name: REVIEW_SESSION,
			description: DESCRIPTION,
			parameters: PARAMETERS,
			async execute(args, run) {
				const parent = run.session.kind === "top" ? await ctx.sessions.get(run.sessionId) : undefined;
				// i18n-exempt：发给模型的话。
				if (!parent) return { output: "Only the conversation itself can hand off its review; run the review here instead.", isError: true };
				// 审阅会话自己也拿得到这件工具（工具表不变，前缀缓存才留得住）。再交一次就是一串互相转交、谁也不审的会话。
				if (reviews.has(parent.id))
					return { output: "This conversation is the review session. Run the review pipeline here; do not hand it off again.", isError: true };
				const brief = text().brief;
				const request = reviewRequest(args, parent.title, brief);
				if ("error" in request) return { output: request.error, isError: true };
				const messages = await ctx.sessions.messages(parent.id);
				const prompt = reviewPrompt(request, await plans.approved(parent.id), messages, parent.title, brief);
				const review: Review = { parentId: parent.id, cwd: parent.cwd };
				pending.set(prompt, review);
				let launched: Awaited<ReturnType<typeof ctx.sessions.launch>>;
				try {
					launched = await ctx.sessions.launch({
						...(parent.project ? { project: parent.project } : { cwd: parent.cwd }),
						message: prompt,
						title: request.title,
						// 审阅用原会话的模型：子智能体设置里给 `review` 选的模型是那个插件自己存的，这里读不到。
						...(parent.model ? { model: parent.model } : {}),
						spawnedFrom: { sessionId: parent.id, toolCallId: run.toolCallId },
					});
				} catch (error) {
					pending.delete(prompt);
					const reason = error instanceof Error ? error.message : String(error);
					return { output: `The review session could not be started: ${reason}. Tell the person; they can send /review again.`, isError: true };
				}
				remember(launched.session.id, review);
				const details: ReviewSessionDetails = { ...request, sessionId: launched.session.id };
				return {
					output:
						`Review handed to a new review session, "${request.title}". It starts now with your hand-off${request.handoff ? "" : " (none: a pull request)"}, the person's messages and the approved plan, if this conversation has one. ` +
						"Before it reports, it asks you which findings to fix (step H); it makes the fixes. Its report is delivered here as a new message when it finishes; do not review the change yourself and do not wait for it.",
					details,
					// 这一轮到此为止：接着往下说的模型多半会自己动手审，那正是要避开的。
					terminate: "done",
				};
			},
		});

		ctx.tools.register({
			name: ASK_IMPLEMENTER,
			description: ASK_DESCRIPTION,
			parameters: {
				type: "object",
				properties: { message: { type: "string", description: "The path to the report, one line per finding, and the question which numbers to fix." } },
				required: ["message"],
				additionalProperties: false,
			},
			async execute(args, run) {
				const review = reviews.get(run.sessionId);
				// i18n-exempt：发给模型的话。
				if (!review || !run.letter) return { output: "Only a review session started by review_session can ask the conversation it reviews.", isError: true };
				const message = typeof args.message === "string" ? args.message.trim() : "";
				// i18n-exempt：发给模型的话。
				if (!message) return { output: "`message` is required.", isError: true };
				// 先占上再 await：同一步里并排调了两次也只寄一封。
				const waiting = asking.has(run.sessionId);
				asking.add(run.sessionId);
				if (await fixesAllowed(run.sessionId)) return { output: ANSWERED, isError: true };
				if (waiting) return { output: STILL_WAITING, isError: true };
				const [self, parent] = await Promise.all([ctx.sessions.get(run.sessionId), ctx.sessions.get(review.parentId)]);
				// 原会话删掉了、归档了：没人能答，照第 F 步第 3 条什么都不修。没寄出去，不算问过。
				if (!self || !parent || parent.archived) {
					asking.delete(run.sessionId);
					return { output: unreachable(), isError: true };
				}
				try {
					run.letter(parent.id, { from: sessionAddress(self), text: message, guide: ASK_GUIDE });
				} catch (error) {
					// 没寄出去，不算问过。原会话这时不在了、归档了，照第 F 步第 3 条什么都不修；还在就是本体拒寄，它的 message 是给模型的话。
					asking.delete(run.sessionId);
					const now = await ctx.sessions.get(parent.id);
					if (!now || now.archived || !(error instanceof Error) || !error.message) return { output: unreachable(), isError: true };
					return { output: error.message, isError: true };
				}
				// i18n-exempt：发给模型的话。
				return {
					output: `Sent to “${parent.title}”. Its answer arrives here as a message by itself and starts your next turn — do not wait, poll or ask again. End your turn now with one line saying you are waiting for its decision.`,
				};
			},
		});

		ctx.tools.register({
			name: ANSWER_REVIEW,
			description: ANSWER_DESCRIPTION,
			parameters: {
				type: "object",
				properties: { message: { type: "string", description: "The numbers to fix, and for each one left, the reason in a few words." } },
				required: ["message"],
				additionalProperties: false,
			},
			async execute(args, run) {
				const message = typeof args.message === "string" ? args.message.trim() : "";
				// i18n-exempt：发给模型的话。
				if (!message) return { output: "`message` is required.", isError: true };
				// 答最近问过来的那一个审阅会话：原会话的记录里最后一封审阅会话寄来的信。
				const mine = new Set(reviewsOf(run.sessionId));
				const messages = await ctx.sessions.messages(run.sessionId);
				const asker = messages
					.flatMap((one) => (one.role === "user" ? (one.peer ?? []) : []))
					.map((letter) => letter.sessionId)
					.findLast((id) => mine.has(id));
				// i18n-exempt：发给模型的话。
				if (!asker || !run.letter) return { output: "No review session you handed off has asked you which findings to fix.", isError: true };
				const [self, review] = await Promise.all([ctx.sessions.get(run.sessionId), ctx.sessions.get(asker)]);
				// i18n-exempt：发给模型的话。
				if (!self || !review || review.archived) return { output: "That review session is gone; tell the person its findings were not fixed.", isError: true };
				try {
					run.letter(review.id, { from: sessionAddress(self), text: message, guide: ANSWER_GUIDE });
				} catch (error) {
					return { output: error instanceof Error ? error.message : String(error), isError: true };
				}
				// i18n-exempt：发给模型的话。
				return {
					output: `Sent to “${review.title}”. It makes the fixes and its report arrives here as a message by itself — do not wait or poll. End your turn now with one line saying the review session is fixing them.`,
				};
			},
		});
	},
} satisfies Plugin;

// i18n-exempt：发给模型的话。
const STILL_WAITING =
	"You have already asked the conversation that wrote the change which findings to fix, and its answer has not arrived yet. Do not ask again: " +
	"end your turn now with one line saying you are waiting for its decision. The answer arrives here as a message by itself and starts your next turn.";

/**
 * 答过以后再问：照第 F 步和 H.4，原会话定完每一条才答，一次答复就是它的决定，再问是让它把同一件事再定一遍。只说它要先问它的人时，
 * 第 F 步第 2 条说的是收尾等下一条消息，不是重问。
 */
// i18n-exempt：发给模型的话。
const ANSWERED =
	"The conversation that wrote the change has already answered which findings to fix; its answer is the message from it above. Do not ask again. " +
	"Fix exactly the findings it named (step F, item 4). If it only said it is asking its person first, end your turn: the decision comes as another message.";

/** 最后一段有字的回复：报告。 */
function lastReply(messages: readonly Message[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role !== "assistant") continue;
		const text = message.content
			.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("")
			.trim();
		if (text) return text;
	}
	return "";
}

// i18n-exempt：发给模型的话。
function unreachable(): string {
	return 'The conversation that wrote the change is gone, so nobody can say which findings to fix. Fix nothing and list every finding under "Awaiting a decision" (step F, item 3).';
}
