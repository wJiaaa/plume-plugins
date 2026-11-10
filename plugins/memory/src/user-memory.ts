/**
 * 用户记忆：跟着人走的偏好和习惯，存在 `memory.json`，现在只有人在设置里加。
 */

import { join } from "node:path";
import type { MemoryEntry } from "./api.ts";
import { inTurn, readText, writeAtomic } from "./files.ts";

export function memoryFile(dataDir: string): string {
	return join(dataDir, "memory.json");
}

/**
 * 读出来的记忆，以及它是不是可信的空。
 *
 * 文件不存在是真的空；读不出或解析不了是**不知道**里面有什么。两者都返回空的话，下一次增删把 `[新条目]` 整份写回，
 * 旧记忆一声不响全没了。注入照旧当成空（不能因为记忆坏了就开不了会话），写入要分开。
 */
async function readMemory(dataDir: string): Promise<{ entries: MemoryEntry[]; unreadable?: unknown }> {
	let raw: string | null;
	try {
		raw = await readText(memoryFile(dataDir));
	} catch (error) {
		return { entries: [], unreadable: error };
	}
	if (raw === null || !raw.trim()) return { entries: [] };
	try {
		const parsed = JSON.parse(raw) as { entries?: unknown };
		if (!Array.isArray(parsed.entries)) return { entries: [], unreadable: new Error("entries is not a list") };
		return { entries: parsed.entries as MemoryEntry[] };
	} catch (error) {
		return { entries: [], unreadable: error };
	}
}

export async function loadMemory(dataDir: string): Promise<MemoryEntry[]> {
	return (await readMemory(dataDir)).entries;
}

/** 要改之前读：读不出就停下，不拿一个空列表去覆盖它。 */
async function loadForWrite(dataDir: string, unreadable: (file: string, reason: string) => string): Promise<MemoryEntry[]> {
	const read = await readMemory(dataDir);
	if (read.unreadable) throw new Error(unreadable(memoryFile(dataDir), read.unreadable instanceof Error ? read.unreadable.message : String(read.unreadable)));
	return read.entries;
}

async function save(dataDir: string, entries: MemoryEntry[]): Promise<void> {
	await writeAtomic(memoryFile(dataDir), JSON.stringify({ entries }, null, 2));
}

export interface UserMemoryErrors {
	empty: string;
	unreadable: (file: string, reason: string) => string;
}

export function addMemoryEntry(dataDir: string, content: string, errors: UserMemoryErrors): Promise<MemoryEntry> {
	const trimmed = content.trim();
	if (!trimmed) return Promise.reject(new Error(errors.empty));
	return inTurn(memoryFile(dataDir), async () => {
		const entries = await loadForWrite(dataDir, errors.unreadable);
		const now = Date.now();
		const entry: MemoryEntry = { id: `mem_${now}_${Math.random().toString(36).slice(2, 7)}`, content: trimmed, createdAt: now, updatedAt: now, source: "user" };
		await save(dataDir, [entry, ...entries]);
		return entry;
	});
}

export function removeMemoryEntry(dataDir: string, id: string, errors: UserMemoryErrors): Promise<boolean> {
	return inTurn(memoryFile(dataDir), async () => {
		const entries = await loadForWrite(dataDir, errors.unreadable);
		const next = entries.filter((entry) => entry.id !== id);
		if (next.length === entries.length) return false;
		await save(dataDir, next);
		return true;
	});
}

export function clearAllMemory(dataDir: string): Promise<void> {
	return inTurn(memoryFile(dataDir), () => save(dataDir, []));
}

/** 放进系统提示词的那一段；没有记忆时是空的。 */
export function formatMemoryForPrompt(entries: MemoryEntry[]): string {
	if (entries.length === 0) return "";
	const list = entries.map((entry) => `- ${entry.content}`).join("\n");
	return `<user_memory>\nRelevant user preferences, facts, and persistent memory learned across sessions:\n${list}\n</user_memory>`;
}
