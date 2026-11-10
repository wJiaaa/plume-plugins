/** plume.sessions 给人看的文字：五件工具在转录里的说法，两种界面语言写在一起。工具结果是发给模型的，不在这里。 */

import type { Locale } from "@plume/contract";

const zhCN = {
	listSessions: "查看在跑的会话",
	readSession: "查看会话记录",
	askSession: "询问会话",
	replySession: "回复会话",
	notifySession: "通知会话",
};

export const MESSAGES: Record<Locale, typeof zhCN> = {
	"zh-CN": zhCN,
	en: {
		listSessions: "Listed running sessions",
		readSession: "Read session",
		askSession: "Asked session",
		replySession: "Replied to session",
		notifySession: "Notified session",
	},
};
