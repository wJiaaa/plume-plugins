/**
 * plume.followups 的逻辑入口，跑在 agent 进程：经 `model.context` 在系统提示词末尾加一段，教模型在一轮的
 * 最后一条回复末尾顺手写一句 `:followup[…]`（见 followups.ts）。读出来、画灰字、从回复里拿掉在界面入口。
 *
 * 只对侧栏里的会话（`session.kind` 是 top）加：子会话（侧边聊天、子 Agent）和插件的独立会话的输入框不画灰字，写了也没人看。
 * 不再按「这一端画不画得出界面」判断：Plume 只有桌面端，侧栏里的会话都有输入框可填。
 */

import type { Plugin } from "@plume/contract";
import { FOLLOWUPS_PROMPT } from "./followups.ts";

export default {
	name: "plume.followups",
	apply(ctx) {
		ctx.hook("model.context", async (input, next) => {
			if (input.session.kind !== "top") return next(input);
			return next({ ...input, sections: [...input.sections, { id: "followups", text: FOLLOWUPS_PROMPT }] });
		});
	},
} satisfies Plugin;
