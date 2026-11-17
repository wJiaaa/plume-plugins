/**
 * plume.magpie 给人看的文字，两种界面语言写在一起；逻辑入口用 ctx.locale() 取当前语言。
 */

import type { Locale } from "@plume/contract";

const zhCN = {
	/** 设置页改、删 Magpie 供应商时读不了它的文件，显示在编辑器上。 */
	unreadable: (path: string) => `读不了 ${path}，这次修改没有保存`,
};

export const MESSAGES: Record<Locale, typeof zhCN> = {
	"zh-CN": zhCN,
	en: {
		unreadable: (path) => `Couldn't read ${path}, so this change wasn't saved`,
	},
};
