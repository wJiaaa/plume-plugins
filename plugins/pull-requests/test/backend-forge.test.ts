import assert from "node:assert/strict";
import { test } from "node:test";
import type { ForgeKind } from "../src/api.ts";
import { apiRoot, normalizeServer, validateRepo } from "../src/forge/accounts.ts";
import { parseUnifiedDiff } from "../src/forge/diff-parse.ts";
import { github } from "../src/forge/github.ts";
import { gitlab, repoOf } from "../src/forge/gitlab.ts";
import { gitee, toPatchFiles } from "../src/forge/gitee.ts";
import { gitea } from "../src/forge/gitea.ts";
import { assembleDiff } from "../src/forge/patch.ts";
import type { ForgeConnection, ForgeDriver } from "../src/forge/types.ts";

const TOKEN = "fixture-credential-for-provider-tests";
function connection(kind: ForgeKind, baseUrl = `https://${kind}.example`): ForgeConnection {
	return {
		account: { id: `${kind}-account`, kind, baseUrl, label: "me", login: "me", avatarUrl: null, enabled: true },
		token: TOKEN,
		signal: new AbortController().signal,
	};
}
const drivers: Record<ForgeKind, ForgeDriver> = { github, gitlab, gitee, gitea };
const patch = "diff --git a/a.ts b/a.ts\n@@ -1,2 +1,2 @@\n same\n-old\n+new\n";

test("四种服务的身份验证、认证头和自建 API 根", async (t) => {
	let current: ForgeConnection;
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
		assert.equal(String(input), `${apiRoot(current.account)}/user`);
		assert.equal(init?.redirect, "error");
		const headers = new Headers(init?.headers);
		assert.equal(
			headers.get(current.account.kind === "gitlab" ? "PRIVATE-TOKEN" : "Authorization"),
			current.account.kind === "gitlab" ? TOKEN : `${current.account.kind === "gitee" ? "token" : "Bearer"} ${TOKEN}`,
		);
		return Response.json({ login: "me", username: "me", name: "Name", full_name: "Full Name", avatar_url: "https://avatars.githubusercontent.com/u/1" });
	});
	for (const kind of Object.keys(drivers) as ForgeKind[]) {
		current = connection(kind, kind === "gitlab" ? "https://code.example/team/gitlab" : `https://${kind}.example`);
		assert.equal((await drivers[kind].identify(current)).login, "me");
	}
	assert.equal(normalizeServer("code.example/gitlab/api/v4/"), "https://code.example/gitlab");
	assert.equal(apiRoot(connection("github", "https://github.com").account), "https://api.github.com");
	for (const input of ["ftp://host", "https://user:fixture@host", "https://host?token=x", "https://host/#fragment"]) assert.equal(normalizeServer(input), null);
	for (const input of ["../repo", "a/../b", "a/%2e%2e", "a/b?x", "a//b", "a/b\\c"]) assert.throws(() => validateRepo(input));
});

test("GitHub 三桶单次查询去重，Enterprise GraphQL 与 REST 根分别正确", async (t) => {
	const conn = connection("github");
	const row = {
		number: 1,
		title: "PR",
		url: "https://github.example/a/b/pull/1",
		createdAt: "2026-01-01",
		updatedAt: "2026-01-02",
		repository: { nameWithOwner: "a/b" },
	};
	const calls: string[] = [];
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
		calls.push(String(input));
		if (String(input).endsWith("/graphql")) {
			assert.equal(String(input), "https://github.example/api/graphql");
			const body = JSON.parse(String(init?.body));
			if (body.variables.number)
				return Response.json({
					data: {
						repository: {
							pullRequest: {
								...row,
								body: "Body",
								headRefName: "feature",
								baseRefName: "main",
								reviewRequests: { nodes: [{ requestedReviewer: { login: "review-bot" } }] },
								reviews: { nodes: [{ author: { login: "reviewer" }, state: "APPROVED" }] },
								history: { nodes: [{ commit: { oid: "1234567890", messageHeadline: "Commit", author: { name: "Author" } } }] },
								checks: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ name: "CI", conclusion: "SUCCESS" }] } } } }] },
							},
						},
					},
				});
			assert.match(body.variables.reviewing, /review-requested:@me/);
			assert.match(body.variables.reviewed, /reviewed-by:@me/);
			return Response.json({ data: { reviewing: { nodes: [row] }, authored: { nodes: [row] }, reviewed: { nodes: [{ ...row, number: 2 }] } } });
		}
		return new Response(patch);
	});
	const list = await github.list(conn);
	assert.deepEqual(
		list.map((p) => [p.number, p.relation]),
		[
			[1, "reviewing"],
			[2, "reviewed"],
		],
	);
	assert.equal(calls.length, 1);
	const detail = await github.detail(conn, "a/b", 1);
	assert.equal(detail.checks?.passed, 1);
	assert.equal(detail.reviewers[0]?.login, "review-bot");
	assert.equal(detail.commits[0]?.sha, "1234567");
	assert.equal((await github.diff(conn, "a/b", 1))[0]?.added, 1);
	assert.equal(calls.at(-1), "https://github.example/api/v3/repos/a/b/pulls/1");
});

