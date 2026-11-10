import type { PullRequestSummary } from "../api.ts";
import { repoPath, validateNumber } from "./accounts.ts";
import { parseUnifiedDiff } from "./diff-parse.ts";
import { checkCancelled, optional } from "./errors.ts";
import { DIFF_TIMEOUT_MS, identifyUser, json, pooled } from "./http.ts";
import { assembleDiff, type PatchFile } from "./patch.ts";
import { type RawComment, type RawCommit, toCommits, toThreads } from "./rest-v3.ts";
import type { ForgeConnection, ForgeDriver } from "./types.ts";

const SCAN_REPOS = 20;
const CONCURRENCY = 5;
const REPOS_TTL_MS = 10 * 60_000;
const repoCache = new Map<string, { at: number; repos: string[] }>();
interface RawPull {
	number: number;
	title: string;
	body?: string;
	state?: string;
	draft?: boolean;
	mergeable?: boolean;
	html_url: string;
	created_at: string;
	updated_at: string;
	comments?: number;
	user?: { login?: string; avatar_url?: string; name?: string } | null;
	head?: { ref?: string; repo?: { full_name?: string } | null } | null;
	base?: { ref?: string; repo?: { full_name?: string } | null } | null;
	assignees?: ({ login?: string } | null)[] | null;
	testers?: ({ login?: string } | null)[] | null;
	labels?: { name?: string }[] | null;
}
async function repositories(conn: ForgeConnection): Promise<string[]> {
	checkCancelled(conn.signal);
	const hit = repoCache.get(conn.account.id);
	if (hit && Date.now() - hit.at < REPOS_TTL_MS) return hit.repos;
	const list = await json<{ full_name?: string }[]>(conn, "/user/repos", { query: { sort: "pushed", direction: "desc", per_page: 100 } });
	const repos = (list ?? [])
		.map((repo) => repo.full_name ?? "")
		.filter(Boolean)
		.slice(0, SCAN_REPOS);
	repoCache.set(conn.account.id, { at: Date.now(), repos });
	return repos;
}
const named = (people: ({ login?: string } | null)[] | null | undefined, me: string) => (people ?? []).some((p) => (p?.login ?? "").toLowerCase() === me);
function toSummary(pull: RawPull, repo: string, relation: PullRequestSummary["relation"], accountId: string): PullRequestSummary {
	return {
		accountId,
		repo,
		number: pull.number,
		title: pull.title,
		author: pull.user?.login ?? pull.user?.name ?? "unknown",
		avatarUrl: pull.user?.avatar_url ?? null,
		state: (pull.state ?? "open").toUpperCase(),
		isDraft: pull.draft === true,
		url: pull.html_url,
		createdAt: pull.created_at,
		updatedAt: pull.updated_at,
		comments: pull.comments ?? 0,
		relation,
		additions: null,
		deletions: null,
		headRefName: pull.head?.ref || null,
		checkState: null,
		reviewDecision: null,
	};
}
function at(repo: string, number: number): string {
	validateNumber(number);
	return `/repos/${repoPath(repo)}/pulls/${number}`;
}
export const gitee: ForgeDriver = {
	kind: "gitee",
	identify: (conn) => identifyUser(conn),
	async list(conn) {
		const me = conn.account.login.toLowerCase();
		const repos = await repositories(conn);
		const results = await pooled(repos, CONCURRENCY, async (repo) => {
			checkCancelled(conn.signal);
			try {
				const pulls = await json<RawPull[]>(conn, `/repos/${repoPath(repo)}/pulls`, {
					query: { state: "open", sort: "updated", direction: "desc", per_page: 100 },
				});
				return {
					rows: (pulls ?? []).flatMap((pull) => {
						if ((pull.user?.login ?? "").toLowerCase() === me) return [toSummary(pull, repo, "authored", conn.account.id)];
						if (named(pull.assignees, me) || named(pull.testers, me)) return [toSummary(pull, repo, "reviewing", conn.account.id)];
						return [];
					}),
					error: null as unknown,
				};
			} catch (error) {
				checkCancelled(conn.signal);
				return { rows: [] as PullRequestSummary[], error };
			}
		});
		checkCancelled(conn.signal);
		if (results.length && results.every((r) => r.error)) throw results[0]!.error;
		return results.flatMap((r) => r.rows);
	},
	async detail(conn, repo, number) {
		const path = at(repo, number);
		const [pull, comments, commits] = await Promise.all([
			json<RawPull>(conn, path),
			json<RawComment[]>(conn, `${path}/comments`, { query: { per_page: 100 } }).catch(optional(conn.signal, [])),
			json<RawCommit[]>(conn, `${path}/commits`).catch(optional(conn.signal, [])),
		]);
		checkCancelled(conn.signal);
		return {
			...toSummary(pull, repo, "authored", conn.account.id),
			body: pull.body ?? "",
			changedFiles: null,
			headRefName: pull.head?.ref ?? "",
			baseRefName: pull.base?.ref ?? "",
			comments: comments?.length ?? pull.comments ?? 0,
			threads: toThreads(comments ?? []),
			reviews: [],
			reviewers: [
				...(pull.assignees ?? []).map((p) => ({ login: p?.login ?? "", state: "REQUESTED" })),
				...(pull.testers ?? []).map((p) => ({ login: p?.login ?? "", state: "REQUESTED" })),
			].filter((r) => r.login),
			checks: null,
			mergeable: pull.mergeable === false ? "CONFLICTING" : "MERGEABLE",
			labels: (pull.labels ?? []).map((l) => l.name ?? "").filter(Boolean),
			commits: toCommits(commits ?? []),
		};
	},
	async diff(conn, repo, number) {
		const files = await json<RawFile[]>(conn, `${at(repo, number)}/files`, { timeoutMs: DIFF_TIMEOUT_MS });
		return parseUnifiedDiff(assembleDiff(toPatchFiles(files ?? [])));
	},
	async comment(conn, repo, number, body) {
		await json(conn, `${at(repo, number)}/comments`, { method: "POST", body: { body } });
	},
	async review(conn, repo, number, verdict, body) {
		const path = at(repo, number);
		if (body.trim()) await json(conn, `${path}/comments`, { method: "POST", body: { body } });
		if (verdict === "approve") await json(conn, `${path}/review`, { method: "POST" });
	},
};
// Gitee 实际返回的 patch 可以是 GitLab 形状的对象，并不总是文档里的字符串。
export function toPatchFiles(files: RawFile[]): PatchFile[] {
	return files.map((file) => {
		const patch = typeof file.patch === "string" ? null : (file.patch ?? null);
		const body = (patch ? patch.diff : typeof file.patch === "string" ? file.patch : "") ?? "";
		const oldPath = patch?.old_path || file.filename || "";
		const newPath = patch?.new_path || file.filename || oldPath;
		const renamed = patch?.renamed_file === true || file.status === "renamed";
		return {
			oldPath,
			newPath,
			patch: body,
			added: patch?.new_file === true || file.status === "added",
			deleted: patch?.deleted_file === true || file.status === "removed",
			renamed,
			binary: patch?.too_large === true || (!body && !renamed),
		};
	});
}
export interface RawFile {
	filename?: string;
	status?: string | null;
	patch?: string | RawPatch | null;
}
interface RawPatch {
	diff?: string;
	old_path?: string;
	new_path?: string;
	new_file?: boolean;
	deleted_file?: boolean;
	renamed_file?: boolean;
	too_large?: boolean;
}
