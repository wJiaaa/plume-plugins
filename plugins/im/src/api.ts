export const CHANNELS = ["wechat", "feishu", "telegram"] as const;
export type ChannelId = (typeof CHANNELS)[number];

type FeishuDomain = "feishu" | "lark";

interface WechatConfig {
	enabled: boolean;
	baseUrl: string;
	botType: string;
	token: string;
}

interface FeishuConfig {
	enabled: boolean;
	appId: string;
	domain: FeishuDomain;
	appSecret: string;
}

interface TelegramConfig {
	enabled: boolean;
	botToken: string;
}

export interface ImSettings {
	wechat: WechatConfig;
	feishu: FeishuConfig;
	telegram: TelegramConfig;
}

export interface ImSettingsView {
	wechat: Omit<WechatConfig, "token"> & { tokenSet: boolean };
	feishu: Omit<FeishuConfig, "appSecret"> & { appSecretSet: boolean };
	telegram: Omit<TelegramConfig, "botToken"> & { botTokenSet: boolean };
}

export type ConfigPatch =
	| { channel: "wechat"; patch: Partial<Pick<WechatConfig, "enabled" | "baseUrl" | "botType">> }
	| { channel: "feishu"; patch: Partial<Pick<FeishuConfig, "enabled" | "appId" | "domain">> }
	| { channel: "telegram"; patch: Partial<Pick<TelegramConfig, "enabled">> };

export interface ImApi {
	settings(): Promise<ImSettingsView>;
	setEnabled(channel: ChannelId, enabled: boolean): Promise<ImSettingsView>;
	setConfig(input: ConfigPatch): Promise<ImSettingsView>;
	setSecret(channel: ChannelId, secret: string): Promise<ImSettingsView>;
	clearSecret(channel: ChannelId): Promise<ImSettingsView>;
}
