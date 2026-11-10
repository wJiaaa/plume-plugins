/**
 * 界面这边手上的那份设置：设置分区、输入框按钮、浮层都读它，改动经逻辑入口写进文件。
 *
 * 一份共享的而不是各组件各读一次：设置分区里关掉「在输入框里显示截图按钮」，输入框里的相机要当场消失。
 */

import type { Remote, ScreenCapture } from "@plume/contract/ui";
import { useSyncExternalStore } from "react";
import { DEFAULT_SETTINGS, type ScreenshotApi, type ScreenshotSettings } from "./api.ts";

export type ShortcutStatus = "ok" | "taken" | "invalid";

export interface SettingsStore {
	get(): ScreenshotSettings;
	/** 全局快捷键上一次注册的结果。 */
	shortcutStatus(): ShortcutStatus;
	update(patch: Partial<ScreenshotSettings>): Promise<void>;
	subscribe(listener: () => void): () => void;
}

/** 关着截图或没设快捷键时放掉它：关掉的意义就是让别的截图工具拿得到这组键。 */
function accelerator(settings: ScreenshotSettings): string | null {
	return settings.enabled && settings.shortcut ? settings.shortcut : null;
}

/** `notify` 弹一条提示：快捷键没注册上、而且还没说过时用（见逻辑入口的 `shortcutNotice`）。 */
export function createSettingsStore(api: Remote<ScreenshotApi>, screen: ScreenCapture, notify: (message: string) => void): SettingsStore {
	let current = DEFAULT_SETTINGS;
	let status: ShortcutStatus = "ok";
	const listeners = new Set<() => void>();
	const emit = () => {
		for (const listener of listeners) listener();
	};

	async function applyShortcut(settings: ScreenshotSettings) {
		const shortcut = accelerator(settings);
		status = await screen.setShortcut(shortcut);
		emit();
		const notice = await api.shortcutNotice(status, shortcut);
		if (notice) notify(notice);
	}

	void api.settings().then((settings) => {
		current = settings;
		emit();
		return applyShortcut(settings);
	});

	return {
		get: () => current,
		shortcutStatus: () => status,
		async update(patch) {
			const before = accelerator(current);
			// 先改手上这份，开关当场跟着动；写文件慢一点没关系。
			current = { ...current, ...patch };
			emit();
			current = await api.update(patch);
			emit();
			if (accelerator(current) !== before) await applyShortcut(current);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

export function useSettings(store: SettingsStore): ScreenshotSettings {
	return useSyncExternalStore(store.subscribe, store.get);
}

export function useShortcutStatus(store: SettingsStore): ShortcutStatus {
	return useSyncExternalStore(store.subscribe, store.shortcutStatus);
}
