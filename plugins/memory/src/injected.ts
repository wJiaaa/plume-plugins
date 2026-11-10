/**
 * 每条记忆最后一次进提示词的时间。
 *
 * 写下以后从没进过提示词的还不算记忆；几个月没进过的，多半它说的东西已经不在了。光看文字看不出这两件事，设置页把这个时间标在每条下面。
 *
 * 存在记忆旁边，不写进记忆本身：`memory.json`、`learned.md` 是人会手改、会往里加的内容，每轮往里写一个时间戳会和人手加的条目抢着整份写回，
 * 丢一次写入就是丢一条记忆；写在旁边，丢的只是一个时间。每个文件一分钟最多写一次：每一轮都要经过这里，而一分钟里是同一个答案。
 */

import { join } from "node:path";
import { readText, writeAtomic } from "./files.ts";

export type InjectedMap = Record<string, number>;

/** 后台总结的 `MEMORY.md` 对模型是一整件东西，这是它的键。 */
export const EXTRACTED_KEY = "extracted";

const MARK_INTERVAL_MS = 60_000;

export function userInjectedFile(dataDir: string): string {
	return join(dataDir, "memory-injected.json");
}

export function projectInjectedFile(projectDir: string): string {
	return join(projectDir, "injected.json");
}

export async function readInjected(file: string): Promise<InjectedMap> {
	const raw = await readText(file).catch(() => null);
	if (raw === null) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object") return {};
		const out: InjectedMap = {};
		for (const [key, value] of Object.entries(parsed)) if (typeof value === "number") out[key] = value;
		return out;
	} catch {
		return {};
	}
}

const lastWrite = new Map<string, number>();

/** 记下 `keys` 在 `at` 进了提示词。同一个文件 `minInterval` 之内写过就跳过；不在 `keys` 里的保留原来的时间。 */
export async function markInjected(file: string, keys: string[], at = Date.now(), minInterval = MARK_INTERVAL_MS): Promise<boolean> {
	if (keys.length === 0) return false;
	const last = lastWrite.get(file);
	if (last !== undefined && at - last < minInterval) return false;
	lastWrite.set(file, at);
	const current = await readInjected(file);
	for (const key of keys) current[key] = at;
	await writeAtomic(file, `${JSON.stringify(current, null, 2)}\n`);
	return true;
}
