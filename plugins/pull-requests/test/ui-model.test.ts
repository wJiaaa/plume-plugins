import assert from "node:assert/strict";
import { test } from "node:test";
import type { ForgeKindInfo, PullRequestDetail, PullRequestSummary } from "../src/api.ts";
import { activityOf, baseline, canSubmit, firstLine, groupFor, mergeLists, reconcileSeen, rowId, sameDetail, tokenUrl, unseenOf } from "../src/view/model.ts";
import { isDetail, isSummary } from "../src/view/cache.ts";

function summary(patch: Partial<PullRequestSummary> = {}): PullRequestSummary {
	return {
		accountId: "work",
		repo: "team/repo",
		number: 1,
		title: "Fix refresh",
		author: "alice",
		avatarUrl: null,
		state: "OPEN",
		isDraft: false,
		url: "https://github.com/team/repo/pull/1",
		createdAt: "2026-11-01T00:00:00Z",
		updatedAt: "2026-11-02T00:00:00Z",
		comments: 0,
		relation: "reviewing",
		additions: 3,
		deletions: 1,
		headRefName: "fix/cache",
		checkState: "pending",
		reviewDecision: null,
		...patch,
	};
}
function detail(patch: Partial<PullRequestDetail> = {}): PullRequestDetail {
	return {
		...summary(),
		body: "Description",
		changedFiles: 1,
		headRefName: "fix/cache",
		baseRefName: "main",
		threads: [],
		reviews: [],
		reviewers: [],
		checks: null,
		mergeable: "MERGEABLE",
		labels: [],
		commits: [],
		...patch,
	};
}

test("分组按待审、我的、已审排列，空组不画", () => {
	const groups = groupFor([summary({ relation: "reviewed", number: 3 }), summary({ relation: "authored", number: 2 }), summary()], "all", "");
	assert.deepEqual(
		groups.map((group) => group.key),
		["reviewing", "authored", "reviewed"],
	);
	assert.equal(groupFor([], "all", "").length, 0);
});
test("搜索不越过账号和关系筛选，支持分支和编号且忽略大小写", () => {
	const rows = [summary(), summary({ accountId: "personal", relation: "authored", number: 2 })];
	assert.equal(groupFor(rows, "authored", "fix", "work").length, 0);
	assert.equal(groupFor(rows, "all", " FIX/CACHE ", "work")[0]!.items.length, 1);
	assert.equal(groupFor(rows, "all", "#2")[0]!.items[0]!.accountId, "personal");
});
test("无变化刷新复用数组和行对象，首次加载不闪高亮", () => {
	const previous = [summary()];
	const same = mergeLists(previous, [summary()]);
	assert.equal(same.items, previous);
	assert.equal(same.items[0], previous[0]);
	assert.equal(same.touched.size, 0);
	assert.equal(mergeLists([], previous).touched.size, 0);
	const changed = mergeLists(previous, [summary({ checkState: "pass" }), summary({ accountId: "other" })]);
	assert.deepEqual([...changed.touched], [rowId(previous[0]!), rowId(summary({ accountId: "other" }))]);
});
test("未读基线不把首次列表当新闻，阅读中的条目同步确认，消失的条目被清掉", () => {
	const a = summary();
	const b = summary({ number: 2 });
	assert.equal(unseenOf([a], null).size, 0);
	const seen = baseline([a, b]);
	const updated = summary({ updatedAt: "2026-11-03T00:00:00Z" });
	const another = summary({ number: 3 });
	const synced = reconcileSeen(seen, [updated, another], updated);
	assert.equal(synced[rowId(updated)], updated.updatedAt);
	assert.equal(synced[rowId(b)], undefined);
	assert.deepEqual([...unseenOf([updated, another], synced)], [rowId(another)]);
});
test("同仓库同编号在两个账号下不是同一条，更新不会互相覆盖", () => {
	const a = summary();
	const b = summary({ accountId: "gitlab" });
	assert.notEqual(rowId(a), rowId(b));
	assert.equal(unseenOf([a, b], baseline([a])).size, 1);
});
test("详情比较检测检查名称及同长度评论的编辑，不仅检测数量", () => {
	const before = detail({
		threads: [{ author: "alice", body: "Before", createdAt: "2026-11-02T00:00:00Z" }],
		checks: { total: 1, passed: 0, failed: 1, pending: 0, items: [{ name: "build", state: "fail" }] },
	});
	assert.equal(sameDetail(before, structuredClone(before)), true);
	assert.equal(sameDetail(before, { ...before, threads: [{ ...before.threads[0]!, body: "After" }] }), false);
	assert.equal(sameDetail(before, { ...before, checks: { ...before.checks!, items: [{ name: "test", state: "fail" }] } }), false);
});
test("时间线交错提交、评论和审查，按时间顺序排列且 key 不撞", () => {
	const entries = activityOf(
		detail({
			commits: [{ sha: "abc", headline: "Commit", author: "alice", at: "2026-11-01T02:00:00Z" }],
			threads: [{ author: "bob", body: "Comment", createdAt: "2026-11-01T01:00:00Z" }],
			reviews: [{ author: "bob", body: "Review", state: "APPROVED", submittedAt: "2026-11-01T03:00:00Z" }],
		}),
	);
	assert.deepEqual(
		entries.map((entry) => entry.kind),
		["opened", "comment", "commit", "review"],
	);
	assert.equal(new Set(entries.map((entry) => entry.key)).size, 4);
	assert.equal(firstLine("\n## Heading\nBody"), "Heading");
});
test("缓存拒绝残缺或坏形状，不修补成伪造数据", () => {
	assert.equal(isSummary(summary()), true);
	assert.equal(isSummary({ title: "partial" }), false);
	assert.equal(isSummary(summary({ number: Number.NaN })), false);
	assert.equal(isDetail(detail()), true);
	assert.equal(isDetail({ ...detail(), threads: [null] }), false);
	assert.equal(isDetail({ ...detail(), checks: { total: 1, passed: 1, failed: 0, pending: 0, items: [{}] } }), false);
});
test("请求修改及评论必须有正文，批准可不附言", () => {
	assert.equal(canSubmit("request-changes", " \n"), false);
	assert.equal(canSubmit("comment", ""), false);
	assert.equal(canSubmit("approve", ""), true);
	assert.equal(canSubmit("request-changes", "Please fix the race"), true);
});
test("创建令牌链接使用自建实例，不允许非 http 协议", () => {
	const info: ForgeKindInfo = { kind: "gitlab", name: "GitLab", baseUrl: "https://gitlab.com", tokenUrl: "https://gitlab.com/token", scopes: "api", note: "" };
	assert.equal(tokenUrl(info, "https://gitlab.com/"), info.tokenUrl);
	assert.equal(tokenUrl(info, "https://git.company.test/"), "https://git.company.test/-/user_settings/personal_access_tokens?name=Plume&scopes=api");
	assert.equal(tokenUrl(info, "javascript:alert(1)"), null);
});
