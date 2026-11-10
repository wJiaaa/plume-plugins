import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createImStore,
	DEFAULT_WECHAT_BASE_URL,
	DEFAULT_WECHAT_BOT_TYPE,
	validateConfigPatch,
	validateTelegramToken,
	validateWeChatBaseUrl,
	viewOf,
} from "../src/config.ts";
import type { ImSettings } from "../src/api.ts";
import type { SecretsService } from "@plume/contract";

/** 服务 `secrets` 的替身：前缀和真的一样，内容只做 base64。 */
const SEALED = "plume-sealed:v1:";
const fakeSecrets: SecretsService = {
	seal: async (value) => SEALED + Buffer.from(value).toString("base64"),
	unseal: async (sealed) => (sealed.startsWith(SEALED) ? Buffer.from(sealed.slice(SEALED.length), "base64").toString() : null),
	isSealed: (value) => value.startsWith(SEALED),
};

test("defaults are complete and views never expose secrets", () => {
	const settings: ImSettings = {
		wechat: { enabled: false, baseUrl: DEFAULT_WECHAT_BASE_URL, botType: DEFAULT_WECHAT_BOT_TYPE, token: "wx-secret" },
		feishu: { enabled: true, appId: "cli_test", domain: "feishu", appSecret: "feishu-secret" },
		telegram: { enabled: true, botToken: "123456:abcdefghijklmnopqrstuv" },
	};
	const view = viewOf(settings);
	assert.deepEqual(view.wechat, { enabled: false, baseUrl: DEFAULT_WECHAT_BASE_URL, botType: DEFAULT_WECHAT_BOT_TYPE, tokenSet: true });
	assert.deepEqual(view.feishu, { enabled: true, appId: "cli_test", domain: "feishu", appSecretSet: true });
	assert.deepEqual(view.telegram, { enabled: true, botTokenSet: true });
	assert.equal(JSON.stringify(view).includes("secret"), false);
});

test("validates platform-specific configuration", () => {
	validateWeChatBaseUrl(DEFAULT_WECHAT_BASE_URL);
	validateTelegramToken("123456:abcdefghijklmnopqrstuv");
	validateConfigPatch({ channel: "wechat", patch: { baseUrl: DEFAULT_WECHAT_BASE_URL, botType: "3" } });
	validateConfigPatch({ channel: "feishu", patch: { appId: "cli_app", domain: "lark" } });
	assert.throws(() => validateWeChatBaseUrl("http://ilinkai.weixin.qq.com/"));
	assert.throws(() => validateWeChatBaseUrl("https://example.com/"));
	assert.throws(() => validateTelegramToken("not-a-token"));
	assert.throws(() => validateConfigPatch({ channel: "feishu", patch: { domain: "other" as "feishu" } }));
});

test("stores secrets with a private atomic file and returns only flags", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-im-"));
	const file = join(dir, "settings.json");
	const store = createImStore(file, fakeSecrets);
	await store.setSecret("telegram", "123456:abcdefghijklmnopqrstuv");
	await store.setEnabled("telegram", true);
	const view = await store.view();
	assert.equal(view.telegram.botTokenSet, true);
	const raw = await readFile(file, "utf8");
	assert.equal(raw.includes("123456:abcdefghijklmnopqrstuv"), false, "凭据不以明文落盘");
	assert.ok(fakeSecrets.isSealed(JSON.parse(raw).telegram.botToken));
	assert.equal(raw.includes("botTokenSet"), false);
	assert.equal((await store.read()).telegram.botToken, "123456:abcdefghijklmnopqrstuv");
	await store.setSecret("telegram", "");
	assert.equal((await store.view()).telegram.botTokenSet, false);
});
