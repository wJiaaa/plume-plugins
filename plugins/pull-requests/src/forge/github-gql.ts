import type { PullRequestCheck, PullRequestDetail } from "../api.ts";
import { backendText } from "../messages.ts";
import type { ForgeConnection } from "./types.ts";
import { summarizeChecks } from "./pr-summary.ts";

export const DETAIL_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number title body url state isDraft createdAt updatedAt
      additions deletions changedFiles headRefName baseRefName mergeable reviewDecision
      author { login avatarUrl(size: 64) }
      labels(first: 20) { nodes { name } }
      comments(last: 100) { totalCount nodes { author { login } body createdAt } }
      reviews(last: 50) { nodes { author { login } state body submittedAt } }
      reviewRequests(first: 20) {
        nodes { requestedReviewer {
          ... on User { login }
          ... on Bot { login }
          ... on Mannequin { login }
          ... on Team { name }
          ... on EnterpriseTeam { name }
        } }
      }
      history: commits(last: 100) {
        nodes { commit { oid messageHeadline committedDate author { name user { login } } } }
      }
      checks: commits(last: 1) {
        nodes { commit { statusCheckRollup { contexts(first: 100) {
          nodes {
            ... on CheckRun { name conclusion status detailsUrl }
            ... on StatusContext { context state targetUrl }
          }
        } } } }
      }
    }
  }
}`;
export interface DetailNode {
	number: number;
	title: string;
	body?: string;
	url: string;
	state?: string;
	isDraft?: boolean;
	createdAt: string;
	updatedAt: string;
	additions?: number;
	deletions?: number;
	changedFiles?: number;
	headRefName?: string;
	baseRefName?: string;
	mergeable?: string;
	reviewDecision?: string | null;
	author?: { login?: string; avatarUrl?: string } | null;
	labels?: { nodes?: { name?: string }[] } | null;
	comments?: { totalCount?: number; nodes?: { author?: { login?: string }; body?: string; createdAt?: string }[] } | null;
	reviews?: { nodes?: { author?: { login?: string }; state?: string; body?: string; submittedAt?: string }[] } | null;
	reviewRequests?: { nodes?: { requestedReviewer?: { login?: string; name?: string } | null }[] } | null;
	history?: {
		nodes?: ({
			commit?: { oid?: string; messageHeadline?: string; committedDate?: string; author?: { name?: string; user?: { login?: string } | null } };
		} | null)[];
	} | null;
	checks?: { nodes?: ({ commit?: { statusCheckRollup?: { contexts?: { nodes?: RawContext[] } } | null } } | null)[] } | null;
}
interface RawContext {
	name?: string;
	conclusion?: string;
	status?: string;
	detailsUrl?: string;
	context?: string;
	state?: string;
	targetUrl?: string;
}
function toCheck(check: RawContext, conn: ForgeConnection): PullRequestCheck {
	const raw = (check.conclusion || check.state || check.status || "").toUpperCase();
	const state = ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(raw) ? "pass" : ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"].includes(raw) ? "fail" : "pending";
	const url = check.detailsUrl || check.targetUrl;
	return { name: (check.name || check.context || "").trim() || backendText(conn.locale ?? "en", "check"), state, ...(url ? { url } : {}) };
}
export function toDetail(conn: ForgeConnection, repo: string, node: DetailNode): PullRequestDetail {
	const reviews = (node.reviews?.nodes ?? []).map((r) => ({
		author: r.author?.login ?? "unknown",
		state: r.state ?? "COMMENTED",
		body: r.body ?? "",
		submittedAt: r.submittedAt ?? "",
	}));
	const contexts = node.checks?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
	return {
		accountId: conn.account.id,
		repo,
		number: node.number,
		title: node.title,
		author: node.author?.login ?? "unknown",
		avatarUrl: node.author?.avatarUrl ?? null,
		state: (node.state ?? "open").toUpperCase(),
		isDraft: node.isDraft === true,
		url: node.url,
		createdAt: node.createdAt,
		updatedAt: node.updatedAt,
		relation: "authored",
		reviewDecision: node.reviewDecision || null,
		...summarizeChecks(contexts.map((c) => toCheck(c, conn))),
		body: node.body ?? "",
		additions: node.additions ?? 0,
		deletions: node.deletions ?? 0,
		changedFiles: node.changedFiles ?? 0,
		headRefName: node.headRefName ?? "",
		baseRefName: node.baseRefName ?? "",
		comments: node.comments?.totalCount ?? 0,
		threads: (node.comments?.nodes ?? []).map((c) => ({ author: c.author?.login ?? "unknown", body: c.body ?? "", createdAt: c.createdAt ?? "" })),
		reviews,
		reviewers: [
			...(node.reviewRequests?.nodes ?? []).map((r) => ({ login: r.requestedReviewer?.login || r.requestedReviewer?.name || "", state: "REQUESTED" })),
			...reviews.map((r) => ({ login: r.author, state: r.state })),
		].filter((r) => r.login),
		commits: (node.history?.nodes ?? []).map((e) => ({
			sha: (e?.commit?.oid ?? "").slice(0, 7),
			headline: e?.commit?.messageHeadline ?? "",
			author: e?.commit?.author?.user?.login || e?.commit?.author?.name || "",
			at: e?.commit?.committedDate ?? "",
		})),
		mergeable: node.mergeable ?? "UNKNOWN",
		labels: (node.labels?.nodes ?? []).map((l) => l.name ?? "").filter(Boolean),
	};
}
