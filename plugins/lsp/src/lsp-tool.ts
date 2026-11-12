/**
 * The `lsp` tool: who uses this symbol, where is it defined, what did I just break.
 *
 * The operation that justifies the whole layer is `references`, and the reason is one specific
 * silent failure. `grep` cannot see an aliased import — `import { parse as p }`, then `p(...)` —
 * and it cannot follow a re-export chain. A rename done from a grep finds most callsites, misses
 * some, and *looks finished*. Nothing errors. The compiler finds out, or production does.
 *
 * The tool always answers. With no language server it does the text search and says so, in a
 * sentence naming what a text search cannot see — because "found 6" and "text search found 6,
 * which may be missing aliased imports" lead to different next actions, and the second one is the
 * true statement.
 */

import { readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import type { Services, ToolDefinition, ToolOutput } from "@plume/contract";
import { textualReferences, TEXTUAL_CAVEAT } from "./fallback.ts";
import type { CodeIntelManager } from "./manager.ts";
import { walkFiles } from "./paths.ts";
import type { CodeLocation } from "./types.ts";

const OPERATIONS = ["references", "definition", "diagnostics", "rename"] as const;
type Operation = (typeof OPERATIONS)[number];

interface LspArgs {
	operation: Operation;
	path: string;
	line?: number;
	column?: number;
	symbol?: string;
	newName?: string;
}

export interface LspToolDeps {
	/** 和文件工具共用读取授权，项目源目录、附件、密钥和符号链接只判断一次。 */
	authorizeRead: Services["file.read"]["authorize"];
	/** 这个会话在这个工作目录借的那一套语言服务器：`lsp` 工具和编辑后的诊断共用，同一个目录的会话也共用。 */
	managerFor(cwd: string, sessionId: string): CodeIntelManager;
	/** `root` 之下 git 认为该看的文件；不在 git 仓库里时是 null，自己走目录。 */
	listFiles(root: string): Promise<string[] | null>;
}

const error = (output: string): ToolOutput => ({ output, isError: true });

export function lspTool(deps: LspToolDeps): ToolDefinition {
	return {
		name: "lsp",
		// 问语言服务器一个符号在哪、谁在用、文件里有什么错，归「探索」里的搜索。rename 只算出要改哪些地方、不动文件，所以整件工具只读。
		kind: "search",
		/*
		 * Worded as a replacement for text search, not as an addition to the toolbox.
		 *
		 * The first version said "before changing an exported symbol, use lsp references", and in a
		 * session with nineteen tools the model read that, reached for `grep`, and read the matching
		 * files to work the rest out. On a three-file project that arrives at the right answer; on a
		 * real one it is the silent-miss failure with extra steps. Naming what it should be used
		 * *instead of* is what makes the choice concrete. That is said as "a text search" rather than
		 * by tool name: the search tool belongs to another plugin, and the model can tell which of its
		 * tools that is.
		 */
		description:
			"Ask the language server about a symbol.\n" +
			"- `references` — every use, including aliased imports (`import { a as b }`) and re-export chains that a text search cannot see. " +
			"Use this, not a text search, to find callers before changing or renaming a symbol: a rename driven by text search looks complete and leaves callers broken.\n" +
			"- `definition` — where it comes from, through re-exports.\n" +
			"- `diagnostics` — type errors in one file, without a build.\n" +
			"- `rename` — every edit for a project-wide rename.\n" +
			"Give `line`/`column` from a read, or `symbol` to have it located. Without a language server it falls back to a text search and says so.",
		parameters: {
			type: "object",
			properties: {
				operation: { type: "string", enum: [...OPERATIONS], description: "What to ask." },
				path: { type: "string", description: "File the symbol is in, relative to the workspace root." },
				line: { type: "number", description: "1-indexed line of the symbol." },
				column: { type: "number", description: "1-indexed column of the symbol." },
				symbol: { type: "string", description: "Symbol name, used to locate it when line/column are not given." },
				newName: { type: "string", description: "Required for `rename`." },
			},
			required: ["operation", "path"],
			additionalProperties: false,
		},

		async execute(raw, run): Promise<ToolOutput> {
			const args = raw as Partial<LspArgs>;
			if (!OPERATIONS.includes(args.operation as Operation)) return error(`\`operation\` must be one of ${OPERATIONS.join(", ")}.`);
			if (typeof args.path !== "string" || !args.path) return error("A path is required.");
			const operation = args.operation as Operation;
			const cwd = run.cwd;

			const authorized = await deps.authorizeRead(run, args.path);
			if (!authorized.ok) return error(authorized.message);
			const absolute = authorized.absolute;

			const manager = deps.managerFor(cwd, run.sessionId);
			const backend = await manager.acquire(absolute, cwd).catch(() => null);
			// 没有服务器时那句「为什么」：没装什么、还在启动。模型据此知道下面是文本搜索，也能转告人去装。
			const why = backend ? null : await manager.unavailable(absolute).catch(() => null);

			if (operation === "diagnostics") {
				if (!backend) {
					/*
					 * No degraded form of this one exists. A text search cannot produce type errors, and
					 * inventing something adjacent — a lint pass, a regex for obvious mistakes — would
					 * answer a question nobody asked while looking like an answer to this one.
					 */
					// i18n-exempt：交给模型的结果。
					return { output: `${why ?? "这个文件没有可用的语言服务器。"}拿不到类型诊断。可以用 bash 跑一次类型检查或编译。` };
				}
				const found = await backend.diagnostics(absolute);
				const body =
					found.length === 0
						? // i18n-exempt：交给模型的结果。
							"没有诊断。"
						: found.map((d) => `${relative(cwd, d.path)}:${d.line}:${d.column} ${d.severity} ${d.message}`).join("\n");
				return { output: body, details: { kind: "lsp", operation: "diagnostics", count: found.length } };
			}

			const position = await locate(args, absolute);
			if (!position) {
				// i18n-exempt：交给模型的结果。
				return error(
					args.symbol
						? `在 ${args.path} 里找不到符号 "${args.symbol}"。给出 line 与 column，或者先 read 这个文件确认名字。`
						: "需要 `line` 与 `column`，或者一个 `symbol` 名字。",
				);
			}

			if (operation === "rename") {
				if (typeof args.newName !== "string" || !args.newName.trim()) return error("`newName` is required for rename.");
				if (!backend) {
					/*
					 * Refused rather than approximated. A textual rename is the exact operation this
					 * whole layer exists to prevent — it is the one that silently drops callsites.
					 */
					// i18n-exempt：交给模型的结果。
					return error(
						(why ?? "") +
							"没有语言服务器，不能安全地重命名——文本替换会漏掉别名导入和重导出链，而且不会报错。" +
							"改用 `lsp references` 看清楚有哪些地方，再逐个 edit。",
					);
				}
				const edits = await backend.rename(absolute, position.line, position.column, args.newName);
				const byFile = new Map<string, number>();
				for (const edit of edits) byFile.set(edit.path, (byFile.get(edit.path) ?? 0) + 1);
				const summary = [...byFile.entries()].map(([file, count]) => `${relative(cwd, file)} (${count})`).join("\n");
				return {
					// i18n-exempt：交给模型的结果。
					output: `重命名需要改 ${edits.length} 处，分布在 ${byFile.size} 个文件：\n${summary}`,
					details: { kind: "lsp", operation: "rename", edits },
				};
			}

			if (backend) {
				const found =
					operation === "references"
						? await backend.references(absolute, position.line, position.column)
						: await backend.definition(absolute, position.line, position.column);
				return {
					output: render(found, cwd, "exact"),
					details: { kind: "lsp", operation, confidence: "exact", count: found.length },
				};
			}

			if (operation === "definition") {
				// i18n-exempt：交给模型的结果。
				return { output: `${why ?? "没有语言服务器。"}用 \`symbol\` 工具查定义，或者用 \`grep\` 搜声明。` };
			}

			const name = args.symbol ?? position.word;
			// i18n-exempt：交给模型的结果。
			if (!name) return error("没有语言服务器时，需要 `symbol` 才能做文本搜索。");
			/*
			 * 只搜同一种语言的文件：负责这个文件的服务器认哪些扩展名，就搜哪些；没有服务器认领的，就搜同扩展名的。
			 * 文件清单在 git 仓库里向 `project.files` 要（被忽略的 node_modules、dist 不搜），不在仓库里才自己走目录。
			 */
			const searchable = manager.backendFor(absolute)?.extensions ?? [extname(absolute).toLowerCase()];
			const listed = await deps.listFiles(cwd).catch(() => null);
			const files = listed
				? listed.filter((file) => searchable.some((ext) => file.toLowerCase().endsWith(ext)))
				: ((await walkFiles(cwd, searchable, 8)) ?? []);
			const found = await textualReferences(files, name, cwd);
			return {
				output: `${render(found, cwd, "textual")}\n\n${why ? `${why}\n` : ""}${TEXTUAL_CAVEAT}`,
				details: { kind: "lsp", operation: "references", confidence: "textual", count: found.length },
			};
		},
	};
}

function render(items: CodeLocation[], cwd: string, confidence: "exact" | "textual"): string {
	// i18n-exempt：交给模型的结果。
	if (items.length === 0) return confidence === "exact" ? "语言服务器没有找到引用。" : "文本搜索没有找到。";
	// i18n-exempt：交给模型的结果。
	const head = confidence === "exact" ? `找到 ${items.length} 处（语言服务器，含别名导入与重导出）：` : `文本搜索找到 ${items.length} 处：`;
	const lines = items
		.slice(0, 200)
		.map((item) => `${relative(cwd, resolve(cwd, item.path)) || item.path}:${item.line}:${item.column}${item.text ? `  ${item.text}` : ""}`);
	// i18n-exempt：交给模型的结果。
	const more = items.length > 200 ? `\n… 还有 ${items.length - 200} 处` : "";
	return `${head}\n${lines.join("\n")}${more}`;
}

/**
 * Turn a symbol name into a position, when the caller gave one instead of coordinates.
 *
 * Prefers a line that looks like a declaration. Asking the server about a *usage* of a symbol
 * returns the same reference set in most cases, but not for a shadowed name — and the declaration
 * is the position a person means when they name a symbol.
 */
async function locate(args: Partial<LspArgs>, absolute: string): Promise<{ line: number; column: number; word?: string } | null> {
	if (typeof args.line === "number" && typeof args.column === "number") {
		return { line: args.line, column: args.column, ...(args.symbol ? { word: args.symbol } : {}) };
	}
	if (typeof args.symbol !== "string" || !args.symbol) return null;

	const content = await readFile(absolute, "utf8").catch(() => null);
	if (content === null) return null;

	const lines = content.split("\n");
	const escaped = args.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const word = new RegExp(`\\b${escaped}\\b`);
	// 后半截是 Python 的 def、Go 的 func、Rust 的 fn/struct/trait/mod/static——接进来的几种语言声明名字的写法。
	const declaration = new RegExp(`\\b(?:function|class|const|let|var|interface|type|enum|def|func|fn|struct|trait|mod|static)\\s+${escaped}\\b`);

	let firstUse: { line: number; column: number } | null = null;
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		const match = word.exec(line);
		if (!match) continue;
		if (declaration.test(line)) return { line: i + 1, column: match.index + 1, word: args.symbol };
		firstUse ??= { line: i + 1, column: match.index + 1 };
	}
	return firstUse ? { ...firstUse, word: args.symbol } : null;
}
