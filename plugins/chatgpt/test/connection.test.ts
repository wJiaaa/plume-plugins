import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Logger } from "@plume/contract";
import { Connection } from "../src/connection.ts";
import { forgetKeys } from "../src/id-token.ts";
import { forgetDiscovery } from "../src/oauth.ts";
import { fakeOpenAI } from "./fake-openai.ts";
import { fakeSecrets } from "./fake-secrets.ts";

const quiet = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

let dir = "";
let lifetime = new AbortController();
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-chatgpt-"));
	lifetime = new AbortController();
	// 发现文档和公钥按模块缓存：每个用例换了一套假的 OpenAI。
	forgetDiscovery();
	forgetKeys();
});
afterEach(async () => {
	lifetime.abort();
	await rm(dir, { recursive: true, force: true });
});

function connect(openai = fakeOpenAI(), secrets = fakeSecrets(), log = quiet) {
	const connection = new Connection({
		fetch: openai.fetch,
		secrets,
		dataDir: dir,
		log,
		signal: lifetime.signal,
		callbackPage: (ok) => (ok ? "ok" : "failed"),
		describe: (code) => code,
		changed() {},
	});
	return { connection, openai, secrets };
}

/** 跑一次登录：拿到授权地址后交给 `browser`（它扮演浏览器去敲回调），登录这边同时往下走。 */
async function signIn(connection: Connection, browser: (url: URL) => Promise<void>, signal = new AbortController().signal, fresh = false): Promise<URL> {
	const run = connection.signIn(signal, fresh);
	const first = await run.next();
	assert.equal(first.done, false);
	const url = new URL(first.value as string);
	await Promise.all([browser(url), run.next()]);
	return url;
}

/** 浏览器从授权页回到回调地址。 */
function callback(url: URL, params: Record<string, string>): Promise<Response> {
	const target = new URL(url.searchParams.get("redirect_uri")!);
	target.search = new URLSearchParams(params).toString();
	return fetch(target);
}

/** 正常授权：id_token 里带上这次的 nonce，回调带上 code 和（第一次时）注册来的 client_id。 */
const approve = (openai: ReturnType<typeof fakeOpenAI>, clientId: string | undefined) => async (url: URL) => {
	openai.identity.nonce = url.searchParams.get("nonce") ?? undefined;
	const response = await callback(url, { state: url.searchParams.get("state")!, code: "fixture-code", ...(clientId ? { client_id: clientId } : {}) });
	assert.equal(response.status, 200);
};

test("第一次登录动态注册，之后沿用 client_id；令牌只以封好的形式落盘", async () => {
	const { connection, openai, secrets } = connect();
	await connection.load();

	const first = await signIn(connection, approve(openai, "oaiapp_test"));
	const params = first.searchParams;
	assert.equal(params.get("client_id"), "dynamic_agent_client");
	assert.equal(params.get("agent_name_hint"), "Plume");
	assert.equal(params.get("code_challenge_method"), "S256");
	assert.equal(params.get("resource"), "https://api.openai.com/v1");
	assert.match(params.get("ext_agent_host_id") ?? "", /^urn:uuid:[0-9a-f-]{36}$/);
	assert.match(params.get("redirect_uri") ?? "", /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);

	// 换令牌用注册来的 client_id，code_verifier 对得上授权时的 challenge。
	const exchange = openai.tokenCalls.find((call) => call.grant === "authorization_code")!;
	assert.equal(exchange.body.get("client_id"), "oaiapp_test");
	assert.equal(createHash("sha256").update(exchange.body.get("code_verifier")!).digest("base64url"), params.get("code_challenge"));

	const state = connection.state();
	assert.equal(state.status, "connected");
	assert.equal(state.sharing, true);
	assert.equal(state.error, undefined);
	assert.deepEqual(state.account, { email: "me@example.com" });
	assert.equal(state.models, 1);

	const provider = connection.provider()!;
	assert.equal(provider.route, "chatgpt-plan");
	assert.equal(provider.enabled, true);
	assert.equal(provider.apiKey, openai.accessToken);
	assert.deepEqual(
		provider.models.map((model) => model.modelId),
		["gpt-plan"],
	);
	assert.equal(provider.models[0]?.supportsThinking, false);
	assert.equal(provider.models[0]?.supportsImages, false);
	assert.equal(provider.models[0]?.supportsTools, true);
	assert.equal(openai.modelAuth.at(-1), `Bearer ${openai.accessToken}`);

	const disk = await readFile(join(dir, "connection.json"), "utf8");
	assert.ok(!disk.includes("fixture-access") && !disk.includes("fixture-refresh"));
	assert.ok(secrets.isSealed(JSON.parse(disk).tokens));
	assert.equal((await stat(join(dir, "connection.json"))).mode & 0o777, 0o600);
	assert.deepEqual((await readdir(dir)).sort(), ["connection.json", "host.json"]);

	// 再登录：沿用 client_id，不再带 agent_name_hint，机器标识不变。
	const again = await signIn(connection, approve(openai, undefined));
	assert.equal(again.searchParams.get("client_id"), "oaiapp_test");
	assert.equal(again.searchParams.has("agent_name_hint"), false);
	assert.equal(again.searchParams.get("ext_agent_host_id"), params.get("ext_agent_host_id"));
	assert.equal(connection.state().status, "connected");

	// 重启后从盘上读回来，令牌照样能用。
	const reopened = connect(openai, secrets).connection;
	await reopened.load();
	assert.equal(reopened.provider()?.apiKey, openai.accessToken);
});

