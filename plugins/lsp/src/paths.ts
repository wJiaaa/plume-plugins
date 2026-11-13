/**
 * 路径的几样小工具：在不在某个目录下、模型给的路径换成绝对路径、没有 git 时自己走目录。
 */

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

/** `target` 在 `root` 下面（`root` 自己不算）。 */
export function within(root: string, target: string): boolean {
	const step = relative(root, target);
	return step !== "" && !/^\.\.(?:[\\/]|$)/.test(step) && !isAbsolute(step);
}

/** 模型给的路径：相对工作目录，或绝对路径，`~/` 开头的是家目录。 */
export function toAbsolute(cwd: string, input: string): string {
	const expanded = input === "~" || input.startsWith("~/") ? input.replace("~", homedir()) : input;
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/**
 * `dir` 下扩展名对得上的文件。`null` 是目录不在，和它是空的不一样，所以不直接给 `[]`。
 * 只在不是 git 仓库时用：仓库里的文件清单向本体的 `ctx.workspace.files` 要，git 忽略的不看。
 */
export async function walkFiles(dir: string, extensions: string[], maxDepth: number): Promise<string[] | null> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
	if (!entries) return null;

	const out: string[] = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (maxDepth <= 1) continue;
			const nested = await walkFiles(full, extensions, maxDepth - 1);
			if (nested) out.push(...nested);
			continue;
		}
		if (entry.isSymbolicLink()) {
			const target = await stat(full).catch(() => null);
			if (target?.isDirectory()) {
				if (maxDepth <= 1) continue;
				const nested = await walkFiles(full, extensions, maxDepth - 1);
				if (nested) out.push(...nested);
				continue;
			}
		}
		if (extensions.some((ext) => entry.name.toLowerCase().endsWith(ext))) out.push(full);
	}
	return out.sort();
}
