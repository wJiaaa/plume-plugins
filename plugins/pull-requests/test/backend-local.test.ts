import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { ForgeAccount, PullRequestDetail } from "../src/api.ts";
import { findLocalCheckout, matchesOrigin, scratchKey, writePullRequestScratch } from "../src/forge/local.ts";

const execFile = promisify(execFileCallback);
const account: ForgeAccount = {
	id: "account-1",
	kind: "gitlab",
	baseUrl: "https://code.example/gitlab",
	label: "me",
	login: "me",
	enabled: true,
	avatarUrl: null,
};
function detail(): PullRequestDetail {
	return {
		accountId: account.id,
		repo: "group/sub/repo",
		number: 1,
		title: "Title",
		body: "Untrusted PR body",
		author: "other",
		avatarUrl: null,
		state: "OPEN",
		isDraft: false,
		url: "https://code.example/gitlab/group/sub/repo/-/merge_requests/1",
		createdAt: "",
		updatedAt: "",
		comments: 0,
		relation: "reviewing",
		additions: null,
		deletions: null,
		headRefName: "feature",
		baseRefName: "main",
		checkState: null,
		reviewDecision: null,
		changedFiles: null,
		threads: [],
		reviews: [],
		reviewers: [],
		checks: null,
		mergeable: "UNKNOWN",
		labels: [],
		commits: [],
	};
}

test("本地 origin 同时匹配账号主机、实例子路径和完整仓库", () => {
	assert.equal(matchesOrigin(account, "group/sub/repo", "https://code.example/gitlab/group/sub/repo.git"), true);
	assert.equal(matchesOrigin(account, "group/sub/repo", "https://other.example/gitlab/group/sub/repo.git"), false);
	assert.equal(matchesOrigin(account, "group/sub/repo", "https://code.example/other/group/sub/repo.git"), false);
	assert.equal(matchesOrigin(account, "group/sub/repo", "https://code.example/gitlab/group/sub/repo-other.git"), false);
	assert.equal(matchesOrigin(account, "group/sub/repo", "ext::command"), false);
	assert.equal(matchesOrigin(account, "group/sub/repo", "git@code.example:group/sub/repo.git"), true);
	assert.equal(matchesOrigin(account, "group/sub/repo", "ssh://git@code.example/group/sub/repo.git"), true);
	assert.equal(matchesOrigin({ ...account, baseUrl: "https://code.example" }, "group/sub/repo", "git@code.example:group/sub/repo.git"), true);
});

test("真实本地 git config 只认匹配的 origin，取消不继续扫描", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-pr-checkout-"));
	try {
		await execFile("git", ["init", "--quiet", dir]);
		await execFile("git", ["-C", dir, "config", "remote.origin.url", "https://code.example/gitlab/group/sub/repo.git"]);
		assert.equal(await findLocalCheckout(account, "group/sub/repo", [dir], new AbortController().signal), dir);
		assert.equal(await findLocalCheckout(account, "group/sub/other", [dir], new AbortController().signal), null);
		const stopped = new AbortController();
		stopped.abort();
		await assert.rejects(findLocalCheckout(account, "group/sub/repo", [dir], stopped.signal));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("PR scratch 稳定隔离且只写私有目录，拒绝符号链接和仓库路径逃逸", async () => {
	const root = await mkdtemp(join(tmpdir(), "plume-pr-scratch-"));
	try {
		const data = join(root, "private");
		const first = await writePullRequestScratch(data, account, "group/sub/repo", 1, detail(), new AbortController().signal);
		const second = await writePullRequestScratch(data, account, "group/sub/repo", 1, detail(), new AbortController().signal);
		assert.equal(first, second);
		assert.ok(first.startsWith(`${await realpath(data)}/scratch/`));
		assert.match(await readFile(join(first, "PR.md"), "utf8"), /Untrusted external pull request content/);
		assert.notEqual(scratchKey(account.id, "group/sub/repo", 1), scratchKey("other-account", "group/sub/repo", 1));
		await assert.rejects(writePullRequestScratch(data, account, "../repo", 1, detail(), new AbortController().signal));
		const blockedData = join(root, "blocked");
		const outside = join(root, "outside");
		await mkdir(blockedData);
		await mkdir(outside);
		await symlink(outside, join(blockedData, "scratch"));
		await assert.rejects(writePullRequestScratch(blockedData, account, "group/sub/repo", 1, detail(), new AbortController().signal));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
