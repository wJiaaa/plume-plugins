import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkinStudioApi } from "./api.ts";
import { PRESETS } from "./presets.ts";
import { defaultMode, parseSkin, type StudioSkin, type StudioView } from "./types.ts";

interface Library {
	custom: StudioSkin[];
	activeId: string | null;
}

/** 串行、原子写入；坏文件让加载失败，不当空库覆盖。 */
export async function createStudioStore(dataDir: string, signal: AbortSignal): Promise<SkinStudioApi> {
	const file = join(dataDir, "skins.json");
	let state: Library = { custom: [], activeId: null };
	try {
		const raw: unknown = JSON.parse(await readFile(file, "utf8"));
		if (!raw || typeof raw !== "object") throw new Error("invalidLibrary");
		const candidate = raw as Record<string, unknown>;
		if (!Array.isArray(candidate.custom) || candidate.custom.length > 200 || (candidate.activeId !== null && typeof candidate.activeId !== "string")) {
			throw new Error("invalidLibrary");
		}
		const custom = candidate.custom.map((entry: unknown): StudioSkin => {
			const skin = parseSkin(entry);
			const id = (entry as Record<string, unknown>).id;
			if (typeof id !== "string" || !/^custom-[\da-f-]{36}$/.test(id)) throw new Error("invalidLibrary");
			return { ...skin, id, builtin: false };
		});
		if (new Set(custom.map((skin) => skin.id)).size !== custom.length) throw new Error("invalidLibrary");
		if (candidate.activeId !== null && !defaultMode(candidate.activeId) && ![...PRESETS, ...custom].some((skin) => skin.id === candidate.activeId))
			throw new Error("invalidLibrary");
		state = { custom, activeId: candidate.activeId as string | null };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("invalidLibrary", { cause: error });
	}
	let queue: Promise<unknown> = Promise.resolve();
	const listeners = new Set<() => void>();
	const snapshot = (): StudioView => structuredClone({ skins: [...PRESETS, ...state.custom], activeId: state.activeId });
	const change = (edit: (current: Library) => Library): Promise<StudioView> => {
		const next = queue.then(async () => {
			signal.throwIfAborted();
			const changed = edit(structuredClone(state));
			await writeFile(`${file}.tmp`, `${JSON.stringify(changed, null, "\t")}\n`);
			await rename(`${file}.tmp`, file);
			state = changed;
			for (const listener of listeners) listener();
			return snapshot();
		});
		queue = next.catch(() => undefined);
		return next;
	};
	const add = (current: Library, value: unknown, apply: boolean): Library => {
		if (current.custom.length >= 200) throw new Error("tooMany");
		const skin: StudioSkin = { ...parseSkin(value), id: `custom-${randomUUID()}`, builtin: false };
		return { custom: [...current.custom, skin], activeId: apply ? skin.id : current.activeId };
	};
	return {
		view: () => queue.then(snapshot),
		async *watch(call) {
			const stop = AbortSignal.any([signal, call.signal]);
			let dirty = true;
			let wake: (() => void) | undefined;
			const changed = () => {
				dirty = true;
				wake?.();
			};
			listeners.add(changed);
			stop.addEventListener("abort", changed, { once: true });
			try {
				while (!stop.aborted) {
					if (!dirty)
						await new Promise<void>((resolve) => {
							wake = resolve;
						});
					wake = undefined;
					if (stop.aborted) break;
					dirty = false;
					yield snapshot();
				}
			} finally {
				listeners.delete(changed);
				stop.removeEventListener("abort", changed);
			}
		},
		apply: (id) =>
			change((current) => {
				if (id !== null && !defaultMode(id) && ![...PRESETS, ...current.custom].some((skin) => skin.id === id)) throw new Error("missingSkin");
				return { ...current, activeId: id };
			}),
		save: (value, apply) => change((current) => add(current, value, apply === true)),
		saveCurrent: (name) =>
			change((current) => {
				const active = [...PRESETS, ...current.custom].find((skin) => skin.id === current.activeId);
				if (!active) throw new Error("noCurrent");
				return add(current, { ...active, name }, true);
			}),
		remove: (id) =>
			change((current) => {
				if (defaultMode(id) || PRESETS.some((skin) => skin.id === id)) throw new Error("builtinSkin");
				if (!current.custom.some((skin) => skin.id === id)) throw new Error("missingSkin");
				return { custom: current.custom.filter((skin) => skin.id !== id), activeId: current.activeId === id ? null : current.activeId };
			}),
	};
}
