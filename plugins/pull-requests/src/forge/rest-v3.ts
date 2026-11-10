import type { PullRequestDetail } from "../api.ts";

export interface RawComment {
	body?: string;
	created_at?: string;
	user?: { login?: string } | null;
}
export interface RawCommit {
	sha?: string;
	author?: { login?: string } | null;
	commit?: { message?: string; author?: { name?: string; date?: string } } | null;
}
export function toThreads(comments: RawComment[]): PullRequestDetail["threads"] {
	return comments.map((c) => ({ author: c.user?.login ?? "unknown", body: c.body ?? "", createdAt: c.created_at ?? "" }));
}
export function toCommits(commits: RawCommit[]): PullRequestDetail["commits"] {
	return commits.map((c) => ({
		sha: (c.sha ?? "").slice(0, 7),
		headline: (c.commit?.message ?? "").split("\n")[0] ?? "",
		author: c.author?.login || c.commit?.author?.name || "",
		at: c.commit?.author?.date ?? "",
	}));
}
