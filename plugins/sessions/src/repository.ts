/**
 * 会话目录在哪个 git 仓库里：认的是仓库共用的 `.git` 目录（`--git-common-dir`），所以主工作树、链出去的工作树和它们的子目录
 * 都认成同一个仓库。工作树默认建在数据目录下，不在项目目录里；不这样认的话，「几个工作树并行干活、干完交接」恰好互相看不见。
 *
 * 比的是真实路径：git 报的路径解析过软链（macOS 的 `/tmp` 报成 `/private/tmp`），Windows 上盘符、目录名的大小写也可能和会话目录写的不一样，
 * 两边都换成 `realpath` 给的那一个再比。
 */

import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * 不在仓库里（或者 git 没答上来：没装、超时）的结果只信这么久：目录之后可能 `git init`，那一次超时也可能只是机器忙。
 * 认出来的仓库一直记着：会话活着时目录不变，它在哪个仓库也就不变。
 */
const MISS_TTL_MS = 60_000;

const known = new Map<string, { repo: string | undefined; at: number; pending: Promise<string | undefined> }>();

function lookup(cwd: string): Promise<string | undefined> {
	return new Promise((done) => {
		execFile("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, windowsHide: true, timeout: 5000 }, (error, stdout) => {
			const dir = error ? "" : stdout.trim();
			if (!dir) return done(undefined);
			realpath(resolve(dir)).then(done, () => done(undefined));
		});
	});
}

function repository(cwd: string, now: number): Promise<string | undefined> {
	const entry = known.get(cwd);
	if (entry && (entry.repo !== undefined || now - entry.at < MISS_TTL_MS)) return entry.pending;
	const fresh = { repo: undefined as string | undefined, at: now, pending: lookup(cwd) };
	fresh.pending.then((repo) => void (fresh.repo = repo));
	known.set(cwd, fresh);
	return fresh.pending;
}

/** 这几个会话目录各在哪个仓库（共用 `.git` 目录的真实路径）；不在仓库里的没有这一项。 */
export async function repositories(cwds: Iterable<string>, now = Date.now()): Promise<Map<string, string>> {
	const unique = [...new Set(cwds)];
	const repos = await Promise.all(unique.map((cwd) => repository(cwd, now)));
	return new Map(unique.flatMap((cwd, index) => (repos[index] ? [[cwd, repos[index]] as const] : [])));
}
