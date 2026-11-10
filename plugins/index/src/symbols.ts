/**
 * 符号索引：记下项目里函数、类、接口、类型和常量定义在哪一行。
 *
 * `grep` 答的是「这段字出现在哪」，索引答的是「这个东西定义在哪」。大仓库里差别很大：grep `applyDiscount` 会把每个调用处
 * 都列出来，索引只给定义它的那一行。
 *
 * 定义靠正则认，不做语法解析。每种语言一个真正的解析器更准，也意味着每种语言一套工具链；认得出各语言声明写法的正则已经能把
 * agent 带到对的文件和行，读代码之前它要的就是这个。
 */

import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export interface SymbolEntry {
	name: string;
	kind: string;
	/** 相对工作目录的路径。 */
	file: string;
	line: number;
	/** 声明那一行，去掉两头空白。 */
	text: string;
}

export interface SymbolIndex {
	cwd: string;
	builtAt: number;
	fileCount: number;
	symbols: SymbolEntry[];
	/** 因为是二进制或太大而跳过的文件。 */
	skipped: number;
	/** 建它时的 `INDEX_VERSION`；没有的是更早的规则建的。 */
	version?: number;
	/** 走到 `MAX_SYMBOLS` 停了：那之后的文件根本没进索引。 */
	truncated?: boolean;
}

export interface IndexStats {
	exists: boolean;
	builtAt?: number;
	files?: number;
	symbols?: number;
	bytes?: number;
}

/** 文件清单：git 认为该看的文件（绝对路径），不在 git 仓库里时是 null。由服务 `project.files` 给。 */
export type ListFiles = (root: string) => Promise<string[] | null>;

const MAX_FILE_BYTES = 800_000;
const MAX_SYMBOLS = 40_000;
/**
 * 建索引的规则一变就加一，旧规则建的索引重建而不是照用。2：只收顶层的绑定（见 `buildIndex`）。3：git 忽略的文件不进。
 */
export const INDEX_VERSION = 3;

/**
 * git 给的清单也按它过一遍，不只是仓库外自己走目录时用：提交进仓库的 `vendor/`、`dist/` 对 grep 是真的文件，
 * 但它们的声明会把项目自己的挤出 `MAX_SYMBOLS`。
 */
const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	".next",
	".nuxt",
	"target",
	"vendor",
	"__pycache__",
	".venv",
	"venv",
	".turbo",
	".cache",
	"Pods",
	".gradle",
	".expo",
	"coverage",
]);

/** 这些正则认得出声明的扩展名。 */
const CODE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".go",
	".rs",
	".java",
	".kt",
	".swift",
	".rb",
	".php",
	".c",
	".h",
	".cc",
	".cpp",
	".hpp",
	".cs",
	".scala",
	".sh",
	".sql",
	".vue",
	".svelte",
]);

