/**
 * 摘要存在插件数据目录的 `summaries/<会话 id>.json`，一个会话一个文件：读的时候只读那一个，删会话时删那一个。
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StoredSummary } from "./api.ts";

export class SummaryStore {
	readonly #dir: string;

	constructor(dataDir: string) {
		this.#dir = join(dataDir, "summaries");
	}

	/** 会话 id 来自界面，拼进路径前挡住会走出目录的。 */
	#file(sessionId: string): string {
		if (!/^[\w-]+$/.test(sessionId)) throw new Error(`Invalid session id: ${sessionId}`);
		return join(this.#dir, `${sessionId}.json`);
	}

	async read(sessionId: string): Promise<StoredSummary | null> {
		const text = await readFile(this.#file(sessionId), "utf8").catch(() => null);
		if (text === null) return null;
		try {
			const value = JSON.parse(text) as Partial<StoredSummary>;
			return typeof value.text === "string" && typeof value.upto === "number" && typeof value.updatedAt === "number"
				? { text: value.text, upto: value.upto, updatedAt: value.updatedAt }
				: null;
		} catch {
			return null;
		}
	}

	async save(sessionId: string, summary: StoredSummary): Promise<void> {
		const file = this.#file(sessionId);
		await mkdir(this.#dir, { recursive: true });
		await writeFile(`${file}.tmp`, JSON.stringify(summary));
		await rename(`${file}.tmp`, file);
	}

	async remove(sessionId: string): Promise<void> {
		await rm(this.#file(sessionId), { force: true });
	}
}
