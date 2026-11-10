import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import type { SecretsService } from "@plume/contract";
import type { ChannelId, ConfigPatch, ImSettings, ImSettingsView } from "./api.ts";
import { CHANNELS } from "./api.ts";

export const DEFAULT_WECHAT_BASE_URL = "https://ilinkai.weixin.qq.com/";
export const DEFAULT_WECHAT_BOT_TYPE = "3";

const DEFAULT_SETTINGS: ImSettings = {
	wechat: { enabled: false, baseUrl: DEFAULT_WECHAT_BASE_URL, botType: DEFAULT_WECHAT_BOT_TYPE, token: "" },
	feishu: { enabled: false, appId: "", domain: "feishu", appSecret: "" },
	telegram: { enabled: false, botToken: "" },
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function enabled(value: unknown): boolean {
	return value === true;
}

function validWeChatHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	return (
		host === "ilinkai.weixin.qq.com" || host === "weixin.qq.com" || host.endsWith(".weixin.qq.com") || host === "wechat.com" || host.endsWith(".wechat.com")
	);
}

export function validateWeChatBaseUrl(value: string): void {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("WeChat service URL is invalid");
	}
	if (url.protocol !== "https:" || !validWeChatHost(url.hostname) || url.username || url.password || url.search || url.hash) {
		throw new Error("WeChat service URL must be an HTTPS URL on a WeChat host without credentials");
	}
}

export function validateTelegramToken(value: string): void {
	if (!/^\d{5,20}:[A-Za-z0-9_-]{20,}$/.test(value)) throw new Error("Telegram Bot Token is invalid");
}

export function validateConfigPatch(input: ConfigPatch): void {
	if (!isRecord(input) || typeof input.channel !== "string" || !CHANNELS.includes(input.channel as ChannelId) || !isRecord(input.patch))
		throw new Error("Configuration update is invalid");
	if (input.channel === "wechat") {
		const patch = input.patch;
		if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") throw new Error("enabled must be a boolean");
		if (patch.baseUrl !== undefined) {
			if (typeof patch.baseUrl !== "string" || !patch.baseUrl.trim()) throw new Error("WeChat service URL is required");
			validateWeChatBaseUrl(patch.baseUrl.trim());
		}
		if (patch.botType !== undefined && (typeof patch.botType !== "string" || !/^[A-Za-z0-9._-]{1,32}$/.test(patch.botType.trim())))
			throw new Error("WeChat Bot Type is invalid");
		return;
	}
	if (input.channel === "feishu") {
		const patch = input.patch;
		if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") throw new Error("enabled must be a boolean");
		if (patch.appId !== undefined && (typeof patch.appId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(patch.appId.trim())))
			throw new Error("Feishu App ID is invalid");
		if (patch.domain !== undefined && patch.domain !== "feishu" && patch.domain !== "lark") throw new Error("Feishu service region is invalid");
		return;
	}
	if (input.patch.enabled !== undefined && typeof input.patch.enabled !== "boolean") throw new Error("enabled must be a boolean");
}

function normalizeSettings(raw: unknown): ImSettings {
	if (!isRecord(raw)) return structuredClone(DEFAULT_SETTINGS);
	const wechat = isRecord(raw.wechat) ? raw.wechat : {};
	const feishu = isRecord(raw.feishu) ? raw.feishu : {};
	const telegram = isRecord(raw.telegram) ? raw.telegram : {};
	const baseUrl = text(wechat.baseUrl) ?? DEFAULT_WECHAT_BASE_URL;
	const botType = text(wechat.botType) ?? DEFAULT_WECHAT_BOT_TYPE;
	const appId = text(feishu.appId) ?? "";
	const domain = feishu.domain === "lark" ? "lark" : "feishu";
	return {
		wechat: {
			enabled: enabled(wechat.enabled),
			baseUrl: (() => {
				try {
					validateWeChatBaseUrl(baseUrl);
					return baseUrl;
				} catch {
					return DEFAULT_WECHAT_BASE_URL;
				}
			})(),
			botType: /^[A-Za-z0-9._-]{1,32}$/.test(botType) ? botType : DEFAULT_WECHAT_BOT_TYPE,
			token: typeof wechat.token === "string" ? wechat.token.trim() : "",
		},
		feishu: {
			enabled: enabled(feishu.enabled),
			appId: /^[A-Za-z0-9._-]{1,128}$/.test(appId) ? appId : "",
			domain,
			appSecret: typeof feishu.appSecret === "string" ? feishu.appSecret.trim() : "",
		},
		telegram: {
			enabled: enabled(telegram.enabled),
			botToken: typeof telegram.botToken === "string" ? telegram.botToken.trim() : "",
		},
	};
}