test("回调只认对得上的 state 和路径，别的请求回 404、不打断登录", async () => {
	const { connection, openai } = connect();
	await connection.load();
	await signIn(connection, async (url) => {
		assert.equal((await callback(url, { state: "someone-else", code: "x", client_id: "oaiapp_evil" })).status, 404);
		const redirect = new URL(url.searchParams.get("redirect_uri")!);
		assert.equal((await fetch(new URL(`/other?state=${url.searchParams.get("state")}&code=x`, redirect))).status, 404);
		await approve(openai, "oaiapp_test")(url);
	});
	assert.equal(connection.state().status, "connected");
	assert.equal(openai.tokenCalls.filter((call) => call.grant === "authorization_code").length, 1);
});

test("注册回调没带 client_id：登录失败、什么都不记下", async () => {
	const { connection, openai } = connect();
	await connection.load();
	await signIn(connection, approve(openai, undefined));
	const state = connection.state();
	assert.equal(state.status, "disconnected");
	assert.equal(state.error, "registration_incomplete");
	assert.equal(connection.provider(), undefined);
	assert.equal(openai.tokenCalls.length, 0);
});

test("界面取消登录：不记错误，回调端口关掉", async () => {
	const { connection } = connect();
	await connection.load();
	const cancel = new AbortController();
	let redirect = "";
	await signIn(
		connection,
		async (url) => {
			redirect = url.searchParams.get("redirect_uri")!;
			cancel.abort();
		},
		cancel.signal,
	);
	assert.equal(connection.state().status, "disconnected");
	assert.equal(connection.state().error, undefined);
	await assert.rejects(fetch(redirect));
});

test("快到期时刷新：刷新令牌轮换、新的先落盘，同时几次刷新只发一次请求", async () => {
	const { connection, openai, secrets } = connect();
	openai.expiresIn = 60;
	await connection.load();
	await signIn(connection, approve(openai, "oaiapp_test"));
	const firstAccess = openai.accessToken;

	await Promise.all([connection.tick(), connection.refresh(), connection.refresh()]);
	const refreshes = openai.tokenCalls.filter((call) => call.grant === "refresh_token");
	assert.equal(refreshes.length, 1);
	assert.equal(refreshes[0]!.body.get("refresh_token"), "fixture-refresh-1");
	assert.equal(refreshes[0]!.body.get("client_id"), "oaiapp_test");
	assert.notEqual(openai.accessToken, firstAccess);
	assert.equal(connection.provider()?.apiKey, openai.accessToken);

	// 盘上是轮换后的那份：重启后拿它还能再刷一次。
	const reopened = connect(openai, secrets).connection;
	await reopened.load();
	await reopened.refresh();
	assert.equal(openai.tokenCalls.at(-1)!.body.get("refresh_token"), "fixture-refresh-2");
	assert.equal(reopened.state().status, "connected");
});

test("刷新被明确拒绝：清掉令牌、要重新登录，client_id 和账号留着", async () => {
	const { connection, openai } = connect();
	await connection.load();
	await signIn(connection, approve(openai, "oaiapp_test"));
	openai.refreshReply = "invalid_grant";
	await connection.refresh();

	const state = connection.state();
	assert.equal(state.status, "reauth_required");
	assert.equal(state.error, "refresh_terminal");
	const provider = connection.provider()!;
	assert.equal(provider.enabled, false);
	assert.equal(provider.apiKey, "");
	const disk = JSON.parse(await readFile(join(dir, "connection.json"), "utf8"));
	assert.equal(disk.tokens, undefined);
	assert.equal(disk.clientId, "oaiapp_test");
	assert.equal(disk.status, "reauth_required");
});

test("刷新被 invalid_client 拒绝也是终局：清掉令牌、要求重新登录", async () => {
	const { connection, openai } = connect();
	await connection.load();
	await signIn(connection, approve(openai, "oaiapp_test"));
	openai.refreshReply = "invalid_client";
	await connection.refresh();

	assert.equal(connection.state().status, "reauth_required");
	assert.equal(connection.state().error, "refresh_terminal");
	assert.equal(connection.provider()?.apiKey, "");
	assert.equal(JSON.parse(await readFile(join(dir, "connection.json"), "utf8")).tokens, undefined);
});

