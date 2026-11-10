import type { Locale } from "@plume/contract";
import type { ForgeAccount, ForgeKind, ForgeKindInfo } from "../api.ts";
import { backendText } from "../messages.ts";
import { ForgeError } from "./errors.ts";
import type { ForgeIdentity } from "./types.ts";

export function isKind(value: unknown): value is ForgeKind {
	return value === "github" || value === "gitlab" || value === "gitee" || value === "gitea";
}
export function normalizeServer(raw: string): string | null {
	if (typeof raw !== "string" || /[\x00-\x20\\]/.test(raw.trim())) return null;
	const text = raw.trim().replace(/\/+$/, "");
	if (!text) return null;
	const scheme = /^([a-z][a-z\d+.-]*):\/\//i.exec(text);
	if (scheme && !/^https?$/i.test(scheme[1]!)) return null;
	try {
		const url = new URL(scheme ? text : `https://${text}`);
		if (!/^https?:$/.test(url.protocol) || !url.hostname || /^[a-z]+:\/\/[^/]*@/i.test(url.href) || url.search || url.hash) return null;
		if (url.hostname === "api.github.com") return "https://github.com";
		// 子路径部署保留前缀，粘贴 API 根时只去掉末尾的 API 部分。
		const path = url.pathname.replace(/\/+$/, "").replace(/\/api(?:\/v[1345])?$/i, "");
		if (
			decodeURIComponent(path)
				.split("/")
				.some((part) => part === "." || part === ".." || /[\\\x00-\x1f]/.test(part))
		)
			return null;
		return `${url.origin}${path}`;
	} catch {
		return null;
	}
}
export function apiRoot(account: Pick<ForgeAccount, "kind" | "baseUrl">): string {
	const base = account.baseUrl.replace(/\/+$/, "");
	if (account.kind === "github") return base === "https://github.com" ? "https://api.github.com" : `${base}/api/v3`;
	return `${base}/api/${account.kind === "gitlab" ? "v4" : account.kind === "gitee" ? "v5" : "v1"}`;
}
export function hostOf(baseUrl: string): string {
	return new URL(baseUrl).host;
}
export function validateRepo(repo: string, kind?: ForgeKind): string[] {
	if (typeof repo !== "string" || repo.length > 1024) throw new ForgeError("badRepoName");
	const parts = repo.split("/");
	if (
		parts.length < 2 ||
		(kind && kind !== "gitlab" && parts.length !== 2) ||
		parts.some((p) => !p || p === "." || p === ".." || !/^[\p{L}\p{N}_.-]+$/u.test(p))
	)
		throw new ForgeError("badRepoName");
	return parts;
}
export function validateNumber(number: number): void {
	if (!Number.isSafeInteger(number) || number < 1) throw new ForgeError("badInput");
}
export function splitRepo(repo: string): { owner: string; name: string } {
	const [owner, name] = validateRepo(repo, "github");
	return { owner: owner!, name: name! };
}
export function repoPath(repo: string): string {
	return validateRepo(repo, "github").map(encodeURIComponent).join("/");
}
export function projectId(repo: string): string {
	validateRepo(repo, "gitlab");
	return encodeURIComponent(repo);
}
function sameIdentity(a: Pick<ForgeAccount, "kind" | "baseUrl" | "login">, b: typeof a): boolean {
	return a.kind === b.kind && a.baseUrl === b.baseUrl && a.login.trim().toLowerCase() === b.login.trim().toLowerCase();
}
export function signedIn(accounts: ForgeAccount[], draft: ForgeAccount, identity: ForgeIdentity): ForgeAccount {
	const existing = accounts.find((a) => sameIdentity(a, { ...draft, login: identity.login }));
	return {
		...draft,
		id: existing?.id ?? draft.id,
		login: identity.login,
		avatarUrl: identity.avatarUrl,
		label: draft.label || existing?.label || identity.login || identity.name,
		enabled: true,
		lastError: "",
	};
}
export function forgeKinds(locale: Locale): ForgeKindInfo[] {
	return [
		{
			kind: "github",
			name: "GitHub",
			baseUrl: "https://github.com",
			tokenUrl: "https://github.com/settings/tokens/new?scopes=repo,read:org,read:user&description=Plume",
			scopes: "repo · read:org · read:user",
			note: backendText(locale, "githubNote"),
		},
		{
			kind: "gitlab",
			name: "GitLab",
			baseUrl: "https://gitlab.com",
			tokenUrl: "https://gitlab.com/-/user_settings/personal_access_tokens?name=Plume&scopes=api",
			scopes: "api",
			note: backendText(locale, "gitlabNote"),
		},
		{
			kind: "gitee",
			name: "Gitee",
			baseUrl: "https://gitee.com",
			tokenUrl: "https://gitee.com/personal_access_tokens/new",
			scopes: "projects · pull_requests · user_info",
			note: backendText(locale, "giteeNote"),
		},
		{
			kind: "gitea",
			name: "Gitea / Forgejo",
			baseUrl: "",
			tokenUrl: "",
			scopes: "read:user · read:repository · write:issue · write:repository",
			note: backendText(locale, "giteaNote"),
		},
	];
}
