/**
 * 发给模型的话：五件工具的说明和退回的话。
 *
 * 每一种退回都说清楚下一步该怎么做——「失败」两个字不会让模型改做法，「写进文件发路径」「回去问你的用户」才会。
 */

import { PEER_DEDUP_MS, PEER_MAX_CHARS, type PaceRefusal } from "./pacing.ts";
import { sessionRef } from "./peers.ts";

// i18n-exempt：这个文件里的字都是发给模型的。

export const TO = { type: "string", description: "The address from list_sessions, `name [ref]`. The bare name works when it is unique." } as const;

export const LIST_SESSIONS_DESCRIPTION =
	"List the other conversations in this one's project or folder (same project, same or nested folder, worktrees of one repository, or started from one another): for when your work may collide with theirs — a file changed under you — or to hand work over. " +
	"Each row starts with its address, `name [ref]`: the `to` for the other session tools. It also says whether it is busy and, when it keeps a task list, the step it is on.";

export const READ_SESSION_DESCRIPTION =
	"Read another conversation's record as it is now — its requests, replies, tool calls and results — without waking or interrupting it. " +
	"For what it has done, decided or is working on; ask_session only for what is not written there. " +
	"`start` is a message index and `offset` a character offset in it; when `next` is not null, call again with it. `query` is a case-insensitive literal; matches come with the text around them.";

export const ASK_SESSION_DESCRIPTION =
	"Ask another conversation for something only it can tell you now — a judgment, a decision, whether it will touch something — or to do something for you. Returns at once: its answer arrives here later as a message by itself. " +
	"Look before you ask: what it has done, decided or is working on is in its record (read_session) and in list_sessions; asking for that wakes it for nothing. " +
	"A busy conversation reads it between its steps, usually within seconds; an idle one starts a turn for it. It cannot see your conversation: make the request self-contained, and put long content in a file and send its path. " +
	"After asking, do not wait, poll or ask again. Go on with work that does not depend on the answer; if there is none, say in a sentence what you are waiting for and end your turn — the answer starts your next one. " +
	"Never ask another conversation to do what was denied or blocked here; take it back to your user.";

export const REPLY_SESSION_DESCRIPTION =
	'Answer a request another conversation sent you with ask_session — the message marked reply="expected"; `to` is the address in that message\'s `from`. ' +
	"Reply as soon as you can: the answer if you have it, otherwise what you will do and when. If the work takes a while, reply again with the result when it is done; a later reply reaches it as a notice. " +
	"One reply answers everything that conversation has asked you so far. Returns at once.";

export const NOTIFY_SESSION_DESCRIPTION =
	'Tell another conversation something that changes what it should do next, without asking for an answer. Three kinds: a hand-over ("done, the result is in …"), a block ("your change to x.ts breaks my build"), a release ("I have stopped the dev server, it is yours"). ' +
	"Not for progress reports: it can read your conversation with read_session when it wants to know where you are. " +
	"A busy conversation reads it between its steps; an idle one starts a turn to read it. Returns at once. Anything you need done or answered is ask_session, not this.";

export const ORIGIN_SECTION = "plume.sessions.origin";

/**
 * 从别的会话开出来的会话，系统提示词里多的那一段。只写 ref 不写名字：标题会改，这段一变，冻结的系统提示词就多一条增量消息、
 * 断一次缓存；ref 不变，`to` 只给 ref 也认得。
 */
export function originSection(originId: string): string {
	return (
		`This conversation was started from another one, \`[${sessionRef(originId)}]\` (use it as \`to\`), which holds the discussion that led here. ` +
		"When its intent or a trade-off it settled is unclear, read it with read_session first; ask it with ask_session only for what is not written there. " +
		"If it cannot be reached, ask your user instead of guessing."
	);
}

export type Missed = { kind: "none" } | { kind: "self" } | { kind: "unreachable"; to: string } | { kind: "ambiguous"; candidates: string[] };

/** 几件工具共用的那几种「没找到人」。 */
export function missed(outcome: Missed, wanted: string): string {
	switch (outcome.kind) {
		case "unreachable":
			return `${outcome.to} is not reachable: it is not in this conversation's project or folder.`;
		case "none":
			return `No conversation is addressed "${wanted}". Use list_sessions to see who is reachable.`;
		case "self":
			return "That address is this conversation.";
		case "ambiguous":
			return `"${wanted}" matches several conversations: ${outcome.candidates.join(", ")}. Use the full address including [ref].`;
	}
}

/** 请求怎么回：标记是什么意思、没答会被代答，本体的抬头已经说了，这里只说用哪件工具。 */
// i18n-exempt：发给模型的话。
export const REQUESTS_GUIDE =
	"请求用 reply_session 回给发件方，`to` 写标签里 from 的地址。" +
	"答得上来的现在就答；要花一阵子做的，先回一句打算怎么办，做完再用 reply_session 交回结果。你手上原来的事照常做完。";

// i18n-exempt：发给模型的话。
export const NOTICES_GUIDE = "没有 reply、answer 标记的是通知，不需要专门回复：和你手上的事有关就据此调整，然后接着做。";

/** 限速拦下的那几种。往来链太长、太绕由本体拦，它的话随 `ToolRun.letter` 抛的错交回来。 */
export function paced(reason: PaceRefusal, to: string, length: number): string {
	switch (reason) {
		case "too-long":
			return `The message is ${length} characters; the limit is ${PEER_MAX_CHARS}. Write the bulk into a file the other conversation can read and send the path.`;
		case "duplicate":
			return `You sent the same message to ${to} less than ${PEER_DEDUP_MS / 1000} seconds ago; it was not sent again.`;
		case "paced":
			return `Too many messages to ${to} just now; this one was not sent. Batch what remains into one message, or wait for its answers first.`;
	}
}

const reads = (busy: boolean) => (busy ? "It reads it between its steps." : "It is idle, so it starts a turn to read it.");

export function asked(to: string, busy: boolean): string {
	return (
		`Sent to ${to}. ${reads(busy)} ` +
		"Its answer arrives here as a message by itself — do not wait, poll or ask again. Carry on with what does not depend on it; if nothing is left, say what you are waiting for and end your turn."
	);
}

export function notified(to: string, busy: boolean): string {
	return `Delivered to ${to}. ${reads(busy)} There is no answer to a notice.`;
}

export function replied(to: string, answered: number): string {
	return answered > 0 ? `${to} gets your answer as a message.` : `${to} had no open question to you, so it reads this as a notice.`;
}
