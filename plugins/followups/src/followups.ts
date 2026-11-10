/**
 * 下一步建议：回复末尾的 `:followup[人接下来多半会说的那句]`，界面上不画，取出来当输入框的灰字。
 *
 * 不在一轮收尾后另发一次请求去「猜人下一句」：那次请求只看得到一条指令，容易写成「继续」「提交一下」；
 * 而写回复的那一刻，模型正清楚哪一步没验、给过哪几个选项。所以让它写回复时顺手写下来：不多一次请求，
 * 写得出完整、具体的一句。
 *
 * 提示词、解析、去标记都在这一个文件里，教给模型的写法就是认得出来的写法。两个入口都用它，所以不碰 Node。
 */

import type { AssistantMessage, Message } from "@plume/contract";

const FOLLOWUP_OPEN = ":followup[";

export interface Followup {
	prompt: string;
	/** 标记结束后的位置。 */
	end: number;
}

/**
 * 写进系统提示词的那一段。
 *
 * 「不写也行」放在最前：这段每次请求都在，模型容易把它读成「每条回复都要有」，于是收尾一律挂上
 * 「继续」。宁缺毋滥是这个功能能不能用的分界。
 *
 * 「是人说的话，不是你的提问」单列一条：模型有话要问人时，会把那句问话写成「告诉我……我帮你……」
 * 塞进标记里——标记不画，问题从回复里消失了，灰字又成了模型在说话。
 */
// i18n-exempt：提示词是发给模型的，不随界面语言变。
export const FOLLOWUPS_PROMPT = `Next step hint:
When your final reply of a turn leaves an obvious next step the user is likely to take, end it with one line:
:followup[what the user would send next]
It is not shown in your reply: the app puts it in the user's empty input box as a hint they can accept with Tab. Most replies need none; a generic one is worse than none.
- Take it from what this reply leaves open: a step not yet verified, the option they would most likely pick among those you offered, the next item of what they asked for. When this reply closes a side request, what an earlier reply left waiting on them counts too.
- Write it as they would: one complete sentence in their language, specific enough to act on ("Run the login page e2e and paste the first failure", not "run the tests").
- It is their message to you, never your question or request to them. If you need something from them, ask it in the reply itself and write no hint: their answer is not yours to guess.
- Never: "continue", thanks or praise, things they did not ask about, or anything after a failure you have not explained.
- Only in the last reply of a turn, never in a reply that calls tools. Inside it, write \\] for a closing bracket.`;

/** `at` 处是不是一个写完了的标记。跨行的、方括号没收口的、空的都不算——那些照原样当字。 */
export function matchFollowup(source: string, at: number): Followup | null {
	if (!source.startsWith(FOLLOWUP_OPEN, at)) return null;
	let prompt = "";
	for (let i = at + FOLLOWUP_OPEN.length; i < source.length; i++) {
		const char = source[i];
		if (char === "\n" || char === "\r") return null;
		if (char === "\\" && i + 1 < source.length && source[i + 1] !== "\n") {
			prompt += source[++i];
			continue;
		}
		if (char === "]") return prompt.trim() ? { prompt: prompt.trim(), end: i + 1 } : null;
		prompt += char;
	}
	return null;
}

/** 一段回复里写完了的标记，按出现的顺序。代码块和行内代码里的不算：那是在讲这个写法。 */
export function followups(text: string): Followup[] {
	const found: Followup[] = [];
	if (text.includes(FOLLOWUP_OPEN)) scan(text, (followup) => found.push(followup));
	return found;
}

/**
 * 去掉标记：回复、复制，凡是给人看的地方都用这一份。
 *
 * 标记多半独占最后一行，去掉之后那一行整行拿掉、末尾的空行收掉，不然回复底下平白多出一段留白。
 * 只动有标记的那几行：别处行尾的两个空格是 Markdown 的硬换行。
 */
export function withoutFollowups(text: string): string {
	if (!text.includes(FOLLOWUP_OPEN)) return text;
	const cut: [number, number][] = [];
	scan(text, (followup, at) => cut.push([at, followup.end]));
	if (cut.length === 0) return text;
	const lines: string[] = [];
	let from = 0;
	let line = "";
	let touched = false;
	const close = () => {
		if (!touched) lines.push(line);
		else if (line.trim()) lines.push(line.trimEnd());
		line = "";
		touched = false;
	};
	for (const [start, end] of [...cut, [text.length, text.length] as [number, number]]) {
		const kept = text.slice(from, start).split("\n");
		kept.forEach((piece, index) => {
			if (index > 0) close();
			line += piece;
		});
		if (start < text.length) touched = true;
		from = end;
	}
	close();
	return lines.join("\n").trimEnd();
}

