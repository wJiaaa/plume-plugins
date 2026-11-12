/**
 * 会话的地址和谁看得见谁。
 *
 * 地址是 `名字 [ref]`：名字取会话标题，会变、会重名；ref 取 id 的前六位，不变。所以解析时 ref 说了算：模型拿着一个
 * 改名之前抄下的地址来，名字对不上、ref 对得上，照样认得。重名又没带 ref 的，不猜，把候选列出来让它挑——猜错一次
 * 就是读了另一个项目里的会话。
 *
 * 看得见的：侧栏里的会话（顶层、没归档的），不是自己，并且和自己在一处——同一个项目、目录相同或一个套着另一个
 * （会话目录是 git 工作树时，它的主工作树也算它的目录，见 `worktree.ts`），或者一个是从另一个开出来的（`spawnedFrom`：计划交出去执行的那个会话要读得到原会话，哪怕它开在别的目录）。
 * 子会话（子 Agent、侧边聊天）不在其列：它们是父会话的一部分，读父会话就够了。
 */

import { resolve, sep } from "node:path";
import type { SessionSummary } from "@plume/contract";

const REF = /^(.*?)\s*\[([0-9a-f]{6,12})\]$/i;

export function sessionRef(id: string): string {
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
	const parsed = REF.exec(wanted);
	if (parsed) return pick(startsWith(parsed[2]!));
	const byName = sessions.filter((session) => sessionName(session) === wanted);
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
	return !session.parentId && !session.owner && !session.archived;
}

function within(child: string, parent: string): boolean {
	const a = resolve(child);
	const b = resolve(parent);
	return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/**
 * 两个会话在不在一处（见文件头）。不查自己、不查是否在侧栏，那两条由调用方先判。
 * `mains` 是会话目录还算哪些目录（`worktree.ts` 的 `mainWorktrees`），没给的当不是工作树。
 */
export function together(from: SessionSummary, to: SessionSummary, mains: ReadonlyMap<string, readonly string[]> = new Map()): boolean {
	if (from.project && from.project === to.project) return true;
	const roots = (cwd: string) => [cwd, ...(mains.get(cwd) ?? [])];
	const theirs = roots(to.cwd);
	if (roots(from.cwd).some((a) => theirs.some((b) => within(a, b) || within(b, a)))) return true;
	return from.spawnedFrom?.sessionId === to.id || to.spawnedFrom?.sessionId === from.id;
}
