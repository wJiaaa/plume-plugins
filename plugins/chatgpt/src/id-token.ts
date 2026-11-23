/**
 * 校验 id_token：RS256 签名（公钥从发现文档的 `jwks_uri` 取），`iss`、`aud`、`azp`、`exp`、`iat`、`sub`，登录时还有 `nonce`。
 * 用 Node 自带的 `crypto`，不加 JOSE 依赖：只要这一种算法、这一种用法。
 *
 * 取不到公钥（网络、服务端临时出错）和公钥取到了但校验不过是两回事：前者是 `identity_unavailable`（稍后再试，凭据留着），
 * 后者是 `identity_invalid`（这份身份不能信）。
 */

import { createPublicKey, type JsonWebKey, verify } from "node:crypto";
import type { PluginFetch } from "@plume/contract";
import { ChatGptError } from "./errors.ts";
import { type Endpoints, readJson } from "./oauth.ts";

export interface Identity {
	subject: string;
	name?: string;
	email?: string;
}

/** 允许的时钟偏差，秒。 */
const SKEW = 5;

const keySets = new Map<string, { keys: JsonWebKey[]; at: number }>();
/** 公钥缓存一小时；碰到不认识的 `kid` 时不等过期、马上重取一次（换了钥匙）。 */
const KEYS_TTL_MS = 60 * 60_000;

async function fetchKeys(fetch: PluginFetch, uri: string, signal: AbortSignal): Promise<JsonWebKey[]> {
	let response: Response;
	try {
		response = await fetch(uri, { headers: { accept: "application/json" }, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
	} catch (error) {
		if (signal.aborted) throw error;
		throw new ChatGptError("identity_unavailable", "jwks request failed");
	}
	const data = await readJson(response);
	const keys = (data as { keys?: unknown } | undefined)?.keys;
	if (!response.ok || !Array.isArray(keys)) throw new ChatGptError("identity_unavailable", `jwks returned ${response.status}`);
	const usable = keys.filter((key): key is JsonWebKey => typeof key === "object" && key !== null && (key as JsonWebKey).kty === "RSA");
	keySets.set(uri, { keys: usable, at: Date.now() });
	return usable;
}

async function keyFor(fetch: PluginFetch, uri: string, kid: string | undefined, signal: AbortSignal): Promise<JsonWebKey> {
	const cached = keySets.get(uri);
	const pick = (keys: JsonWebKey[]) => keys.find((key) => (kid === undefined ? true : key.kid === kid));
	const fresh = cached && Date.now() - cached.at < KEYS_TTL_MS ? pick(cached.keys) : undefined;
	if (fresh) return fresh;
	const found = pick(await fetchKeys(fetch, uri, signal));
	if (!found) throw new ChatGptError("identity_unavailable", "no signing key matches the token");
	return found;
}

/** 测试换钥匙时用。 */
export function forgetKeys(): void {
	keySets.clear();
}

const invalid = (why: string) => new ChatGptError("identity_invalid", `id_token ${why}`);

function decodePart(part: string | undefined): Record<string, unknown> {
	if (!part) throw invalid("is malformed");
	try {
		const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
		if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
	} catch {
		// 落到下面
	}
	throw invalid("is malformed");
}

export async function verifyIdToken(
	fetch: PluginFetch,
	endpoints: Endpoints,
	token: string,
	expected: { clientId: string; nonce: string | undefined },
	signal: AbortSignal,
): Promise<Identity> {
	const parts = token.split(".");
	if (parts.length !== 3) throw invalid("is malformed");
	const header = decodePart(parts[0]);
	const payload = decodePart(parts[1]);
	if (header.alg !== "RS256") throw invalid("is not RS256");
	const jwk = await keyFor(fetch, endpoints.jwks, typeof header.kid === "string" ? header.kid : undefined, signal);
	let signed: boolean;
	try {
		signed = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2]!, "base64url"));
	} catch {
		signed = false;
	}
	if (!signed) throw invalid("signature does not verify");

	const now = Date.now() / 1000;
	const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
	if (payload.iss !== endpoints.issuer) throw invalid("issuer does not match");
	if (!audience.includes(expected.clientId)) throw invalid("audience does not match");
	if (payload.azp !== undefined && payload.azp !== expected.clientId) throw invalid("azp does not match");
	if (audience.length > 1 && payload.azp !== expected.clientId) throw invalid("has several audiences without azp");
	if (typeof payload.exp !== "number" || payload.exp + SKEW < now) throw invalid("has expired");
	if (typeof payload.iat !== "number" || payload.iat - SKEW > now) throw invalid("is issued in the future");
	if (typeof payload.sub !== "string" || !payload.sub) throw invalid("has no subject");
	if (expected.nonce !== undefined && payload.nonce !== expected.nonce) throw invalid("nonce does not match");
	return {
		subject: payload.sub,
		...(typeof payload.name === "string" ? { name: payload.name } : {}),
		...(typeof payload.email === "string" ? { email: payload.email } : {}),
	};
}
