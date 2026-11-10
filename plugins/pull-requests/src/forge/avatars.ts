import type { PluginFetch } from "@plume/contract";
import type { ForgeAccount } from "../api.ts";
import { boundedBytes, pooled } from "./http.ts";
import { checkCancelled } from "./errors.ts";

// 只接受已知公共头像服务或人明确添加的实例源；绝不使用账号认证头。
const PUBLIC_AVATARS = new Set([
	"avatars.githubusercontent.com",
	"secure.gravatar.com",
	"www.gravatar.com",
	"gravatar.com",
	"gitee.com",
	"foruda.gitee.com",
	"gitlab.com",
]);
const TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
function avatarUrl(raw: string, accounts: ForgeAccount[]): URL | null {
	try {
		const url = new URL(raw);
		if (!/^https?:$/.test(url.protocol) || /^[a-z]+:\/\/[^/]*@/i.test(url.href) || url.hash || raw.length > 4096) return null;
		if ([...url.searchParams.keys()].some((key) => /token|auth|secret|pass(?:word)?|signature|credential/i.test(key))) return null;
		const known = url.protocol === "https:" && PUBLIC_AVATARS.has(url.hostname) && !url.port;
		if (!known && !accounts.some((a) => new URL(a.baseUrl).origin === url.origin)) return null;
		return url;
	} catch {
		return null;
	}
}
export async function fetchAvatars(
	people: { login: string; url?: string | null }[],
	accounts: ForgeAccount[],
	signal: AbortSignal,
	request: PluginFetch = fetch,
): Promise<Record<string, string | null>> {
	if (!Array.isArray(people) || people.length > 100) return {};
	checkCancelled(signal);
	const entries = await pooled(people, 5, async (person): Promise<[string, string | null]> => {
		checkCancelled(signal);
		if (!person || typeof person.login !== "string" || person.login.length > 256) return ["", null];
		const url = typeof person.url === "string" ? avatarUrl(person.url, accounts) : null;
		if (!url) return [person.login, null];
		try {
			const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
			const response = await request(url.href, {
				redirect: "error",
				signal: requestSignal,
				credentials: "omit",
				headers: { Accept: "image/png,image/jpeg,image/gif,image/webp,image/avif" },
			});
			const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
			if (!response.ok || !TYPES.has(type)) {
				await response.body?.cancel();
				return [person.login, null];
			}
			const bytes = await boundedBytes(response, 512 * 1024, requestSignal);
			return [person.login, bytes.length ? `data:${type};base64,${Buffer.from(bytes).toString("base64")}` : null];
		} catch {
			checkCancelled(signal);
			return [person.login, null];
		}
	});
	return Object.fromEntries(entries.filter(([login]) => login));
}
