/**
 * `learn`：记下下次还用得上的东西。
 *
 * 难的不是存一个字符串，是让模型为对的东西调它——要紧的失败不是不记，是一文件会过期的事实。「parseFrontmatter 在 skills/loader.ts 里」
 * 今天是真的，从此进这个项目的每一次请求，下次重构以后悄悄变成错的。**记忆里一条过时的事实比没有更糟，因为模型会照着做。**
 * 所以说明的大半篇幅在说不要记什么；留下的标准是读代码能不能知道：能的话，代码就是记录。
 */

import type { ToolDefinition, ToolOutput } from "@plume/contract";
import { MAX_LESSON_CHARS, recordLesson } from "./project-memory.ts";

export interface LearnOptions {
	/** 现在项目记忆开着没有：执行时才读，设置里刚关掉的也拦得住。 */
	enabled(): boolean;
	/** 这个工作目录的记忆目录，写之前确保它登记了是哪个目录。 */
	projectDir(cwd: string): Promise<string>;
}

const error = (output: string): ToolOutput => ({ output, isError: true });

export function learnTool(options: LearnOptions): ToolDefinition {
	return {
		name: "learn",
		description:
			"Record a lesson about this project for future sessions; it is injected into the prompt from the next session on.\n\n" +
			"Record: a correction from the user that will apply again in this repository; a convention the code does not show (the build command, why something is done an odd way); " +
			"a trap you fell into and would fall into again.\n\n" +
			"Do NOT record: where code lives, what a function is called or what a file contains — reading the code answers those, and such notes go stale silently; " +
			"anything specific to this one task; anything already in the git history. A stale entry is worse than a missing one, because it will be believed.",
		parameters: {
			type: "object",
			properties: {
				lesson: { type: "string", description: "The lesson. One or two sentences, specific and actionable." },
				context: { type: "string", description: "When it applies, if that is not obvious. Optional." },
			},
			required: ["lesson"],
			additionalProperties: false,
		},
		async execute(args, run) {
			if (!options.enabled()) return error("Project memory is disabled in settings.");
			const { lesson, context } = args;
			if (typeof lesson !== "string" || !lesson.trim()) return error("`lesson` is required.");
			if (lesson.length > MAX_LESSON_CHARS) return error(`\`lesson\` is ${lesson.length} characters; the limit is ${MAX_LESSON_CHARS}. Say it more briefly.`);
			try {
				const { action, total } = await recordLesson(await options.projectDir(run.cwd), { text: lesson, ...(typeof context === "string" ? { context } : {}) });
				// 「记下了」和「你早就知道了」是两个答案，后者成立时说成前者，模型会一直写同一句话的变体。
				// i18n-exempt：交给模型的工具结果。
				const verb = action === "merged" ? "已经记过类似的，这次把它更新了" : "记下了";
				// i18n-exempt：交给模型的工具结果。
				return { output: `${verb}。这个项目现在有 ${total} 条。**从下一个会话开始生效**——这一轮不重建提示词。`, details: { kind: "learn", action, total } };
			} catch (cause) {
				return error(`Could not record it: ${cause instanceof Error ? cause.message : String(cause)}`);
			}
		},
	};
}
