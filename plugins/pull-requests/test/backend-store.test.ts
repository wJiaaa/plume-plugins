import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ForgeAccount } from "../src/api.ts";
import { AccountStore } from "../src/forge/vault.ts";
import { createPullRequestsApi } from "../src/forge/index.ts";
import { ForgeError } from "../src/forge/errors.ts";
import { fakeSecrets } from "./fake-secrets.ts";

const signal = () => new AbortController().signal;
function draft(id: string, baseUrl = "https://gitlab.example/team"): ForgeAccount {
	return { id, kind: "gitlab", baseUrl, label: "", login: "", enabled: true, avatarUrl: null };
}
const identity = { login: "me", name: "Me", avatarUrl: null };

test("账号并发写入不丢失，同身份更新令牌而不同子路径独立", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-pr-store-"));
	try {
		const secrets = fakeSecrets();
		const store = new AccountStore(dir, secrets);
		const [first, duplicate, other] = await Promise.all([
			store.saveIdentity(draft("a"), identity, "fixture-credential-1", signal()),
			store.saveIdentity(draft("b"), identity, "fixture-credential-2", signal()),
			store.saveIdentity(draft("c", "https://gitlab.example/other"), identity, "fixture-credential-3", signal()),
		]);
		assert.equal(first.id, duplicate.id);
		assert.notEqual(other.id, first.id);
		assert.equal((await store.connect(first.id, signal())).token, "fixture-credential-2");
		await Promise.all([store.update(first.id, { label: "Work" }), store.update(other.id, { enabled: false })]);
		const reopened = new AccountStore(dir, secrets);
		const accounts = await reopened.list();
		assert.equal((await reopened.connect(first.id, signal())).token, (await store.connect(first.id, signal())).token);
		assert.equal(accounts.length, 2);
		assert.ok(!JSON.stringify(accounts).includes("fixture-credential"));
		assert.equal(accounts.find((a) => a.id === first.id)?.label, "Work");
		assert.equal(accounts.find((a) => a.id === other.id)?.enabled, false);
		assert.equal((await stat(join(dir, "accounts.json"))).mode & 0o777, 0o600);
		const disk = await readFile(join(dir, "accounts.json"), "utf8");
		assert.ok(!disk.includes("fixture-credential"));
		for (const entry of JSON.parse(disk).entries as { account: { id: string }; token: string }[]) {
			assert.ok(secrets.isSealed(entry.token));
			const token = (await reopened.connect(entry.account.id, signal())).token;
			assert.ok(!disk.includes(token));
		}
		assert.deepEqual(await readdir(dir), ["accounts.json"]);
		await store.remove(first.id);
		assert.equal((await store.list()).length, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("无法解析的账号文件不被空列表覆盖，也不跟随账号文件符号链接", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-pr-corrupt-"));
	try {
		const data = join(dir, "data");
		const store = new AccountStore(data, fakeSecrets());
		await store.list();
		await writeFile(join(data, "accounts.json"), "{invalid}", { mode: 0o600 });
		const broken = new AccountStore(data, fakeSecrets());
		await assert.rejects(broken.saveIdentity(draft("a"), identity, "fixture", signal()));
		assert.equal(await readFile(join(data, "accounts.json"), "utf8"), "{invalid}");
		const target = join(dir, "external.json");
		await writeFile(target, "do not touch", { mode: 0o600 });
		const linked = join(dir, "linked");
		await new AccountStore(linked, fakeSecrets()).list();
		await symlink(target, join(linked, "accounts.json"));
		await assert.rejects(new AccountStore(linked, fakeSecrets()).list());
		assert.equal(await readFile(target, "utf8"), "do not touch");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("登录先验证再保存，失败不落盘，账号视图不返回令牌", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "plume-pr-signin-"));
	const lifecycle = new AbortController();
	const api = createPullRequestsApi({ dataDir: dir, secrets: fakeSecrets(), locale: () => "en", signal: lifecycle.signal });
	let valid = false;
	t.mock.method(globalThis, "fetch", async () =>
		valid ? Response.json({ login: "me", name: "Me" }) : Response.json({ message: "fixture-credential" }, { status: 401 }),
	);
	try {
		const input = { kind: "github" as const, baseUrl: "https://github.com", token: "fixture-credential" };
		const failed = await api.signIn(input, { signal: signal() });
		assert.ok(failed.error);
		assert.ok(!failed.error.includes(input.token));
		assert.deepEqual(await readdir(dir), []);
		valid = true;
		const success = await api.signIn(input, { signal: signal() });
		assert.ok(success.account);
		assert.ok(!JSON.stringify(success).includes(input.token));
		const repeated = await api.signIn({ ...input, token: "fixture-credential-updated" }, { signal: signal() });
		assert.equal(repeated.account?.id, success.account.id);
		assert.equal((await api.accounts()).length, 1);
		const cancelled = new AbortController();
		cancelled.abort();
		assert.ok((await api.signIn(input, { signal: cancelled.signal })).error);
	} finally {
		lifecycle.abort();
		await rm(dir, { recursive: true, force: true });
	}
});

test("生命周期取消终止登录，固定方法参数个数保留 RPC 取消上下文", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "plume-pr-cancel-"));
	const lifecycle = new AbortController();
	const api = createPullRequestsApi({ dataDir: dir, secrets: fakeSecrets(), locale: () => "en", signal: lifecycle.signal });
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	t.mock.method(
		globalThis,
		"fetch",
		async (_url: unknown, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init!.signal!.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
				started();
			}),
	);
	try {
		for (const [method, count] of [
			["signIn", 2],
			["myPullRequests", 1],
			["pullRequest", 4],
			["pullRequestDiff", 4],
			["commentOnPullRequest", 5],
			["reviewPullRequest", 6],
			["avatars", 2],
			["findLocalCheckout", 4],
			["scratchForPullRequest", 4],
		] as const)
			assert.equal(api[method].length, count);
		const pending = api.signIn({ kind: "github", baseUrl: "https://github.com", token: "fixture-credential" }, { signal: signal() });
		await ready;
		lifecycle.abort();
		assert.match((await pending).error!, /cancelled/i);
		assert.deepEqual(await readdir(dir), []);
	} finally {
		lifecycle.abort();
		await rm(dir, { recursive: true, force: true });
	}
});

