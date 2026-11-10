import type { ChangeHunk } from "@plume/contract";
import type { WorkspaceDiffFile } from "../api.ts";

const MAX_FILES = 300;
const MAX_LINES_PER_FILE = 4000;

// 行号与行类型直接使用公共 ChangeHunk，远端 diff 不需要本地检出。
export function parseUnifiedDiff(patch: string): WorkspaceDiffFile[] {
	const files: WorkspaceDiffFile[] = [];
	let current: WorkspaceDiffFile | null = null;
	let hunk: ChangeHunk | null = null;
	let oldLine = 0;
	let newLine = 0;
	let lineCount = 0;
	const closeHunk = () => {
		if (current && hunk && hunk.lines.length > 0) current.hunks.push(hunk);
		hunk = null;
	};
	const closeFile = () => {
		closeHunk();
		if (current) files.push(current);
		current = null;
	};
	for (const line of patch.split("\n")) {
		if (line.startsWith("diff --git ")) {
			closeFile();
			if (files.length >= MAX_FILES) break;
			current = { path: pathFromHeader(line), status: "modified", added: 0, removed: 0, hunks: [] };
			lineCount = 0;
			continue;
		}
		if (!current) continue;
		if (line.startsWith("new file mode")) {
			current.status = "added";
			continue;
		}
		if (line.startsWith("deleted file mode")) {
			current.status = "deleted";
			continue;
		}
		if (line.startsWith("rename to ")) {
			current.status = "renamed";
			current.path = unquote(line.slice("rename to ".length).trim());
			continue;
		}
		if (line.startsWith("Binary files ") || line === "GIT binary patch") {
			current.binary = true;
			closeHunk();
			continue;
		}
		if (line.startsWith("@@")) {
			closeHunk();
			const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
			if (!match) continue;
			oldLine = Number(match[1]);
			newLine = Number(match[2]);
			hunk = { oldStart: oldLine, newStart: newLine, lines: [] };
			continue;
		}
		if (!hunk || lineCount >= MAX_LINES_PER_FILE || line.startsWith("\\")) continue;
		const marker = line[0];
		const text = line.slice(1);
		if (marker === "+") {
			hunk.lines.push({ type: "add", text, newLine: newLine++ });
			current.added++;
		} else if (marker === "-") {
			hunk.lines.push({ type: "remove", text, oldLine: oldLine++ });
			current.removed++;
		} else if (marker === " ") hunk.lines.push({ type: "context", text, oldLine: oldLine++, newLine: newLine++ });
		else continue;
		lineCount++;
	}
	closeFile();
	return files;
}
function pathFromHeader(line: string): string {
	const rest = line.slice("diff --git ".length).trim();
	const quoted = /^("a\/.*") ("b\/.*")$/.exec(rest);
	if (quoted) return unquote(quoted[2]!).slice(2);
	const at = rest.lastIndexOf(" b/");
	return at === -1 ? rest : rest.slice(at + 3);
}
// Git 的非 ASCII 路径使用 UTF-8 八进制字节，不能只交给 JSON.parse。
function unquote(value: string): string {
	if (!value.startsWith('"') || !value.endsWith('"')) return value;
	const inner = value.slice(1, -1);
	const bytes: number[] = [];
	for (let at = 0; at < inner.length;) {
		const octal = /^\\([0-7]{1,3})/.exec(inner.slice(at));
		if (octal) {
			bytes.push(Number.parseInt(octal[1]!, 8));
			at += octal[0].length;
			continue;
		}
		const escaped = inner[at] === "\\" ? inner[at + 1] : undefined;
		if (escaped !== undefined) {
			const special: Record<string, string> = { t: "\t", n: "\n", r: "\r", b: "\b", f: "\f", v: "\v", a: "\x07" };
			bytes.push(...Buffer.from(special[escaped] ?? escaped));
			at += 2;
		} else {
			const char = String.fromCodePoint(inner.codePointAt(at)!);
			bytes.push(...Buffer.from(char));
			at += char.length;
		}
	}
	return Buffer.from(bytes).toString("utf8");
}
