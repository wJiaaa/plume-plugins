/**
 * 信寄出去以后的账：哪几问还没拿到答复、各进了对方哪一轮，每个会话这一轮接着哪条往来链。
 * 信本身由本体送（`ToolRun.letter`），这里只记账、到时候代答。
 *
 * 答复总会到：对方读到请求的那一轮收场了还没回，拿那一轮最后说的话代它答（`unreplied`）；请求没读到就被对方的人停下了，
 * 代它说「没读到」（`dropped`）；对方删掉了，说「关了」（`closed`）。发件方问完多半已经收尾等着，什么都不送它就永远等下去。
 * 代答钉住读到信的那一轮：读到以后它的下一个 `turnEnd` 就是那一轮收场，不等对方下一次空闲——那之前它可能又跑了好几轮，
 * 最后一句回答的是别人。
 *
 * 往来链记在一轮上：这一轮里发出去的信，接的是叫起这一轮的那几封信的链（`LetterFate.opened`），插进一轮已经在跑的信不接
 * ——几个会话各跑一个长回合、互相递信时，每封都给链加一跳，正常协作半小时就撞上链长上限。人在这一轮里开口之后清空。
 */

import type { LetterInput, LetterReceipt, Logger, Message, TurnStop } from "@plume/contract";
import { lastReply } from "./history.ts";
import { PeerPacer, type PaceRefusal } from "./pacing.ts";

/** 代答时带过去的对方最后那段话最多几个字：够读结论，长报告该让对方写进文件。 */
export const REPLY_LIMIT = 4000;
/** 一个发件方对同一个收件方最多记几封还没答的问；再多就是在刷，旧的忘掉。 */
const OUTSTANDING_PER_PAIR = 8;

/** 请求怎么回：本体的抬头已经说了它不是用户的话，这里只说怎么处理。 */
// i18n-exempt：发给模型的话。
export const REQUESTS_GUIDE =
	'标着 reply="expected" 的是请求，发件方要你的答复：用 reply_session 回给它，`to` 写标签里 from 的地址。' +
	"答得上来的现在就答；要花一阵子做的，先回一句打算怎么办，做完再用 reply_session 交回结果。你手上原来的事照常做完。";

// i18n-exempt：发给模型的话。
export const ANSWERS_GUIDE =
	"标着 answer 的是你之前用 ask_session 问过的会话交回的答复，re 是你当时问的话的开头：据此接着做。" +
	'answer="unreplied" 是对方没用 reply_session 回，正文是它读到你的问题那一轮最后说的话，未必对着你的问题；' +
	'answer="dropped" 是请求没被对方读到（对方的人在它读到之前按了停），answer="closed" 是对方会话关了——这两种都没有答复，要再问先告诉你的用户。';

// i18n-exempt：发给模型的话。
export const NOTICES_GUIDE = "没有 reply、answer 标记的是通知，不需要专门回复：和你手上的事有关就据此调整，然后接着做。";

const DROPPED = "Its user stopped it before it read your message. Nothing was read and nothing will be answered.";
const CLOSED = "That session was closed before it answered.";

/** 一封还没拿到答复的问。收件方的地址和目录在发出时记下：它删掉以后还要替它说一句。 */
interface Asked {
	id: string;
	text: string;
	/** 发出时的往来链，含发件方自己：代答的信接在它后面。 */
	chain: string[];
	asker: string;
	target: { id: string; address: string };
	receipt: LetterReceipt;
	/** 进了对方的对话。 */
	read: boolean;
}

export type Answer = NonNullable<LetterInput["answer"]>;

export class PeerRouter {
	private readonly pacer: PeerPacer;
	/** 每个会话正在跑的这一轮接着的往来链；没在跑、或这一轮不是信叫起来的，就没有。 */
	private readonly chains = new Map<string, string[]>();
	/** 问出去、还没拿到答复的，按发出的顺序。 */
	private outstanding: Asked[] = [];

	private readonly messages: (sessionId: string) => Promise<Message[]>;
	private readonly log: Pick<Logger, "warn">;

	constructor(messages: (sessionId: string) => Promise<Message[]>, log: Pick<Logger, "warn">) {
		this.messages = messages;
		this.log = log;
		this.pacer = new PeerPacer();
	}

	/** 从 `fromId` 这一刻寄出的信所在的链，含它自己。 */
	chain(fromId: string): string[] {
		return [...(this.chains.get(fromId) ?? []), fromId];
	}

	/** 限速、去重、链长，过了就记账。 */
	admit(fromId: string, toId: string, text: string, chain: readonly string[]): PaceRefusal | null {
		return this.pacer.admit(fromId, toId, text, chain);
	}

	/** 寄出的每一封都过这里：它叫起了对方一轮，对方这一轮就接着它的链。 */
	sent(receipt: LetterReceipt, toId: string, chain: string[]): void {
		void receipt.read.then((fate) => {
			if (fate.status !== "read" || !fate.opened) return;
			// 一批里几封都叫起了这一轮时取最长的那条：链是防两边原地来回的，宁可多算一跳。
			if (chain.length > (this.chains.get(toId)?.length ?? 0)) this.chains.set(toId, chain);
		});
	}

