/**
 * 把 LSP 的回答换成 `lsp` 工具认得的形状，和 tsserver 那条路给出的一模一样。
 *
 * 换算只有一处要紧：LSP 的行列从 0 数、列按 UTF-16 码元，工具和 `read` 从 1 数。JS 字符串的
 * 下标本来就是 UTF-16 码元，所以加一就对，不用再按字节或码点换算——初始化时也只向服务器声明
 * `utf-16` 这一种编码。
 */

import { readFile } from "node:fs/promises";
import type { CodeLocation, Diagnostic, TextEdit } from "./types.ts";

interface WirePosition {
	line: number;
	character: number;
}
interface WireRange {
	start: WirePosition;
	end: WirePosition;
}
interface WireTextEdit {
	range: WireRange;
	newText: string;
}
interface WireDiagnostic {
	range: WireRange;
	severity?: number;
	code?: string | number;
	message: string;
}

/** URI 换成本地路径；换不了的（虚拟文档）返回 null，这一项跳过。 */
export type ToPath = (uri: string) => string | null;

const isRange = (value: unknown): value is WireRange =>
	!!value && typeof value === "object" && typeof (value as WireRange).start?.line === "number" && typeof (value as WireRange).end?.line === "number";

/** `definition` / `references` 的回答：`Location`、`Location[]`、`LocationLink[]` 或 null。 */
export function toLocations(payload: unknown, toPath: ToPath): CodeLocation[] {
	if (!payload) return [];
	const found: CodeLocation[] = [];
	const seen = new Set<string>();
	for (const entry of Array.isArray(payload) ? payload : [payload]) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as { uri?: string; range?: unknown; targetUri?: string; targetSelectionRange?: unknown };
		// LocationLink 用 targetSelectionRange：那是名字本身，targetRange 是整个声明体。
		const uri = record.targetUri ?? record.uri;
		const range = record.targetUri ? record.targetSelectionRange : record.range;
		if (typeof uri !== "string" || !isRange(range)) continue;
		const path = toPath(uri);
		if (path === null) continue;
		// 同一处可能经两条路径各报一次（头文件被两个编译单元包含），换算成本地路径之后再去重。
		const key = `${path}:${range.start.line}:${range.start.character}`;
		if (seen.has(key)) continue;
		seen.add(key);
		found.push({ path, line: range.start.line + 1, column: range.start.character + 1 });
	}
	return found;
}

/**
 * `rename` 的回答（WorkspaceEdit）展平成逐条编辑。
 *
 * 两种写法都有服务器在用：pyright 给 `documentChanges`，gopls 看客户端声明了什么给哪种。
 * `documentChanges` 里的建文件、改名、删文件不是文本编辑，跳过——重命名一个符号不该产生它们。
 */
export function toTextEdits(payload: unknown, toPath: ToPath): TextEdit[] {
	if (!payload || typeof payload !== "object") return [];
	const edit = payload as { changes?: Record<string, WireTextEdit[]>; documentChanges?: { textDocument?: { uri: string }; edits?: WireTextEdit[] }[] };
	const groups: [string, WireTextEdit[]][] = [];
	if (edit.documentChanges) {
		for (const change of edit.documentChanges) {
			if (change.textDocument && Array.isArray(change.edits)) groups.push([change.textDocument.uri, change.edits]);
		}
	} else {
		groups.push(...Object.entries(edit.changes ?? {}));
	}
	const edits: TextEdit[] = [];
	for (const [uri, list] of groups) {
		const path = toPath(uri);
		if (path === null) continue;
		for (const item of list) {
			if (!isRange(item.range)) continue;
			edits.push({
				path,
				line: item.range.start.line + 1,
				column: item.range.start.character + 1,
				endLine: item.range.end.line + 1,
				endColumn: item.range.end.character + 1,
				newText: item.newText,
			});
		}
	}
	return edits;
}

/** LSP 的严重程度是 1 错误、2 警告、3 信息、4 提示；后两种在工具里都算 info。 */
export function toDiagnostics(items: unknown, path: string): Diagnostic[] {
	if (!Array.isArray(items)) return [];
	return (items as WireDiagnostic[])
		.filter((item) => isRange(item?.range) && typeof item.message === "string")
		.map((item) => ({
			path,
			line: item.range.start.line + 1,
			column: item.range.start.character + 1,
			severity: item.severity === 2 ? "warning" : item.severity === 3 || item.severity === 4 ? "info" : "error",
			message: item.message,
			code: item.code,
		}));
}

/** 给每一处引用配上那一行源码，和 tsserver 的 `lineText` 对齐——模型不用再 read 一遍才知道是哪种用法。 */
export async function withLineText(locations: CodeLocation[]): Promise<CodeLocation[]> {
	const files = new Map<string, Promise<string[] | null>>();
	for (const location of locations.slice(0, 200)) {
		if (!files.has(location.path))
			files.set(
				location.path,
				readFile(location.path, "utf8").then(
					(text) => text.split("\n"),
					() => null,
				),
			);
		const lines = await files.get(location.path);
		const text = lines?.[location.line - 1]?.trim();
		if (text) location.text = text.slice(0, 200);
	}
	return locations;
}
