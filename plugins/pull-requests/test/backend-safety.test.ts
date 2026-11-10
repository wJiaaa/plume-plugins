import assert from "node:assert/strict";
import { test } from "node:test";
import type { ForgeConnection } from "../src/forge/types.ts";
import { boundedBytes, DIFF_TIMEOUT_MS, json, text } from "../src/forge/http.ts";
import { describe, ForgeError } from "../src/forge/errors.ts";
import { fetchAvatars } from "../src/forge/avatars.ts";
import { gitlab } from "../src/forge/gitlab.ts";

const TOKEN = "fixture-credential-for-safety-tests";
function connection(signal = new AbortController().signal): ForgeConnection {
	return {
		account: { id: "a", kind: "github", baseUrl: "https://github.com", label: "me", login: "me", avatarUrl: null, enabled: true },
		token: TOKEN,
		signal,
	};
}

test("网络错误、HTTP 正文和成功数据都不会泄漏访问令牌", async (t) => {
	let status = 500;
	t.mock.method(globalThis, "fetch", async () => Response.json({ message: TOKEN, value: TOKEN }, { status }));
	try {
		await json(connection(), "/user");
		assert.fail("Expected failure");
	} catch (error) {
		assert.ok(error instanceof ForgeError);
		assert.ok(!describe(error).includes(TOKEN));
	}
	status = 200;
	const result = await json<{ value: string }>(connection(), "/user");
	assert.equal(result.value, "[redacted]");
	assert.ok(!describe(new Error(`Network error ${TOKEN}`)).includes(TOKEN));
});

test("请求禁止自动重定向，拒绝仓库路径逃逸和非账号根", async (t) => {
	let requests = 0;
	t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
		requests++;
		assert.equal(init?.redirect, "error");
		assert.ok(init?.signal);
		return Response.json({});
	});
	await json(connection(), "/user");
	for (const path of ["//evil.example/user", "/repos/a/../user", "/repos/a/%2e%2e/user", "/repos/a\\b"])
		await assert.rejects(json(connection(), path), ForgeError);
	await assert.rejects(json(connection(), "/user", { root: "https://evil.example" }), ForgeError);
	assert.equal(requests, 1);
});

test("取消正在等待的 fetch，预取消不发请求", async (t) => {
	let requests = 0;
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
		requests++;
		return new Promise<Response>((_resolve, reject) => {
			init!.signal!.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
			started();
		});
	});
	const controller = new AbortController();
	const pending = json(connection(controller.signal), "/user");
	await ready;
	controller.abort();
	await assert.rejects(pending, (error: unknown) => error instanceof ForgeError && error.key === "cancelled");
	await assert.rejects(json(connection(controller.signal), "/user"));
	assert.equal(requests, 1);
});

test("响应体读取也能取消，声明长度与流式长度都有上限", async () => {
	await assert.rejects(
		boundedBytes(new Response("long", { headers: { "Content-Length": "1000" } }), 10, new AbortController().signal),
		(error: unknown) => error instanceof ForgeError && error.key === "tooLarge",
	);
	await assert.rejects(boundedBytes(new Response("too long"), 2, new AbortController().signal), ForgeError);
	const controller = new AbortController();
	const response = new Response(
		new ReadableStream<Uint8Array>({
			start(stream) {
				stream.enqueue(new Uint8Array([1]));
			},
		}),
	);
	const reading = boundedBytes(response, 10, controller.signal);
	controller.abort();
	await assert.rejects(reading, (error: unknown) => error instanceof ForgeError && error.key === "cancelled");
});

test("头像不带认证头，拒绝未知来源、凭据、SVG 和超大图片", async (t) => {
	let requests = 0;
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
		requests++;
		const headers = new Headers(init?.headers);
		assert.equal(headers.get("Authorization"), null);
		assert.equal(headers.get("PRIVATE-TOKEN"), null);
		assert.equal(init?.credentials, "omit");
		assert.equal(init?.redirect, "error");
		if (String(input).includes("svg")) return new Response("<svg/>", { headers: { "Content-Type": "image/svg+xml" } });
		if (String(input).includes("large")) return new Response("x", { headers: { "Content-Type": "image/png", "Content-Length": "9999999" } });
		return new Response(new Uint8Array([1, 2]), { headers: { "Content-Type": "image/png" } });
	});
	const result = await fetchAvatars(
		[
			{ login: "ok", url: "https://avatars.githubusercontent.com/u/1" },
			{ login: "private", url: "https://127.0.0.1/image" },
			{ login: "file", url: "file:///tmp/avatar" },
			{ login: "auth", url: "https://avatars.githubusercontent.com/u/1?access_token=x" },
			{ login: "svg", url: "https://avatars.githubusercontent.com/svg" },
			{ login: "large", url: "https://avatars.githubusercontent.com/large" },
		],
		[],
		new AbortController().signal,
	);
	assert.match(result.ok!, /^data:image\/png;base64,/);
	for (const login of ["private", "file", "auth", "svg", "large"]) assert.equal(result[login], null);
	assert.equal(requests, 3);
});

test("GitLab 可选评论的取消不能被吞，取消后不执行取消批准", async (t) => {
	const controller = new AbortController();
	const conn = connection(controller.signal);
	conn.account.kind = "gitlab";
	conn.account.baseUrl = "https://gitlab.example";
	let requests = 0;
	t.mock.method(globalThis, "fetch", async () => {
		requests++;
		controller.abort();
		return new Response(null, { status: 204 });
	});
	await assert.rejects(gitlab.review(conn, "a/b", 1, "request-changes", "Reason"), ForgeError);
	assert.equal(requests, 1);
});

test("文本 diff 也会清除服务回显的令牌", async (t) => {
	t.mock.method(globalThis, "fetch", async () => new Response(`+${TOKEN}`));
	assert.equal(await text(connection(), "/repos/a/b/pulls/1"), "+[redacted]");
});

test("普通请求 30 秒、diff 请求 60 秒时限覆盖响应读取", async (t) => {
	const deadlines: number[] = [];
	t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
		deadlines.push(milliseconds);
		return new AbortController().signal;
	});
	t.mock.method(globalThis, "fetch", async () => Response.json({}));
	await json(connection(), "/user");
	await text(connection(), "/repos/a/b/pulls/1", { timeoutMs: DIFF_TIMEOUT_MS });
	assert.deepEqual(deadlines, [30_000, 60_000]);
});
