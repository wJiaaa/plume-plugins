/**
 * 信寄出去以后插件还要管的账：每个会话这一轮接着哪条往来链，和发得太快、太长、太绕的拦下来（`pacing.ts`）。
 * 信本身由本体送（`ToolRun.letter`）；请求和答复的配对、收件方没答时的代答也归本体（见 `LetterReceipt`），这里不记。
 *
 * 往来链记在一轮上：这一轮里发出去的信，接的是叫起这一轮的那几封信的链（`LetterFate.opened`），插进一轮已经在跑的信不接
 * ——几个会话各跑一个长回合、互相递信时，每封都给链加一跳，正常协作半小时就撞上链长上限。人在这一轮里开口之后清空。
 * 只认这里寄出的信：本体代答的那封插件拿不到回执，它叫起的那一轮从头算。
 */

import type { LetterReceipt } from "@plume/contract";
import { PeerPacer, type PaceRefusal } from "./pacing.ts";

/** 请求怎么回：标记是什么意思、没答会被代答，本体的抬头已经说了，这里只说用哪件工具。 */
// i18n-exempt：发给模型的话。
export const REQUESTS_GUIDE =
	"请求用 reply_session 回给发件方，`to` 写标签里 from 的地址。" +
	"答得上来的现在就答；要花一阵子做的，先回一句打算怎么办，做完再用 reply_session 交回结果。你手上原来的事照常做完。";

// i18n-exempt：发给模型的话。
export const NOTICES_GUIDE = "没有 reply、answer 标记的是通知，不需要专门回复：和你手上的事有关就据此调整，然后接着做。";

export class PeerRouter {
	private readonly pacer = new PeerPacer();
	/** 每个会话正在跑的这一轮接着的往来链；没在跑、或这一轮不是信叫起来的，就没有。 */
	private readonly chains = new Map<string, string[]>();

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

	/** 人在这个会话里开口了、这一轮收场了、会话删掉了：之后它发出去的信是一条新链，不再接着别人的那条。 */
	reset(sessionId: string): void {
		this.chains.delete(sessionId);
	}
}
