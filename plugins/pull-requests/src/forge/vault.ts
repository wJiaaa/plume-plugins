import { join } from "node:path";
import type { PluginSecrets } from "@plume/contract";
import type { ForgeAccount } from "../api.ts";
import { isKind, normalizeServer, signedIn } from "./accounts.ts";
import { checkCancelled, ForgeError } from "./errors.ts";
import { atomicPrivateWrite, privateDirectory, readPrivateFile } from "./private-files.ts";
import type { ForgeConnection, ForgeIdentity } from "./types.ts";

// 内存缓存和账号文件都只保留密文（经 `ctx.secrets` 加密），明文只在使用和校验时短暂存在。
interface StoredEntry {
	account: ForgeAccount;
	token: string;
}
function parseAccount(raw: unknown): ForgeAccount {
	if (!raw || typeof raw !== "object") throw new ForgeError("storeError");
	const a = raw as Partial<ForgeAccount>;
	if (
		typeof a.id !== "string" ||
		!a.id ||
		!isKind(a.kind) ||
		typeof a.baseUrl !== "string" ||
		normalizeServer(a.baseUrl) !== a.baseUrl ||
		typeof a.login !== "string" ||
		!a.login ||
		typeof a.label !== "string" ||
		typeof a.enabled !== "boolean" ||
		(a.avatarUrl !== null && typeof a.avatarUrl !== "string")
	)
		throw new ForgeError("storeError");
	return {
		id: a.id,
		kind: a.kind,
		baseUrl: a.baseUrl,
		login: a.login,
		label: a.label,
		enabled: a.enabled,
		avatarUrl: a.avatarUrl,
		...(typeof a.lastError === "string" ? { lastError: a.lastError } : {}),
	};
}

function validateToken(token: string): void {
	if (!token || token.length > 16_384 || /[\x00-\x20\x7f]/.test(token)) throw new ForgeError("storeError");
}

// 所有读改写在同一队列里完成，内存只在原子重命名成功后更新。
export class AccountStore {
	private entries: StoredEntry[] | null = null;
	private changing: Promise<unknown> = Promise.resolve();
	private directory: string | null = null;
	private readonly dataDir: string;
	private readonly secrets: PluginSecrets;
	constructor(dataDir: string, secrets: PluginSecrets) {
		this.dataDir = dataDir;
		this.secrets = secrets;
	}
	private async read(): Promise<StoredEntry[]> {
		if (this.entries) return this.entries;
		try {
			this.directory = await privateDirectory(this.dataDir);
			const raw = await readPrivateFile(join(this.directory, "accounts.json"), 4 * 1024 * 1024);
			if (raw === null) return (this.entries = []);
			const file = JSON.parse(raw) as { version?: unknown; entries?: unknown };
			if (file.version !== 1 || !Array.isArray(file.entries)) throw new ForgeError("storeError");
			const entries = file.entries.map((entry: unknown) => {
				if (!entry || typeof entry !== "object") throw new ForgeError("storeError");
				const e = entry as Partial<StoredEntry>;
				if (typeof e.token !== "string" || !this.secrets.isSealed(e.token)) throw new ForgeError("storeError");
				return { account: parseAccount(e.account), token: e.token };
			});
			if (new Set(entries.map((e) => e.account.id)).size !== entries.length) throw new ForgeError("storeError");
			return (this.entries = await this.usable(entries));
		} catch {
			throw new ForgeError("storeError");
		}
	}
	/**
	 * 解开一个令牌。解不开（不是现在这把钥匙封的：钥匙丢了、换了）是 null，当成没存过；
	 * 钥匙文件读不出来时报存储错误（这时不能当成没了），错误里不带令牌。
	 */
	private async open(sealed: string): Promise<string | null> {
		const token = await this.secrets.unseal(sealed).catch(() => {
			throw new ForgeError("storeError");
		});
		if (token !== null) validateToken(token);
		return token;
	}
	private async seal(token: string): Promise<string> {
		validateToken(token);
		return this.secrets.seal(token).catch(() => {
			throw new ForgeError("storeError");
		});
	}
	/**
	 * 只留令牌解得开的账号：解不开的当成没存过，人重新登录；下次写盘时一起去掉，文件里不混着两把钥匙的密文。
	 * 钥匙文件读不出来时报存储错误、不写盘，原文件原样留着，等钥匙读得出来。
	 */
	private async usable(entries: StoredEntry[], signal?: AbortSignal): Promise<StoredEntry[]> {
		const kept: StoredEntry[] = [];
		for (const entry of entries) if ((await this.open(entry.token)) !== null) kept.push(entry);
		if (signal) checkCancelled(signal);
		return kept;
	}
	private queue<T>(body: () => Promise<T>): Promise<T> {
		const run = this.changing.then(body);
		this.changing = run.catch(() => {});
		return run;
	}
	private async write(entries: StoredEntry[], signal?: AbortSignal): Promise<void> {
		await atomicPrivateWrite(this.directory!, "accounts.json", JSON.stringify({ version: 1, entries }, null, 2), signal);
		this.entries = entries;
	}
	list(): Promise<ForgeAccount[]> {
		return this.queue(async () => (await this.read()).map((e) => structuredClone(e.account)));
	}
	connect(id: string, signal: AbortSignal): Promise<ForgeConnection> {
		return this.queue(async () => {
			checkCancelled(signal);
			const entries = await this.read();
			const entry = entries.find((e) => e.account.id === id);
			if (!entry) throw new ForgeError("accountGone");
			const token = await this.open(entry.token);
			if (token === null) throw new ForgeError("accountGone");
			checkCancelled(signal);
			return { account: structuredClone(entry.account), token, signal };
		});
	}
	saveIdentity(draft: ForgeAccount, identity: ForgeIdentity, token: string, signal: AbortSignal): Promise<ForgeAccount> {
		return this.queue(async () => {
			checkCancelled(signal);
			const entries = await this.usable(await this.read(), signal);
			const account = signedIn(
				entries.map((e) => e.account),
				draft,
				identity,
			);
			const at = entries.findIndex((e) => e.account.id === account.id);
			const next = [...entries];
			const sealed = { account, token: await this.seal(token) };
			checkCancelled(signal);
			if (at < 0) next.push(sealed);
			else next[at] = sealed;
			await this.write(next, signal);
			return structuredClone(account);
		});
	}
	update(id: string, patch: Partial<Pick<ForgeAccount, "label" | "enabled" | "lastError">>, signal?: AbortSignal): Promise<ForgeAccount | null> {
		return this.queue(async () => {
			if (signal) checkCancelled(signal);
			const entries = await this.usable(await this.read(), signal);
			const at = entries.findIndex((e) => e.account.id === id);
			if (at < 0) return null;
			const entry = entries[at]!;
			const account = { ...entry.account, ...patch };
			if (JSON.stringify(account) !== JSON.stringify(entry.account)) {
				const next = [...entries];
				next[at] = { ...entry, account };
				await this.write(next, signal);
			}
			return structuredClone(account);
		});
	}
	remove(id: string, signal?: AbortSignal): Promise<void> {
		return this.queue(async () => {
			if (signal) checkCancelled(signal);
			const entries = await this.usable(await this.read(), signal);
			const next = entries.filter((e) => e.account.id !== id);
			if (next.length !== entries.length) {
				await this.write(next, signal);
			}
		});
	}
}
