export const MAX_BYTES = 2_000_000;
export const MAX_STATE = 16 * 1024;
export const MAX_HEIGHT = 720;

export interface Preview {
	id: string;
	sessionId: string;
	title: string;
	entry: string;
	themed: boolean;
	height: number;
	published: boolean;
}
export interface PreviewFile {
	path: string;
	content: string;
}
export interface PreviewTheme {
	scheme: "light" | "dark";
	vars: Record<string, string>;
}
export interface PreviewDocument {
	preview: Preview;
	files: PreviewFile[];
	exceptions: string[];
	state: unknown;
	pending: boolean;
}

export function safeName(value: string): boolean {
	return !!value && !value.includes("\\") && !/[\x00-\x1f:#?%]/.test(value) && value.split("/").every((part) => !!part && part !== "." && part !== "..");
}
export function validId(value: string): boolean {
	return /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}
export function isPreview(value: unknown): value is Preview {
	if (!value || typeof value !== "object") return false;
	const p = value as Preview;
	return (
		typeof p.id === "string" &&
		validId(p.id) &&
		typeof p.sessionId === "string" &&
		validId(p.sessionId) &&
		typeof p.title === "string" &&
		typeof p.entry === "string" &&
		safeName(p.entry) &&
		typeof p.themed === "boolean" &&
		typeof p.published === "boolean" &&
		Number.isFinite(p.height)
	);
}
export function stateJson(value: unknown): string {
	const json = JSON.stringify(value ?? null);
	if (typeof json !== "string" || new TextEncoder().encode(json).length > MAX_STATE) throw new Error("Page state must be JSON of at most 16 KB");
	return json;
}

export function pageFiles(args: Record<string, unknown>): { files: PreviewFile[]; entry: string } {
	let files: PreviewFile[];
	if (args.files !== undefined) {
		if (!Array.isArray(args.files) || !args.files.length || args.files.length > 100) throw new Error("files must contain 1–100 files");
		files = args.files.map((item: unknown) => {
			if (!item || typeof item !== "object") throw new Error("Invalid preview file");
			const file = item as PreviewFile;
			if (typeof file.path !== "string" || !safeName(file.path) || typeof file.content !== "string") throw new Error("Invalid preview file path or content");
			return { path: file.path, content: file.content };
		});
	} else {
		if (typeof args.html !== "string" || !args.html.trim()) throw new Error("Provide html, files or path");
		files = [{ path: "index.html", content: args.html }];
	}
	if (files.reduce((size, file) => size + new TextEncoder().encode(file.content).length, 0) > MAX_BYTES) throw new Error("Preview exceeds 2 MB");
	if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error("Duplicate preview file paths");
	const entry = args.entry ?? "index.html";
	if (typeof entry !== "string" || !/\.html?$/i.test(entry) || !files.some((file) => file.path === entry))
		throw new Error("The HTML entry must be included in files");
	return { files, entry };
}
