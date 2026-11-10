/**
 * 界面入口这边手上的那份状态：插件一装上就连着逻辑入口的 `watch`，页面、输入框上方那一行、侧栏的数目都读这一份。
 *
 * 一直连着，不等有人看：侧栏的数目不在任何组件里，没人打开页面时也得跟上失败。
 */

import type { Remote } from "@plume/contract/ui";
import type { ScheduledApi, ScheduledState } from "./api.ts";

export interface ScheduledClient {
	/** 还没连上时为 null。 */
	get(): ScheduledState | null;
	subscribe(listener: () => void): () => void;
	/** 页面下次打开时要滚进视野、亮一下的那张卡片（「查看」点的那个任务、刚新建的那个）。 */
	focus: string | null;
}

export function connectScheduled(api: Remote<ScheduledApi>, onState: (state: ScheduledState) => void): ScheduledClient {
	let state: ScheduledState | null = null;
	const listeners = new Set<() => void>();
	void (async () => {
		try {
			for await (const next of api.watch()) {
				state = next;
				onState(next);
				for (const listener of listeners) listener();
			}
		} catch (error) {
			// 逻辑入口停了：插件重新加载时界面入口也会重来，到时重新连上。
			console.error("[plume.scheduled] 定时任务的状态断了：", error);
		}
	})();
	return {
		get: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		focus: null,
	};
}
