/**
 * plume.screenshot 的逻辑入口：截图设置存在插件数据目录的 `settings.json` 里，写截图文件、查窗口列表也在这边做，
 * 经 ctx.serve 开给界面入口（界面入口跑在浏览器里，碰不到文件和子进程）。
 *
 * 拍屏幕、开浮层、剪贴板、全局快捷键是宿主的事（界面入口经 `ui.screen` 用），这里不管。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Locale, Plugin } from "@plume/contract";
import { DEFAULT_SETTINGS, type ScreenshotApi, type ScreenshotSettings } from "./api.ts";
import { MESSAGES } from "./messages.ts";
import { listWindows } from "./windows.ts";

/** `~` 开头的路径按用户目录展开：设置里手填的目录常这么写。 */
function expandHome(path: string): string {
	return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

/** 和 macOS 自带截图一样的文件名，按时间排得开。 */
function screenshotFilename(): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `Screenshot ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} at ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}.png`;
}

function createApi(dataDir: string, locale: () => Locale): ScreenshotApi {
	const file = join(dataDir, "settings.json");
	/*
	 * 上一次说过的失败，`状态:快捷键`。没注册上的快捷键要明说：设置页里写着 Alt+A，按了却没反应，而 Windows 上
	 * Alt+A 正是微信的截图键。但只说一次：每个窗口的界面入口都注册一遍，改别的设置也会重注册，各窗口自己记的话
	 * 每开一个窗口就弹一次，所以记在两边共用的逻辑入口。注册上了或放掉以后再失败，又算新的。
	 */
	let announced: string | null = null;
	// 写一个接一个排队：设置页连着改两项时，后一次读到的是前一次写完的结果。
	let queue: Promise<unknown> = Promise.resolve();

	async function read(): Promise<ScreenshotSettings> {
		let text: string;
		try {
			text = await readFile(file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_SETTINGS };
			throw error;
		}
		return { ...DEFAULT_SETTINGS, ...(JSON.parse(text) as Partial<ScreenshotSettings>) };
	}

	return {
		settings: () => queue.then(read),
		update(patch) {
			const next = queue.then(async () => {
				const settings = { ...(await read()), ...patch };
				// 先写临时文件再改名：写到一半退出不会留下半个文件。
				await writeFile(`${file}.tmp`, JSON.stringify(settings, null, "\t"));
				await rename(`${file}.tmp`, file);
				return settings;
			});
			queue = next.catch(() => undefined);
			return next;
		},
		listWindows,
		async save(png, directory) {
			const dir = expandHome(directory);
			const path = join(dir, screenshotFilename());
			await mkdir(dir, { recursive: true });
			await writeFile(path, Buffer.from(png.replace(/^data:image\/\w+;base64,/, ""), "base64"));
			return path;
		},
		async shortcutNotice(status, shortcut) {
			if (status === "ok" || !shortcut) {
				announced = null;
				return null;
			}
			if (announced === `${status}:${shortcut}`) return null;
			announced = `${status}:${shortcut}`;
			const text = MESSAGES[locale()];
			return (status === "taken" ? text.shortcutTakenNotice : text.shortcutInvalidNotice).replace("{shortcut}", shortcut);
		},
	};
}

export default {
	name: "plume.screenshot",
	apply(ctx) {
		ctx.serve(createApi(ctx.dataDir, () => ctx.locale()));
	},
} satisfies Plugin;
