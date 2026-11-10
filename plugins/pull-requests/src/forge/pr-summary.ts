import type { PullRequestCheck, PullRequestDetail, PullRequestSummary } from "../api.ts";

export const PER_BUCKET = 30;
export const BUCKETS = [
	{ relation: "reviewing", query: "is:pr is:open review-requested:@me" },
	{ relation: "authored", query: "is:pr is:open author:@me" },
	{ relation: "reviewed", query: "is:pr is:open reviewed-by:@me" },
] as const;
export type Relation = (typeof BUCKETS)[number]["relation"];
export const SEARCH_QUERY = `
query($reviewing: String!, $authored: String!, $reviewed: String!, $n: Int!) {
  reviewing: search(query: $reviewing, type: ISSUE, first: $n) { nodes { ...row } }
  authored: search(query: $authored, type: ISSUE, first: $n) { nodes { ...row } }
  reviewed: search(query: $reviewed, type: ISSUE, first: $n) { nodes { ...row } }
}
fragment row on PullRequest {
  number title url state isDraft createdAt updatedAt additions deletions headRefName reviewDecision
  author { login avatarUrl(size: 64) }
  repository { nameWithOwner }
  comments { totalCount }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;
export interface SearchNode {
	number: number;
	title: string;
	url: string;
	state?: string;
	isDraft?: boolean;
	createdAt: string;
	updatedAt: string;
	additions?: number;
	deletions?: number;
	headRefName?: string;
	reviewDecision?: string | null;
	author?: { login?: string; avatarUrl?: string } | null;
	repository?: { nameWithOwner?: string } | null;
	comments?: { totalCount?: number } | null;
	commits?: { nodes?: ({ commit?: { statusCheckRollup?: { state?: string } | null } } | null)[] } | null;
}
export function parseSearch(data: Record<string, { nodes?: (SearchNode | null)[] } | null> | undefined): Record<Relation, SearchNode[]> {
	const out = {} as Record<Relation, SearchNode[]>;
	for (const { relation } of BUCKETS)
		out[relation] = (data?.[relation]?.nodes ?? []).filter((node): node is SearchNode => Boolean(node && typeof node.number === "number"));
	return out;
}
function checkStateOf(state: string | null | undefined): PullRequestCheck["state"] | null {
	const raw = (state ?? "").toUpperCase();
	if (!raw) return null;
	return raw === "SUCCESS" ? "pass" : raw === "FAILURE" || raw === "ERROR" ? "fail" : "pending";
}
export function toSummary(node: SearchNode, relation: Relation, accountId: string): PullRequestSummary {
	return {
		accountId,
		repo: node.repository?.nameWithOwner ?? "",
		number: node.number,
		title: node.title,
		author: node.author?.login ?? "unknown",
		avatarUrl: node.author?.avatarUrl ?? null,
		state: (node.state ?? "open").toUpperCase(),
		isDraft: node.isDraft === true,
		url: node.url,
		createdAt: node.createdAt,
		updatedAt: node.updatedAt,
		comments: node.comments?.totalCount ?? 0,
		relation,
		additions: typeof node.additions === "number" ? node.additions : null,
		deletions: typeof node.deletions === "number" ? node.deletions : null,
		headRefName: node.headRefName || null,
		checkState: checkStateOf(node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state),
		reviewDecision: node.reviewDecision || null,
	};
}
// 同名仓库在不同账号下仍是不同条目；桶顺序决定重叠条目的关系。
export function dedupe(buckets: PullRequestSummary[][]): PullRequestSummary[] {
	const seen = new Map<string, PullRequestSummary>();
	for (const bucket of buckets)
		for (const pr of bucket) {
			const key = JSON.stringify([pr.accountId, pr.repo, pr.number]);
			if (!seen.has(key)) seen.set(key, pr);
		}
	return [...seen.values()];
}
export function newestFirst(rows: PullRequestSummary[]): PullRequestSummary[] {
	return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function summarizeChecks(items: PullRequestCheck[]): Pick<PullRequestDetail, "checks" | "checkState"> {
	if (!items.length) return { checks: null, checkState: null };
	const count = (state: PullRequestCheck["state"]) => items.filter((check) => check.state === state).length;
	const failed = count("fail");
	const pending = count("pending");
	return { checks: { total: items.length, passed: count("pass"), failed, pending, items }, checkState: failed > 0 ? "fail" : pending > 0 ? "pending" : "pass" };
}
