/** 每个渲染进程只订阅一次；面板关闭后仍接收工具和其他窗口的配色变更。 */
import type { Remote, UiContext } from "@plume/contract/ui";
import type { SkinStudioApi } from "./api.ts";
import { toSkin } from "./palette.ts";
import { COLOR_KEYS, type StudioView } from "./types.ts";

interface StudioState {
	view: StudioView | null;
	status: "loading" | "ready" | "error";
	error: unknown;
	actionError: unknown;
}

function cancelled(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "E_CANCELLED";
}

export function createStudioStore(ui: UiContext, api: Remote<SkinStudioApi>) {
	let state: StudioState = { view: null, status: "loading", error: null, actionError: null };
	const listeners = new Set<() => void>();
	const pending = new Set<{ cancel(): void }>();
	let stream: ReturnType<typeof api.watch> | undefined;
	let generation = 0;
	let disposed = false;
	let applied: string | undefined;

	const update = (value: Partial<StudioState>) => {
		state = { ...state, ...value };
		for (const listener of listeners) listener();
	};

	const start = () => {
		if (disposed) return;
		const own = ++generation;
		stream?.cancel();
		update({ status: "loading", error: null });
		const call = api.watch();
		stream = call;
		void (async () => {
			try {
				for await (const view of call) {
					if (disposed || own !== generation) return;
					const active = view.skins.find((skin) => skin.id === view.activeId);
					// 只保存作品不应重新注册皮肤，避免抢走其他皮肤插件的优先级。
					const key = active ? JSON.stringify([active.id, active.base, ...COLOR_KEYS.map((name) => active.colors[name])]) : "null";
					if (key !== applied) {
						ui.skin(active ? toSkin(active) : null);
						applied = key;
					}
					update({ view, status: "ready", error: null });
				}
				if (!disposed && own === generation) update({ status: "error", error: null });
			} catch (error) {
				if (!disposed && own === generation) update({ status: "error", error });
			}
		})();
	};

	/**
	 * 不锁界面：逻辑入口按顺序写库，连点几张卡片也只是依次切换，最后一次为准。
	 * 切换只要一次本地写盘，给整块面板盖一层忙碌态反而让每次点击都闪一下。
	 */
	const run = async (action: () => ReturnType<typeof api.apply>): Promise<boolean> => {
		if (disposed || state.status !== "ready") return false;
		if (state.actionError !== null) update({ actionError: null });
		let call: ReturnType<typeof api.apply> | undefined;
		try {
			call = action();
			pending.add(call);
			// 广播是唯一的数据来源，不让较晚返回的操作结果盖过更新的 watch 快照。
			await call;
			return !disposed;
		} catch (error) {
			if (!disposed && !cancelled(error)) update({ actionError: error });
			return false;
		} finally {
			if (call) pending.delete(call);
		}
	};

	return {
		get: () => state,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		start,
		active: () => !disposed,
		clearError() {
			if (!disposed && state.actionError !== null) update({ actionError: null });
		},
		run,
		/**
		 * 「系统外观」三个按钮就是外观页的主题卡片：先当场撤下工坊皮肤（皮肤接管深浅模式时宿主不让改主题），
		 * 再改应用的主题偏好，最后把库里的当前皮肤清掉、各窗口跟着撤下。
		 */
		chooseTheme(theme: "system" | "light" | "dark"): Promise<boolean> {
			if (disposed || state.status !== "ready") return Promise.resolve(false);
			if (applied !== "null") {
				ui.skin(null);
				applied = "null";
			}
			ui.setTheme(theme);
			return state.view?.activeId ? run(() => api.apply(null)) : Promise.resolve(true);
		},
		dispose() {
			disposed = true;
			generation++;
			stream?.cancel();
			for (const call of pending) call.cancel();
			pending.clear();
			listeners.clear();
		},
	};
}

export type StudioStore = ReturnType<typeof createStudioStore>;
