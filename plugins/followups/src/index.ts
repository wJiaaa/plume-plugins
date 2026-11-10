/**
 * plume.followups 的逻辑入口，跑在 agent 进程：经 `model.context` 在系统提示词末尾加一段，教模型在一轮的
 * 最后一条回复末尾顺手写一句 `:followup[…]`（见 followups.ts）。读出来、画灰字、从回复里拿掉在界面入口。
 *
 * 只对主会话加：子会话（侧边聊天、子 Agent）的回复不进用户的输入框，写了也没人看。
 * 不再按「这一端画不画得出界面」判断：Plume 只有桌面端，主会话都有输入框可填。
 */

import type { Plugin } from "@plume/contract";
import { FOLLOWUPS_PROMPT } from "./followups.ts";

export default {
	name: "plume.followups",
	apply(ctx) {
		// 一个会话是不是子会话建好就定了，按 sessionId 记下，不用每次请求都列一遍全部会话。
		const isChild = new Map<string, boolean>();
		ctx.sessions.onDeleted((sessionId) => isChild.delete(sessionId));

		async function childSession(sessionId: string): Promise<boolean> {
			const known = isChild.get(sessionId);
			if (known !== undefined) return known;
			const summary = (await ctx.sessions.list()).find((session) => session.id === sessionId);
			// 列表里还没有的不记：下一次请求再看。
			if (!summary) return false;
			const child = Boolean(summary.parentId);
			isChild.set(sessionId, child);
			return child;
		}

		ctx.hook("model.context", async (input, next) => {
			if (await childSession(input.sessionId)) return next(input);
			return next({ ...input, sections: [...input.sections, { id: "followups", text: FOLLOWUPS_PROMPT }] });
		});
	},
} satisfies Plugin;
