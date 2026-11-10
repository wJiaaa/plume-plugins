/**
 * 三个开关，存在插件数据目录的 `settings.json`。用户记忆和项目记忆默认开（只在本机读写），后台总结默认关（要把会话发给模型）。
 * 同一份文件里还有后台总结用的模型（设置 › 智能体里选），没选就用新会话的默认模型。
 */

import { join } from "node:path";
import type { MemorySettings } from "./api.ts";
import { inTurn, readText, writeAtomic } from "./files.ts";

export const DEFAULT_SETTINGS: MemorySettings = { user: true, project: true, extraction: false };

export async function createSettings(dataDir: string) {
	const file = join(dataDir, "settings.json");
	let current = { ...DEFAULT_SETTINGS };
	let model: string | undefined;
	try {
		const raw = JSON.parse((await readText(file)) ?? "{}") as Partial<Record<keyof MemorySettings | "model", unknown>>;
		for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof MemorySettings)[]) if (typeof raw[key] === "boolean") current[key] = raw[key];
		if (typeof raw.model === "string" && raw.model) model = raw.model;
	} catch {
		// 读不出就用默认值；下次改开关时整份写回。
	}
	const write = (next: MemorySettings, nextModel: string | undefined) =>
		writeAtomic(file, JSON.stringify({ ...next, ...(nextModel ? { model: nextModel } : {}) }, null, 2));
	return {
		get: (): MemorySettings => current,
		set(change: Partial<MemorySettings>): Promise<MemorySettings> {
			return inTurn(file, async () => {
				const next = { ...current };
				for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof MemorySettings)[]) if (typeof change[key] === "boolean") next[key] = change[key];
				await write(next, model);
				current = next;
				return current;
			});
		},
		model: (): string | undefined => model,
		setModel(next: unknown): Promise<void> {
			const value = typeof next === "string" && next ? next : undefined;
			return inTurn(file, async () => {
				await write(current, value);
				model = value;
			});
		},
	};
}
