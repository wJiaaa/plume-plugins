/**
 * plume.review 的逻辑入口：`/review`，和它要的审阅背景。
 *
 * - `/review [目标] [--effort …] [--comment]` 展开成整段审阅流程（`review.ts`），气泡里只画人敲的那一句。流程在当前对话里跑：
 *   找问题、复核交给子智能体（别的插件的工具，按类别 `delegate` 现找），这个对话合并、决定修哪几条、自己修。
 * - `review_brief`：对话把前因后果填成几个必填字段，这里连同用户原话（从记录里取）和批准过的计划（向服务 `session.plan`，
 *   内置插件 plume.plan 提供）原样排成 `review/intent.md`，写进这个会话的临时目录，子智能体按绝对路径读。原话和计划不经模型转述。
 * - 子会话（子 Agent、侧边聊天）和插件的独立会话里藏起 `review_brief`、调到了也拒绝：正文第 0 步按有没有它分流。
 *   一个会话是哪种在它开出来时就定了，工具表在会话里不变，前缀缓存留得住。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "@plume/contract";
import { reviewHandoff, reviewIntent } from "./brief.ts";
import { MESSAGES } from "./messages.ts";
import { type BodyTools, REVIEW_ARGUMENT_HINT, reviewRequest } from "./review.ts";
import { REVIEW_BRIEF } from "./types.ts";

// i18n-exempt：工具说明、参数和结果是发给模型的话。
const DESCRIPTION =
	"Write the review brief to review/intent.md for the reviewer sub-agents: why the change was made, the person's decisions, what you did. Use only as step 3 of the `/review` instructions says.";

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
	},
	additionalProperties: false,
} as const;

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

		ctx.commands.provide({
			list: () => [{ name: "review", description: text().command, argumentHint: REVIEW_ARGUMENT_HINT }],
			expand: (_name, rest) => ({ text: reviewRequest(rest, bodyTools()), displayText: rest ? `/review ${rest}` : "/review" }),
		});

		ctx.hook("model.context", async (input, next) =>
			input.session.kind === "top" ? next(input) : next({ ...input, tools: input.tools.filter((tool) => tool.name !== REVIEW_BRIEF) }),
		);

		ctx.tools.register({
			name: REVIEW_BRIEF,
			description: DESCRIPTION,
			parameters: PARAMETERS,
			async execute(args, run) {
				const self = run.session.kind === "top" ? await ctx.sessions.get(run.sessionId) : undefined;
				// i18n-exempt：发给模型的话。
				if (!self) return { output: "Only the conversation itself has a brief to write; follow step 0 of the `/review` instructions.", isError: true };
				const handoff = reviewHandoff(args);
				if ("error" in handoff) return { output: handoff.error, isError: true };
				const [plan, messages] = await Promise.all([plans.approved(self.id), ctx.sessions.messages(self.id)]);
				const path = join(run.scratchDir, "review", "intent.md");
				await mkdir(join(run.scratchDir, "review"), { recursive: true });
				await writeFile(path, reviewIntent(handoff, plan, messages, self.title, text().brief));
				// i18n-exempt：发给模型的话。
				return { output: `Wrote ${path}, with the person's messages and the approved plan attached verbatim. Give this path to every finder and checker.` };
			},
		});
	},
} satisfies Plugin;
