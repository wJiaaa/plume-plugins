/**
 * plume.index 的逻辑入口：`symbol` 工具，和设置页「索引库」用的接口。
 *
 * 索引按目录存在插件数据目录的 `index/` 下，文件清单向服务 `project.files` 要（git 忽略的不进）；
 * 每个会话在内存里留一份，会话删掉时丢掉。加载时顺手删掉目录已经不在了的索引。
 */

import { execFile } from "node:child_process";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Plugin } from "@plume/contract";
import type { IndexApi } from "./api.ts";
import { symbolTool } from "./symbol-tool.ts";
import { buildIndex, indexStats, loadIndex, pruneIndexes, saveIndex, searchIndex, type SymbolIndex } from "./symbols.ts";

/**
 * 用系统的默认程序打开。Windows 上交给 explorer，不经 cmd 的 `start`：文件名里的 `&` 会被它当成命令分隔符。explorer
 * 打开成功也报退出码 1，所以那边只看起没起得来。
 */
function openWithDefaultApp(path: string): Promise<void> {
	const [command, args] = process.platform === "darwin" ? ["open", [path]] : process.platform === "win32" ? ["explorer.exe", [path]] : ["xdg-open", [path]];
	return new Promise((resolve, reject) =>
		execFile(command as string, args as string[], (error) =>
			error && (process.platform !== "win32" || typeof error.code !== "number") ? reject(error) : resolve(),
		),
	);
}

export default {
	name: "plume.index",
	inject: ["project.files"],
	apply(ctx) {
		const root = join(ctx.dataDir, "index");
		const files = ctx.use("project.files");
		const listFiles = (dir: string) => files.list(dir);
		const cache = new Map<string, SymbolIndex>();

		ctx.tools.register(symbolTool({ root, listFiles, cache }));
		ctx.sessions.onDeleted((sessionId) => {
			cache.delete(sessionId);
		});
		// i18n-exempt：日志
		void pruneIndexes(root).catch((error: unknown) => ctx.log.warn(`清理索引失败：${error instanceof Error ? error.message : String(error)}`));

		const api: IndexApi = {
			stats: (path) => indexStats(root, path),
			async rebuild(path) {
				await saveIndex(root, await buildIndex(path, listFiles));
				// 开着的会话留着一份旧的；丢掉，下一次查就用重建的。
				for (const [sessionId, index] of cache) if (index.cwd === path) cache.delete(sessionId);
				return indexStats(root, path);
			},
			async search(path, query) {
				const index = (await loadIndex(root, path)) ?? (await buildIndex(path, listFiles));
				return searchIndex(index, query, undefined, 50).map(({ name, kind, file, line }) => ({ name, kind, file, line }));
			},
			async open(path, file) {
				const step = relative(path, join(path, file));
				if (!step || step === ".." || step.startsWith(`..${sep}`) || isAbsolute(step)) throw new Error(`not inside ${path}: ${file}`);
				await openWithDefaultApp(join(path, file));
			},
		};
		ctx.serve(api);
	},
} satisfies Plugin;
