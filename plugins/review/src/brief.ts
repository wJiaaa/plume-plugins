/**
 * 交给审阅会话的那份交接单：原会话填的字段、从记录里取的原文，排成审阅会话的第一句话。
 *
 * 写成必填字段、逐项卡长度，而不是一段自由的「实现总结」：一段总结模型一句话就能打发，而审阅者缺的正是那一句话没说的前因后果。
 * 缺哪项、哪项太短，退回去点名，让它补齐重发。计划（向服务 `session.plan` 要）和用户原话（从记录里取）都用原文，不让模型转述：转述会被改写、截短，漏写的约束审阅者就无从知道。
 * 排版照任务说明的顺序——你是谁、背景、决定与原话、计划、实现、文件、不做的、没验证的、重点、目标、交付。
 */

import type { Message, UserMessage } from "@plume/contract";
import type { Messages } from "./messages.ts";
import { REVIEW_SESSION_OPENING } from "./review.ts";
import type { Effort, ReviewHandoff, ReviewSessionDetails } from "./types.ts";

/**
 * 每项的最短长度，按码点算。下限只为挡住一句话打发：背景和实现说明少于一两句话就说不清前因后果；
 * 决定和未验证允许「用户没有额外约束」「没有已知未验证的地方」这样明写的「没有」，但不收「无」。
 */
const MIN = { story: 40, decisions: 8, implementation: 40, unverified: 6, change: 4 } as const;
/** 一项写得再细也装得下；再长就是把 diff 或对话贴了进来，那两样审阅会话自己有。 */
const FIELD_MAX = 8_000;
const FILES_MAX = 200;
/** 侧栏里的名字，按码点数。 */
const TITLE_MAX = 60;
const TARGET_MAX = 2_000;
const EFFORTS = new Set<string>(["low", "medium", "high"]);

/**
 * 附上的用户原话总共多少字：大约三到六千 token，真实会话里人说的话很少超过它，超过的多半是贴进来的日志或文档。
 * 超了保留最早一条（最初的需求）和最近几条（最后的改口），中间写明省略了几条。单条先截到三千字，免得一条长日志挤掉其余所有的话。
 */
const WORDS_MAX = 12_000;
const WORD_MAX = 3_000;

type Args = Record<string, unknown>;
const length = (text: string) => [...text].length;

// i18n-exempt：这个文件里的英文都是退回给模型的话。

function clip(text: string, max: number): string {
	const points = [...text.replace(/\s+/g, " ").trim()];
	return points.length > max ? `${points.slice(0, max - 1).join("")}…` : points.join("");
}

function clipWord(text: string): string {
	const points = [...text];
	return points.length > WORD_MAX ? `${points.slice(0, WORD_MAX).join("")}…` : text;
}

/** 一项文字：缺了或太短就记进 `missing`，太长就是错。 */
function field(args: Args, key: string, min: number, missing: string[], errors: string[]): string | undefined {
	const value = args[key];
	if (value !== undefined && typeof value !== "string") {
		errors.push(`${key} must be text.`);
		return undefined;
	}
	const trimmed = (value ?? "").trim();
	if (length(trimmed) < min) {
		if (min > 0) missing.push(`${key} (${trimmed ? `${length(trimmed)} characters, at least ${min}` : "missing"})`);
		return undefined;
	}
	if (length(trimmed) > FIELD_MAX) errors.push(`${key} is ${length(trimmed)} characters; keep it to ${FIELD_MAX}.`);
	return trimmed || undefined;
}

function files(value: unknown, missing: string[], errors: string[]): ReviewHandoff["files"] {
	if (value === undefined || (Array.isArray(value) && value.length === 0)) {
		missing.push("files (missing: list each changed file with one sentence on what changed)");
		return [];
	}
	if (!Array.isArray(value)) {
		errors.push("files must be a list of { path, change }.");
		return [];
	}
	if (value.length > FILES_MAX) errors.push(`files has ${value.length} entries; keep it to ${FILES_MAX}.`);
	const result: ReviewHandoff["files"] = [];
	value.forEach((entry: unknown, at) => {
		const one = (typeof entry === "object" && entry !== null ? entry : {}) as Args;
		const path = typeof one.path === "string" ? one.path.trim() : "";
		const change = typeof one.change === "string" ? one.change.trim() : "";
		if (!path) missing.push(`files[${at}].path (missing)`);
		else if (length(change) < MIN.change)
			missing.push(`files[${at}].change for ${path} (${change ? `${length(change)} characters, at least ${MIN.change}` : "missing"})`);
		else result.push({ path, change });
	});
	return result;
}

