/**
 * Sign in with ChatGPT 的 OAuth：OIDC 发现、授权地址、127.0.0.1 上的回调、换令牌、刷新、吊销。
 *
 * 协议按官方文档写（developers.openai.com/siwc/token-sharing-open-source/sign-in）：
 * - 第一次用 `client_id=dynamic_agent_client` 动态注册，回调里带回正式的 `client_id`（`oaiapp_…`），之后换令牌、再登录都用它；
 *   `agent_name_hint` 只在第一次带。
 * - `ext_agent_host_id` 必带：每台机器一个、永远不变（见 `store.ts` 的 `hostId`）。
 * - 回调只认 `http://127.0.0.1:<端口>/auth/callback`，端口可以每次不同，同一次授权里授权和换令牌用同一个地址。
 * - 每次登录都是新的 state、nonce、PKCE（S256）。
 *
 * 所有请求经 `ctx.fetch`（走系统代理、不跟重定向）。错误只带原因码和英文说明，不带令牌、授权码。
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { PluginFetch } from "@plume/contract";
import { ChatGptError } from "./errors.ts";

export const ISSUER = "https://auth.openai.com";
export const RESOURCE = "https://api.openai.com/v1";
/** 身份三项加套餐额度三项。`chatgpt.tokens.use.direct` 没给时登录照样成功，但用不了额度（`SHARING_SCOPE`）。 */
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export const SHARING_SCOPE = "chatgpt.tokens.use.direct";
const FIRST_CLIENT = "dynamic_agent_client";
/** 每台机器都用同一个名字：人在 ChatGPT 设置里看到的应用名，人可以改，不是身份。 */
const AGENT_NAME = "Plume";
const CALLBACK_PATH = "/auth/callback";
const REQUEST_TIMEOUT_MS = 30_000;
/** 令牌、发现文档、JWKS 的响应都很小，超过这个数的不是我们要的东西。 */
const MAX_BODY = 1024 * 1024;
/** 服务端的说明（`error_description`）进日志时最多留这么长。 */
const MAX_DESCRIPTION = 200;

