/**
 * 会话之间那封信发不发得出去：发得太快、太长、太绕的拦下来。不查权限宽窄
 * （Plume 的权限档是全局的，所有会话一样宽）。
 *
 * 全是确定的判断——链有多长、三十秒内是不是同一句话。「两个会话是不是在互相推诿」这种猜测不在这里。
 * 拦下来时给的理由要能让模型据以改做法，文案在 `index.ts`。
 */

/** 一封信的全文进收件方的上下文。再长就该写成文件、信里给路径。 */
export const PEER_MAX_CHARS = 20_000;
/** 一条往来链最多经手几次；超出多半是两个会话在原地来回。 */
export const PEER_CHAIN_LIMIT = 28;
/** 同一个会话在一条链里最多出现几次。 */
const PEER_SELF_HOPS = 10;
/** 令牌桶：按「发件方 → 收件方」计。一口气能发三十封，之后两秒补一封。 */
const PEER_BUCKET = 30;
const PEER_REFILL_PER_SECOND = 0.5;
/** 同一对之间这么久里一字不差的第二封不发。 */
export const PEER_DEDUP_MS = 30_000;
/** 记着多少对的账；再多就把最久没动静的那对忘掉。 */
const TRACKED_PAIRS = 256;

export type PaceRefusal = "too-long" | "chain-runaway" | "chain-loop" | "duplicate" | "paced";

interface Pair {
	tokens: number;
	at: number;
	lastText: string;
	lastAt: number;
}

/** 限速、去重和链长。状态只活在内存里。 */
export class PeerPacer {
	private readonly pairs = new Map<string, Pair>();
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	/**
	 * 这封能不能发。能发就当场记账——问一次就是发一次，拦下来的不扣令牌。
	 *
	 * `chain` 是寄出时这封信所在的链，已经包含发件方自己。
	 */
	admit(from: string, to: string, text: string, chain: readonly string[]): PaceRefusal | null {
		if (text.length > PEER_MAX_CHARS) return "too-long";
		if (chain.length > PEER_CHAIN_LIMIT) return "chain-runaway";
		if (chain.filter((id) => id === from).length > PEER_SELF_HOPS) return "chain-loop";
		const now = this.now();
		const pair = this.pair(`${from}\n${to}`, now);
		pair.tokens = Math.min(PEER_BUCKET, pair.tokens + ((now - pair.at) / 1000) * PEER_REFILL_PER_SECOND);
		pair.at = now;
		if (text && text === pair.lastText && now - pair.lastAt < PEER_DEDUP_MS) return "duplicate";
		if (pair.tokens < 1) return "paced";
		pair.tokens -= 1;
		if (text) {
			pair.lastText = text;
			pair.lastAt = now;
		}
		return null;
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
