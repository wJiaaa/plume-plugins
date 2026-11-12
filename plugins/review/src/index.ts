/**
 * plume.review 的逻辑入口：`/review`，和它交出去的只读审阅会话。
 *
 * - `/review [目标] [--effort …] [--comment]` 展开成整段审阅流程（`review.ts`），气泡里只画人敲的那一句。
 * - 写代码的会话不审自己：它填一份交接单、调 `review_session`，这里当场在同一个项目里开一个审阅会话（`ctx.sessions.launch`，
 *   `spawnedFrom` 记着这次调用），第一句是交接单（`brief.ts`），这一轮以 `terminate` 停下。人敲 `/review` 就是同意，不经卡片。
 *   开不出来时这次调用报错，模型当场知道。
 * - 审阅会话的第一轮开头（`prompt.submit`）：认出交接单，把流程正文接在它后面给模型（气泡里只有交接单），
 *   原会话在别的目录里跑（工作树）时把审阅会话也挪过去，未提交的改动只在那里。
 * - 只读：审阅会话和它派出的子会话写文件的调用一律拒绝（`tool.execute`），直到原会话答复了修哪几条——
 *   审阅会话的记录里有原会话寄来、带 `answer`（`replied`、`unreplied`）的信。命令不压只读沙箱，留给权限档：`verify` 要写缓存。
 * - 审阅会话第一轮之后真闲下来（问出去的有了答复、修完了），把最后那段回复（报告）交回原会话；被人停下的不交。
 * - 子会话（子 Agent、侧边聊天）里藏起 `review_session`、调到了也拒绝，它们在当前会话里跑整条流水线（正文第 0 步）。
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LaunchedSession, Message, Plugin, SessionScope, ToolKind } from "@plume/contract";
import { latestApprovedPlan, reviewPrompt, reviewRequest, sessionAddress } from "./brief.ts";
import { MESSAGES } from "./messages.ts";
import { REVIEW_ARGUMENT_HINT, REVIEW_BODY, REVIEW_SESSION_OPENING, reportText, reviewRequest as commandText } from "./review.ts";
import { REVIEW_SESSION, type ReviewSessionDetails } from "./types.ts";

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
function edits(name: string, kind: ToolKind | undefined, args: Record<string, unknown>): string | undefined {
	if (name === "lsp") return args.operation === "rename" ? "a rename edits files" : undefined;
	return kind === "create" || kind === "modify" ? "it edits files" : undefined;
}

// i18n-exempt：发给模型的工具结果。
function refusal(tool: string, why: string): string {
	return (
		`Review session: ${why}, so "${tool}" did not run. A review session reads until the conversation that wrote the ` +
		"change has said which findings to fix: finish the report, ask it with `ask_session` (step F) and end your turn. Once its answer arrives, edits are allowed."
	);
}

/** 审阅会话记着从哪个会话交过来、原会话当时在哪个目录。 */
interface Review {
	parentId: string;
	cwd: string;
}

export default {
	name: "plume.review",
	async apply(ctx) {
		const text = () => MESSAGES[ctx.locale()];
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
		ctx.sessions.onDeleted((sessionId) => {
			if (reviews.delete(sessionId)) save();
		});

		/** 这次调用受哪个审阅会话管：它自己，或派出它的那个（子 Agent）。 */
		function reviewOf(session: SessionScope): string | undefined {
			if (reviews.has(session.id)) return session.id;
			const parentId = session.kind === "child" ? session.parentId : undefined;
			return parentId && reviews.has(parentId) ? parentId : undefined;
		}

		/** 原会话答复了修哪几条：审阅会话的记录里有它寄来的答复（它自己回的，或那一轮收场时代答的）。没读到、关掉了不算——修什么还没定。 */
		async function fixesAllowed(reviewId: string): Promise<boolean> {
			const parentId = reviews.get(reviewId)?.parentId;
			const messages = await ctx.sessions.messages(reviewId).catch((): Message[] => []);
			return messages.some(
				(message) =>
					message.role === "user" &&
					(message.peer ?? []).some((letter) => letter.sessionId === parentId && (letter.answer === "replied" || letter.answer === "unreplied")),
			);
		}

		ctx.commands.provide({
			list: () => [{ name: "review", description: text().command, argumentHint: REVIEW_ARGUMENT_HINT }],
			expand: (_name, rest) => ({ text: commandText(rest), displayText: rest ? `/review ${rest}` : "/review" }),
		});

		ctx.hook("model.context", async (input, next) => {
			// 子会话和插件的独立会话都不是侧栏里那段对话，交不出审阅。
			if (input.session.kind !== "top") return next({ ...input, tools: input.tools.filter((tool) => tool.name !== REVIEW_SESSION) });
			return next(input);
		});

		ctx.hook("prompt.submit", async (input, next) => {
			const verdict = await next(input);
			if (verdict.block || !input.fresh || !input.text.startsWith(REVIEW_SESSION_OPENING)) return verdict;
			const review = pending.get(input.text);
			if (!review) return verdict;
			pending.delete(input.text);
			remember(input.sessionId, review);
			return {
				block: false,
				context: verdict.context ? `${verdict.context}\n\n${REVIEW_BODY}` : REVIEW_BODY,
				// 和原会话同一个目录：它在自己的工作树里时，未提交的改动只在那里。
				...(verdict.cwd !== undefined ? { cwd: verdict.cwd } : review.cwd !== input.cwd ? { cwd: review.cwd } : {}),
			};
		});

		ctx.hook("tool.execute", async (input, next) => {
			const why = edits(input.call.name, ctx.tools.list().find((tool) => tool.name === input.call.name)?.kind, input.call.args);
			if (!why) return next(input);
			const reviewId = reviewOf(input.session);
			if (!reviewId || (await fixesAllowed(reviewId))) return next(input);
			return { output: refusal(input.call.name, why), isError: true };
		});

		/** 第一轮之后真闲下来（问出去的有了答复、答复叫起的那一轮修完了），把报告交回原会话。被人停下的不交，出错、跑到上限的照样交，标成没跑完。 */
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
				const address = ctx.tools.names().includes("ask_session") ? sessionAddress(parent) : undefined;
				const prompt = reviewPrompt(request, latestApprovedPlan(messages), messages, parent.title, address, brief);
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
	},
} satisfies Plugin;
