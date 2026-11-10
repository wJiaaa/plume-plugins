import type { Locale } from "@plume/contract";
import { backendText, type BackendMessageKey } from "../messages.ts";

export class ForgeError extends Error {
	readonly key: BackendMessageKey;
	readonly status: number;
	readonly params: Record<string, string | number>;
	constructor(key: BackendMessageKey, status = 0, params: Record<string, string | number> = {}) {
		super(backendText("en", key, params));
		this.name = "ForgeError";
		this.key = key;
		this.status = status;
		this.params = params;
	}
}

// 服务可以在错误正文里回显令牌，因此错误只使用本地文案，不透传正文或底层异常。
export function describe(error: unknown, locale: Locale = "en"): string {
	if (error instanceof ForgeError) return backendText(locale, error.key, error.params);
	if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return backendText(locale, "cancelled");
	return backendText(locale, "unknownError");
}
export function statusError(status: number, detail = ""): ForgeError {
	if (status === 401) return new ForgeError("invalidToken", status);
	if (status === 403) return new ForgeError(/rate limit|too many/i.test(detail) ? "rateLimited" : "forbidden", status);
	if (status === 404) return new ForgeError("notFound", status);
	if (status === 422) return new ForgeError("rejected", status);
	if (status === 429) return new ForgeError("rateLimited", status);
	return new ForgeError(status >= 500 ? "serverError" : "requestFailed", status, { status });
}
export function checkCancelled(signal: AbortSignal): void {
	if (signal.aborted) throw new ForgeError("cancelled");
}

// 可选资源缺失不阻断主体，但取消不能伪装成缺少评论或检查。
export function optional<T>(signal: AbortSignal, fallback: T): (error: unknown) => T {
	return () => {
		checkCancelled(signal);
		return fallback;
	};
}
