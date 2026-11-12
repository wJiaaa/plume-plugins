/**
 * plume.lsp 的界面入口：只登记 `lsp` 在转录里的说法。没有专用卡片，画法是宿主的通用卡片：
 * 行上说「查符号 parseConfig」，和读文件、搜索归成一类，连着做时并进同一段活。
 */

import type { UiPlugin } from "@plume/contract/ui";
import { MESSAGES } from "./messages.ts";

export default {
	name: "plume.lsp",
	apply(ui) {
		ui.toolLine("lsp", {
			verb: (locale) => MESSAGES[locale].toolVerb,
			// 有名字说名字，只给了行列的说文件。
			subject: (args) => [args.symbol, args.path].find((value): value is string => typeof value === "string" && value !== ""),
		});
	},
} satisfies UiPlugin;
