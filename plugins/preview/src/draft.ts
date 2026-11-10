/** 从流式参数提取静态正文与独立样式表。 */
import { partialJson } from "./partial-json.ts";

export interface DraftDocument {
	html: string;
	css: string[];
}

export type DraftPhase = "styles" | "markup" | "script";

interface PreviewFile {
	path?: unknown;
	content?: unknown;
}

export function draftArguments(args: Record<string, unknown>, raw: string | undefined): Record<string, unknown> {
	if (typeof args.html === "string" || Array.isArray(args.files) || !raw) return args;
	const value = partialJson(raw);
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function draftDocument(value: Record<string, unknown>): DraftDocument | null {
	if (typeof value.html === "string") return value.html ? { html: value.html, css: [] } : null;
	if (!Array.isArray(value.files)) return null;
	const files = (value.files as PreviewFile[]).filter((file) => file && typeof file.path === "string" && typeof file.content === "string") as {
		path: string;
		content: string;
	}[];
	const entry = typeof value.entry === "string" ? value.entry : "index.html";
	const page = files.find((file) => file.path === entry);
	if (!page?.content) return null;
	return { html: page.content, css: files.filter((file) => /\.css$/i.test(file.path)).map((file) => file.content) };
}

function inside(html: string, tag: string): boolean {
	const lower = html.toLowerCase();
	return lower.lastIndexOf(`<${tag}`) > lower.lastIndexOf(`</${tag}`);
}

export function draftPhase(html: string): DraftPhase {
	if (inside(html, "style")) return "styles";
	if (inside(html, "script")) return "script";
	return "markup";
}

export function draftSize(document: DraftDocument): string {
	const chars = document.html.length + document.css.reduce((sum, css) => sum + css.length, 0);
	return `${(chars / 1024).toFixed(1)} KB`;
}
