/** 每个渲染进程只订阅一次；面板关闭后仍接收工具和其他窗口的配色变更。 */
import type { Remote, UiContext } from "@plume/contract/ui";
import type { SkinStudioApi } from "./api.ts";
import { toSkin } from "./palette.ts";
import { COLOR_KEYS, defaultMode, type StudioView } from "./types.ts";

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
					const mode = defaultMode(view.activeId);
					// 只保存作品不应重新注册皮肤，避免抢走其他皮肤插件的优先级。
					const key = active ? JSON.stringify([active.id, active.base, ...COLOR_KEYS.map((name) => active.colors[name])]) : (view.activeId ?? "null");
					if (key !== applied) {
						ui.skin(active ? toSkin(active) : mode ? { name: "Plume", mode } : null);
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
		/**
		 * 不锁界面：逻辑入口按顺序写库，连点几张卡片也只是依次切换，最后一次为准。
		 * 切换只要一次本地写盘，给整块面板盖一层忙碌态反而让每次点击都闪一下。
		 */
		async run(action: () => ReturnType<typeof api.apply>): Promise<boolean> {
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
