/**
 * 逻辑入口经 ctx.serve 开给界面的接口，两个入口共用这一份类型。
 *
 * 设置存在逻辑入口那边（插件数据目录），写文件、查窗口列表也在那边：界面入口跑在浏览器里，没有 Node。
 */

export interface ScreenshotSettings {
	/** 关掉时连全局快捷键一起放掉，别的截图工具才拿得到它。 */
	enabled: boolean;
	/** 全局快捷键，Electron accelerator 的写法；空串是不要快捷键。 */
	shortcut: string;
	/** 每次完成都留一份文件的目录；空串是不留文件（只进剪贴板）。 */
	saveLocation: string;
	/** 工具栏「下载」存到哪；空串是系统桌面——下载就是要一个文件，空着不能等于不存。 */
	downloadLocation: string;
	/** 输入框左边常驻一个相机按钮。 */
	showInComposer: boolean;
	/** 完成时把图放进剪贴板。 */
	copyToClipboard: boolean;
	insertIntoComposer: boolean;
	openEditor: boolean;
}

export const DEFAULT_SETTINGS: ScreenshotSettings = {
	enabled: true,
	shortcut: "Alt+A",
	saveLocation: "",
	downloadLocation: "",
	showInComposer: false,
	copyToClipboard: true,
	insertIntoComposer: false,
	openEditor: true,
};

/** 屏幕上的一个窗口，坐标已经换成浮层自己的（相对那块屏幕的左上角）。 */
export interface WindowRect {
	x: number;
	y: number;
	width: number;
	height: number;
	/** 窗口属于哪个程序。 */
	app: string;
}

export interface ScreenshotApi {
	settings(): Promise<ScreenshotSettings>;
	/** 改几项，返回改完的整份。 */
	update(patch: Partial<ScreenshotSettings>): Promise<ScreenshotSettings>;
	/** 屏幕上的窗口，从前到后；`display` 是浮层盖住的那块屏幕（全局坐标）。查不到是空数组，不报错。 */
	listWindows(display: { x: number; y: number; width: number; height: number }): Promise<WindowRect[]>;
	/** 把 PNG（data URL）写进 `directory`，文件名按时间取；返回写到的路径。 */
	save(png: string, directory: string): Promise<string>;
	/**
	 * 全局快捷键注册完把结果报过来：是还没说过的失败（被占了、写法不认识）就返回要弹给人的话，否则 null。
	 * `shortcut` 是这次注册的组合，放掉快捷键时为 null。
	 */
	shortcutNotice(status: "ok" | "taken" | "invalid", shortcut: string | null): Promise<string | null>;
}
