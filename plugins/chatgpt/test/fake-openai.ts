import { generateKeyPairSync, sign } from "node:crypto";
import type { PluginFetch } from "@plume/contract";
import { ISSUER, RESOURCE } from "../src/oauth.ts";

export interface TokenCall {
	grant: string;
	body: URLSearchParams;
}

/**
 * 假的 auth.openai.com 和 api.openai.com：发现文档、令牌、吊销、JWKS、模型表。只认它发出去的刷新令牌，每刷一次轮换；
 * `refreshReply` 换成别的回法测失败。id_token 用测试里现生成的 RSA 钥匙签。
 */
export function fakeOpenAI() {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const kid = "test-key";
	let issued = 0;
	const live = new Set<string>();
	const tokenCalls: TokenCall[] = [];
	const revoked: string[] = [];
	const modelAuth: string[] = [];

	const fake = {
		tokenCalls,
		revoked,
		modelAuth,
		/** 下一次换令牌时 id_token 里的这些字段。 */
		identity: { sub: "user-1", email: "me@example.com", nonce: undefined as string | undefined, aud: "" },
		scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
		expiresIn: 3600,
		refreshReply: "ok" as "ok" | "invalid_client" | "invalid_grant" | "unavailable",
		/** 换授权码的回法：`rejected` 时回 `invalid_grant`，说明里把授权码原样带回来（测它不进日志）。 */
		codeReply: "ok" as "ok" | "rejected",
		revokeStatus: 200,
		/** 当前有效的访问令牌（最近签发的那份）。 */
		accessToken: "",

		idToken(claims: Record<string, unknown>): string {
			const now = Math.floor(Date.now() / 1000);
			const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
			const head = `${part({ alg: "RS256", kid, typ: "JWT" })}.${part({ iss: ISSUER, iat: now, exp: now + 3600, ...claims })}`;
			return `${head}.${sign("RSA-SHA256", Buffer.from(head), privateKey).toString("base64url")}`;
		},

		issue(clientId: string, withIdToken: boolean): Record<string, unknown> {
			issued += 1;
			const refresh = `fixture-refresh-${issued}`;
			live.add(refresh);
			fake.accessToken = `fixture-access-${issued}`;
			return {
				access_token: fake.accessToken,
				token_type: "Bearer",
				expires_in: fake.expiresIn,
				refresh_token: refresh,
				scope: fake.scope,
				...(withIdToken ? { id_token: fake.idToken({ sub: fake.identity.sub, email: fake.identity.email, aud: clientId, nonce: fake.identity.nonce }) } : {}),
			};
		},

		fetch: (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
			const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
			const form = () => new URLSearchParams(String(init?.body ?? ""));
			if (url.href === `${ISSUER}/.well-known/openid-configuration`) {
				return json(200, {
					issuer: ISSUER,
					authorization_endpoint: `${ISSUER}/oauth/authorize`,
					token_endpoint: `${ISSUER}/oauth/token`,
					revocation_endpoint: `${ISSUER}/oauth/revoke`,
					jwks_uri: `${ISSUER}/.well-known/jwks.json`,
				});
			}
			if (url.href === `${ISSUER}/.well-known/jwks.json`)
				return json(200, { keys: [{ ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" }] });
			if (url.href === `${ISSUER}/oauth/token`) {
				const body = form();
				const grant = body.get("grant_type") ?? "";
				tokenCalls.push({ grant, body });
				const clientId = body.get("client_id") ?? "";
				if (grant === "authorization_code" && fake.codeReply === "rejected") {
					return new Response(JSON.stringify({ error: "invalid_grant", error_description: `Invalid authorization code ${body.get("code")}` }), {
						status: 400,
						headers: { "content-type": "application/json", "x-request-id": "req-fixture-1" },
					});
				}
				if (grant === "authorization_code") return json(200, fake.issue(clientId, true));
				if (fake.refreshReply === "unavailable") return json(503, { error: "temporarily_unavailable" });
				if (fake.refreshReply === "invalid_client") return json(400, { error: "invalid_client" });
				const old = body.get("refresh_token") ?? "";
				if (fake.refreshReply === "invalid_grant" || !live.delete(old)) return json(400, { error: "invalid_grant" });
				return json(200, fake.issue(clientId, false));
			}
			if (url.href === `${ISSUER}/oauth/revoke`) {
				revoked.push(form().get("token") ?? "");
				return new Response(null, { status: fake.revokeStatus });
			}
			if (url.href === `${RESOURCE}/models`) {
				modelAuth.push(new Headers(init?.headers).get("authorization") ?? "");
				return json(200, {
					models: [
						{ slug: "gpt-plan", display_name: "GPT Plan", visibility: "list" },
						{ slug: "gpt-hidden", display_name: "Hidden", visibility: "hide" },
					],
				});
			}
			return json(404, {});
		}) as PluginFetch,
	};
	return fake;
}
