import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { ForgeAccount, ListResult, PullRequestDetail, PullRequestSummary } from "../src/api.ts";
import { cacheDetail, readDetails, readList, writeCache } from "../src/view/cache.ts";
import { rowId } from "../src/view/model.ts";
import { createStore, type Api } from "../src/view/store.ts";

function storage(t: TestContext) {
	const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	const values = new Map<string, string>();
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => {
				values.set(key, value);
			},
		},
	});
	t.after(() => {
		if (original) Object.defineProperty(globalThis, "localStorage", original);
		else Reflect.deleteProperty(globalThis, "localStorage");
	});
	return values;
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = Object.assign(
		new Promise<T>((yes, no) => {
			resolve = yes;
			reject = no;
		}),
		{ cancel: () => reject(new Error("cancelled")) },
	);
	return { promise, resolve, reject };
}
const account: ForgeAccount = { id: "work", kind: "github", label: "Work", baseUrl: "https://github.com", login: "alice", avatarUrl: null, enabled: true };
function summary(number = 1): PullRequestSummary {
	return {
		accountId: "work",
		repo: "team/repo",
		number,
		title: "Review",
		author: "alice",
		avatarUrl: null,
		state: "OPEN",
		isDraft: false,
		url: "https://github.com/team/repo/pull/1",
		createdAt: "2026-11-01T00:00:00Z",
		updatedAt: "2026-11-02T00:00:00Z",
		comments: 0,
		relation: "reviewing",
		additions: null,
		deletions: null,
		headRefName: "main",
		checkState: null,
		reviewDecision: null,
	};
}
function detail(number: number): PullRequestDetail {
	return {
		...summary(number),
		body: "Description",
		changedFiles: 1,
		headRefName: "topic",
		baseRefName: "main",
		threads: [],
		reviews: [],
		reviewers: [],
		checks: null,
		mergeable: "MERGEABLE",
		labels: [],
		commits: [],
	};
}

test("缓存先提供列表，详情只保留最近 24 个，损坏缓存不抛错", (t) => {
	const values = storage(t);
	writeCache("list", [summary()]);
	assert.equal(readList()[0]!.number, 1);
	const cache = new Map<string, PullRequestDetail>();
	for (let i = 1; i <= 25; i++) cacheDetail(cache, detail(i));
	assert.equal(readDetails().size, 24);
	assert.equal(readDetails().has(rowId(detail(1))), false);
	values.set("plume.pull-requests.list", "not-json");
	assert.deepEqual(readList(), []);
});
test("列表请求合并，20 秒内唤醒不重读，失败保留已有缓存", async (t) => {
	storage(t);
	writeCache("list", [summary()]);
	let now = 30_000;
	t.mock.method(Date, "now", () => now);
	const first = deferred<ListResult>();
	let calls = 0;
	const api = {
		accounts: async () => [account],
		myPullRequests: () => {
			calls++;
			return first.promise;
		},
	} as unknown as Api;
	const store = createStore(api);
	t.after(store.stop);
	await store.reloadAccounts();
	const pending = store.refresh(() => null);
	await store.refresh(() => null);
	assert.equal(calls, 1);
	first.resolve({ pullRequests: [summary()], errors: {} });
	await pending;
	now += 19_999;
	await store.refresh(() => null, true);
	assert.equal(calls, 1);
	const failure = deferred<ListResult>();
	api.myPullRequests = (() => {
		calls++;
		return failure.promise;
	}) as unknown as Api["myPullRequests"];
	const second = store.refresh(() => null);
	failure.resolve({ pullRequests: [], errors: { work: "Offline" }, error: "Offline" });
	await second;
	assert.equal(store.getSnapshot().items.length, 1);
	assert.equal(store.getSnapshot().error, "Offline");
});
test("账号停用时清掉列表和详情，旧列表回复不能把它们放回去", async (t) => {
	storage(t);
	writeCache("list", [summary()]);
	const pending = deferred<ListResult>();
	pending.promise.cancel = () => {};
	let enabled = true;
	const api = { accounts: async () => [{ ...account, enabled }], myPullRequests: () => pending.promise } as unknown as Api;
	const store = createStore(api);
	t.after(store.stop);
	await store.reloadAccounts();
	cacheDetail(store.details, detail(1));
	const refresh = store.refresh(() => null);
	enabled = false;
	await store.invalidateAccounts();
	pending.resolve({ pullRequests: [summary()], errors: {} });
	await refresh;
	assert.equal(store.getSnapshot().items.length, 0);
	assert.equal(store.details.size, 0);
});
test("请求返回时才确定正在阅读的目标，而非使用请求发出时的旧选择", async (t) => {
	storage(t);
	writeCache("seen", {});
	const pending = deferred<ListResult>();
	const api = { accounts: async () => [account], myPullRequests: () => pending.promise } as unknown as Api;
	const store = createStore(api);
	t.after(store.stop);
	await store.reloadAccounts();
	let selected = summary(1);
	const refresh = store.refresh(() => selected);
	selected = summary(2);
	pending.resolve({ pullRequests: [summary(1), summary(2)], errors: {} });
	await refresh;
	assert.equal(store.getSnapshot().seen?.[rowId(summary(2))], summary(2).updatedAt);
	assert.equal(store.getSnapshot().seen?.[rowId(summary(1))], undefined);
});
test("失败保留目标草稿，单次提交锁跨页面挂载，不会清空另一条的文字", (t) => {
	storage(t);
	const store = createStore({} as Api);
	store.setDraft("one", "Reason");
	store.setDraft("two", "Other");
	assert.equal(store.startReview("one"), true);
	assert.equal(store.startReview("two"), false);
	store.finishReview("one", "Reason", "Offline");
	assert.equal(store.getSnapshot().drafts.one, "Reason");
	assert.equal(store.getSnapshot().reviewErrors.one, "Offline");
	assert.equal(store.startReview("one"), true);
	store.finishReview("one", "Reason", null);
	assert.equal(store.getSnapshot().drafts.one, "");
	assert.equal(store.getSnapshot().drafts.two, "Other");
});
