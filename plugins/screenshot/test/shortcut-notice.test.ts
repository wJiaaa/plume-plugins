/**
 * 全局快捷键没注册上要说出来，但同一个失败只说一次：每个窗口的界面入口都注册一遍，改别的设置也会重注册。
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PluginContext } from "@plume/contract";
import type { Remote, ScreenCapture } from "@plume/contract/ui";
import type { ScreenshotApi } from "../src/api.ts";
import plugin from "../src/index.ts";
import { createSettingsStore } from "../src/settings-store.ts";

function serve(locale: "zh-CN" | "en" = "zh-CN"): ScreenshotApi {
	let api: ScreenshotApi | undefined;
	const ctx = { dataDir: mkdtempSync(join(tmpdir(), "plume-screenshot-")), locale: () => locale, serve: (served: ScreenshotApi) => (api = served) };
	plugin.apply(ctx as unknown as PluginContext);
	assert.ok(api);
	return api;
}

test("同一个失败只说一次；注册上或放掉以后再失败，又说一次", async () => {
	const api = serve();
	const taken = await api.shortcutNotice("taken", "Alt+A");
	assert.match(taken ?? "", /Alt\+A.*微信/);
	assert.equal(await api.shortcutNotice("taken", "Alt+A"), null);
	// 换了一组、或者失败的原因变了，是另一个失败。
	assert.match((await api.shortcutNotice("invalid", "Alt+A")) ?? "", /无法识别/);
	assert.match((await api.shortcutNotice("taken", "Alt+Q")) ?? "", /Alt\+Q/);
	assert.equal(await api.shortcutNotice("ok", "Alt+B"), null);
	assert.ok(await api.shortcutNotice("taken", "Alt+Q"));
	assert.equal(await api.shortcutNotice("ok", null), null);
	assert.ok(await api.shortcutNotice("taken", "Alt+Q"));
});

test("文案按界面语言", async () => {
	assert.match((await serve("en").shortcutNotice("taken", "Alt+A")) ?? "", /^The global shortcut Alt\+A could not be registered/);
});

test("几个窗口各注册一遍，只有第一个弹提示", async () => {
	const api = serve();
	const remote = api as unknown as Remote<ScreenshotApi>;
	const screen = { setShortcut: async () => "taken" as const } as unknown as ScreenCapture;
	const notices: string[] = [];
	const settle = () => new Promise((done) => setTimeout(done, 20));
	createSettingsStore(remote, screen, (message) => notices.push(message));
	await settle();
	createSettingsStore(remote, screen, (message) => notices.push(message));
	await settle();
	assert.equal(notices.length, 1);
	assert.match(notices[0] ?? "", /Alt\+A/);
});
