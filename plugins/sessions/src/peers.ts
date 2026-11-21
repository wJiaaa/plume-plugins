/**
 * 会话的地址和谁看得见谁。
 *
 * 地址是 `名字 [ref]`：名字取会话标题，会变、会重名；ref 取 id 的前六位，不变。所以解析时 ref 说了算：模型拿着一个
 * 改名之前抄下的地址来，名字对不上、ref 对得上，照样认得。重名又没带 ref 的，不猜，把候选列出来让它挑——猜错一次
 * 就是读了另一个项目里的会话。完整的 id（名册里写的）和开出它的一方起的短名（`spawnedFrom.name`）也认。
 *
 * 看得见的：侧栏里的会话（顶层、没归档的），不是自己，并且和自己在一处——同一个项目、同一个 git 仓库（含它的工作树和子目录，
 * 见 `repository.ts`），或者一个是从另一个开出来的（`spawnedFrom`：计划交出去执行的那个会话要读得到原会话，哪怕它开在别的目录）。
 * 只是目录挨着不算：开在主目录里的聊天不该看见它下面每一个会话，不在项目里的聊天都开在本体的同一个目录里，彼此也不相干。
 * 子会话（子 Agent、侧边聊天）不在其列：它们是父会话的一部分，读父会话就够了。
 *
 * 找人只在看得见的里面找（`reachable` 之后再 `resolveSession`）：重名、ref 撞上的只算看得见的，别处的会话名字也不会出现在退回的话里。
 */

import type { SessionSummary } from "@plume/contract";

const REF = /^(.*?)\s*\[([0-9a-f]{6,12})\]$/i;

function sessionRef(id: string): string {
	return id.replace(/-/g, "").slice(0, 6).toLowerCase();
}

/** 标题压成一行；方括号换掉，免得名字本身被读成 ref。空标题用目录名。 */
function sessionName(session: Pick<SessionSummary, "title" | "cwd">): string {
	const name = session.title.replace(/\s+/g, " ").replace(/[[\]]/g, "").trim();
	return name || session.cwd.split(/[\\/]/).findLast(Boolean) || "session";
}

export function sessionAddress(session: Pick<SessionSummary, "id" | "title" | "cwd">): string {
	return `${sessionName(session)} [${sessionRef(session.id)}]`;
}

export type Resolution = { kind: "found"; session: SessionSummary } | { kind: "none" } | { kind: "ambiguous"; candidates: SessionSummary[] };

export function resolveSession(to: string, sessions: readonly SessionSummary[]): Resolution {
	const wanted = to.trim();
	const startsWith = (ref: string) => sessions.filter((session) => session.id.replace(/-/g, "").toLowerCase().startsWith(ref.toLowerCase()));
	const exact = sessions.find((session) => session.id === wanted);
	if (exact) return { kind: "found", session: exact };
	const parsed = REF.exec(wanted);
	if (parsed) return pick(startsWith(parsed[2]!));
	const byName = sessions.filter((session) => sessionName(session) === wanted || session.spawnedFrom?.name === wanted);
	if (byName.length > 0) return pick(byName);
	// 只写了 ref 的也认：那是从列表里抄的，不会是别的意思。
	if (/^[0-9a-f]{6,12}$/i.test(wanted)) return pick(startsWith(wanted));
	return { kind: "none" };
}

function pick(hits: SessionSummary[]): Resolution {
	if (hits.length === 1) return { kind: "found", session: hits[0]! };
	if (hits.length === 0) return { kind: "none" };
	return { kind: "ambiguous", candidates: hits };
}

/** 侧栏里的会话：能被读、能被问的只有这些。 */
export function listed(session: SessionSummary): boolean {
	return session.kind === "top" && !session.archived;
}

/**
 * 两个会话在不在一处（见文件头）。不查自己、不查是否在侧栏，那两条由调用方先判。
 * `repos` 是会话目录在哪个仓库（`repository.ts` 的 `repositories`），没有的当不在仓库里。
 */
export function together(from: SessionSummary, to: SessionSummary, repos: ReadonlyMap<string, string> = new Map()): boolean {
	if (from.project && from.project === to.project) return true;
	if (from.spawnedFrom?.sessionId === to.id || to.spawnedFrom?.sessionId === from.id) return true;
	const repo = repos.get(from.cwd);
	return repo !== undefined && repo === repos.get(to.cwd);
}

/**
 * 和 `self` 互相开出来的那一家子（顺着 `spawnedFrom` 往上找到头，再把头下面的都算上），不含自己，只算侧栏里的。
 * 只有自己时是空的。
 */
export function familyOf(self: SessionSummary, sessions: readonly SessionSummary[]): SessionSummary[] {
	const byId = new Map(sessions.filter(listed).map((session) => [session.id, session]));
	const root = (session: SessionSummary) => {
		const seen = new Set<string>();
		let current = session;
		while (current.spawnedFrom && !seen.has(current.id)) {
			seen.add(current.id);
			const up = byId.get(current.spawnedFrom.sessionId);
			if (!up) break;
			current = up;
		}
		return current.id;
	};
	const mine = root(self);
	return [...byId.values()].filter((session) => session.id !== self.id && root(session) === mine);
}