/** 服务端给的一句说明，压成一行、截短，只进日志。 */
const shortDescription = (said: unknown): string => {
	const text = typeof said === "string" ? said.replace(/\s+/g, " ").trim() : "";
	return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION)}…` : text;
};

export interface Endpoints {
	issuer: string;
	authorization: string;
	token: string;
	revocation?: string;
	jwks: string;
}

export interface TokenSet {
	accessToken: string;
	refreshToken: string;
	/** 毫秒时间戳。 */
	expiresAt: number;
	/** 早于它不能刷新（令牌响应的 `earliest_refresh_at`），毫秒时间戳；没给是随时能刷。 */
	earliestRefreshAt?: number;
	scopes: string[];
	idToken?: string;
}

const random = () => randomBytes(32).toString("base64url");

/** 读一个不大的 JSON 响应。读不出、太大时是 undefined，由调用方按场合报错。 */
export async function readJson(response: Response): Promise<unknown> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_BODY) {
		await response.body?.cancel();
		return undefined;
	}
	const text = await response.text();
	if (text.length > MAX_BODY) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** 网络层的失败（断网、超时、代理拒绝）统一成 `network`；已经是 `ChatGptError` 的、被调用方取消的原样抛。 */
async function send(fetch: PluginFetch, url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
	try {
		return await fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) });
	} catch (error) {
		if (signal.aborted) throw error;
		throw new ChatGptError("network", `request to ${new URL(url).origin} failed`);
	}
}

let discovered: Promise<Endpoints> | undefined;

/** OIDC 发现文档，每个端点都要在 `auth.openai.com` 下；成功的一份留着，失败的不留。 */
export function discover(fetch: PluginFetch, signal: AbortSignal): Promise<Endpoints> {
	discovered ??= (async () => {
		const response = await send(fetch, `${ISSUER}/.well-known/openid-configuration`, { headers: { accept: "application/json" } }, signal);
		const data = await readJson(response);
		if (!response.ok || !isRecord(data) || data.issuer !== ISSUER) throw new ChatGptError("discovery_failed", `discovery returned ${response.status}`);
		const at = (key: string, optional = false): string | undefined => {
			const value = data[key];
			if (optional && value === undefined) return undefined;
			if (typeof value !== "string" || new URL(value).origin !== ISSUER)
				throw new ChatGptError("discovery_failed", `discovery field ${key} is not on the issuer`);
			return value;
		};
		const revocation = at("revocation_endpoint", true);
		return {
			issuer: ISSUER,
			authorization: at("authorization_endpoint")!,
			token: at("token_endpoint")!,
			jwks: at("jwks_uri")!,
			...(revocation ? { revocation } : {}),
		};
	})().catch((error: unknown) => {
		discovered = undefined;
		throw error;
	});
	return discovered;
}

/** 测试换假的发现文档时用。 */
export function forgetDiscovery(): void {
	discovered = undefined;
}

export interface Attempt {
	state: string;
	nonce: string;
	verifier: string;
	challenge: string;
}

export function newAttempt(): Attempt {
	const verifier = random();
	return { state: random(), nonce: random(), verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function authorizationUrl(
	endpoints: Endpoints,
	options: { clientId: string | undefined; redirectUri: string; attempt: Attempt; hostId: string; loginHint: string | undefined },
): string {
	const url = new URL(endpoints.authorization);
	const params: Record<string, string> = {
		response_type: "code",
		client_id: options.clientId ?? FIRST_CLIENT,
		redirect_uri: options.redirectUri,
		scope: SCOPES,
		resource: RESOURCE,
		state: options.attempt.state,
		nonce: options.attempt.nonce,
		code_challenge: options.attempt.challenge,
		code_challenge_method: "S256",
		ext_agent_host_id: options.hostId,
	};
	if (!options.clientId) params.agent_name_hint = AGENT_NAME;
	if (options.loginHint) params.login_hint = options.loginHint;
	url.search = new URLSearchParams(params).toString();
	return url.toString();
}

interface CallbackResult {
	code: string;
	/** 新注册时回调带回的正式 client_id；再次登录时可能不带。 */
	clientId?: string;
}

export interface Callback {
	redirectUri: string;
	/** 等浏览器回来。`close` 或 `signal` 中止后以错误结束。 */
	result: Promise<CallbackResult>;
	close(): void;
}

const same = (a: string, b: string) => {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * 在 127.0.0.1 的随机端口上等一次回调。只认 GET、本机这个 Host、`/auth/callback`、对得上的 state；别的请求一律 404，
 * 不算这一趟的结果（别的程序探一下端口不该让登录失败）。`page(ok)` 是回给浏览器的那一页。
 */
export async function listenForCallback(state: string, page: (ok: boolean) => string, signal: AbortSignal): Promise<Callback> {
	signal.throwIfAborted();
	let settle!: { resolve: (value: CallbackResult) => void; reject: (error: unknown) => void };
	const result = new Promise<CallbackResult>((resolve, reject) => (settle = { resolve, reject }));
	// 没人等的时候（监听没起来就中止了）也不留一个未处理的拒绝。
	result.catch(() => {});
	let done = false;
	let port = 0;
	const finish = (outcome: CallbackResult | Error) => {
		if (done) return;
		done = true;
		if (outcome instanceof Error) settle.reject(outcome);
		else settle.resolve(outcome);
		server.close();
		server.closeAllConnections();
	};
	const server: Server = createServer((request, response) => {
		const reply = (status: number, body: string) => {
			response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
			response.end(body);
		};
		let url: URL;
		try {
			url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
		} catch {
			return reply(404, "");
		}
		if (done || request.method !== "GET" || request.headers.host !== `127.0.0.1:${port}` || url.pathname !== CALLBACK_PATH) return reply(404, "");
		const states = url.searchParams.getAll("state");
		if (states.length !== 1 || !same(states[0]!, state)) return reply(404, "");
		if (url.searchParams.has("error")) {
			reply(200, page(false));
			const said = shortDescription(url.searchParams.get("error_description"));
			return finish(new ChatGptError("callback_denied", `authorization returned error ${url.searchParams.get("error")}${said ? `: ${said}` : ""}`));
		}
		const codes = url.searchParams.getAll("code");
		const clients = url.searchParams.getAll("client_id");
		if (codes.length !== 1 || !codes[0] || clients.length > 1) {
			reply(200, page(false));
			return finish(new ChatGptError("token_invalid", "callback did not carry exactly one code"));
		}
		reply(200, page(true));
		finish({ code: codes[0], ...(clients[0] ? { clientId: clients[0] } : {}) });
	});
	const abort = () => finish(signal.reason instanceof Error ? signal.reason : new Error("cancelled"));
	signal.addEventListener("abort", abort, { once: true });
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen({ port: 0, host: "127.0.0.1" }, () => resolve());
	});
	port = (server.address() as AddressInfo).port;
	return {
		redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
		result: result.finally(() => signal.removeEventListener("abort", abort)),
		close: () => finish(new Error("closed")),
	};
}

/**
 * 刷新令牌已经用不了的说法（官方「Errors and recovery」页列的）：清掉令牌、让人重新登录。
 * 别的失败（网络、5xx）不清：临时故障不该把唯一一份能用的刷新令牌丢掉。
 */
const TERMINAL = new Set([
	"invalid_client",
	"invalid_grant",
	"invalid_refresh_token",
	"token_expired",
	"refresh_token_expired",
	"refresh_token_invalidated",
	"refresh_token_reused",
]);

function oauthErrorOf(data: unknown): string | undefined {
	if (!isRecord(data)) return undefined;
	if (typeof data.error === "string") return data.error;
	if (isRecord(data.error) && typeof data.error.code === "string") return data.error.code;
	return undefined;
}

/** 请求里不能进日志的值：服务端的说明偶尔会把它们原样带回来。 */
const SECRET_FIELDS = ["code", "code_verifier", "refresh_token"];

/**
 * 令牌端点拒绝时写进日志的那句话：状态码、错误码、服务端的说明（`error_description`）和 `x-request-id`。
 * 只有错误码分不清是哪里不对（`invalid_grant` 可能是授权码、PKCE、redirect_uri 或 client_id 对不上），要靠说明和请求 id 去查。
 */
function rejection(response: Response, data: unknown, error: string | undefined, body: Record<string, string>): string {
	const said = isRecord(data) ? (data.error_description ?? (isRecord(data.error) ? data.error.message : undefined)) : undefined;
	// 先换掉秘密再截短：截短可能把秘密切成半截，就认不出来了。
	let text = typeof said === "string" ? said : "";
	for (const field of SECRET_FIELDS) {
		const value = body[field];
		if (value) text = text.split(value).join(`[${field}]`);
	}
	const description = shortDescription(text);
	const requestId = response.headers.get("x-request-id");
	return `token endpoint returned ${response.status}${error ? ` ${error}` : ""}${description ? `: ${description}` : ""}${requestId ? ` (request ${requestId})` : ""}`;
}

async function tokenRequest(fetch: PluginFetch, endpoints: Endpoints, body: Record<string, string>, signal: AbortSignal): Promise<Record<string, unknown>> {
	const response = await send(
		fetch,
		endpoints.token,
		{
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
			body: new URLSearchParams(body).toString(),
		},
		signal,
	);
	const data = await readJson(response);
	if (!response.ok) {
		const error = oauthErrorOf(data);
		const why = rejection(response, data, error, body);
		// 换授权码时的 `invalid_grant` 是这一个授权码不能用了（官方：丢掉它、重新授权），和刷新令牌失效是两回事。
		if (body.grant_type === "authorization_code" && error === "invalid_grant") throw new ChatGptError("code_rejected", why);
		if (body.grant_type === "refresh_token" && error && TERMINAL.has(error)) throw new ChatGptError("refresh_terminal", why);
		if (response.status >= 500) throw new ChatGptError("network", why);
		throw new ChatGptError("token_invalid", why);
	}
	if (!isRecord(data)) throw new ChatGptError("token_invalid", "token response is not an object");
	return data;
}

/** 核对令牌响应：bearer、正的有效期、有刷新令牌（套餐额度要 `offline_access`）、说清授予了哪些 scope。 */
function tokenSet(data: Record<string, unknown>, scopesIfOmitted: string[] | undefined): TokenSet {
	const scope = typeof data.scope === "string" ? data.scope : scopesIfOmitted?.join(" ");
	if (
		typeof scope !== "string" ||
		typeof data.access_token !== "string" ||
		!data.access_token ||
		typeof data.token_type !== "string" ||
		data.token_type.toLowerCase() !== "bearer" ||
		typeof data.expires_in !== "number" ||
		!(data.expires_in > 0) ||
		typeof data.refresh_token !== "string" ||
		!data.refresh_token
	) {
		throw new ChatGptError("token_invalid", "token response is incomplete");
	}
	const earliest = data.earliest_refresh_at;
	const earliestMs = typeof earliest === "number" ? earliest * 1000 : typeof earliest === "string" ? Date.parse(earliest) : NaN;
	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expiresAt: Date.now() + data.expires_in * 1000,
		...(Number.isFinite(earliestMs) ? { earliestRefreshAt: earliestMs } : {}),
		scopes: scope.split(/\s+/).filter(Boolean),
		...(typeof data.id_token === "string" && data.id_token ? { idToken: data.id_token } : {}),
	};
}

export async function exchangeCode(
	fetch: PluginFetch,
	endpoints: Endpoints,
	options: { code: string; clientId: string; redirectUri: string; verifier: string },
	signal: AbortSignal,
): Promise<TokenSet> {
	const data = await tokenRequest(
		fetch,
		endpoints,
		{
			grant_type: "authorization_code",
			code: options.code,
			redirect_uri: options.redirectUri,
			client_id: options.clientId,
			code_verifier: options.verifier,
			resource: RESOURCE,
		},
		signal,
	);
	return tokenSet(data, undefined);
}

/** 刷新：刷新令牌每次都轮换，新的一整份（令牌、有效期、scope、刷新令牌）一起换。没回 scope 时是没变。 */
export async function refreshTokens(
	fetch: PluginFetch,
	endpoints: Endpoints,
	options: { clientId: string; refreshToken: string; scopes: string[] },
	signal: AbortSignal,
): Promise<TokenSet> {
	const data = await tokenRequest(
		fetch,
		endpoints,
		{ grant_type: "refresh_token", client_id: options.clientId, refresh_token: options.refreshToken, resource: RESOURCE },
		signal,
	);
	return tokenSet(data, options.scopes);
}

/** 吊销刷新令牌。没有吊销端点或没成功时抛 `revocation_failed`：本机照样删，人要到 ChatGPT 设置里断开。 */
export async function revoke(
	fetch: PluginFetch,
	endpoints: Endpoints,
	options: { clientId: string; refreshToken: string },
	signal: AbortSignal,
): Promise<void> {
	if (!endpoints.revocation) throw new ChatGptError("revocation_failed", "no revocation endpoint");
	const response = await send(
		fetch,
		endpoints.revocation,
		{
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ token: options.refreshToken, token_type_hint: "refresh_token", client_id: options.clientId }).toString(),
		},
		signal,
	).catch(() => {
		throw new ChatGptError("revocation_failed", "revocation request failed");
	});
	await response.body?.cancel();
	if (!response.ok) throw new ChatGptError("revocation_failed", `revocation returned ${response.status}`);
}