function safeStoreError(token: string): (error: unknown) => boolean {
	return (error) => {
		assert.ok(error instanceof ForgeError);
		assert.equal(error.key, "storeError");
		assert.ok(!String(error.stack).includes(token));
		assert.ok(!JSON.stringify(error).includes(token));
		return true;
	};
}

test("钥匙读不出来时，存活及重开的存储都拒绝解密和写入，不覆盖原数据", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-pr-key-failure-"));
	const token = "fixture-key-failure-credential";
	try {
		const secrets = fakeSecrets();
		const store = new AccountStore(dir, secrets);
		await store.saveIdentity(draft("a"), identity, token, signal());
		const accountsPath = join(dir, "accounts.json");
		const before = await readFile(accountsPath, "utf8");
		secrets.unreadable = true;
		for (const instance of [store, new AccountStore(dir, secrets)]) {
			await assert.rejects(instance.connect("a", signal()), safeStoreError(token));
			await assert.rejects(instance.saveIdentity(draft("b"), identity, "fixture-replacement-credential", signal()), safeStoreError(token));
			await assert.rejects(instance.update("a", { label: "Changed" }), safeStoreError(token));
			await assert.rejects(instance.remove("a"), safeStoreError(token));
		}
		assert.equal(await readFile(accountsPath, "utf8"), before);
		secrets.unreadable = false;
		assert.equal((await new AccountStore(dir, secrets).connect("a", signal())).token, token, "钥匙读得出来以后原样能用");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("令牌解不开（钥匙换过）的账号当成没存过：列表里没有它，再登录时写盘去掉它", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-pr-key-rotated-"));
	const token = "fixture-old-credential";
	try {
		const secrets = fakeSecrets();
		await new AccountStore(dir, secrets).saveIdentity(draft("a"), identity, token, signal());
		secrets.rotate();
		const store = new AccountStore(dir, secrets);
		assert.deepEqual(await store.list(), []);
		await assert.rejects(store.connect("a", signal()), (error) => error instanceof ForgeError && error.key === "accountGone");
		const account = await store.saveIdentity(draft("b", "https://gitlab.example/other"), identity, "fixture-new-credential", signal());
		const reopened = new AccountStore(dir, secrets);
		assert.deepEqual(
			(await reopened.list()).map((a) => a.id),
			[account.id],
		);
		assert.equal((await reopened.connect(account.id, signal())).token, "fixture-new-credential");
		assert.equal(JSON.parse(await readFile(join(dir, "accounts.json"), "utf8")).entries.length, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("旧明文记录不会被迁移或覆盖", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-pr-no-migration-"));
	const token = "fixture-legacy-credential";
	try {
		const path = join(dir, "accounts.json");
		const before = JSON.stringify({ version: 1, entries: [{ account: { ...draft("a"), login: identity.login }, token }] });
		await writeFile(path, before, { mode: 0o600 });
		await assert.rejects(new AccountStore(dir, fakeSecrets()).saveIdentity(draft("b"), identity, "fixture-new-credential", signal()), safeStoreError(token));
		assert.equal(await readFile(path, "utf8"), before);
		assert.deepEqual(await readdir(dir), ["accounts.json"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