test("刷新遇到临时故障：令牌留着，退避后再试", async () => {
	const { connection, openai } = connect();
	openai.expiresIn = 60;
	await connection.load();
	await signIn(connection, approve(openai, "oaiapp_test"));
	const access = openai.accessToken;
	openai.refreshReply = "unavailable";
	await connection.tick();
	await connection.tick();

	assert.equal(openai.tokenCalls.filter((call) => call.grant === "refresh_token").length, 1, "退避期间不再刷新");
	assert.equal(connection.state().status, "connected");
	assert.equal(connection.provider()?.apiKey, access);
});

test("断开时吊销没成：本机凭据照样删掉，提示到 ChatGPT 设置里断开", async () => {
	const { connection, openai } = connect();
	await connection.load();
	await signIn(connection, approve(openai, "oaiapp_test"));
	openai.revokeStatus = 500;

	assert.deepEqual(await connection.disconnect(), { revoked: false });
	assert.deepEqual(openai.revoked, ["fixture-refresh-1"]);
	assert.equal(connection.state().status, "disconnected");
	assert.equal(connection.state().error, "revocation_failed");
	assert.equal(connection.provider(), undefined);
	const disk = JSON.parse(await readFile(join(dir, "connection.json"), "utf8"));
	assert.equal(disk.tokens, undefined);
	assert.equal(disk.clientId, "oaiapp_test");
});

test("钥匙换了、封着的令牌解不开：当成要重新登录，文件不动", async () => {
	const { connection, openai, secrets } = connect();
	await connection.load();
	await signIn(connection, approve(openai, "oaiapp_test"));
	const before = await readFile(join(dir, "connection.json"), "utf8");
	secrets.rotate();

	const reopened = connect(openai, secrets).connection;
	await reopened.load();
	assert.equal(reopened.state().status, "reauth_required");
	assert.equal(reopened.provider()?.enabled, false);
	assert.equal(await readFile(join(dir, "connection.json"), "utf8"), before);
});

test("连接记录读不出来：不覆盖它，登录和断开都拒绝", async () => {
	await writeFile(join(dir, "connection.json"), "{ not json");
	const { connection } = connect();
	await connection.load();
	assert.equal(connection.state().error, "storage_unreadable");
	await assert.rejects(connection.signIn(new AbortController().signal, false).next(), { code: "storage_unreadable" });
	await assert.rejects(connection.disconnect(), { code: "storage_unreadable" });
	assert.equal(await readFile(join(dir, "connection.json"), "utf8"), "{ not json");
});

test("授权码被拒：报成授权码的问题，日志里有服务端的说明和请求 id、没有授权码；再登录沿用 client_id", async () => {
	const warnings: string[] = [];
	const log = { ...quiet, warn: (message: string) => void warnings.push(message) } as unknown as Logger;
	const { connection, openai } = connect(fakeOpenAI(), fakeSecrets(), log);
	await connection.load();
	openai.codeReply = "rejected";
	await signIn(connection, approve(openai, "oaiapp_test"));

	const state = connection.state();
	assert.equal(state.status, "disconnected");
	assert.equal(state.error, "code_rejected");
	const logged = warnings.join("\n");
	assert.match(logged, /invalid_grant: Invalid authorization code \[code\] \(request req-fixture-1\)/);
	assert.ok(!logged.includes("fixture-code"));
	assert.equal(JSON.parse(await readFile(join(dir, "connection.json"), "utf8")).clientId, "oaiapp_test");

	openai.codeReply = "ok";
	const again = await signIn(connection, approve(openai, undefined));
	assert.equal(again.searchParams.get("client_id"), "oaiapp_test");
	assert.equal(again.searchParams.has("agent_name_hint"), false);
	assert.equal(connection.state().status, "connected");
	assert.equal(connection.state().error, undefined);
});

/** 浏览器里授权页拒绝了（比如选的工作区不在注册绑定的那个里），带着 OpenAI 的说明回到回调。 */
const deny = (description: string) => async (url: URL) => {
	const response = await callback(url, { state: url.searchParams.get("state")!, error: "access_denied", error_description: description });
	assert.equal(response.status, 200);
};

