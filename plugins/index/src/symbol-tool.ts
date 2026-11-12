/**
 * `symbol` 工具：查一个符号定义在哪个文件哪一行。
 *
 * 索引每个会话建一次、之后复用（每次调用都重建太浪费）；磁盘上的索引新会话只信 10 分钟。以前一直信：一份隔了一周的索引
 * 还在答，期间新写的定义一个都没有。重建一个中等仓库要零点几秒，过时的回答才是贵的那个——对存在的代码答「找不到」，
 * agent 就回去用 grep。
 */

import type { ToolDefinition, ToolOutput, ToolRun } from "@plume/contract";
import { buildIndex, INDEX_VERSION, loadIndex, saveIndex, searchIndex, type ListFiles, type SymbolIndex } from "./symbols.ts";

const MAX_AGE_MS = 10 * 60_000;
/** 模型有时把名字写在别的键上。 */
const NAME_KEYS = ["name", "query", "symbol", "pattern"];

export interface SymbolToolDeps {
	/** 索引存在哪个目录。 */
	root: string;
	listFiles: ListFiles;
	/** 会话 id → 这个会话用的索引。 */
	cache: Map<string, SymbolIndex>;
}

function nameOf(args: Record<string, unknown>): string {
	for (const key of NAME_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value) return value;
	}
	return "";
}

async function indexFor(run: ToolRun, deps: SymbolToolDeps): Promise<SymbolIndex> {
	const cached = deps.cache.get(run.sessionId);
	if (cached && cached.cwd === run.cwd) return cached;

	const stored = await loadIndex(deps.root, run.cwd);
	if (stored && stored.version === INDEX_VERSION && Date.now() - stored.builtAt < MAX_AGE_MS) {
		deps.cache.set(run.sessionId, stored);
		return stored;
	}

	const built = await buildIndex(run.cwd, deps.listFiles, run.signal);
	deps.cache.set(run.sessionId, built);
	await saveIndex(deps.root, built).catch(() => {});
	return built;
}

export function symbolTool(deps: SymbolToolDeps): ToolDefinition {
	return {
		name: "symbol",
		description:
			"Find where a symbol is declared: file:line for each matching function, class, interface, type or constant, best match first. " +
			"More precise than grepping a name that appears at every call site.",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "Symbol name or a fragment of it." },
				kind: {
					type: "string",
					description: "function, class, interface, type, enum, const, def, func, struct or method.",
				},
				limit: { type: "number", description: "Maximum matches. Default 40." },
			},
			required: ["name"],
			additionalProperties: true,
		},
		// 导出会话成 Markdown 时这次调用写成的那一行（英文，和本体给自己工具的说法一样）；参数是模型给的，取名字和执行时同一个办法。
		describe(args) {
			const name = nameOf(args).trim();
			return name ? `Find definition of ${name}` : "Find definition";
		},

		async execute(args, run): Promise<ToolOutput> {
			const name = nameOf(args).trim();
			if (!name) return { output: "`name` is required.", isError: true };
			const kind = typeof args.kind === "string" && args.kind ? args.kind : undefined;
			const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 40;

			const index = await indexFor(run, deps);
			const matches = searchIndex(index, name, kind, limit);

			if (matches.length === 0) {
				// 「没有」和「没找过」是两个回答；前一个告诉 agent 这个定义不存在。
				const why = index.truncated
					? `The index stopped at ${index.symbols.length} symbols, so files after that point were never indexed — use grep.`
					: "It may be defined in a dependency, or declared in a form the index does not recognise — try grep.";
				return {
					output: `No definition found for "${name}" among ${index.symbols.length} indexed symbols across ${index.fileCount} files. ${why}`,
					details: { kind: "symbol", query: name, count: 0 },
				};
			}

			return {
				output: matches.map((m) => `${m.file}:${m.line}  [${m.kind}]  ${m.text}`).join("\n"),
				details: { kind: "symbol", query: name, count: matches.length, matches },
			};
		},
	};
}
