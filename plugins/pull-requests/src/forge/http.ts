import { apiRoot, hostOf } from "./accounts.ts";
import { checkCancelled, ForgeError, statusError } from "./errors.ts";
import type { ForgeConnection, ForgeIdentity } from "./types.ts";

export const DIFF_TIMEOUT_MS = 60_000;
const JSON_LIMIT = 8 * 1024 * 1024;
const DIFF_LIMIT = 24 * 1024 * 1024;
export interface CallOptions {
	method?: string;
	body?: unknown;
	accept?: string;
	timeoutMs?: number;
	query?: Record<string, string | number | boolean | undefined | (string | number)[]>;
	root?: string;
}
export async function boundedBytes(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
	checkCancelled(signal);
	if (Number(response.headers.get("content-length")) > limit) {
		await response.body?.cancel();
		throw new ForgeError("tooLarge");
	}
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	const abort = () => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		checkCancelled(signal);
		for (;;) {
			const { done, value } = await reader.read();
			checkCancelled(signal);
			if (done) break;
			size += value.byteLength;
			if (size > limit) throw new ForgeError("tooLarge");
			chunks.push(value);
		}
		const out = new Uint8Array(size);
		let at = 0;
		for (const chunk of chunks) {
			out.set(chunk, at);
			at += chunk.byteLength;
		}
		return out;
	} finally {
		signal.removeEventListener("abort", abort);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
function redact<T>(value: T, token: string): T {
	if (!token) return value;
	if (typeof value === "string") return value.split(token).join("[redacted]") as T;
	if (Array.isArray(value)) return value.map((item) => redact(item, token)) as T;
	if (value && typeof value === "object")
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.split(token).join("[redacted]"), redact(item, token)])) as T;
	return value;
}
function authHeader(conn: ForgeConnection): Record<string, string> {
	if (conn.account.kind === "gitlab") return { "PRIVATE-TOKEN": conn.token };
	return { Authorization: `${conn.account.kind === "gitee" ? "token" : "Bearer"} ${conn.token}` };
}
async function call(conn: ForgeConnection, path: string, options: CallOptions, limit: number): Promise<{ status: number; text: string }> {
	checkCancelled(conn.signal);
	const api = apiRoot(conn.account);
	const root = options.root ?? api;
	// GraphQL 只允许同一账号的已知根；拒绝驱动意外传入的绝对路径或上级路径。
	if (
		(root !== api && !(conn.account.kind === "github" && root === api.replace(/\/v3$/, ""))) ||
		!path.startsWith("/") ||
		path.startsWith("//") ||
		/[\\?#\x00-\x20]/.test(path)
	)
		throw new ForgeError("badInput");
	for (const segment of path.split("/")) {
		let decoded: string;
		try {
			decoded = decodeURIComponent(segment);
		} catch {
			throw new ForgeError("badInput");
		}
		if (decoded.split("/").some((part) => part === "." || part === "..") || /[\\\x00-\x1f]/.test(decoded)) throw new ForgeError("badInput");
	}
	const url = new URL(`${root}${path}`);
	for (const [key, value] of Object.entries(options.query ?? {})) {
		if (value === undefined) continue;
		if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
		else url.searchParams.set(key, String(value));
	}
	const deadline = AbortSignal.timeout(options.timeoutMs ?? 30_000);
	const signal = AbortSignal.any([conn.signal, deadline]);
	try {
		const response = await (conn.fetch ?? fetch)(url.href, {
			method: options.method ?? "GET",
			redirect: "error",
			signal,
			headers: {
				...authHeader(conn),
				Accept: options.accept ?? "application/json",
				"User-Agent": "Plume",
				...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
		});
		const raw = new TextDecoder().decode(await boundedBytes(response, response.ok ? limit : 64 * 1024, signal));
		if (!response.ok) throw statusError(response.status, raw);
		return { status: response.status, text: raw };
	} catch (error) {
		checkCancelled(conn.signal);
		if (deadline.aborted) throw new ForgeError("timeout", 0, { host: redact(hostOf(conn.account.baseUrl), conn.token) });
		if (error instanceof ForgeError) throw error;
		const message = error instanceof Error ? `${error.name} ${error.message} ${String((error.cause as { code?: string } | undefined)?.code ?? "")}` : "";
		const key = /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)
			? "unresolved"
			: /ECONNREFUSED/i.test(message)
				? "refused"
				: /CERT|certificate|SSL|TLS/i.test(message)
					? "certificate"
					: "unreachable";
		throw new ForgeError(key, 0, { host: redact(hostOf(conn.account.baseUrl), conn.token) });
	}
}
export async function json<T>(conn: ForgeConnection, path: string, options: CallOptions = {}): Promise<T> {
	const result = await call(conn, path, options, options.timeoutMs === DIFF_TIMEOUT_MS ? DIFF_LIMIT : JSON_LIMIT);
	if (result.status === 204 || !result.text.trim()) return undefined as T;
	try {
		return redact(JSON.parse(result.text) as T, conn.token);
	} catch {
		throw new ForgeError("notJson", result.status);
	}
}
export async function text(conn: ForgeConnection, path: string, options: CallOptions = {}): Promise<string> {
	return redact((await call(conn, path, options, DIFF_LIMIT)).text, conn.token);
}
export async function identifyUser(conn: ForgeConnection, fields = { login: "login", name: "name" }): Promise<ForgeIdentity> {
	const user = await json<Record<string, unknown> | undefined>(conn, "/user");
	const login = user?.[fields.login];
	if (typeof login !== "string" || !login.trim() || login.length > 256) throw new ForgeError("noUserInfo");
	return {
		login,
		name: typeof user?.[fields.name] === "string" ? (user[fields.name] as string) : login,
		avatarUrl: typeof user?.avatar_url === "string" ? user.avatar_url : null,
	};
}
export async function pooled<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = Array.from({ length: items.length });
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			for (;;) {
				const at = next++;
				if (at >= items.length) return;
				out[at] = await work(items[at]!);
			}
		}),
	);
	return out;
}
