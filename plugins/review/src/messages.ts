/**
 * 审阅插件的文字，两种界面语言写在一起。`brief` 那几项是交给审阅会话的交接单里的话（按界面语言写，模型也读得懂），
 * 其余给人看；命令正文、工具说明在 `review.ts`、`index.ts`（英文，发给模型）。
 */

import type { Locale } from "@plume/contract";

const zhCN = {
	command: "在只读会话里审查改动或 PR，报告交回这里修",
	handingOff: "交给审阅会话",
	askingImplementer: "问原会话修哪几条",
	reviewSession: "审阅会话",
	failedMark: "没跑完",
	brief: {
		sessionTitle: (title: string) => `审阅 · ${title}`,
		localChanges: "本地改动",
		brief: (title: string) =>
			`你是审阅会话：「${title}」那个对话写了这次改动，把审阅交给了你。先只审：原会话答复修哪几条之前不改任何文件，任何时候都不提交，最后交一份报告。下面按顺序交代前因后果，不用去猜。依据有先后：用户原话和决定最高，计划次之；实现说明、改动文件和未验证那几节是作者的自述，要对着代码核实，不能当作事实。`,
		role: "你是谁、做什么",
		story: "背景",
		decisions: "用户的决定与原话",
		decisionsByAuthor: "原会话整理的决定与约束",
		userWords: "用户原话",
		plan: "计划原文",
		implementation: "实现说明（作者自述）",
		files: "改动文件",
		outOfScope: "不做的事",
		unverified: "未验证的地方",
		focus: "审阅重点",
		target: "目标与力度",
		deliver: "交付",
		none: "未提供。",
		noPlan: "原会话没有批准过计划。",
		wordsNote: "由运行时从原会话记录里按时间顺序原样附上，不经模型转述；交回的报告、别的会话的消息这类不是人说的话不在其中。",
		wordsOmitted: (n: number) => `（中间省略了 ${n} 条）`,
		pipeline:
			"照下面 `/review` 说明第 0 步的第 1 条走：第 1 到 6 步，按上面的力度派子智能体并核实；以上各节就是意图对照（E）的依据，派子智能体时把相关的背景和约束写进它们的提示词。",
		deliverText: (title: string, tool: string) =>
			`审完先照第 F 步用 \`${tool}\` 问「${title}」修哪几条。问完就结束这一轮，它的答复会作为一条消息送回来、开始下一轮；答复之前不改任何文件，它点名的才修。最后一条回复是第 6 步的报告加上第 F 步那几节，不提议再修，不在末尾提问，会原样交回「${title}」。`,
	},
};

export type Messages = typeof zhCN;

export const MESSAGES: Record<Locale, Messages> = {
	"zh-CN": zhCN,
	en: {
		command: "Review changes or a PR in a read-only session; the report comes back here to fix",
		handingOff: "Handed off the review",
		askingImplementer: "Asked which findings to fix",
		reviewSession: "Review chat",
		failedMark: "Unfinished",
		brief: {
			sessionTitle: (title: string) => `Review · ${title}`,
			localChanges: "local changes",
			brief: (title: string) =>
				`You are the review session: the conversation “${title}” wrote this change and handed its review to you. Review first: change no files until that conversation has said which findings to fix, commit nothing at any point, and end with a report. The sections below give the background in order, so there is nothing to guess. They are not equal: the person's own words and decisions come first, the plan second; the implementation notes, the file list and the unverified list are the author's own account — claims to check against the code, not facts.`,
			role: "Who you are and what to do",
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
			target: "Target and effort",
			deliver: "What to deliver",
			none: "Not given.",
			noPlan: "The implementing conversation has no approved plan.",
			wordsNote:
				"Attached by the app from the implementing conversation's record, in order and verbatim — not retold by the model. Reports, messages from other conversations and the like are not the person's words and are left out.",
			wordsOmitted: (n: number) => `(${n} messages omitted here)`,
			pipeline:
				"Follow case 1 of step 0 in the `/review` instructions below: steps 1 to 6, dispatching and verifying at the effort above. The sections above are what dimension E checks against; when you dispatch sub-agents, put the background and constraints that bear on their task into their prompts.",
			deliverText: (title: string, tool: string) =>
				`When the review is done, ask “${title}” which findings to fix with \`${tool}\`, as step F says. Then end your turn: its answer arrives as a message and starts the next one. Change no file before it answers, and fix only what it names. Your last reply is the step 6 report with step F's sections — no offer to fix more, no question at the end. It goes back as it stands to “${title}”.`,
		},
	},
};
