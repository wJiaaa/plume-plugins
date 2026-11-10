/**
 * 项目钩子的信任记录。
 *
 * `.plume/config.json` 跟着仓库走：克隆一个别人的仓库、在 Plume 里打开，里面写的命令就会在这台机器上跑，而且跑在沙箱外面。
 * 所以项目钩子要先被这台机器的主人逐条认过——按内容认，不按位置认：命令改了，指纹就变了，旧的信任不再算数。
 *
 * 记录放在插件数据目录的 `hook-trust.json`，不进仓库。文件读不出来时一条都不信，而不是全信。
 */

import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

interface TrustFile {
	version: 1;
	/** 工作区的真实路径 → 已信任的钩子指纹。 */
	workspaces: Record<string, string[]>;
}

function trustFile(dataDir: string): string {
	return join(dataDir, "hook-trust.json");
}

async function workspaceKey(cwd: string): Promise<string> {
	return realpath(cwd).catch(() => resolve(cwd));
}

async function readTrustFile(dataDir: string): Promise<TrustFile> {
	const raw = await readFile(trustFile(dataDir), "utf8").catch(() => null);
	if (raw === null) return { version: 1, workspaces: {} };
	try {
		const parsed = JSON.parse(raw) as Partial<TrustFile>;
		if (parsed.version !== 1 || typeof parsed.workspaces !== "object" || parsed.workspaces === null) return { version: 1, workspaces: {} };
		return { version: 1, workspaces: parsed.workspaces };
	} catch {
		return { version: 1, workspaces: {} };
	}
}

export async function trustedHookDigests(dataDir: string, cwd: string): Promise<Set<string>> {
	const file = await readTrustFile(dataDir);
	const list = file.workspaces[await workspaceKey(cwd)];
	return new Set(Array.isArray(list) ? list.filter((digest) => typeof digest === "string") : []);
}

/**
 * 信任这些指纹。`keep` 是这个工作区此刻还存在的全部指纹：顺手把已经不存在的旧记录清掉，
 * 免得删掉又改回来的一条命令凭一份过期的信任直接生效。
 */
export async function trustHookDigests(dataDir: string, cwd: string, digests: readonly string[], keep: readonly string[]): Promise<void> {
	const file = await readTrustFile(dataDir);
	const key = await workspaceKey(cwd);
	const alive = new Set(keep);
	file.workspaces[key] = [...new Set([...(file.workspaces[key] ?? []).filter((digest) => alive.has(digest)), ...digests])];
	const target = trustFile(dataDir);
	const temp = `${target}.${process.pid}.tmp`;
	await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
	await rename(temp, target);
}
