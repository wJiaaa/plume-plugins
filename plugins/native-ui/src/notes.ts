import type { Message } from "@plume/contract";
import { component } from "./catalog.ts";
import { prepareBlock } from "./language.ts";

/** 跳过其他语言的围栏，不把示例里的 ui 围栏和标签当成已发布界面。 */
export function problemsIn(markdown: string): string[] {
	const problems: string[] = [];
	const lines = markdown.split(/\r?\n/);
	for (let at = 0; at < lines.length; at++) {
		const fence = /^\s*(\x60{3,}|~{3,})(\S*)\s*$/.exec(lines[at]!);
		if (fence) {
			const body: string[] = [];
			const close = new RegExp(`^\\s*${fence[1]![0]}{${fence[1]!.length},}\\s*$`);
			for (at++; at < lines.length && !close.test(lines[at]!); at++) body.push(lines[at]!);
			if (fence[2]!.toLowerCase() !== "ui") continue;
			const parsed = prepareBlock(body.join("\n"), true);
			if (!parsed.ok) problems.push(parsed.error);
			else if (at >= lines.length) problems.push("ui fence never closed; shown as source");
		} else {
			const tag = /^ {0,3}<([A-Z]\w*)[\s/>]/.exec(lines[at]!);
			if (tag && component(tag[1]!)) problems.push(`<${tag[1]}> outside a ui fence; shown as plain text`);
		}
	}
	return [...new Set(problems)].slice(0, 8);
}

/** 只在下一条真实用户消息的请求副本里加诊断，不写转录、不自行唤起模型，历史相同则字节相同。 */
export function withInterfaceNotes(messages: Message[]): Message[] {
	let out = messages;
	let problems = new Set<string>();
	for (let at = 0; at < messages.length; at++) {
		const message = messages[at]!;
		if (message.role === "assistant" && (message.stopReason === "stop" || message.stopReason === "toolUse")) {
			for (const block of message.content)
				if (block.type === "text")
					for (const problem of problemsIn(block.text)) {
						if (problems.size < 8) problems.add(problem);
					}
		}
		if (message.role !== "user" || message.synthetic) continue;
		if (problems.size) {
			const note = `<env>\nThe previous reply's native UI could not render as written. Read ui_help before the next block:\n${[...problems].map((problem) => `- ${problem}`).join("\n")}\n</env>`;
			if (!message.content.some((part) => part.type === "text" && part.text === note)) {
				if (out === messages) out = [...messages];
				out[at] = { ...message, content: [...message.content, { type: "text", text: note }] };
			}
		}
		problems = new Set();
	}
	return out;
}
