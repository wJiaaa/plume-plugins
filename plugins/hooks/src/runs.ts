/**
 * 钩子的运行记录：每个会话一份，存在插件数据目录的 `runs/<会话>.json`，重开应用还在。
 *
 * 每条带 `at`：它归哪一轮——那一轮开口的消息在会话里的位置加一。回复底下的按钮按 `from < at <= to` 挑出这一轮的。
 * 撤回时 `at` 落在被撤掉那段里的跟着删掉，会话删掉时整份删掉。
 *
 * 每个会话只留最近 500 条：大多数钩子是静静跑完的格式化和日志，一个长会话几千次工具调用全记下来，文件只会越写越大，
 * 而按钮只看有没有出岔子的那几轮。要翻更早的，再按会话分文件、按需读。
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HookRun } from "./runner.ts";

const MAX_RUNS = 500;

export type HookRunRecord = HookRun & { at: number };

export class RunStore {
	private readonly cache = new Map<string, Promise<HookRunRecord[]>>();
	private readonly writes = new Map<string, Promise<unknown>>();
	private readonly listeners = new Set<(sessionId: string) => void>();
	private readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	private file(sessionId: string): string {
		return join(this.dir, `${encodeURIComponent(sessionId)}.json`);
	}

	/** 一个会话的全部记录，旧的在前。 */
	list(sessionId: string): Promise<HookRunRecord[]> {
		let runs = this.cache.get(sessionId);
		if (!runs) {
			runs = readFile(this.file(sessionId), "utf8").then(
				(raw) => {
					const parsed: unknown = JSON.parse(raw);
					return Array.isArray(parsed) ? (parsed as HookRunRecord[]) : [];
				},
				() => [],
			);
			this.cache.set(sessionId, runs);
		}
		return runs;
	}

	/** 记一条；同一个 `id` 的是那一次运行的结局，换掉开始时那条。 */
	async put(sessionId: string, run: HookRunRecord): Promise<void> {
		const runs = await this.list(sessionId);
		const at = runs.findIndex((one) => one.id === run.id);
		if (at >= 0) runs[at] = run;
		else runs.push(run);
		if (runs.length > MAX_RUNS) runs.splice(0, runs.length - MAX_RUNS);
		await this.save(sessionId, runs);
	}

	/** 撤回到只剩 `count` 条消息：归被撤掉那几轮的记录一起删掉。 */
	async rewind(sessionId: string, count: number): Promise<void> {
		const runs = await this.list(sessionId);
		const kept = runs.filter((run) => run.at <= count);
		if (kept.length === runs.length) return;
		runs.splice(0, runs.length, ...kept);
		await this.save(sessionId, runs);
	}

	async forget(sessionId: string): Promise<void> {
		// 等最后一次写落盘的这段时间里有人来读，读到的是空的，而不是从还没删的文件里把旧记录读回缓存。
		const empty = Promise.resolve([]);
		this.cache.set(sessionId, empty);
		await this.writes.get(sessionId)?.catch(() => {});
		this.writes.delete(sessionId);
		await rm(this.file(sessionId), { force: true });
		if (this.cache.get(sessionId) === empty) this.cache.delete(sessionId);
		this.notify(sessionId);
	}

	/** 某个会话的记录变了。 */
	onChange(listener: (sessionId: string) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(sessionId: string): void {
		for (const listener of this.listeners) listener(sessionId);
	}

	/** 同一个会话的写一个接一个：后一次写的总是内存里最新的那份。 */
	private async save(sessionId: string, runs: HookRunRecord[]): Promise<void> {
		this.notify(sessionId);
		const write = (this.writes.get(sessionId) ?? Promise.resolve())
			.catch(() => {})
			.then(async () => {
				await mkdir(this.dir, { recursive: true });
				const file = this.file(sessionId);
				const temp = `${file}.${process.pid}.tmp`;
				await writeFile(temp, JSON.stringify(runs), "utf8");
				await rename(temp, file);
			});
		this.writes.set(sessionId, write);
		await write;
	}
}
