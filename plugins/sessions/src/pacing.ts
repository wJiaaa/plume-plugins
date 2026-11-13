/**
 * 会话之间那封信发不发得出去：太长、发得太快、刚发过一模一样的拦下来。不查权限宽窄
 * （Plume 的权限档是全局的，所有会话一样宽）。往来链太长、太绕由本体拦（`ToolRun.letter` 抛错）：只有它看得见
 * 哪封信叫起了哪一轮，包括它代答的那几封。
 *
 * 全是确定的判断——多长、三十秒内是不是同一句话。「两个会话是不是在互相推诿」这种猜测不在这里。
 * 拦下来时给的理由要能让模型据以改做法，文案在 `prompt.ts`。
 */

/** 一封信的全文进收件方的上下文。再长就该写成文件、信里给路径。 */
export const PEER_MAX_CHARS = 20_000;
/** 令牌桶：按「发件方 → 收件方」计。一口气能发三十封，之后两秒补一封。 */
const PEER_BUCKET = 30;
const PEER_REFILL_PER_SECOND = 0.5;
/** 同一对之间这么久里一字不差的第二封不发。 */
export const PEER_DEDUP_MS = 30_000;
/** 记着多少对的账；再多就把最久没动静的那对忘掉。 */
const TRACKED_PAIRS = 256;

export type PaceRefusal = "too-long" | "duplicate" | "paced";

interface Pair {
	tokens: number;
	at: number;
	lastText: string;
	lastAt: number;
}

/** 长度、限速和去重。状态只活在内存里。 */
export class PeerPacer {
	private readonly pairs = new Map<string, Pair>();
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	/** 这封能不能发；不记账，真寄出去了再 `spend`：本体拒寄（往来链太长）的不扣令牌、不算发过。 */
	check(from: string, to: string, text: string): PaceRefusal | null {
		if (text.length > PEER_MAX_CHARS) return "too-long";
		const now = this.now();
		const pair = this.refilled(from, to, now);
		if (text && text === pair.lastText && now - pair.lastAt < PEER_DEDUP_MS) return "duplicate";
		if (pair.tokens < 1) return "paced";
		return null;
	}

	/** 寄出去了：扣一个令牌，记下这句话。 */
	spend(from: string, to: string, text: string): void {
		const now = this.now();
		const pair = this.refilled(from, to, now);
		pair.tokens -= 1;
		pair.lastText = text;
		pair.lastAt = now;
	}

	/** 这一对的账，按过去的时间补上令牌。 */
	private refilled(from: string, to: string, now: number): Pair {
		const pair = this.pair(`${from}\n${to}`, now);
		pair.tokens = Math.min(PEER_BUCKET, pair.tokens + ((now - pair.at) / 1000) * PEER_REFILL_PER_SECOND);
		pair.at = now;
		return pair;
	}

	/** 拿出来就挪到最后：Map 的插入顺序就是最近使用的顺序，满了从头上删。 */
	private pair(key: string, now: number): Pair {
		const existing = this.pairs.get(key);
		if (existing) {
			this.pairs.delete(key);
			this.pairs.set(key, existing);
			return existing;
		}
		while (this.pairs.size >= TRACKED_PAIRS) {
			const oldest = this.pairs.keys().next().value;
			if (oldest === undefined) break;
			this.pairs.delete(oldest);
		}
		const fresh: Pair = { tokens: PEER_BUCKET, at: now, lastText: "", lastAt: 0 };
		this.pairs.set(key, fresh);
		return fresh;
	}
}
