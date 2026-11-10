import { apiRoot, repoPath, splitRepo, validateNumber } from "./accounts.ts";
import { parseUnifiedDiff } from "./diff-parse.ts";
import { ForgeError } from "./errors.ts";
import { DETAIL_QUERY, type DetailNode, toDetail } from "./github-gql.ts";
import { DIFF_TIMEOUT_MS, identifyUser, json, text } from "./http.ts";
import { BUCKETS, dedupe, parseSearch, PER_BUCKET, SEARCH_QUERY, toSummary } from "./pr-summary.ts";
import type { ForgeConnection, ForgeDriver } from "./types.ts";

async function graphql<T>(conn: ForgeConnection, query: string, variables: Record<string, unknown>): Promise<T> {
	const body = await json<{ data?: T; errors?: { message?: string; type?: string }[] }>(conn, "/graphql", {
		method: "POST",
		root: apiRoot(conn.account).replace(/\/v3$/, ""),
		body: { query, variables },
	});
	if (body?.errors?.length) {
		const limited = body.errors.some((e) => e.type === "RATE_LIMITED" || /rate limit/i.test(e.message ?? ""));
		throw new ForgeError(limited ? "rateLimited" : "githubRejected");
	}
	if (!body?.data) throw new ForgeError("githubNoData");
	return body.data;
}
function at(repo: string, number: number): string {
	validateNumber(number);
	return `/repos/${repoPath(repo)}/pulls/${number}`;
}
export const github: ForgeDriver = {
	kind: "github",
	identify: (conn) => identifyUser(conn),
	async list(conn) {
		const data = await graphql<Parameters<typeof parseSearch>[0]>(conn, SEARCH_QUERY, {
			...Object.fromEntries(BUCKETS.map(({ relation, query }) => [relation, query])),
			n: PER_BUCKET,
		});
		const found = parseSearch(data);
		return dedupe(BUCKETS.map(({ relation }) => found[relation].map((node) => toSummary(node, relation, conn.account.id))));
	},
	async detail(conn, repo, number) {
		validateNumber(number);
		const data = await graphql<{ repository?: { pullRequest?: DetailNode | null } | null }>(conn, DETAIL_QUERY, { ...splitRepo(repo), number });
		const node = data.repository?.pullRequest;
		if (!node) throw new ForgeError("pullRequestMissing", 404);
		return toDetail(conn, repo, node);
	},
	async diff(conn, repo, number) {
		return parseUnifiedDiff(await text(conn, at(repo, number), { accept: "application/vnd.github.diff", timeoutMs: DIFF_TIMEOUT_MS }));
	},
	async comment(conn, repo, number, body) {
		validateNumber(number);
		await json(conn, `/repos/${repoPath(repo)}/issues/${number}/comments`, { method: "POST", body: { body } });
	},
	async review(conn, repo, number, verdict, body) {
		const event = verdict === "approve" ? "APPROVE" : verdict === "request-changes" ? "REQUEST_CHANGES" : "COMMENT";
		await json(conn, `${at(repo, number)}/reviews`, { method: "POST", body: { event, ...(body.trim() ? { body } : {}) } });
	},
};
