/**
 * plume.followups 的界面入口，跑在渲染进程：最新那条回复末尾写的下一步建议当输入框的灰字（Tab 填入），
 * 回复正文和复制出去的字里拿掉标记。解析见 followups.ts。
 */

import type { UiPlugin } from "@plume/contract/ui";
import { nextFollowup, shownText } from "./followups.ts";

export default {
	name: "plume.followups",
	apply(ui) {
		// 正在生成时没有建议：这一轮还没说完，上一条回复的下一步已经不是下一步了。
		ui.composerHint((session) => (session.draft ? undefined : nextFollowup(session.messages)));
		ui.replyText(shownText);
	},
} satisfies UiPlugin;
