/**
 * 审阅插件的文字，两种界面语言写在一起。`brief` 那几项是写进 `review/intent.md` 的审阅背景里的话（按界面语言写，模型也读得懂），
 * 其余给人看；命令正文、工具说明在 `review.ts`、`index.ts`（英文，发给模型）。
 */

import type { Locale } from "@plume/contract";

const zhCN = {
	command: "派审阅子智能体审查改动或 PR，再决定修哪几条",
	writingBrief: "整理审阅背景",
	brief: {
		title: "审阅背景",
		intro: (title: string) =>
			`「${title}」这个对话写了这次改动，下面是它交给审阅者的前因后果。依据有先后：用户原话和决定最高，计划次之；实现说明、改动文件和未验证那几节是作者的自述，要对着代码核实，不能当作事实。`,
		story: "背景",
		decisions: "用户的决定与原话",
		decisionsByAuthor: "写代码的对话整理的决定与约束",
		userWords: "用户原话",
		plan: "计划原文",
		implementation: "实现说明（作者自述）",
		files: "改动文件",
		outOfScope: "不做的事",
		unverified: "未验证的地方",
		focus: "审阅重点",
		none: "未提供。",
		noPlan: "这个对话没有批准过计划。",
		wordsNote: "由运行时从对话记录里按时间顺序原样附上，不经模型转述；别的会话的消息、子智能体交回的结果这类不是人说的话不在其中。",
		wordsOmitted: (n: number) => `（中间省略了 ${n} 条）`,
	},
};

export type Messages = typeof zhCN;

export const MESSAGES: Record<Locale, Messages> = {
	"zh-CN": zhCN,
	en: {
		command: "Review changes or a PR with reviewer sub-agents, then decide what to fix",
		writingBrief: "Wrote the review brief",
		brief: {
			title: "Review brief",
			intro: (title: string) =>
				`The conversation “${title}” wrote this change; below is the background it handed to the reviewers. The sections are not equal: the person's own words and decisions come first, the plan second; the implementation notes, the file list and the unverified list are the author's own account — claims to check against the code, not facts.`,
			story: "Background",
			decisions: "The person's decisions and words",
			decisionsByAuthor: "Decisions and constraints, as the implementing conversation recorded them",
			userWords: "The person's messages",
			plan: "Approved plan",
			implementation: "Implementation (the author's account)",
			files: "Changed files",
			outOfScope: "Out of scope",
			unverified: "Unverified",
			focus: "Review focus",
			none: "Not given.",
			noPlan: "This conversation has no approved plan.",
			wordsNote:
				"Attached by the app from the conversation's record, in order and verbatim — not retold by the model. Messages from other conversations, sub-agent results and the like are not the person's words and are left out.",
			wordsOmitted: (n: number) => `(${n} messages omitted here)`,
		},
	},
};
