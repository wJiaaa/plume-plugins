export interface PatchFile {
	oldPath: string;
	newPath: string;
	patch: string;
	added?: boolean;
	deleted?: boolean;
	renamed?: boolean;
	binary?: boolean;
}

// 文件名必须引用，避免远端路径中的换行冒充另一个 diff 头。
const quoted = (path: string) => JSON.stringify(path);
export function assembleDiff(files: PatchFile[]): string {
	const out: string[] = [];
	for (const file of files) {
		const from = file.oldPath || file.newPath;
		const to = file.newPath || file.oldPath;
		if (!from && !to) continue;
		out.push(`diff --git ${quoted(`a/${from}`)} ${quoted(`b/${to}`)}`);
		if (file.added) out.push("new file mode 100644");
		else if (file.deleted) out.push("deleted file mode 100644");
		if (file.renamed && from !== to) out.push(`rename from ${quoted(from)}`, `rename to ${quoted(to)}`);
		if (file.binary) {
			out.push(`Binary files ${quoted(`a/${from}`)} and ${quoted(`b/${to}`)} differ`);
			continue;
		}
		const body = file.patch.replace(/\n+$/, "");
		if (!body) continue;
		out.push(file.added ? "--- /dev/null" : `--- ${quoted(`a/${from}`)}`, file.deleted ? "+++ /dev/null" : `+++ ${quoted(`b/${to}`)}`, body);
	}
	return out.length ? `${out.join("\n")}\n` : "";
}
