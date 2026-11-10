/**
 * plume.usage 的逻辑入口。花销由宿主在每次计费的调用时记下（会话库的花销表），这里只把读数转给界面入口：
 * 界面入口跑在渲染进程，读不到 agent 进程里的库。
 */

import type { Plugin } from "@plume/contract";
import type { UsageApi } from "./api.ts";

export default {
	name: "plume.usage",
	apply(ctx) {
		ctx.serve({ scan: () => ctx.model.usage() } satisfies UsageApi);
	},
} satisfies Plugin;