test("GitLab 子路径、子组、付费已审筛选失败和详情映射", async (t) => {
	const conn = connection("gitlab", "https://code.example/gitlab");
	const mr = {
		iid: 7,
		title: "MR",
		state: "opened",
		web_url: "https://code.example/gitlab/group/sub/repo/-/merge_requests/7",
		created_at: "2026-01-01",
		updated_at: "2026-01-02",
		head_pipeline: { status: "failed" },
		source_branch: "feature",
		target_branch: "main",
	};
	assert.equal(repoOf(mr, conn.account.baseUrl), "group/sub/repo");
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
		const url = new URL(String(input));
		if (url.pathname.endsWith("/merge_requests")) {
			if (url.searchParams.has("approved_by_usernames[]")) return Response.json({}, { status: 400 });
			return Response.json([mr]);
		}
		assert.ok(url.pathname.startsWith("/gitlab/api/v4/projects/group%2Fsub%2Frepo/merge_requests/7"));
		if (url.pathname.endsWith("/notes"))
			return Response.json([
				{ system: true, body: "System" },
				{ body: "Comment", author: { username: "reviewer" } },
			]);
		if (url.pathname.endsWith("/approvals")) return Response.json({ approved: true, approved_by: [{ user: { username: "reviewer" } }] });
		if (url.pathname.endsWith("/commits")) return Response.json([{ id: "abcdef1234", title: "Commit" }]);
		if (url.pathname.endsWith("/changes")) return Response.json({ changes: [{ old_path: "old", new_path: "new", renamed_file: true, diff: "" }] });
		return Response.json(mr);
	});
	const rows = await gitlab.list(conn);
	assert.equal(rows[0]?.repo, "group/sub/repo");
	assert.equal(rows[0]?.relation, "reviewing");
	const detail = await gitlab.detail(conn, "group/sub/repo", 7);
	assert.equal(detail.threads.length, 1);
	assert.equal(detail.reviewDecision, "APPROVED");
	assert.equal(detail.checks?.failed, 1);
	assert.equal((await gitlab.diff(conn, "group/sub/repo", 7))[0]?.status, "renamed");
});

test("Gitee 最近仓库扫描、审阅者关系和真实对象 patch", async (t) => {
	const conn = connection("gitee");
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
		const url = new URL(String(input));
		if (url.pathname.endsWith("/user/repos")) return Response.json([{ full_name: "owner/repo" }]);
		return Response.json([
			{
				number: 1,
				title: "PR",
				user: { login: "other" },
				assignees: [{ login: "ME" }],
				html_url: "https://gitee.example/owner/repo/pulls/1",
				created_at: "",
				updated_at: "",
			},
		]);
	});
	assert.equal((await gitee.list(conn))[0]?.relation, "reviewing");
	const files = toPatchFiles([
		{ filename: "new.ts", status: null, patch: { old_path: "new.ts", new_path: "new.ts", new_file: true, diff: "@@ -0,0 +1 @@\n+hello\n" } },
		{ filename: "large", patch: { too_large: true } },
	]);
	const result = parseUnifiedDiff(assembleDiff(files));
	assert.equal(result[0]?.status, "added");
	assert.equal(result[0]?.hunks[0]?.lines[0]?.newLine, 1);
	assert.equal(result[1]?.binary, true);
});