export function viewOf(settings: ImSettings): ImSettingsView {
	return {
		wechat: { enabled: settings.wechat.enabled, baseUrl: settings.wechat.baseUrl, botType: settings.wechat.botType, tokenSet: Boolean(settings.wechat.token) },
		feishu: {
			enabled: settings.feishu.enabled,
			appId: settings.feishu.appId,
			domain: settings.feishu.domain,
			appSecretSet: Boolean(settings.feishu.appSecret),
		},
		telegram: { enabled: settings.telegram.enabled, botTokenSet: Boolean(settings.telegram.botToken) },
	};
}

function validateSecret(channel: ChannelId, secret: string): void {
	if (secret.length > 4096) throw new Error("Secret is too long");
	if (channel === "telegram" && secret) validateTelegramToken(secret);
	if (channel === "wechat" && secret && secret.length < 1) throw new Error("WeChat login token is invalid");
	if (channel === "feishu" && secret.length > 512) throw new Error("Feishu App Secret is too long");
}

export interface ImStore {
	read(): Promise<ImSettings>;
	view(): Promise<ImSettingsView>;
	setEnabled(channel: ChannelId, value: boolean): Promise<ImSettingsView>;
	setConfig(input: ConfigPatch): Promise<ImSettingsView>;
	setSecret(channel: ChannelId, secret: string): Promise<ImSettingsView>;
}

/** 三个渠道的凭据各在哪一格，读写时经服务 `secrets` 解开、加密。 */
async function mapSecrets(settings: ImSettings, map: (value: string) => Promise<string>): Promise<ImSettings> {
	return {
		wechat: { ...settings.wechat, token: await map(settings.wechat.token) },
		feishu: { ...settings.feishu, appSecret: await map(settings.feishu.appSecret) },
		telegram: { ...settings.telegram, botToken: await map(settings.telegram.botToken) },
	};
}

/**
 * 凭据在 `settings.json` 里是密文；解不开的（加密用的钥匙换过）当成没填。钥匙文件读不出来时 `unseal` 抛错，
 * 读设置跟着失败，不会带着空凭据写回去盖掉密文。
 */
export function createImStore(file: string, secrets: SecretsService): ImStore {
	let queue: Promise<unknown> = Promise.resolve();

	async function read(): Promise<ImSettings> {
		let raw: string;
		try {
			raw = await readFile(file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_SETTINGS);
			throw error;
		}
		return mapSecrets(normalizeSettings(JSON.parse(raw)), async (value) => (secrets.isSealed(value) ? ((await secrets.unseal(value)) ?? "") : value));
	}

	async function write(settings: ImSettings): Promise<ImSettings> {
		const normalized = normalizeSettings(settings);
		const sealed = await mapSecrets(normalized, async (value) => (value ? secrets.seal(value) : value));
		const temp = `${file}.tmp`;
		await writeFile(temp, `${JSON.stringify(sealed, null, "\t")}\n`, { mode: 0o600 });
		await chmod(temp, 0o600);
		await rename(temp, file);
		return normalized;
	}

	function update(change: (settings: ImSettings) => ImSettings): Promise<ImSettings> {
		const next = queue.then(async () => write(change(await read())));
		queue = next.catch(() => undefined);
		return next;
	}

	return {
		read: () => queue.then(read),
		view: async () => viewOf(await read()),
		setEnabled: (channel, value) => {
			if (!CHANNELS.includes(channel)) return Promise.reject(new Error("Unknown IM channel"));
			return update((settings) => ({ ...settings, [channel]: { ...settings[channel], enabled: value } })).then(viewOf);
		},
		setConfig: (input) => {
			validateConfigPatch(input);
			return update((settings) => ({ ...settings, [input.channel]: { ...settings[input.channel], ...input.patch } })).then(viewOf);
		},
		setSecret: (channel, secret) => {
			if (!CHANNELS.includes(channel) || typeof secret !== "string") return Promise.reject(new Error("Secret update is invalid"));
			const value = secret.trim();
			validateSecret(channel, value);
			return update((settings) => {
				if (channel === "wechat") return { ...settings, wechat: { ...settings.wechat, token: value } };
				if (channel === "feishu") return { ...settings, feishu: { ...settings.feishu, appSecret: value } };
				return { ...settings, telegram: { ...settings.telegram, botToken: value } };
			}).then(viewOf);
		},
	};
}
