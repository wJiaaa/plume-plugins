/**
 * plume.lsp 给人看的文字，两种界面语言写在一起。
 */

import type { Locale } from "@plume/contract";

const zhCN = {
	/** 转录里 `lsp` 那一行的动作：「查符号 parseConfig」。 */
	toolVerb: "查符号",
};

export const MESSAGES: Record<Locale, typeof zhCN> = {
	"zh-CN": zhCN,
	en: {
		toolVerb: "Looked up",
	},
};
