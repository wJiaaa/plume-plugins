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
 * - 审阅会话经自己的 `ask_implementer` 问原会话修哪几条：一封请求（`ToolRun.letter`），答复的配对、原会话没答时的代答归本体，
 *   不靠别的插件；这件工具只列给审阅会话。一个审阅会话只问一次：在等答复时、答过以后再调都拒绝（见 `asking`）。
 * - 只读：审阅会话和它派出的子会话写文件的调用一律拒绝（`tool.execute`），直到原会话答复了修哪几条——
 *   审阅会话的记录里有原会话寄来、带 `answer`（`replied`、`unreplied`）的信。命令不压只读沙箱，留给权限档：`verify` 要写缓存。
 * - 审阅会话第一轮之后真闲下来（问出去的有了答复、修完了），把最后那段回复（报告）交回原会话；被人停下的不交。
 * - 子会话（子 Agent、侧边聊天）里藏起 `review_session`、调到了也拒绝，它们在当前会话里跑整条流水线（正文第 0 步）。
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LaunchedSession, Message, PeerLetter, Plugin, SessionScope, ToolKind } from "@plume/contract";
import { reviewPrompt, reviewRequest, sessionAddress } from "./brief.ts";
import { MESSAGES } from "./messages.ts";
import { type BodyTools, REVIEW_ARGUMENT_HINT, REVIEW_SESSION_OPENING, reportText, reviewBody, reviewRequest as commandText } from "./review.ts";
import { ASK_IMPLEMENTER, REVIEW_SESSION, type ReviewSessionDetails } from "./types.ts";

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

/**
 * 原会话读到这封请求时附的处理说明：请求没答会被代答这些本体的抬头说了，这里只说拿它怎么办。原会话未必装着能回信的工具，
 * 所以说成把决定写进这一轮的回复——读到请求的那一轮收场时，本体把最后一段回复原样交回去当答复。
 */
// i18n-exempt：发给模型的话。
const ASK_GUIDE =
	"The request is from the review session you handed off with review_session: decide which of its findings to fix as step H.4 of the `/review` instructions says, " +
	"and put the numbers to fix and a short reason for each one left in your reply.";

/** 审阅会话记着从哪个会话交过来、原会话当时在哪个目录。 */
interface Review {
	parentId: string;
	cwd: string;
}

