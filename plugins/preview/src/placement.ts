import type { Message } from "@plume/contract";

export type Placement = { waiting: true } | { publishedBy: string } | { publishing: true };

/** 带着页面内容（html、files）：写的时候在这里画草稿，检查后同轮按 id 发布的网页也交接到这里。参数还在写时看原文里有没有这两个键。 */
function carriesPage(args: Record<string, unknown>, raw: string | undefined): boolean {
	return "html" in args || "files" in args || /(?<!\\)"(?:html|files)"\s*:/.test(raw ?? "");
}

/**
 * 这次调用只画一行、并进前后的活（`ui.toolCard` 的 `inline`）：不带页面内容的截图检查（path、按 id 重查切片）。
 * 参数还在写（`args` 还是空的）时先当作检查，写出页面内容就单独一行；写完了不是检查的（发布）也单独一行，画网页。
 */
export function inlineCall(args: Record<string, unknown>, raw: string | undefined): boolean {
	return !carriesPage(args, raw) && (args.check === true || Object.keys(args).length === 0);
}

/** 同轮的检查和发布共用原位置；重查截图不抢走带 HTML 的草稿位置。path 的检查只画一行、并在一段活里，不当发布的原位置。 */
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
				if (carriesPage(args, raw)) {
					content.add(block.id);
					latest = { call: block.id, check, over: false };
				} else if (Object.keys(args).length || /"[^"\\]*"\s*:/.test(raw)) latest = undefined;
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
