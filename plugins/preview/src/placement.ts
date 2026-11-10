import type { Message } from "@plume/contract";

export type Placement = { waiting: true } | { publishedBy: string } | { publishing: true };

/** 同轮的检查和发布共用原位置；重查截图不抢走带 HTML 的草稿位置。 */
export function placements(messages: readonly Message[], running: boolean): Map<string, Placement> {
	const out = new Map<string, Placement>();
	const checks = new Map<string, { call: string; turn: number }>();
	const content = new Set<string>();
	const failed = new Set(messages.flatMap((m) => (m.role === "toolResult" && m.isError ? [m.toolCallId] : [])));
	let turn = 0;
	let latest: { call: string; check: boolean; over: boolean } | undefined;
	for (const message of messages) {
		if (message.role === "user" && !message.synthetic) {
			turn++;
			latest = undefined;
		}
		if (message.role === "toolResult") {
			const d = message.details as { kind?: string; id?: unknown } | undefined;
			if (!message.isError && d?.kind === "preview-check" && typeof d.id === "string" && content.has(message.toolCallId))
				checks.set(d.id, { call: message.toolCallId, turn });
			continue;
		}
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || block.name !== "preview") continue;
			const args = block.arguments;
			const raw = (block as typeof block & { argumentsText?: string }).argumentsText ?? "";
			const check = args.check === true || /(?<!\\)"check"\s*:\s*true/.test(raw);
			const partial = /(?<!\\)"id"\s*:\s*"([^"\\]*)("?)/.exec(raw);
			const id = typeof args.id === "string" ? args.id : partial ? (partial[2] ? partial[1] : "") : undefined;
			if (id === undefined) {
				if (Object.keys(args).length || /"[^"\\]*"\s*:/.test(raw)) {
					content.add(block.id);
					latest = { call: block.id, check, over: false };
				}
				continue;
			}
			if (!id && latest?.check) {
				out.set(block.id, { publishing: true });
				continue;
			}
			const source = checks.get(id);
			if (!check && source?.turn === turn) {
				out.set(block.id, { publishing: true });
				if (!failed.has(block.id)) out.set(source.call, { publishedBy: block.id });
				if (latest?.call === source.call) latest.over = true;
			}
		}
		if (latest && ["stop", "length", "error", "aborted"].includes(message.stopReason)) latest.over = true;
	}
	if (running && latest?.check && !latest.over && !failed.has(latest.call)) out.set(latest.call, { waiting: true });
	return out;
}