/**
 * 交接单，或者一句说给模型听的错误：一次列出所有缺的、太短的，让它一次补齐。
 * 审 PR 时没有实现可交接，一项都不填是对的；填了任何一项就按全套校验，免得交一半。
 */
export function reviewHandoff(args: Args, pullRequest: boolean): ReviewHandoff | undefined | { error: string } {
	const keys = ["background", "decisions", "implementation", "files", "out_of_scope", "unverified", "focus"];
	if (pullRequest && keys.every((key) => args[key] === undefined)) return undefined;
	const missing: string[] = [];
	const errors: string[] = [];
	const background = field(args, "background", MIN.story, missing, errors);
	const decisions = field(args, "decisions", MIN.decisions, missing, errors);
	const implementation = field(args, "implementation", MIN.implementation, missing, errors);
	const changed = files(args.files, missing, errors);
	const outOfScope = field(args, "out_of_scope", 0, missing, errors);
	const unverified = field(args, "unverified", MIN.unverified, missing, errors);
	const focus = field(args, "focus", 0, missing, errors);
	if (errors.length > 0) return { error: errors.join(" ") };
	if (missing.length > 0 || !background || !decisions || !implementation || !unverified)
		return {
			error:
				`The hand-off is incomplete — missing or too short: ${missing.join("; ")}. ` +
				'The review session knows nothing but what you write here, so fill these in fully and call again: quote the person\'s own words in decisions, and write explicitly when there is none ("The person set no further constraints", "Nothing known unverified").',
		};
	return { background, decisions, implementation, files: changed, ...(outOfScope ? { outOfScope } : {}), unverified, ...(focus ? { focus } : {}) };
}

/** 和 `/review` 正文第 1 步认目标的规则一样：数字、`#123`，或一个拉取请求的网址。 */
function isPullRequestTarget(target: string): boolean {
	return /^#?\d+$/.test(target) || /^https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d+/.test(target);
}

function optional(value: unknown, name: string, max: number): string | undefined | { error: string } {
	if (value === undefined) return undefined;
	if (typeof value !== "string") return { error: `${name} must be text.` };
	const text = value.trim();
	if (!text) return undefined;
	return length(text) > max ? { error: `${name} is ${length(text)} characters; keep it to ${max}.` } : text;
}

/** 这次调用要什么，或者为什么用不了——说给模型听，让它改了再调。`sessionId` 等开出来以后再填。 */
export function reviewRequest(args: Args, parentTitle: string, text: Messages["brief"]): Omit<ReviewSessionDetails, "sessionId"> | { error: string } {
	const target = optional(args.target, "target", TARGET_MAX);
	if (typeof target === "object") return target;
	if (args.effort !== undefined && (typeof args.effort !== "string" || !EFFORTS.has(args.effort))) return { error: "effort must be one of low, medium, high." };
	const effort = args.effort as Effort | undefined;
	// 审 PR 没有实现可交接；其余都得有一份——审阅会话少了它，就只能从 diff 去猜这次想做什么。
	const handoff = reviewHandoff(args, Boolean(target && isPullRequestTarget(target)));
	if (handoff && "error" in handoff) return handoff;
	const subject = clip(target ?? parentTitle, TITLE_MAX) || text.localChanges;
	return {
		kind: "review_session",
		title: clip(text.sessionTitle(subject), TITLE_MAX),
		subject,
		...(target ? { target } : {}),
		...(effort ? { effort } : {}),
		...(handoff ? { handoff } : {}),
	};
}

/** 人在这一条里说的话：气泡里画的字，没有就是正文里的字；图片之类没有字的不算。 */
function spoken(message: UserMessage): string {
	if (message.displayText !== undefined) return message.displayText.trim();
	return message.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("")
		.trim();
}

