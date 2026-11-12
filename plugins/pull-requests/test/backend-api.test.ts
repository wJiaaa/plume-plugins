import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPullRequestsApi } from "../src/forge/index.ts";
import plugin from "../src/index.ts";
import { fakeSecrets } from "./fake-secrets.ts";
import type { PluginContext, ToolDefinition, ToolRun } from "@plume/contract";

// 多账号共用相同仓库名时，失败只影响自己的账号，列表仍保留另外的账号。
test("跨账号聚合部分失败、错误持久化、禁用与改名", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "plume-pr-api-"));
	const lifecycle = new AbortController();
	const api = createPullRequestsApi({ dataDir: dir, secrets: fakeSecrets(), locale: () => "en", signal: lifecycle.signal });
	const call = { signal: new AbortController().signal };
	let requests = 0;
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
		requests++;
		const url = new URL(String(input));
		if (url.pathname.endsWith("/user")) return Response.json({ login: "me", full_name: "Me" });
		if (url.hostname === "broken.example") return Response.json({}, { status: 401 });
		return Response.json([
			{
				number: 1,
				title: "PR",
				repository: { full_name: "a/b" },
				html_url: "https://good.example/a/b/pulls/1",
				created_at: "2026-01-01",
				updated_at: "2026-01-02",
			},
		]);
	});
	try {
		const good = (await api.signIn({ kind: "gitea", baseUrl: "https://good.example", token: "fixture-credential-good" }, call)).account!;
		const broken = (await api.signIn({ kind: "gitea", baseUrl: "https://broken.example", token: "fixture-credential-broken" }, call)).account!;
		assert.ok(good);
		assert.ok(broken);
		const result = await api.myPullRequests(call);
		assert.equal(result.error, undefined);
		assert.equal(result.pullRequests.length, 1);
		assert.equal(result.pullRequests[0]?.accountId, good.id);
		assert.ok(result.errors[broken.id]);
		assert.ok((await api.accounts()).find((a) => a.id === broken.id)?.lastError);
		assert.equal((await api.rename(good.id, " Work "))?.label, "Work");
		await api.setEnabled(broken.id, false);
		assert.deepEqual((await api.myPullRequests(call)).errors, {});
		const before = requests;
		assert.ok((await api.pullRequest(good.id, "a/../user", 1, call)).error);
		assert.ok((await api.pullRequestDiff(good.id, "a/b", -1, call)).error);
		assert.ok((await api.commentOnPullRequest(good.id, "a/b", 1, " ", call)).error);
		assert.ok((await api.reviewPullRequest(good.id, "a/b", 1, "request-changes", "", call)).error);
		assert.equal(requests, before);
		await api.signOut(good.id);
		assert.equal((await api.accounts()).length, 1);
	} finally {
		lifecycle.abort();
		await rm(dir, { recursive: true, force: true });
	}
});

test("插件只注册只读 PR 工具，没有绕过审批的外部写工具", async () => {
	const tools: ToolDefinition[] = [];
	const effects: (() => void | Promise<void>)[] = [];
	plugin.apply({
		dataDir: "/unused-plugin-test-directory",
		locale: () => "en",
		secrets: fakeSecrets(),
		effect: (dispose: () => void | Promise<void>) => {
			effects.push(dispose);
		},
		serve: () => {},
		tools: {
			register: (tool: ToolDefinition) => {
				tools.push(tool);
				return () => {};
			},
		},
	} as unknown as PluginContext);
	assert.deepEqual(
		tools.map((tool) => [tool.name, tool.mutating]),
		[["read_pull_request", false]],
	);
	assert.match(tools[0]!.description, /untrusted external data/);
	assert.equal(effects.length, 1);
	const invalid = await tools[0]!.execute({ accountId: "a", repo: "a/b", number: 0 }, { signal: new AbortController().signal } as ToolRun);
	assert.equal(invalid.isError, true);
	await effects[0]!();
});