export default {
	name: "plume.review",
	inject: ["session.plan"],
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

		/** 审阅会话的记录里原会话寄来的答复（它自己回的，或本体代答的），旧的在前。 */
		async function answers(reviewId: string): Promise<NonNullable<PeerLetter["answer"]>[]> {
			const parentId = reviews.get(reviewId)?.parentId;
			const messages = await ctx.sessions.messages(reviewId).catch((): Message[] => []);
			return messages.flatMap((message) =>
				message.role === "user" ? (message.peer ?? []).flatMap((letter) => (letter.sessionId === parentId && letter.answer ? [letter.answer] : [])) : [],
			);
		}

		/** 原会话答复了修哪几条：它自己回的，或那一轮收场时代答的。没读到、关掉了不算——修什么还没定。 */
		async function fixesAllowed(reviewId: string): Promise<boolean> {
			return (await answers(reviewId)).some((answer) => answer === "replied" || answer === "unreplied");
		}

		ctx.commands.provide({
			list: () => [{ name: "review", description: text().command, argumentHint: REVIEW_ARGUMENT_HINT }],
			expand: (_name, rest) => ({ text: commandText(rest, bodyTools()), displayText: rest ? `/review ${rest}` : "/review" }),
		});

		ctx.hook("model.context", async (input, next) => {
			// 子会话和插件的独立会话都不是侧栏里那段对话，交不出审阅；问原会话只有审阅会话自己用得上。
			// 一个会话是不是审阅会话在它第一轮开头（`prompt.submit`）就定了，工具表在会话里不变，前缀缓存留得住。
			const hidden = new Set([...(input.session.kind !== "top" ? [REVIEW_SESSION] : []), ...(reviews.has(input.session.id) ? [] : [ASK_IMPLEMENTER])]);
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
		 * 第一轮之后真闲下来（子智能体、一次性的后台命令都回来了，问出去的有了答复、答复叫起的那一轮修完了），把报告交回原会话。
		 * 它留下的监视、开发服务器、约好的唤醒不挡（本体的规则，见 `ParentStatus`）：它们没有做完的那一刻，等它们报告就永远交不回去；
		 * 之后它们叫醒的几轮不算进报告。被人停下的不交，出错、跑到上限的照样交，标成没跑完。
		 */
		function follow(launched: LaunchedSession, title: string): void {
			const id = launched.session.id;
			const report = async () => {
				const { stop, reply } = await launched.idle;
				if (!stop || !reviews.has(id) || stop.reason === "aborted") return;
				const status = stop.reason === "done" ? "done" : "failed";
				const shown = (await ctx.sessions.get(id))?.title || title;
				// 对话里那一行由宿主画成「来自新会话 · 标题」，点了到审阅会话（宿主填它的 id）。
				launched.reportBack(reportText({ sessionId: id, title: shown, status, reply }), { id, title: shown, status });
			};
			// i18n-exempt：日志
			void report().catch((error: unknown) => ctx.log.warn(`审阅会话 ${id} 的报告没交回去：${String(error)}`));
		}

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
				let launched: LaunchedSession;
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
				follow(launched, request.title);
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
				const answer = (await answers(run.sessionId)).at(-1);
				if (answer) return { output: answered(answer), isError: true };
				if (waiting) return { output: STILL_WAITING, isError: true };
				const [self, parent] = await Promise.all([ctx.sessions.get(run.sessionId), ctx.sessions.get(review.parentId)]);
				// 原会话删掉了、归档了：没人能答，照第 F 步第 3 条什么都不修。没寄出去，不算问过。
				if (!self || !parent || parent.archived) {
					asking.delete(run.sessionId);
					return { output: unreachable(), isError: true };
				}
				try {
					run.letter(parent.id, {
						from: sessionAddress(self),
						text: message,
						request: true,
						// 本体代答时署这个名，和原会话自己回信时一样。
						recipient: sessionAddress(parent),
						guide: ASK_GUIDE,
					});
				} catch {
					asking.delete(run.sessionId);
					return { output: unreachable(), isError: true };
				}
				// i18n-exempt：发给模型的话。
				return {
					output: `Sent to “${parent.title}”. Its answer arrives here as a message by itself and starts your next turn — do not wait, poll or ask again. End your turn now with one line saying you are waiting for its decision.`,
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
 * 第 F 步第 2 条说的是收尾等下一条消息，不是重问。没读到（它的人先按了停）、原会话关了，照第 F 步第 3 条什么都不修——
 * 那边的人停下了这件事，重问就是绕过他。
 */
// i18n-exempt：发给模型的话。
function answered(answer: NonNullable<PeerLetter["answer"]>): string {
	if (answer === "dropped" || answer === "closed")
		return (
			`Your question already got its answer: ${answer === "dropped" ? "its person stopped that conversation before it read your request" : "that conversation was closed"}. ` +
			'Do not ask again. Fix nothing and list every finding under "Awaiting a decision" (step F, item 3).'
		);
	return (
		"The conversation that wrote the change has already answered which findings to fix; its answer is the message from it above. Do not ask again. " +
		"Fix exactly the findings it named (step F, item 4). If it only said it is asking its person first, end your turn: the decision comes as another message."
	);
}

// i18n-exempt：发给模型的话。
function unreachable(): string {
	return 'The conversation that wrote the change is gone, so nobody can say which findings to fix. Fix nothing and list every finding under "Awaiting a decision" (step F, item 3).';
}
