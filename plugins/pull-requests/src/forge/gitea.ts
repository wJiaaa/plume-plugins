import type { PullRequestCheck, PullRequestSummary } from "../api.ts";
import { backendText } from "../messages.ts";
import { repoPath, validateNumber } from "./accounts.ts";
import { parseUnifiedDiff } from "./diff-parse.ts";
import { checkCancelled, ForgeError, optional } from "./errors.ts";
import { DIFF_TIMEOUT_MS, identifyUser, json, text } from "./http.ts";
import { dedupe, PER_BUCKET, type Relation, summarizeChecks } from "./pr-summary.ts";
import { type RawComment, type RawCommit, toCommits, toThreads } from "./rest-v3.ts";
import type { ForgeConnection, ForgeDriver } from "./types.ts";

const BUCKETS: { relation: Relation; flag: string }[] = [
	{ relation: "reviewing", flag: "review_requested" },
	{ relation: "authored", flag: "created" },
	{ relation: "reviewed", flag: "reviewed" },
];
interface RawIssue {
	number: number;
	title: string;
	state?: string;
	html_url: string;
	created_at: string;
	updated_at: string;
	comments?: number;
	user?: { login?: string; avatar_url?: string } | null;
	repository?: { full_name?: string; owner?: string; name?: string } | null;
	pull_request?: { draft?: boolean; merged?: boolean } | null;
}
interface RawPull {
	number: number;
	title: string;
	body?: string;
	state?: string;
	draft?: boolean;
	merged?: boolean;
	mergeable?: boolean;
	html_url: string;
	created_at: string;
	updated_at: string;
	comments?: number;
	additions?: number;
	deletions?: number;
	changed_files?: number;
	user?: { login?: string; avatar_url?: string } | null;
	head?: { ref?: string; sha?: string } | null;
	base?: { ref?: string } | null;
	labels?: { name?: string }[] | null;
	requested_reviewers?: ({ login?: string } | null)[] | null;
}
function repoOf(issue: RawIssue, baseUrl: string): string {
	if (issue.repository?.full_name) return issue.repository.full_name;
	const { owner, name } = issue.repository ?? {};
	if (owner && name) return `${owner}/${name}`;
	try {
		const url = new URL(issue.html_url);
		const base = new URL(baseUrl);
		if (url.origin !== base.origin) return "";
		const prefix = base.pathname.replace(/\/+$/, "");
		if (prefix && !url.pathname.startsWith(`${prefix}/`)) return "";
		const parts = decodeURIComponent(url.pathname.slice(prefix.length)).split("/").filter(Boolean);
		return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : "";
	} catch {
		return "";
	}
}
function toSummary(issue: RawIssue, repo: string, relation: Relation, accountId: string): PullRequestSummary {
	return {
		accountId,
		repo,
		number: issue.number,
		title: issue.title,
		author: issue.user?.login ?? "unknown",
		avatarUrl: issue.user?.avatar_url ?? null,
		state: (issue.state ?? "open").toUpperCase(),
		isDraft: issue.pull_request?.draft === true,
		url: issue.html_url,
		createdAt: issue.created_at,
		updatedAt: issue.updated_at,
		comments: issue.comments ?? 0,
		relation,
		additions: null,
		deletions: null,
		headRefName: null,
		checkState: null,
		reviewDecision: null,
	};
}
function at(repo: string, number: number): string {
	validateNumber(number);
	return `/repos/${repoPath(repo)}/pulls/${number}`;
}
export const gitea: ForgeDriver = {
	kind: "gitea",
	identify: (conn) => identifyUser(conn, { login: "login", name: "full_name" }),
	async list(conn) {
		const buckets = await Promise.all(
			BUCKETS.map(({ relation, flag }) =>
				json<RawIssue[]>(conn, "/repos/issues/search", { query: { type: "pulls", state: "open", [flag]: true, limit: PER_BUCKET } }).then((list) => ({
					relation,
					list: list ?? [],
				})),
			),
		);
		return dedupe(
			buckets.map(({ relation, list }) =>
				list.flatMap((issue) => {
					const repo = repoOf(issue, conn.account.baseUrl);
					return repo ? [toSummary(issue, repo, relation, conn.account.id)] : [];
				}),
			),
		);
	},
	async detail(conn, repo, number) {
		const path = at(repo, number);
		const root = `/repos/${repoPath(repo)}`;
		const pull = await json<RawPull>(conn, path);
		if (pull.head?.sha && !/^[a-f\d]{7,64}$/i.test(pull.head.sha)) throw new ForgeError("badInput");
		const [comments, reviews, commits, status] = await Promise.all([
			json<RawComment[]>(conn, `${root}/issues/${number}/comments`, { query: { limit: 100 } }).catch(optional(conn.signal, [])),
			json<RawReview[]>(conn, `${path}/reviews`, { query: { limit: 50 } }).catch(optional(conn.signal, [])),
			json<RawCommit[]>(conn, `${path}/commits`, { query: { limit: 100 } }).catch(optional(conn.signal, [])),
			pull.head?.sha ? json<RawStatus>(conn, `${root}/commits/${pull.head.sha}/status`).catch(optional(conn.signal, null)) : Promise.resolve(null),
		]);
		checkCancelled(conn.signal);
		const verdicts = (reviews ?? []).filter((r) => r.state && r.state !== "PENDING");
		return {
			accountId: conn.account.id,
			repo,
			number: pull.number,
			title: pull.title,
			author: pull.user?.login ?? "unknown",
			avatarUrl: pull.user?.avatar_url ?? null,
			state: (pull.state ?? "open").toUpperCase(),
			isDraft: pull.draft === true,
			url: pull.html_url,
			createdAt: pull.created_at,
			updatedAt: pull.updated_at,
			relation: "authored",
			reviewDecision: verdictOf(verdicts),
			...summarizeChecks((status?.statuses ?? []).map((s) => toCheck(s, conn))),
			body: pull.body ?? "",
			additions: pull.additions ?? null,
			deletions: pull.deletions ?? null,
			changedFiles: pull.changed_files ?? null,
			headRefName: pull.head?.ref ?? "",
			baseRefName: pull.base?.ref ?? "",
			comments: comments?.length ?? pull.comments ?? 0,
			threads: toThreads(comments ?? []),
			reviews: verdicts.map((r) => ({
				author: r.user?.login ?? "unknown",
				state: r.state ?? "COMMENT",
				body: r.body ?? "",
				submittedAt: r.submitted_at ?? "",
			})),
			reviewers: [
				...(pull.requested_reviewers ?? []).map((r) => ({ login: r?.login ?? "", state: "REQUESTED" })),
				...verdicts.map((r) => ({ login: r.user?.login ?? "", state: r.state ?? "COMMENT" })),
			].filter((r) => r.login),
			mergeable: pull.merged ? "MERGED" : pull.mergeable === false ? "CONFLICTING" : "MERGEABLE",
			labels: (pull.labels ?? []).map((l) => l.name ?? "").filter(Boolean),
			commits: toCommits(commits ?? []),
		};
	},
	async diff(conn, repo, number) {
		return parseUnifiedDiff(await text(conn, `${at(repo, number)}.diff`, { accept: "text/plain", timeoutMs: DIFF_TIMEOUT_MS }));
	},
	async comment(conn, repo, number, body) {
		validateNumber(number);
		await json(conn, `/repos/${repoPath(repo)}/issues/${number}/comments`, { method: "POST", body: { body } });
	},
	async review(conn, repo, number, verdict, body) {
		const event = verdict === "approve" ? "APPROVED" : verdict === "request-changes" ? "REQUEST_CHANGES" : "COMMENT";
		await json(conn, `${at(repo, number)}/reviews`, { method: "POST", body: { event, body } });
	},
};
function verdictOf(reviews: RawReview[]): string | null {
	return reviews.some((r) => r.state === "REQUEST_CHANGES") ? "CHANGES_REQUESTED" : reviews.some((r) => r.state === "APPROVED") ? "APPROVED" : null;
}
function toCheck(entry: RawStatusEntry, conn: ForgeConnection): PullRequestCheck {
	const raw = (entry.status ?? "").toLowerCase();
	return {
		name: entry.context?.trim() || backendText(conn.locale ?? "en", "check"),
		state: raw === "success" ? "pass" : raw === "failure" || raw === "error" ? "fail" : "pending",
		...(entry.target_url ? { url: entry.target_url } : {}),
	};
}
interface RawReview {
	state?: string;
	body?: string;
	submitted_at?: string;
	user?: { login?: string } | null;
}
interface RawStatusEntry {
	context?: string;
	status?: string;
	target_url?: string;
}
interface RawStatus {
	statuses?: RawStatusEntry[];
}