/** 声明的写法，按优先级排。第一个捕获组是符号名。 */
const PATTERNS: { kind: string; re: RegExp }[] = [
	{ kind: "function", re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
	{ kind: "class", re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
	{ kind: "interface", re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
	{ kind: "type", re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/ },
	{ kind: "enum", re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
	// `export const foo = (…) =>` 和 `export const Foo: Type = {` 都算定义。
	{ kind: "const", re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/ },
	{ kind: "func", re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/ },
	{ kind: "def", re: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/ },
	{ kind: "struct", re: /^\s*(?:pub\s+)?(?:struct|trait|impl|enum)\s+([A-Za-z_][\w]*)/ },
	{ kind: "method", re: /^\s*(?:public|private|protected|internal)\s+(?:static\s+)?[\w<>[\],\s]+\s+([A-Za-z_]\w*)\s*\(/ },
];

/** 前 8KB 里有 NUL 字节就当二进制。 */
function looksBinary(buffer: Buffer): boolean {
	const limit = Math.min(buffer.length, 8192);
	for (let i = 0; i < limit; i++) if (buffer[i] === 0) return true;
	return false;
}

export async function buildIndex(cwd: string, listFiles: ListFiles, signal?: AbortSignal): Promise<SymbolIndex> {
	const symbols: SymbolEntry[] = [];
	let fileCount = 0;
	let skipped = 0;

	const indexFile = async (full: string): Promise<void> => {
		const dot = full.lastIndexOf(".");
		if (dot === -1 || !CODE_EXTENSIONS.has(full.slice(dot).toLowerCase())) return;

		const info = await stat(full).catch(() => null);
		if (!info || info.size > MAX_FILE_BYTES) {
			skipped += 1;
			return;
		}

		const buffer = await readFile(full).catch(() => null);
		if (!buffer || looksBinary(buffer)) {
			skipped += 1;
			return;
		}

		fileCount += 1;
		const rel = relative(cwd, full).split(sep).join("/");
		const lines = buffer.toString("utf8").split("\n");

		for (let i = 0; i < lines.length && symbols.length < MAX_SYMBOLS; i++) {
			const line = lines[i]!;
			// 压缩过的长行里没有值得收的声明。
			if (line.length > 400) continue;
			for (const { kind, re } of PATTERNS) {
				const match = re.exec(line);
				if (!match) continue;
				/*
				 * 绑定只收顶层的。`const` 的正则对函数体里的每个局部变量一样认：在一个大仓库上它们占了五万多条里的三万六，
				 * 索引走到字母表一半就到了 `MAX_SYMBOLS`，后面的文件全没进去，`symbol` 对明明存在的函数答「找不到」，
				 * agent 又回去用 grep。
				 */
				if (kind === "const" && /^\s/.test(line)) break;
				symbols.push({ name: match[1]!, kind, file: rel, line: i + 1, text: line.trim().slice(0, 200) });
				break;
			}
		}
	};

	const walk = async (dir: string): Promise<void> => {
		if (signal?.aborted || symbols.length >= MAX_SYMBOLS) return;
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (signal?.aborted) return;
			const full = join(dir, entry.name);

			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
				await walk(full);
				continue;
			}
			if (entry.isFile()) await indexFile(full);
		}
	};

	const listed = await listFiles(cwd);
	if (!listed) await walk(cwd);
	else
		for (const full of listed) {
			if (signal?.aborted || symbols.length >= MAX_SYMBOLS) break;
			if (
				relative(cwd, full)
					.split(sep)
					.slice(0, -1)
					.some((name) => SKIP_DIRS.has(name))
			)
				continue;
			await indexFile(full);
		}
	return { cwd, builtAt: Date.now(), fileCount, symbols, skipped, version: INDEX_VERSION, truncated: symbols.length >= MAX_SYMBOLS };
}

// ---------------------------------------------------------------------------
// 存盘：`<root>/<目录的哈希>.json`，root 是插件数据目录下的 `index/`
// ---------------------------------------------------------------------------

function indexPath(root: string, cwd: string): string {
	const id = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	return join(root, `${id}.json`);
}

/** 先写临时文件再改名：同一项目的两个会话可能同时建完，读的一方只会看到旧的或新的一整份。 */
export async function saveIndex(root: string, index: SymbolIndex): Promise<void> {
	await mkdir(root, { recursive: true });
	const path = indexPath(root, index.cwd);
	const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	try {
		await writeFile(tmp, JSON.stringify(index));
		await rename(tmp, path);
	} catch (error) {
		await rm(tmp, { force: true }).catch(() => {});
		throw error;
	}
}

export async function loadIndex(root: string, cwd: string): Promise<SymbolIndex | null> {
	const raw = await readFile(indexPath(root, cwd), "utf8").catch(() => null);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as SymbolIndex;
		return parsed.cwd === cwd && Array.isArray(parsed.symbols) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * 删掉目录已经不在了的索引。
 *
 * 索引按目录存、不过期，用完删掉的工作树也是一个目录：每删一个就留下一份几 MB 的索引。
 */
export async function pruneIndexes(root: string): Promise<number> {
	let removed = 0;
	for (const name of await indexFiles(root)) {
		const path = join(root, name);
		const cwd = await indexedDir(path);
		if (cwd && (await stat(cwd).catch(() => null))) continue;
		await rm(path, { force: true }).catch(() => {});
		removed++;
	}
	return removed;
}

async function indexFiles(root: string): Promise<string[]> {
	return (await readdir(root).catch(() => [] as string[])).filter((name) => name.endsWith(".json"));
}

/** 只读文件开头：目录是第一个字段，后面可能有好几 MB。 */
async function indexedDir(path: string): Promise<string | null> {
	const file = await open(path, "r").catch(() => null);
	if (!file) return null;
	try {
		const { buffer, bytesRead } = await file.read({ buffer: Buffer.alloc(8192), position: 0 });
		// 引号写成 \x22：i18n 检查按引号认字符串，正则里落单的引号会让它把后面的注释当成代码。
		const head = /^\{\x22cwd\x22:(\x22(?:[^\x22\\]|\\.)*\x22)/.exec(buffer.toString("utf8", 0, bytesRead))?.[1];
		return head ? (JSON.parse(head) as string) : null;
	} catch {
		return null;
	} finally {
		await file.close();
	}
}

export async function indexStats(root: string, cwd: string): Promise<IndexStats> {
	const info = await stat(indexPath(root, cwd)).catch(() => null);
	if (!info) return { exists: false };
	const index = await loadIndex(root, cwd);
	return {
		exists: true,
		...(index ? { builtAt: index.builtAt, files: index.fileCount, symbols: index.symbols.length } : {}),
		bytes: info.size,
	};
}

/**
 * 最可能是定义的排在前面：名字完全一样，再是开头一样，再是包含；同一档里看着是导出的排在局部的前面。
 */
export function searchIndex(index: SymbolIndex, query: string, kind?: string, limit = 40): SymbolEntry[] {
	const needle = query.toLowerCase();
	const scored: { entry: SymbolEntry; score: number }[] = [];

	for (const entry of index.symbols) {
		if (kind && entry.kind !== kind) continue;
		const name = entry.name.toLowerCase();
		let score: number;
		if (name === needle) score = 0;
		else if (name.startsWith(needle)) score = 1;
		else if (name.includes(needle)) score = 2;
		else continue;
		if (entry.text.startsWith("export") || entry.text.startsWith("pub ")) score -= 0.5;
		scored.push({ entry, score });
	}

	scored.sort((a, b) => a.score - b.score || a.entry.file.localeCompare(b.entry.file) || a.entry.line - b.entry.line);
	return scored.slice(0, limit).map((s) => s.entry);
}