test("Gitea 三桶搜索和详情检查、提交、评论、评审均保留", async (t) => {
	const conn = connection("gitea");
	const flags: string[] = [];
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
		const url = new URL(String(input));
		if (url.pathname.endsWith("/search")) {
			flags.push([...url.searchParams.keys()].find((k) => ["review_requested", "created", "reviewed"].includes(k))!);
			return Response.json([
				{ number: 1, title: "PR", repository: { full_name: "a/b" }, created_at: "", updated_at: "", html_url: "https://gitea.example/a/b/pulls/1" },
			]);
		}
		if (url.pathname.endsWith("/comments")) return Response.json([{ body: "Comment", user: { login: "me" } }]);
		if (url.pathname.endsWith("/reviews")) return Response.json([{ state: "REQUEST_CHANGES", user: { login: "reviewer" } }]);
		if (url.pathname.endsWith("/commits")) return Response.json([{ sha: "1234567890", commit: { message: "Headline\nBody" } }]);
		if (url.pathname.endsWith("/status")) return Response.json({ statuses: [{ context: "CI", status: "error" }] });
		return Response.json({
			number: 1,
			title: "PR",
			body: "Body",
			head: { ref: "branch", sha: "abcdef123" },
			base: { ref: "main" },
			created_at: "",
			updated_at: "",
			html_url: "https://gitea.example/a/b/pulls/1",
		});
	});
	assert.equal((await gitea.list(conn)).length, 1);
	assert.deepEqual(flags.sort(), ["created", "review_requested", "reviewed"]);
	const detail = await gitea.detail(conn, "a/b", 1);
	assert.equal(detail.reviewDecision, "CHANGES_REQUESTED");
	assert.equal(detail.checks?.failed, 1);
	assert.equal(detail.commits[0]?.headline, "Headline");
	assert.equal(detail.threads[0]?.body, "Comment");
});

test("各家评论和三种评审使用对应协议", async (t) => {
	const requests: { url: string; body: Record<string, string> }[] = [];
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : {} });
		return new Response(null, { status: 204 });
	});
	for (const kind of Object.keys(drivers) as ForgeKind[]) {
		const conn = connection(kind);
		await drivers[kind].comment(conn, "a/b", 1, "Comment");
		for (const verdict of ["approve", "request-changes", "comment"] as const) await drivers[kind].review(conn, "a/b", 1, verdict, "Reason");
	}
	assert.ok(requests.some((r) => r.url.endsWith("/issues/1/comments")));
	for (const event of ["APPROVE", "APPROVED", "REQUEST_CHANGES", "COMMENT"]) assert.ok(requests.some((r) => r.body.event === event));
	for (const endpoint of ["/approve", "/unapprove", "/review", "/notes"]) assert.ok(requests.some((r) => r.url.endsWith(endpoint)));
});

test("统一 diff 的行号、重命名、二进制和八进制 UTF-8 路径", () => {
	const files = parseUnifiedDiff(
		patch +
			'diff --git "a/\\344\\270\\255.ts" "b/\\344\\270\\255.ts"\nnew file mode 100644\n@@ -0,0 +1 @@\n+字\n' +
			"diff --git a/old b/new\nrename from old\nrename to new\n" +
			"diff --git a/bin b/bin\nBinary files a/bin and b/bin differ\n",
	);
	assert.deepEqual(files[0]?.hunks[0], {
		oldStart: 1,
		newStart: 1,
		lines: [
			{ type: "context", text: "same", oldLine: 1, newLine: 1 },
			{ type: "remove", text: "old", oldLine: 2 },
			{ type: "add", text: "new", newLine: 2 },
		],
	});
	assert.equal(files[1]?.path, "中.ts");
	assert.equal(files[2]?.status, "renamed");
	assert.equal(files[3]?.binary, true);
});
