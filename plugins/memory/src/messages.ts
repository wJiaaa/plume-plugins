/**
 * 记忆插件给人看的文字，两种界面语言写在一起。设置分区用 @plume/ui 的 useI18n() 取当前语言，逻辑入口用 ctx.locale()。
 * 发给模型的（`learn` 的说明和结果、提示词里的段）不在这里，不随界面语言变。
 */

import type { Locale } from "@plume/contract";

const zhCN = {
	title: "记忆",
	intro: "设置在此电脑上如何收集、保留和整合本地记忆，跨会话保留开发习惯与核心决策。",
	clearMemory: "清除所有记忆",
	confirmClear: "确定要删除此电脑上保存的所有本地记忆吗？此操作不可撤销。",
	user: "用户记忆",
	userDetail: "根据此电脑上的聊天与工程任务沉淀关键记忆，并用于个性化此电脑上的后续会话",
	project: "项目记忆",
	projectDetail: "在后续对话中使用项目约定、决策与排障经验。关闭后停止读取和记录，保留已有记忆。",
	autoProject: "自动沉淀项目记忆",
	autoProjectDetail:
		"空闲时读最近几次对话（12 小时前到 30 天内），提炼这个仓库的约定和踩过的坑，写进项目记忆。会把那些对话内容发给你配置的模型；默认关闭，每天最多一次。",
	add: "添加记忆",
	addPlaceholder: "手动添加一条用户记忆（例如：习惯使用 bun 进行包管理，项目打包目标为 ES2024）...",
	deleteOne: "删除此条记忆",
	deleteExtracted: "丢弃这份抽取出来的记忆",
	forgetAllProject: "全部忘掉",
	confirmForgetAllProject: "忘掉这个项目记住的全部内容？抽取出来的那一份和每一条记录都会删掉，且不可撤销。",
	confirm: "删除",
	reading: "正在读取记忆...",
	empty: "暂无用户记忆",
	rememberedByProject: "项目记住的",
	projectLabel: "项目",
	projectMemoryEmpty: "这个项目还没有记住什么",
	appliesTo: (context: string) => `适用于：${context}`,
	source: {
		user: "手动添加",
		auto: "自动沉淀",
		session: "对话中记下",
		learn: "learn 工具",
		extracted: "后台抽取",
	},
	writtenAt: (when: string) => `${when}写下`,
	injectedAt: (when: string) => `最后注入 ${when}`,
	neverUsed: "还没进过提示词",
	passUpdated: (n: number) => `更新了这个项目的记忆，读了 ${n} 次会话`,
	/** 转录里 `learn` 那一行的动作。 */
	learn: "学习",
	emptyContent: "记忆内容不能为空",
	unreadable: (file: string, reason: string) => `记忆文件 ${file} 读不出来（${reason}），为免覆盖原有记忆，这次没有改动。修好或移走这个文件后再试。`,
	modelTitle: "记忆整理模型",
	modelDetail: "每天读一遍旧会话，更新项目记忆",
	followDefault: "跟随默认模型",
	byDefault: "默认",
};

export const MESSAGES: Record<Locale, typeof zhCN> = {
	"zh-CN": zhCN,
	en: {
		title: "Memory",
		intro: "How memory is gathered, kept and merged on this machine — so habits and decisions survive between conversations.",
		clearMemory: "Clear all memory",
		confirmClear: "Delete every local memory saved on this machine? This cannot be undone.",
		user: "User memory",
		userDetail: "Distils what matters from the chats and engineering work on this machine, and uses it to personalise later sessions here",
		project: "Project memory",
		projectDetail:
			"Uses the project's conventions, decisions and hard-won fixes in later conversations. Turning it off stops both reading and writing; what is already there stays.",
		autoProject: "Build project memory on its own",
		autoProjectDetail:
			"While idle, reads the recent conversations (from 12 hours to 30 days old), distils this repository's conventions and pitfalls, and writes them to project memory. Those conversations are sent to the model you configured. Off by default, at most once a day.",
		add: "Add a memory",
		addPlaceholder: "Add a memory by hand — for example: prefers bun for package management; builds target ES2024…",
		deleteOne: "Delete this memory",
		deleteExtracted: "Discard this extracted summary",
		forgetAllProject: "Forget all",
		confirmForgetAllProject: "Forget everything this project remembers? The extracted summary and every recorded lesson go. This cannot be undone.",
		confirm: "Delete",
		reading: "Reading memories…",
		empty: "No user memories yet",
		rememberedByProject: "Remembered for",
		projectLabel: "Project",
		projectMemoryEmpty: "Nothing remembered for this project yet",
		appliesTo: (context) => `Applies to: ${context}`,
		source: {
			user: "Added by hand",
			auto: "Gathered on its own",
			session: "Noted in a conversation",
			learn: "The learn tool",
			extracted: "Extracted in the background",
		},
		writtenAt: (when) => `written ${when}`,
		injectedAt: (when) => `last used ${when}`,
		neverUsed: "Never reached a prompt yet",
		passUpdated: (n) => `Updated this project's memory after reading ${n} ${n === 1 ? "conversation" : "conversations"}`,
		learn: "Learned",
		emptyContent: "A memory cannot be empty",
		unreadable: (file, reason) =>
			`The memory file ${file} could not be read (${reason}). Nothing was changed, so the memories in it are not overwritten. Fix or move the file, then try again.`,
		modelTitle: "Memory model",
		modelDetail: "Reads past sessions once a day to update project memory",
		followDefault: "Follow the default model",
		byDefault: "Default",
	},
};
