/** 会话摘要插件给人看的文字，两种界面语言写在一起。 */

import type { Locale } from "@plume/contract";

const zhCN = {
	section: "摘要",
	justNow: "刚刚更新",
	updated: (ago: string) => `${ago}更新`,
	afterTurn: "有新消息，这一轮结束后更新",
	updating: "有新消息，稍后更新",
	failed: "摘要没生成出来",
	retry: "重试",
	modelTitle: "会话摘要模型",
	modelDetail: "环境卡片里那段会话摘要",
	followMain: "跟随主会话",
	followMainShort: "随主会话",
};

export const MESSAGES: Record<Locale, typeof zhCN> = {
	"zh-CN": zhCN,
	en: {
		section: "Summary",
		justNow: "Updated just now",
		updated: (ago: string) => `Updated ${ago}`,
		afterTurn: "New messages; updates after this turn",
		updating: "New messages; updating shortly",
		failed: "Couldn't generate the summary",
		retry: "Retry",
		modelTitle: "Session summary model",
		modelDetail: "The session summary in the environment card",
		followMain: "Follow the main session",
		followMainShort: "As the session",
	},
};
