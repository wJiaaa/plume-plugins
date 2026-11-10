/**
 * plume.sessions 的界面入口：只登记五件工具在转录里的说法。没有专用卡片，画法是宿主的通用卡片。
 *
 * 和别的会话往来只是这段活里交代一句、问一句，归成一类（`group`），和读文件、跑命令接成一段，不单独一行把活切成好几截。
 */

import type { UiPlugin } from "@plume/contract/ui";
import { Megaphone, MessageCircleQuestionMark, MessagesSquare, Reply, ScrollText } from "@plume/ui/icons";
import { MESSAGES } from "./messages.ts";

/** 地址里的名字：`修登录 [a1b2c3]` 说成「修登录」，ref 是给模型认人的；只写了 ref 就说 ref。 */
function peerName(to: unknown): string | undefined {
	if (typeof to !== "string" || to.trim() === "") return undefined;
	const address = to.trim();
	return address.replace(/\s*\[[0-9a-f]{6,12}\]$/i, "") || address;
}

export default {
	name: "plume.sessions",
	apply(ui) {
		ui.toolLine("list_sessions", { verb: (locale) => MESSAGES[locale].listSessions, group: "peer", icon: MessagesSquare });
		ui.toolLine("read_session", { verb: (locale) => MESSAGES[locale].readSession, subject: (args) => peerName(args.to), group: "peer", icon: ScrollText });
		ui.toolLine("ask_session", {
			verb: (locale) => MESSAGES[locale].askSession,
			subject: (args) => peerName(args.to),
			group: "peer",
			icon: MessageCircleQuestionMark,
		});
		ui.toolLine("reply_session", { verb: (locale) => MESSAGES[locale].replySession, subject: (args) => peerName(args.to), group: "peer", icon: Reply });
		ui.toolLine("notify_session", { verb: (locale) => MESSAGES[locale].notifySession, subject: (args) => peerName(args.to), group: "peer", icon: Megaphone });
	},
} satisfies UiPlugin;
