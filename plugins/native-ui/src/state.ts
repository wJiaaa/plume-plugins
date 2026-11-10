import { record } from "./data.ts";
import { validateValues, type Block, type Values } from "./language.ts";

export interface BlockState {
	values: Values;
	tabs: Record<string, string>;
	sent?: { payload: string; button: string; values: Values };
}
const KEY = "plume-native-ui-state";
const KEEP = 200;
// 存储不可用时，复制仍须拿到当前窗口里刚改的值。
const live = new Map<string, BlockState>();

/** 按会话及原文保存；修改声明后不沿用旧表单，重开相同回复时恢复。 */
export function stateKey(sessionId: string, source: string): string {
	let hash = 0x811c9dc5;
	for (let at = 0; at < source.length; at++) hash = Math.imul(hash ^ source.charCodeAt(at), 0x01000193);
	return `${sessionId}:${(hash >>> 0).toString(36)}`;
}
function read(): [string, BlockState][] {
	try {
		const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
		if (!Array.isArray(saved)) return [];
		return saved
			.filter((entry): entry is [string, BlockState] => {
				if (!Array.isArray(entry) || typeof entry[0] !== "string" || !record(entry[1])) return false;
				const state = entry[1];
				return (
					record(state.values) &&
					record(state.tabs) &&
					Object.values(state.tabs).every((value) => typeof value === "string") &&
					(state.sent === undefined ||
						(record(state.sent) && typeof state.sent.payload === "string" && typeof state.sent.button === "string" && record(state.sent.values)))
				);
			})
			.slice(0, KEEP);
	} catch {
		return [];
	}
}
export function recall(key: string, block: Block): BlockState {
	const saved = live.get(key) ?? read().find(([id]) => id === key)?.[1];
	if (saved) {
		try {
			validateValues(block, { ...block.initial, ...saved.values });
			return saved;
		} catch {
			/* 存储不可信，不能让损坏的值使整段界面无法使用。 */
		}
	}
	return { values: {}, tabs: {} };
}
export function remember(key: string, state: BlockState): void {
	live.delete(key);
	live.set(key, state);
	if (live.size > KEEP) live.delete(live.keys().next().value!);
	try {
		localStorage.setItem(KEY, JSON.stringify([[key, state], ...read().filter(([id]) => id !== key)].slice(0, KEEP)));
	} catch {
		/* 存储满或不可用时仍允许当前界面交互。 */
	}
}