test("沿用注册过的应用被授权页拒绝：报成工作区的问题，日志带 OpenAI 的说明；重新注册后能登上别的账号", async () => {
	const warnings: string[] = [];
	const log = { ...quiet, warn: (message: string) => void warnings.push(message) } as unknown as Logger;
	const { connection, openai } = connect(fakeOpenAI(), fakeSecrets(), log);
	await connection.load();
	// 第一次注册了，但换令牌没成：只留下 client_id。
	openai.codeReply = "rejected";
	await signIn(connection, approve(openai, "oaiapp_first"));
	assert.equal(connection.state().registered, true);
	openai.codeReply = "ok";

	const denied = await signIn(connection, deny("This app is only available to members of its workspace."));
	assert.equal(denied.searchParams.get("client_id"), "oaiapp_first");
	assert.equal(connection.state().error, "workspace_denied");
	assert.equal(connection.state().status, "disconnected");
	assert.match(warnings.at(-1)!, /access_denied: This app is only available to members of its workspace\./);

	const fresh = await signIn(connection, approve(openai, "oaiapp_second"), undefined, true);
	assert.equal(fresh.searchParams.get("client_id"), "dynamic_agent_client");
	assert.equal(fresh.searchParams.get("agent_name_hint"), "Plume");
	assert.equal(connection.state().status, "connected");
	assert.equal(connection.state().error, undefined);
	const disk = JSON.parse(await readFile(join(dir, "connection.json"), "utf8"));
	assert.equal(disk.clientId, "oaiapp_second");
	assert.equal(openai.tokenCalls.at(-1)!.body.get("client_id"), "oaiapp_second");
});

test("已连上时重新注册：换到新账号，旧应用的令牌吊销，人改过的供应商名字留着", async () => {
	const { connection, openai } = connect();
	await connection.load();
	await signIn(connection, approve(openai, "oaiapp_first"));
	const provider = connection.provider()!;
	await connection.saveProvider({ ...provider, name: "我的 ChatGPT" });
	const oldRefresh = "fixture-refresh-1";

	openai.identity.sub = "user-2";
	openai.identity.email = "other@example.com";
	await signIn(connection, approve(openai, "oaiapp_second"), undefined, true);

	assert.deepEqual(openai.revoked, [oldRefresh]);
	const state = connection.state();
	assert.equal(state.status, "connected");
	assert.deepEqual(state.account, { email: "other@example.com" });
	assert.equal(connection.provider()?.name, "我的 ChatGPT");
	assert.equal(connection.provider()?.apiKey, openai.accessToken);
	const disk = JSON.parse(await readFile(join(dir, "connection.json"), "utf8"));
	assert.equal(disk.clientId, "oaiapp_second");
	assert.equal(disk.subject, "user-2");
});

test("已连上时重新注册的授权码兑换失败：旧令牌、旧应用和旧供应商都不动", async () => {
	const { connection, openai } = connect();
	await connection.load();
	await signIn(connection, approve(openai, "oaiapp_first"));
	await connection.saveProvider({ ...connection.provider()!, name: "我的 ChatGPT" });
	const before = await readFile(join(dir, "connection.json"), "utf8");
	const access = connection.provider()?.apiKey;

	openai.codeReply = "rejected";
	await signIn(connection, approve(openai, "oaiapp_second"), undefined, true);

	assert.equal(await readFile(join(dir, "connection.json"), "utf8"), before);
	assert.equal(connection.state().status, "connected");
	assert.equal(connection.state().error, "code_rejected");
	assert.equal(connection.provider()?.apiKey, access);
	assert.equal(connection.provider()?.name, "我的 ChatGPT");
	assert.deepEqual(openai.revoked, []);
});

test("套餐终局失败持久化停用供应商，人在模型设置重新启用后清掉暂停错误", async () => {
	const { connection, openai, secrets } = connect();
	await connection.load();
	await signIn(connection, approve(openai, "oaiapp_first"));
	await connection.failed("chatgpt", "usage-limit");

	assert.equal(connection.state().error, "usage_limit");
	assert.equal(connection.provider()?.enabled, false);
	const reopened = connect(openai, secrets).connection;
	await reopened.load();
	assert.equal(reopened.provider()?.enabled, false);
	assert.equal(reopened.state().error, "usage_limit");

	await reopened.saveProvider({ ...reopened.provider()!, enabled: true });
	assert.equal(reopened.state().error, undefined);
	assert.equal(reopened.provider()?.enabled, true);
});

test("重新注册中途取消：原来的连接一点不动", async () => {
	const { connection, openai } = connect();
	await connection.load();
	await signIn(connection, approve(openai, "oaiapp_first"));
	const before = await readFile(join(dir, "connection.json"), "utf8");
	const access = connection.provider()?.apiKey;

	const cancel = new AbortController();
	await signIn(connection, async () => cancel.abort(), cancel.signal, true);

	assert.equal(await readFile(join(dir, "connection.json"), "utf8"), before);
	assert.equal(connection.state().status, "connected");
	assert.equal(connection.provider()?.apiKey, access);
	assert.deepEqual(openai.revoked, []);
});
