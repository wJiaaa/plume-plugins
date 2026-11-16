/**
 * plume.review 的界面入口：`review_brief` 在转录里画成一行「整理审阅背景」。派出去的审阅子智能体由子智能体插件画在对话和
 * 「子 Agent」面板里，这里不另画。
 */

import type { UiPlugin } from "@plume/contract/ui";
import { FileSearch } from "@plume/ui/icons";
import { MESSAGES } from "./messages.ts";
import { REVIEW_BRIEF } from "./types.ts";

export default {
	name: "plume.review",
	apply(context) {
		context.toolLine(REVIEW_BRIEF, { verb: (locale) => MESSAGES[locale].writingBrief, icon: FileSearch });
	},
} satisfies UiPlugin;
