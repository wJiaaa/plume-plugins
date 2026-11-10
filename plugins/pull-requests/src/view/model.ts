import type { ForgeKindInfo, PullRequestDetail, PullRequestSummary, ReviewVerdict } from "../api";

export type PrRef = Pick<PullRequestSummary, "accountId" | "repo" | "number">;
export type Filter = "all" | "reviewing" | "authored";
export const rowId = (pr: PrRef): string => JSON.stringify([pr.accountId, pr.repo, pr.number]);
export const sameRef = (a: PrRef | null, b: PrRef | null): boolean => a === b || Boolean(a && b && rowId(a) === rowId(b));
const GROUP_ORDER = ["reviewing", "authored", "reviewed"] as const;

export function groupFor(items: PullRequestSummary[], filter: Filter, query: string, account: string | null = null) {
	const needle = query.trim().toLowerCase();
	const matching = items.filter((pr) => {
		if (account && pr.accountId !== account) return false;
		if (filter !== "all" && pr.relation !== filter) return false;
		return !needle || `${pr.title} ${pr.repo} ${pr.author} ${pr.headRefName ?? ""} #${pr.number}`.toLowerCase().includes(needle);
	});
	return GROUP_ORDER.map((key) => ({ key, items: matching.filter((pr) => pr.relation === key) })).filter((group) => group.items.length > 0);
}

export function mergeLists(previous: PullRequestSummary[], incoming: PullRequestSummary[]) {
	const before = new Map(previous.map((pr) => [rowId(pr), pr]));
	const touched = new Set<string>();
	const items = incoming.map((pr) => {
		const old = before.get(rowId(pr));
		if (old && sameSummary(old, pr)) return old;
		if (previous.length) touched.add(rowId(pr));
		return pr;
	});
	return { items: items.length === previous.length && items.every((pr, index) => pr === previous[index]) ? previous : items, touched };
}

function sameSummary(a: PullRequestSummary, b: PullRequestSummary): boolean {
	return (Object.keys(a) as (keyof PullRequestSummary)[]).every((key) => a[key] === b[key]);
}

// 比较嵌套内容，而非只比数组长度；同一条评论编辑后也必须更新。
export function sameDetail(a: PullRequestDetail, b: PullRequestDetail): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
export const baseline = (items: PullRequestSummary[]): Record<string, string> => Object.fromEntries(items.map((pr) => [rowId(pr), pr.updatedAt]));
export const acknowledge = (seen: Record<string, string> | null, pr: PullRequestSummary): Record<string, string> => ({ ...seen, [rowId(pr)]: pr.updatedAt });
function pruneSeen(seen: Record<string, string>, items: PullRequestSummary[]): Record<string, string> {
	const live = new Set(items.map(rowId));
	return Object.fromEntries(Object.entries(seen).filter(([key]) => live.has(key)));
}
export function unseenOf(items: PullRequestSummary[], seen: Record<string, string> | null): Set<string> {
	return new Set(seen ? items.filter((pr) => seen[rowId(pr)] !== pr.updatedAt).map(rowId) : []);
}
export function reconcileSeen(seen: Record<string, string> | null, items: PullRequestSummary[], selected: PrRef | null) {
	let next = seen === null ? baseline(items) : pruneSeen(seen, items);
	const reading = items.find((pr) => sameRef(pr, selected));
	if (reading) next = acknowledge(next, reading);
	return next;
}

export interface ActivityEntry {
	key: string;
	kind: "opened" | "commit" | "review" | "comment";
	author: string;
	at: string;
	state?: string;
	sha?: string;
	body: string;
}
export function activityOf(detail: Pick<PullRequestDetail, "reviews" | "threads" | "commits" | "author" | "createdAt">): ActivityEntry[] {
	const entries: ActivityEntry[] = [
		{ key: "opened", kind: "opened", author: detail.author, at: detail.createdAt, body: "" },
		...detail.commits
			.filter((commit) => commit.at)
			.map((commit, index) => ({ key: `k-${index}`, kind: "commit" as const, author: commit.author, at: commit.at, sha: commit.sha, body: commit.headline })),
		...detail.reviews.map((review, index) => ({
			key: `r-${index}`,
			kind: "review" as const,
			author: review.author,
			at: review.submittedAt,
			state: review.state,
			body: review.body,
		})),
		...detail.threads.map((comment, index) => ({
			key: `c-${index}`,
			kind: "comment" as const,
			author: comment.author,
			at: comment.createdAt,
			body: comment.body,
		})),
	];
	return entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
export function firstLine(body: string): string {
	for (const line of body.split("\n")) {
		const text = line.replace(/^[#>\-*\s]+/, "").trim();
		if (text) return text;
	}
	return body.trim();
}
export function canSubmit(verdict: ReviewVerdict, body: string): boolean {
	return verdict === "approve" || Boolean(body.trim());
}
export function httpUrl(value: string): boolean {
	try {
		return ["http:", "https:"].includes(new URL(value).protocol);
	} catch {
		return false;
	}
}
export function tokenUrl(info: ForgeKindInfo, baseUrl: string): string | null {
	const base = baseUrl.trim().replace(/\/+$/, "");
	if (!base) return httpUrl(info.tokenUrl) ? info.tokenUrl : null;
	if (!httpUrl(base)) return null;
	if (base === info.baseUrl.replace(/\/+$/, "")) return info.tokenUrl;
	switch (info.kind) {
		case "github":
			return `${base}/settings/tokens/new?scopes=repo,read:org,read:user&description=Plume`;
		case "gitlab":
			return `${base}/-/user_settings/personal_access_tokens?name=Plume&scopes=api`;
		case "gitee":
			return `${base}/personal_access_tokens/new`;
		case "gitea":
			return `${base}/user/settings/applications`;
	}
}
export function host(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}
