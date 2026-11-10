/**
 * 会话目录是链出去的 git 工作树时，它的主工作树在哪。
 *
 * 工作树默认建在数据目录下，不在项目目录里；不认主树的话，「几个工作树并行干活、干完交接」恰好互相看不见
 * ——工作树会话多半和主树在同一个项目里，但不在任何项目里的聊天开出的工作树只能靠这一条认。
 */

import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** 会话活着时 cwd 不变，主工作树也就不变；git 只问一次。 */
const mainTrees = new Map<string, Promise<string | null>>();

function mainWorktree(cwd: string): Promise<string | null> {
	let pending = mainTrees.get(cwd);
	if (!pending) {
		pending = new Promise((done) => {
			execFile("git", ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], { cwd, windowsHide: true, timeout: 5000 }, (error, stdout) => {
				if (error) return done(null);
				const [gitDir, commonDir] = stdout.trim().split(/\r?\n/);
				done(!gitDir || !commonDir || resolve(gitDir) === resolve(commonDir) ? null : dirname(resolve(commonDir)));
			});
		});
		mainTrees.set(cwd, pending);
	}
	return pending;
}

/**
 * 这几个会话目录除了自己还算哪些目录：主工作树，连同目录本身的真实路径——git 报的是解析过软链的路径
 * （macOS 的 `/tmp` 报成 `/private/tmp`），拿它和没解析过的会话目录比会对不上，所以两边都带上真实路径。
 */
export async function mainWorktrees(cwds: Iterable<string>): Promise<Map<string, string[]>> {
	const unique = [...new Set(cwds)];
	const roots = await Promise.all(
		unique.map(async (cwd) => {
			const [main, real] = await Promise.all([mainWorktree(cwd), realpath(cwd).catch(() => cwd)]);
			return [...(main ? [main] : []), ...(real === cwd ? [] : [real])];
		}),
	);
	return new Map(unique.map((cwd, index) => [cwd, roots[index] ?? []]));
}