	/** 一封问寄出去了（已经过了 `sent`）：记下，等它的下落。 */
	asked(receipt: LetterReceipt, input: { text: string; chain: string[]; asker: string; target: { id: string; address: string } }): void {
		const mine = this.outstanding.filter((one) => one.asker === input.asker && one.target.id === input.target.id);
		// 刷到上限的，最旧的那封不再记：它的答复照样会写，只是不再有人为它代答。
		if (mine.length >= OUTSTANDING_PER_PAIR) this.outstanding = this.outstanding.filter((one) => one !== mine[0]);
		const asked: Asked = { id: receipt.id, ...input, receipt, read: false };
		this.outstanding.push(asked);
		void receipt.read.then((fate) => {
			if (!this.outstanding.includes(asked)) return;
			if (fate.status === "read") asked.read = true;
			else this.answerEach([asked], fate.status, fate.status === "dropped" ? DROPPED : CLOSED);
		});
	}

	/** `replierId` 读到了、还没答的、`askerId` 问它的那几封：`reply_session` 一起答掉。 */
	answerable(replierId: string, askerId: string): string[] {
		return this.outstanding.filter((one) => one.asker === askerId && one.target.id === replierId && one.read).map((one) => excerpt(one.text));
	}

	/** `reply_session` 答掉了这几封。 */
	replied(replierId: string, askerId: string): void {
		this.settle(this.outstanding.filter((one) => one.asker === askerId && one.target.id === replierId && one.read));
	}

	/** 人在这个会话里开口了：之后它发出去的信是一条新链，不再接着别人的那条。 */
	personSpoke(sessionId: string): void {
		this.chains.delete(sessionId);
	}

	/** 这个会话的一轮收场了：读到了却没回的，拿那一轮最后说的话代答。 */
	turnEnded(sessionId: string, stop: TurnStop): void {
		this.chains.delete(sessionId);
		const asked = this.outstanding.filter((one) => one.target.id === sessionId && one.read);
		if (asked.length === 0) return;
		void (async () => {
			const messages = await this.messages(sessionId).catch(() => [] as Message[]);
			// 等消息的这一下里可能已经回了，只代答还挂着的。
			const still = asked.filter((one) => this.outstanding.includes(one));
			const early = stop.reason === "done" ? "" : `[The turn that read your message ended early (${stop.reason}).]\n`;
			for (const one of still) {
				const at = messages.findIndex((message) => message.role === "user" && message.peer?.some((letter) => letter.id === one.id));
				const said = clip(lastReply(messages, at < 0 ? messages.length : at + 1));
				this.answerEach([one], "unreplied", `${early}${said || "(It said nothing.)"}`);
			}
		})().catch((error: unknown) => this.log.warn(`代答没送出去：${String(error)}`));
	}

	/** 会话删掉了：问它的、已经读到还没答的，替它说一句「关了」（没读到的由本体告诉 `closed`）；它自己问出去的不再等。 */
	deleted(sessionId: string): void {
		this.chains.delete(sessionId);
		const toIt = this.outstanding.filter((one) => one.target.id === sessionId && one.read);
		if (toIt.length > 0) this.answerEach(toIt, "closed", CLOSED);
		this.settle(this.outstanding.filter((one) => one.asker === sessionId));
	}

	private settle(asked: Asked[]): void {
		this.outstanding = this.outstanding.filter((one) => !asked.includes(one));
	}

	/** 按发件方分组，一家一封代答：几家问了同一个会话，各收各的。 */
	private answerEach(asked: Asked[], how: Answer, text: string): void {
		this.settle(asked);
		for (const asker of new Set(asked.map((one) => one.asker))) {
			const theirs = asked.filter((one) => one.asker === asker);
			const longest = theirs.reduce<string[]>((chain, one) => (one.chain.length > chain.length ? one.chain : chain), []);
			const chain = [...longest, theirs[0]!.target.id];
			const letter: LetterInput = {
				from: theirs[0]!.target.address,
				text,
				answer: how,
				re: theirs.map((one) => excerpt(one.text)),
				chain,
				guide: ANSWERS_GUIDE,
			};
			try {
				const receipt = theirs[0]!.receipt.answer(letter);
				if (receipt) this.sent(receipt, asker, chain);
			} catch (error) {
				this.log.warn(`代答没送出去：${String(error)}`);
			}
		}
	}
}

/** 太长的截掉，说明截了多少、怎么拿到其余的部分。 */
function clip(text: string): string {
	if (text.length <= REPLY_LIMIT) return text;
	return `${text.slice(0, REPLY_LIMIT)}\n[cut after ${REPLY_LIMIT} characters; ${text.length - REPLY_LIMIT} more not shown. Read the rest with read_session.]`;
}

/** 一封信开头的一截，够认出是哪封。 */
function excerpt(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return [...line].length > 60 ? `${[...line].slice(0, 60).join("")}…` : line;
}