/**
 * 画出来、复制出去的回复正文：去掉写完了的标记，再拿掉末尾写到一半的那个。
 *
 * 标记写完了才认得出、才拿得掉，在那之前露出来的是一串语法，所以最后一行里从 `:f` 起像是标记开头、
 * 还没收口的部分先不画。跨了行的已经不会是标记了，照原样。宿主不告诉这段字是不是还在写，
 * 所以写完了的回复恰好停在这样半截上时也会拿掉——那本来就是没写对的标记。
 */
export function shownText(text: string): string {
	const at = unfinishedAt(text);
	// 拿掉半截以后和去掉写完的标记一样：那一行剩下空白就整行不要，末尾不留空行。
	return at === undefined ? withoutFollowups(text) : withoutFollowups(text.slice(0, at)).trimEnd();
}

/** 末尾那个还没写完的标记从哪开始；没有就是 undefined。 */
function unfinishedAt(text: string): number | undefined {
	// 每画一帧都要过一遍：最后一个 `:f` 之后已经换行了，就不可能有，省掉整段扫描。
	const last = text.lastIndexOf(FOLLOWUP_OPEN.slice(0, 2));
	if (last < 0 || text.includes("\n", last)) return undefined;
	let found: number | undefined;
	scan(
		text,
		() => {},
		(at) => {
			found = at;
		},
	);
	return found;
}

/** 一行开头的代码围栏。用字符串写：正则字面量里的反引号会让仓库的文案检查把后面的代码当成模板字符串。 */
const FENCE_OPEN = new RegExp("^[ \\t]*(`{3,}|~{3,})");

/**
 * 从头扫一遍，跳过代码围栏、行内代码和 `\` 转义；每个写完了的标记交给 `found`。给了 `unfinished` 时，
 * 碰到一个没收口、后面也没换行的标记开头就交给它并停下。
 */
function scan(text: string, found: (followup: Followup, at: number) => void, unfinished?: (at: number) => void): void {
	let i = 0;
	let lineStart = true;
	while (i < text.length) {
		if (lineStart) {
			const fence = FENCE_OPEN.exec(text.slice(i, i + 64));
			if (fence) {
				i = fenceEnd(text, i, fence[1] ?? "```");
				continue;
			}
		}
		const char = text[i];
		lineStart = char === "\n";
		if (char === "\\") {
			i += 2;
			continue;
		}
		if (char === "`") {
			let width = 1;
			while (text[i + width] === "`") width++;
			const close = text.indexOf("`".repeat(width), i + width);
			i = close >= 0 ? close + width : i + width;
			continue;
		}
		if (char === ":") {
			const followup = matchFollowup(text, i);
			if (followup) {
				found(followup, i);
				i = followup.end;
				continue;
			}
			if (unfinished && text.startsWith(FOLLOWUP_OPEN.slice(0, 2), i)) {
				const rest = text.slice(i);
				if ((rest.startsWith(FOLLOWUP_OPEN) || FOLLOWUP_OPEN.startsWith(rest)) && !rest.includes("\n")) {
					unfinished(i);
					return;
				}
			}
		}
		i++;
	}
}

/** 围栏收口那一行之后的位置；没收口就是全文末尾。 */
function fenceEnd(text: string, at: number, marker: string): number {
	const close = new RegExp(`^[ \\t]*${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`);
	let line = text.indexOf("\n", at);
	while (line >= 0) {
		const next = text.indexOf("\n", line + 1);
		if (close.test(text.slice(line + 1, next < 0 ? text.length : next))) return next < 0 ? text.length : next + 1;
		line = next;
	}
	return text.length;
}

/**
 * 从末尾往回找最近一条回复；中间隔着人说的话就没有——人已经接过话了，那条回复的下一步不再是下一步。
 * 运行时塞进来的消息（续跑提醒、送达的报告、同伴的来信）不算人开口。
 */
function latestReply(messages: readonly Message[]): AssistantMessage | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message) continue;
		if (message.role === "assistant") return message;
		if (message.role === "user" && !message.synthetic && !message.peer?.length && !message.delivery?.length) return null;
	}
	return null;
}

/**
 * 写完了的那条回复里的下一步建议；还在写、或者停在工具调用上的不算。
 *
 * 同一条回复里先播报（`commentary`）、再收尾答复（`final_answer`）时，答复会把播报过的话再说一遍，
 * 只读答复那份，免得同一个标记数两次、取到播报里的那个。
 */
export function nextFollowup(messages: readonly Message[]): string | undefined {
	const reply = latestReply(messages);
	if (!reply || reply.stopReason === "pending" || reply.stopReason === "toolUse") return undefined;
	const answered = reply.content.some((block) => block.type === "text" && block.phase === "final_answer" && block.text.trim() !== "");
	const text = reply.content
		.map((block) => (block.type === "text" && !(answered && block.phase === "commentary") ? block.text : undefined))
		.filter((piece): piece is string => piece !== undefined)
		.join("\n\n");
	return followups(text)[0]?.prompt;
}
