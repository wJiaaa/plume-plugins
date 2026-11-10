/**
 * plume.scheduled 的逻辑入口：定时任务的列表存在插件数据目录里（见 store.ts），经 ctx.serve 开给页面读写；
 * 插件开着就一直按时检查，到点的任务开新会话跑（见 scheduler.ts）。
 */

import type { Plugin } from "@plume/contract";
import type { ScheduledApi } from "./api.ts";
import { MESSAGES } from "./messages.ts";
import { createScheduler, FIRST_TICK_MS, TICK_MS } from "./scheduler.ts";
import { createTaskStore } from "./store.ts";

export default {
	name: "plume.scheduled",
	apply(ctx) {
		const store = createTaskStore(ctx.dataDir, () => scheduler.changed());
		const scheduler = createScheduler({ store, launch: (options) => ctx.sessions.launch(options), text: () => MESSAGES[ctx.locale()] });
		const tick = () =>
			void scheduler.tick().catch((error: unknown) => ctx.log.error(`检查定时任务失败：${error instanceof Error ? error.message : String(error)}`));
		const first = setTimeout(tick, FIRST_TICK_MS);
		const timer = setInterval(tick, TICK_MS);
		ctx.effect(() => {
			clearTimeout(first);
			clearInterval(timer);
		});
		ctx.serve({
			list: () => store.list(),
			add: (task) => store.add(task),
			update: (id, patch) => store.update(id, patch),
			remove: (id) => store.remove(id),
			runNow: (id) => scheduler.runNow(id),
			markSeen: () => scheduler.markSeen(),
			watch: (call) => scheduler.watch(call),
		} satisfies ScheduledApi);
	},
} satisfies Plugin;
