/**
 * 插件数据目录里的两份文件：
 * - `host.json`：这台机器的 `ext_agent_host_id`（`urn:uuid:<UUIDv4>`），第一次用到时生成，之后永远不变；不是密钥，不加密。
 *   单独一份，删掉连接记录不会顺带换掉它（换了在 OpenAI 看来就是另一台机器）。
 * - `connection.json`：注册来的 client_id、账号、授权的 scope、人在设置页改过的供应商，加上经 `ctx.secrets` 封好的令牌。
 *   0600，先写临时文件再换名，半截写坏不会盖掉旧的那份。
 */

import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelEntry, PluginSecrets, ProviderFailure } from "@plume/contract";
import { ChatGptError } from "./errors.ts";
import type { TokenSet } from "./oauth.ts";

export interface SavedRecord {
	/** 正式的 client_id（`oaiapp_…`），换令牌、再登录都用它；断开连接也留着，下次登录不再注册一个新应用。 */
	clientId?: string;
	/** id_token 的 `sub`：之后的登录和刷新都要是同一个人。 */
	subject?: string;
	account?: { name?: string; email?: string };
	status: "disconnected" | "connected" | "reauth_required";
	scopes: string[];
	/** 封好的 `TokenSet` JSON。 */
	tokens?: string;
	/** 供应商下的模型：登录时拉的表，加上人在设置页的改动（见 `mergeModels`）。 */
	models?: ModelEntry[];
	/** 人在设置页改过的名字、启停；没改过时不写。 */
	provider?: { name?: string; enabled?: boolean };
	/** 套餐通道要求暂停后续请求的终局失败；人在模型设置重新启用时清掉。 */
	failure?: ProviderFailure;
}

export const EMPTY_RECORD: SavedRecord = { status: "disconnected", scopes: [] };

const HOST_FILE = "host.json";
const RECORD_FILE = "connection.json";

async function writePrivate(file: string, text: string): Promise<void> {
	const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temp, text, { mode: 0o600 });
	await rename(temp, file);
}

/** 读不到（没有这个文件）是 undefined；读到了解析不了的抛，别的读错误原样抛（不当成没有，否则会被一份空的盖掉）。 */
async function readText(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export async function hostId(dataDir: string): Promise<string> {
	const file = join(dataDir, HOST_FILE);
	const text = await readText(file);
	if (text !== undefined) {
		const saved = (JSON.parse(text) as { hostId?: unknown }).hostId;
		if (typeof saved === "string" && /^urn:uuid:[0-9a-f-]{36}$/.test(saved)) return saved;
		throw new ChatGptError("storage_unreadable", "host.json does not hold a host id");
	}
	const created = `urn:uuid:${randomUUID()}`;
	// `wx`：两次同时生成时只留先写的那一个，后一个读回它。
	try {
		await writeFile(file, `${JSON.stringify({ hostId: created })}\n`, { flag: "wx", mode: 0o600 });
		return created;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return hostId(dataDir);
		throw error;
	}
}

export async function readRecord(dataDir: string): Promise<SavedRecord> {
	const text = await readText(join(dataDir, RECORD_FILE));
	if (text === undefined) return { ...EMPTY_RECORD };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new ChatGptError("storage_unreadable", "connection.json is not JSON");
	}
	const value = parsed as Partial<SavedRecord> | null;
	if (!value || typeof value !== "object" || !["disconnected", "connected", "reauth_required"].includes(String(value.status))) {
		throw new ChatGptError("storage_unreadable", "connection.json has an unexpected shape");
	}
	return {
		...EMPTY_RECORD,
		...value,
		scopes: Array.isArray(value.scopes) ? value.scopes.filter((scope) => typeof scope === "string") : [],
		failure: value.failure === "usage-limit" || value.failure === "not-eligible" ? value.failure : undefined,
	};
}

export async function writeRecord(dataDir: string, record: SavedRecord): Promise<void> {
	await writePrivate(join(dataDir, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
}

export const sealTokens = async (secrets: PluginSecrets, tokens: TokenSet): Promise<string> => secrets.seal(JSON.stringify(tokens));

/** 解不开（换了钥匙、不是这个插件封的）是 undefined，当成没有令牌、要重新登录；钥匙文件读不出来时 `unseal` 抛，原样抛出去。 */
export async function unsealTokens(secrets: PluginSecrets, sealed: string | undefined): Promise<TokenSet | undefined> {
	if (!sealed) return undefined;
	const text = await secrets.unseal(sealed);
	if (text === null) return undefined;
	const tokens = JSON.parse(text) as TokenSet;
	return typeof tokens.accessToken === "string" && typeof tokens.refreshToken === "string" && typeof tokens.expiresAt === "number" ? tokens : undefined;
}