/**
 * 用户在原会话里说过的话，按时间顺序，原文。合成的（交回的报告、定时唤醒、「继续」）、别的会话的信、侧边聊天交过来的任务不是人说的，不算。
 * 超过 `WORDS_MAX` 时保留最早一条和放得下的最近几条，`omitted` 是中间省略的条数。
 */
export function userWords(messages: readonly Message[]): { words: { n: number; text: string }[]; omitted: number } {
	const all = messages
		.filter((message): message is UserMessage => message.role === "user" && !message.synthetic && !message.peer?.length && message.origin === undefined)
		.map(spoken)
		.filter(Boolean)
		.map((said, at) => ({ n: at + 1, text: clipWord(said) }));
	const total = all.reduce((sum, one) => sum + length(one.text), 0);
	if (total <= WORDS_MAX || all.length <= 2) return { words: all, omitted: 0 };
	const first = all[0]!;
	let room = WORDS_MAX - length(first.text);
	const recent: typeof all = [];
	// 最近的那一条总在：首条和它都截过，加起来不超过上限。
	for (let at = all.length - 1; at > 0; at--) {
		const size = length(all[at]!.text);
		if (recent.length > 0 && size > room) break;
		recent.unshift(all[at]!);
		room -= size;
	}
	return { words: [first, ...recent], omitted: all.length - 1 - recent.length };
}

/** 会话的地址，和会话互通插件（`ask_session`）认的一样：`名字 [id 前六位]`。 */
export function sessionAddress(session: { id: string; title: string; cwd: string }): string {
	const name = session.title.replace(/\s+/g, " ").replace(/[[\]]/g, "").trim() || session.cwd.split(/[\\/]/).findLast(Boolean) || "session";
	return `${name} [${session.id.replace(/-/g, "").slice(0, 6).toLowerCase()}]`;
}

/**
 * 审阅会话的第一句话。第一行让它认出自己（`/review` 正文第 0 步）；之后每一节都在，没填的写「未提供」，审阅者看得出是没有，
 * 而不是漏排了。计划、原话包在标签里（`<approved_plan>`、`<user_messages>`）：那是原文，边界要清楚。
 * `address` 为空是没有 `ask_session`：交付那一节改说不问、不修。
 */
export function reviewPrompt(
	details: Omit<ReviewSessionDetails, "sessionId">,
	plan: string | null,
	messages: readonly Message[],
	parentTitle: string,
	address: string | undefined,
	text: Messages["brief"],
): string {
	const handoff = details.handoff;
	const { words, omitted } = userWords(messages);
	const said = words.map((one, at) => {
		const gap = omitted > 0 && at === 1 ? `${text.wordsOmitted(omitted)}\n\n` : "";
		return `${gap}<user_message n="${one.n}">\n${one.text}\n</user_message>`;
	});
	const args = [details.target, details.effort ? `--effort ${details.effort}` : ""].filter(Boolean).join(" ");
	const section = (title: string, body: string) => `## ${title}\n\n${body}`;
	return [
		REVIEW_SESSION_OPENING,
		section(text.role, text.brief(parentTitle)),
		section(text.story, handoff?.background ?? text.none),
		section(
			text.decisions,
			[
				`### ${text.decisionsByAuthor}\n\n${handoff?.decisions ?? text.none}`,
				`### ${text.userWords}\n\n${text.wordsNote}\n\n${said.length > 0 ? `<user_messages>\n${said.join("\n\n")}\n</user_messages>` : text.none}`,
			].join("\n\n"),
		),
		section(text.plan, plan ? `<approved_plan>\n${plan}\n</approved_plan>` : text.noPlan),
		section(text.implementation, handoff?.implementation ?? text.none),
		section(text.files, handoff?.files.map((one) => `- \`${one.path}\` — ${one.change}`).join("\n") ?? text.none),
		section(text.outOfScope, handoff?.outOfScope ?? text.none),
		section(text.unverified, handoff?.unverified ?? text.none),
		section(text.focus, handoff?.focus ?? text.none),
		section(text.target, `Arguments: ${args || "none (the uncommitted local changes)"}\n\n${text.pipeline}`),
		section(text.deliver, address ? text.deliverText(parentTitle, address) : text.deliverNoAsk(parentTitle)),
	].join("\n\n");
}
