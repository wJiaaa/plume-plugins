/** plume.sessions 给人看的文字：三件工具在转录里的说法和消息的回执，两种界面语言写在一起。工具结果是发给模型的，不在这里。 */

import type { Locale } from "@plume/contract";

const zhCN = {
	listSessions: "查看在跑的会话",
	readSession: "查看会话记录",
	sendMessage: "发消息给",
	queued: "排队中",
	delivered: "已送达",
	replied: "已回复",
	undelivered: "未送达",
	undeliveredDropped: "钩子拦下了这次送达，对方没读到",
	undeliveredClosed: "对方会话已经不在了",
	openSession: "打开这个会话",
};

export const MESSAGES: Record<Locale, typeof zhCN> = {
	"zh-CN": zhCN,
	en: {
		listSessions: "Listed running sessions",
		readSession: "Read session",
		sendMessage: "Messaged",
		queued: "Queued",
		delivered: "Delivered",
		replied: "Replied",
		undelivered: "Not delivered",
		undeliveredDropped: "A hook stopped this message before the other chat read it",
		undeliveredClosed: "The other chat is gone",
		openSession: "Open this chat",
	},
};
