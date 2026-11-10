/**
 * 设置页「钩子」正在看的那个项目，null 是用户级。放在组件外面：输入框上方那一行的「去审核」先把它切到会话的项目，再打开设置页。
 * 活在这次运行里，离开设置页再回来还停在上次看的那个。
 */

let current: string | null = null;
const listeners = new Set<() => void>();

export const hooksProject = {
	get: (): string | null => current,
	set(path: string | null): void {
		if (path === current) return;
		current = path;
		for (const listener of listeners) listener();
	},
	subscribe(listener: () => void): () => void {
		listeners.add(listener);
		return () => void listeners.delete(listener);
	},
};

/**
 * 设置页刚改过钩子（信任、开关、增删）。对话那一屏在设置页开着时并不卸下，输入框上方的待审核提示靠它知道该重读，
 * 而不是等窗口重新拿到焦点。
 */
const changeListeners = new Set<() => void>();

export const hooksChanged = {
	emit(): void {
		for (const listener of changeListeners) listener();
	},
	subscribe(listener: () => void): () => void {
		changeListeners.add(listener);
		return () => void changeListeners.delete(listener);
	},
};
