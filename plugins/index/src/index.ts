/**
 * plume.index 的逻辑入口：`symbol` 工具，和设置页「索引库」用的接口。
 *
 * 索引按目录存在插件数据目录的 `index/` 下，文件清单向服务 `project.files` 要（git 忽略的不进）；
 * 每个会话在内存里留一份，会话删掉时丢掉。加载时顺手删掉目录已经不在了的索引。
 * 打开搜到的文件只在这里算出路径，交给系统打开由界面经 `ui.openPath` 做。
 */

import { isAbsolute, join, relative, sep } from "node:path";
import type { Plugin } from "@plume/contract";
import type { IndexApi } from "./api.ts";
import { symbolTool } from "./symbol-tool.ts";
import { buildIndex, indexStats, loadIndex, pruneIndexes, saveIndex, searchIndex, type SymbolIndex } from "./symbols.ts";

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
			async file(path, file) {
				const step = relative(path, join(path, file));
				if (!step || step === ".." || step.startsWith(`..${sep}`) || isAbsolute(step)) throw new Error(`not inside ${path}: ${file}`);
				return join(path, file);
			},
		};
		ctx.serve(api);
	},
} satisfies Plugin;
