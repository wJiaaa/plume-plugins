/**
 * 记忆放在插件数据目录的哪儿。
 *
 *   settings.json           三个开关
 *   memory.json             用户记忆（跟着人走）
 *   memory-injected.json    用户记忆每条最后一次进提示词的时间
 *   projects/<id>/          一个项目一份（跟着仓库走），id 由目录算出，project.json 记着是哪个目录
 *     learned.md            `learn` 和人刻意记下的
 *     MEMORY.md             后台从旧会话里总结的
 *     injected.json         同上，项目这边的
 *     .cursor .last-pass .lock   后台总结读到哪儿、上次什么时候跑、谁正在跑
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

export function projectDir(dataDir: string, cwd: string): string {
	const home = memoryHome(cwd);
	return join(dataDir, "projects", createHash("sha256").update(home).digest("hex").slice(0, 16));
}

/**
 * 记忆按哪个目录归档：git 工作树里的目录换成主检出里的同一个目录，其余原样。
 *
 * 记的是仓库的事（「用 pnpm 不用 npm」），工作树是同一个仓库；按工作树路径归档，每个工作树会话都从一份空记忆开始，
 * `learn` 写下的落进一个工作树一收回就没人再读的目录。
 *
 * 认工作树靠 `.git` 文件指向的 gitdir 里有没有 `commondir`：submodule 的 `.git` 也是文件，但它是另一个仓库，没有这个文件。
 * 共享目录不叫 `.git`（裸仓库）就没有主检出可回，也原样。拿不准一律原样。
 *
 * 已知边界：工作树收回以后 `.git` 指针跟着没了，在那里跑过的会话算不回主检出，后台总结读不到它们。
 */
export function memoryHome(cwd: string): string {
	const target = resolve(cwd);
	for (let dir = target; ; dir = dirname(dir)) {
		const dotGit = join(dir, ".git");
		let pointer: string | null = null;
		try {
			// 目录 = 主检出或普通仓库，这里就是它自己。
			if (!lstatSync(dotGit).isFile()) return target;
			pointer = readFileSync(dotGit, "utf8");
		} catch {
			// 这一层没有 `.git`，往上找。
		}
		if (pointer !== null) {
			const main = mainCheckout(dir, pointer);
			// 子目录项目落在主检出的同一个子目录；`relative` 而不是拼分隔符，Windows 上才成立。
			return main === null ? target : join(main, relative(dir, target));
		}
		if (dirname(dir) === dir) return target;
	}
}

/** `.git` 指针所在的工作树对应的主检出，不是工作树就是 null。 */
function mainCheckout(worktree: string, pointer: string): string | null {
	const gitdir = /^\s*gitdir:\s*(.+?)\s*$/m.exec(pointer)?.[1];
	if (!gitdir) return null;
	try {
		// 指针和 `commondir` 都可能是相对路径（`worktree.useRelativePaths`），各自相对所在位置解析。
		const own = resolve(worktree, gitdir);
		const common = resolve(own, readFileSync(join(own, "commondir"), "utf8").trim());
		return basename(common) === ".git" ? dirname(common) : null;
	} catch {
		return null;
	}
}
