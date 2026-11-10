import type { PullRequestSummary } from "../api.ts";
import { backendText } from "../messages.ts";
import { projectId, validateNumber } from "./accounts.ts";
import { parseUnifiedDiff } from "./diff-parse.ts";
import { checkCancelled, ForgeError, optional } from "./errors.ts";
import { DIFF_TIMEOUT_MS, identifyUser, json } from "./http.ts";
import { assembleDiff } from "./patch.ts";
import { dedupe, PER_BUCKET, type Relation, summarizeChecks } from "./pr-summary.ts";
import type { ForgeDriver } from "./types.ts";

interface RawMr {
	iid: number;
	title: string;
	description?: string;
	state?: string;
	draft?: boolean;
	work_in_progress?: boolean;
	created_at: string;
	updated_at: string;
	web_url: string;
	source_branch?: string;
	target_branch?: string;
	user_notes_count?: number;
	changes_count?: string;
	merge_status?: string;
	detailed_merge_status?: string;
	has_conflicts?: boolean;
	labels?: string[];
	author?: { username?: string; name?: string; avatar_url?: string } | null;
	reviewers?: { username?: string }[] | null;
	references?: { full?: string } | null;
	head_pipeline?: { status?: string; web_url?: string } | null;
	pipeline?: { status?: string; web_url?: string } | null;
}
export function repoOf(mr: Pick<RawMr, "references" | "web_url">, baseUrl: string): string {
	const full = mr.references?.full ?? "";
	const cut = full.indexOf("!");
	if (cut > 0) return full.slice(0, cut);
	try {
		const url = new URL(mr.web_url);
		const base = new URL(baseUrl);
		if (url.origin !== base.origin) return "";
		const prefix = base.pathname.replace(/\/+$/, "");
		if (prefix && !url.pathname.startsWith(`${prefix}/`)) return "";
		const path = decodeURIComponent(url.pathname.slice(prefix.length).replace(/^\//, ""));
		const at = path.indexOf("/-/");
		return at > 0 ? path.slice(0, at) : path;
	} catch {
		return "";
	}
}
function pipelineState(status: string | undefined): PullRequestSummary["checkState"] {
	const raw = (status ?? "").toLowerCase();
	if (!raw) return null;
	if (["success", "skipped", "manual"].includes(raw)) return "pass";
	return ["failed", "canceled", "cancelled"].includes(raw) ? "fail" : "pending";
}
function toSummary(mr: RawMr, relation: Relation, accountId: string, baseUrl: string): PullRequestSummary {
	const pipeline = mr.head_pipeline ?? mr.pipeline;
	return {
		accountId,
		repo: repoOf(mr, baseUrl),
		number: mr.iid,
		title: mr.title,
		author: mr.author?.username ?? mr.author?.name ?? "unknown",
		avatarUrl: mr.author?.avatar_url ?? null,
		state: mr.state?.toUpperCase() === "OPENED" || !mr.state ? "OPEN" : mr.state.toUpperCase(),
		isDraft: mr.draft === true || mr.work_in_progress === true,
		url: mr.web_url,
		createdAt: mr.created_at,
		updatedAt: mr.updated_at,
		comments: mr.user_notes_count ?? 0,
		relation,
		additions: null,
		deletions: null,
		headRefName: mr.source_branch || null,
		checkState: pipelineState(pipeline?.status),
		reviewDecision: null,
	};
}
const BUCKETS: { relation: Relation; scope: string }[] = [
	{ relation: "reviewing", scope: "reviews_for_me" },
	{ relation: "authored", scope: "created_by_me" },
	{ relation: "reviewed", scope: "all" },
];
function at(repo: string, number: number): string {
	validateNumber(number);
	return `/projects/${projectId(repo)}/merge_requests/${number}`;
}
export const gitlab: ForgeDriver = {
	kind: "gitlab",
	identify: (conn) => identifyUser(conn, { login: "username", name: "name" }),
	async list(conn) {
		const results = await Promise.allSettled(
			BUCKETS.map(({ relation, scope }) =>
				json<RawMr[]>(conn, "/merge_requests", {
					query: {
						scope,
						state: "opened",
						per_page: PER_BUCKET,
						order_by: "updated_at",
						...(relation === "reviewed" ? { "approved_by_usernames[]": [conn.account.login] } : {}),
					},
				}).then((list) => (list ?? []).map((mr) => toSummary(mr, relation, conn.account.id, conn.account.baseUrl))),
			),
		);
		checkCancelled(conn.signal);
		// 已审筛选可能是付费能力，不因它失败抹掉另外两桶；全部失败则保留错误。
		const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
		if (!ok.length) throw (results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined)?.reason ?? new ForgeError("requestFailed");
		return dedupe(ok);
	},
	async detail(conn, repo, number) {
		const path = at(repo, number);
		const [mr, notes, approvals, commits] = await Promise.all([
			json<RawMr>(conn, path),
			json<RawNote[]>(conn, `${path}/notes`, { query: { per_page: 100, sort: "asc", order_by: "created_at" } }).catch(optional(conn.signal, [])),
			json<RawApprovals>(conn, `${path}/approvals`).catch(optional(conn.signal, {} as RawApprovals)),
			json<RawCommit[]>(conn, `${path}/commits`, { query: { per_page: 100 } }).catch(optional(conn.signal, [])),
		]);
		checkCancelled(conn.signal);
		const said = (notes ?? []).filter((note) => !note.system);
		const approvedBy = (approvals?.approved_by ?? []).map((a) => a.user?.username ?? "").filter(Boolean);
		const pipeline = mr.head_pipeline ?? mr.pipeline;
		const state = pipelineState(pipeline?.status);
		return {
			...toSummary(mr, "authored", conn.account.id, conn.account.baseUrl),
			repo,
			reviewDecision: approvals?.approved ? "APPROVED" : (approvals?.approvals_required ?? 0) > 0 ? "REVIEW_REQUIRED" : null,
			body: mr.description ?? "",
			changedFiles: mr.changes_count ? Number.parseInt(mr.changes_count, 10) || 0 : null,
			headRefName: mr.source_branch ?? "",
			baseRefName: mr.target_branch ?? "",
			comments: said.length,
			threads: said.map((n) => ({ author: n.author?.username ?? "unknown", body: n.body ?? "", createdAt: n.created_at ?? "" })),
			reviews: approvedBy.map((login) => ({ author: login, state: "APPROVED", body: "", submittedAt: "" })),
			reviewers: [
				...(mr.reviewers ?? []).map((r) => ({ login: r.username ?? "", state: "REQUESTED" })),
				...approvedBy.map((login) => ({ login, state: "APPROVED" })),
			].filter((r) => r.login),
			...summarizeChecks(
				pipeline?.status && state
					? [{ name: backendText(conn.locale ?? "en", "pipeline", { status: pipeline.status }), state, ...(pipeline.web_url ? { url: pipeline.web_url } : {}) }]
					: [],
			),
			mergeable: mr.has_conflicts ? "CONFLICTING" : mr.detailed_merge_status === "mergeable" || mr.merge_status === "can_be_merged" ? "MERGEABLE" : "UNKNOWN",
			labels: mr.labels ?? [],
			commits: (commits ?? []).map((c) => ({
				sha: (c.short_id || c.id || "").slice(0, 7),
				headline: c.title ?? "",
				author: c.author_name ?? "",
				at: c.created_at ?? "",
			})),
		};
	},
	async diff(conn, repo, number) {
		const body = await json<{ changes?: RawChange[] }>(conn, `${at(repo, number)}/changes`, { timeoutMs: DIFF_TIMEOUT_MS });
		return parseUnifiedDiff(
			assembleDiff(
				(body?.changes ?? []).map((c) => ({
					oldPath: c.old_path ?? c.new_path ?? "",
					newPath: c.new_path ?? c.old_path ?? "",
					patch: c.diff ?? "",
					added: c.new_file,
					deleted: c.deleted_file,
					renamed: c.renamed_file,
				})),
			),
		);
	},
	async comment(conn, repo, number, body) {
		await json(conn, `${at(repo, number)}/notes`, { method: "POST", body: { body } });
	},
	async review(conn, repo, number, verdict, body) {
		const path = at(repo, number);
		if (body.trim()) await json(conn, `${path}/notes`, { method: "POST", body: { body } });
		if (verdict === "approve") await json(conn, `${path}/approve`, { method: "POST" });
		if (verdict === "request-changes") {
			try {
				await json(conn, `${path}/unapprove`, { method: "POST" });
			} catch (error) {
				checkCancelled(conn.signal);
				// 未曾批准时 404 是正常的空操作，其他失败仍必须告知用户。
				if (!(error instanceof ForgeError) || error.status !== 404) throw error;
			}
		}
	},
};
interface RawNote {
	body?: string;
	created_at?: string;
	system?: boolean;
	author?: { username?: string } | null;
}
interface RawApprovals {
	approved?: boolean;
	approvals_required?: number;
	approved_by?: { user?: { username?: string } }[];
}
interface RawCommit {
	id?: string;
	short_id?: string;
	title?: string;
	created_at?: string;
	author_name?: string;
}
interface RawChange {
	old_path?: string;
	new_path?: string;
	diff?: string;
	new_file?: boolean;
	deleted_file?: boolean;
	renamed_file?: boolean;
}
