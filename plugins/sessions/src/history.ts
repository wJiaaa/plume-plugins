/**
 * 把一个会话的记录读成给模型的文字：一页一页翻（`readHistory`）。
 *
 * 和侧边聊天的 `read_main_chat` 是同一种读法、同一套参数：插件之间不共用代码，这里各留一份，改了两边一起改。
 */

import type { ChecklistDetails, ChecklistItem, Message } from "@plume/contract";

/** 一次最多带回多少字：和侧边聊天每一问附上的主会话一样多。 */
export const READ_LIMIT = 12_000;

// i18n-exempt：这个文件里的字都是发给模型的。

/** 一条消息原样写成文字，不丢东西；图片只说那里有一张。 */
function messageText(message: Message): string {
	const who =
		message.role === "toolResult" ? `tool result ${message.toolName}` : message.role === "assistant" ? "assistant" : message.synthetic ? "system note" : "user";
	const blocks = message.content.map((block) => {
		switch (block.type) {
			case "text":
				return block.text;
			case "image":
				return "[image]";
			case "thinking":
				return block.thinking ? `[thinking]\n${block.thinking}` : "[no visible thinking]";
			case "toolCall":
				return `[tool call ${block.name}]\n${JSON.stringify(block.arguments)}`;
			default:
				return "";
		}
	});
	return `[${who}]\n${blocks.join("\n")}`;
}

export interface HistoryArgs {
	start?: number;
	offset?: number;
	limit?: number;
	maxChars?: number;
	query?: string;
}

export const HISTORY_PROPERTIES = {
	start: { type: "integer", minimum: 0 },
	offset: { type: "integer", minimum: 0 },
	limit: { type: "integer", minimum: 1, maximum: 30 },
	maxChars: { type: "integer", minimum: 1, maximum: READ_LIMIT },
	query: { type: "string" },
};

/** 参数不对时给模型的话；对的返回 undefined。 */
export function invalidHistoryArgs(args: Record<string, unknown>): string | undefined {
	for (const key of ["start", "offset", "limit", "maxChars"] as const) {
		const value = args[key];
		if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < (key === "limit" || key === "maxChars" ? 1 : 0))) {
			return `${key} must be a non-negative integer (limit and maxChars at least 1).`;
		}
	}
	if (args.query !== undefined && typeof args.query !== "string") return "query must be a string.";
	return undefined;
}

/** 那个会话此刻的一页：从第 `start` 条起，或者只看含 `query` 的，最多 `charLimit` 字；`next` 说从哪接着读。 */
export function readHistory(sessionId: string, messages: readonly Message[], args: HistoryArgs, charLimit = READ_LIMIT): string {
	const start = args.start ?? 0;
	const query = args.query?.trim().toLowerCase();
	const entries: { index: number; role: Message["role"]; offset: number; totalChars: number; text: string }[] = [];
	let remaining = Math.min(args.maxChars ?? charLimit, charLimit);
	let next: { start: number; offset?: number; query?: string } | null = null;
	for (let index = start; index < messages.length; index++) {
		const text = messageText(messages[index] as Message);
		const match = query ? text.toLowerCase().indexOf(query) : 0;
		if (match < 0) continue;
		const offset = index === start && args.offset !== undefined ? args.offset : Math.max(0, match - 160);
		const excerpt = text.slice(offset, offset + remaining);
		entries.push({ index, role: (messages[index] as Message).role, offset, totalChars: text.length, text: excerpt });
		remaining -= excerpt.length;
		if (offset + excerpt.length < text.length) {
			next = { start: index, offset: offset + excerpt.length, ...(query ? { query } : {}) };
			break;
		}
		if (remaining === 0 || entries.length >= Math.min(args.limit ?? 10, 30)) {
			if (index + 1 < messages.length) next = { start: index + 1, ...(query ? { query } : {}) };
			break;
		}
	}
	return JSON.stringify({ sessionId, totalMessages: messages.length, messages: entries, next });
}

/**
 * 它清单上正在做的那一项：最新一份进度清单里 `in_progress` 的那条。列出会话时据此说它在做什么。
 * 清单认工具结果 `details` 里的 `checklist`（`ChecklistDetails`，会话里最新一条成功的那份算数），不认是哪个工具记的。
 */
export function currentStep(messages: readonly Message[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "toolResult" || message.isError) continue;
		const checklist = (message.details as Partial<ChecklistDetails> | undefined)?.checklist;
		if (!Array.isArray(checklist)) continue;
		const step = checklist.find(
			(item): item is ChecklistItem =>
				typeof item === "object" && item !== null && item.status === "in_progress" && typeof (item as { content?: unknown }).content === "string",
		);
		return step?.content;
	}
	return undefined;
}
