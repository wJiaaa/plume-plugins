/**
 * 下载和导出写到本机「下载」文件夹。插件拿不到系统的保存对话框，固定写到这里、重名加序号，写完告诉人路径。
 */

import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";

export function downloadsDir(): string {
	return join(homedir(), "Downloads");
}

/** 不覆盖已有文件：`a.txt` 在了就用 `a (1).txt`，以此类推（正在下载的 `.part` 也算占着）。 */
export async function availablePath(path: string): Promise<string> {
	const taken = async (candidate: string) => {
		for (const file of [candidate, `${candidate}.part`]) {
			try {
				await access(file);
				return true;
			} catch {}
		}
		return false;
	};
	if (!(await taken(path))) return path;
	const extension = extname(path);
	const stem = path.slice(0, path.length - extension.length);
	for (let index = 1; ; index++) {
		const candidate = `${stem} (${index})${extension}`;
		if (!(await taken(candidate))) return candidate;
	}
}
