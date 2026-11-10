/**
 * plume.index 给人看的文字（设置页「索引库」），两种界面语言写在一起；界面入口用 @plume/ui 的 useI18n() 取当前语言。
 */

import type { Locale } from "@plume/contract";

const zhCN = {
	title: "索引库",
	/** 转录里 `symbol` 那一行的动作：「查找符号 runAgent」。 */
	toolVerb: "查找符号",
	/** 页头下的一句介绍：`{strong}` 画成加粗的 `definitions`，`{tool}` 画成等宽的工具名；位置由译文定。 */
	intro: "索引记录函数、类、接口、类型和常量的{strong}，Agent 用 {tool} 工具查它。",
	definitions: "定义位置",
	status: "状态",
	project: "项目",
	building: "构建中…",
	rebuild: "重建",
	build: "建立索引",
	symbols: "符号数",
	files: "已索引文件",
	size: "索引大小",
	lastBuilt: "上次构建",
	never: "从未",
	trySearch: "试搜",
	searchPlaceholder: "输入符号名，例如 runAgent",
	tooShort: "输入至少两个字符",
	noSymbols: "没有匹配的符号",
	buildFirst: "先建立索引",
	noProjects: "还没有项目",
	loadFailed: (reason: string) => `读不出索引：${reason}`,
	rebuildFailed: (reason: string) => `建立索引失败：${reason}`,
	openFailed: (reason: string) => `打不开文件：${reason}`,
};

export const MESSAGES: Record<Locale, typeof zhCN> = {
	"zh-CN": zhCN,
	en: {
		title: "Index",
		toolVerb: "Looked up symbols",
		intro: "The index records, for functions, classes, interfaces, types and constants, their {strong} — the agent looks it up with the {tool} tool.",
		definitions: "where things are defined",
		status: "Status",
		project: "Project",
		building: "Building…",
		rebuild: "Rebuild",
		build: "Build the index",
		symbols: "Symbols",
		files: "Files indexed",
		size: "Index size",
		lastBuilt: "Last built",
		never: "Never",
		trySearch: "Try a search",
		searchPlaceholder: "Type a symbol name, for example runAgent",
		tooShort: "Type at least two characters",
		noSymbols: "No symbols match",
		buildFirst: "Build the index first",
		noProjects: "No projects yet",
		loadFailed: (reason: string) => `Couldn't read the index: ${reason}`,
		rebuildFailed: (reason: string) => `Couldn't build the index: ${reason}`,
		openFailed: (reason: string) => `Couldn't open the file: ${reason}`,
	},
};
