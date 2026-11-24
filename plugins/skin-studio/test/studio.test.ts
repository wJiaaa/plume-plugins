// color-exempt：测试皮肤数据的色值与 token 校验断言，不是界面固定色
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PluginContext, ToolDefinition, ToolRun } from "@plume/contract";
import plugin from "../src/index.ts";
import { createStudioStore } from "../src/store.ts";
import { PRESETS } from "../src/presets.ts";
import { COLOR_KEYS, contrast, parseSkin } from "../src/types.ts";
import { toSkin } from "../src/palette.ts";
import { oklch } from "../src/tone.ts";

const ONE_PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZP8sAAAAASUVORK5CYII=";

async function fixture(t: { after(callback: () => Promise<void>): void }) {
	const dir = await mkdtemp(join(tmpdir(), "plume-skin-studio-"));
	const stop = new AbortController();
	t.after(async () => {
		stop.abort();
		await rm(dir, { recursive: true, force: true });
	});
	return { dir, stop, store: await createStudioStore(dir, stop.signal) };
}

test("十二套预设均有12色，文字在所有表面可读，映射不丢角色", () => {
	assert.equal(PRESETS.length, 12);
	for (const preset of PRESETS) {
		const skin = parseSkin(preset);
		assert.equal(Object.keys(skin.colors).length, 12);
		const mapped = toSkin(skin);
		assert.equal(mapped.mode, skin.base);
		assert.equal(mapped.name, skin.name);
		assert.deepEqual(mapped.light, mapped.dark);
		const tokens = mapped.light!;
		if (skin.tokens) {
			for (const [key, value] of Object.entries(skin.tokens)) {
				assert.equal(tokens[key as keyof typeof tokens], value, `${preset.id}.${key}`);
			}
			assert.notEqual(tokens.card, tokens.float, `${preset.id}：浮层与卡片应有区分，不融底`);
		} else {
			assert.equal(tokens.root, skin.colors.bgRoot);
			assert.equal(tokens.shell, skin.colors.bgMain);
			assert.equal(tokens.input, skin.colors.bgElevated);
			assert.equal(tokens["ink-muted"], skin.colors.textSecondary);
			assert.equal(tokens["ink-faint"], skin.colors.textTertiary);
			assert.equal(tokens["accent-dim"], skin.colors.accentDim);
			assert.ok(contrast(tokens.accent!, tokens["on-accent"]!) >= 4.5);
			for (const key of COLOR_KEYS) assert.ok(Object.values(tokens).includes(skin.colors[key]), key);
		}
	}
	// 纯 12 色皮肤（不含 tokens 覆写）照常完整映射。
	const plain = parseSkin({ ...PRESETS[0]!, tokens: undefined });
	const plainTokens = toSkin(plain).light!;
	assert.equal(plainTokens.root, plain.colors.bgRoot);
	assert.equal(plainTokens.shell, plain.colors.bgMain);
	assert.equal(plainTokens.input, plain.colors.bgElevated);
	assert.equal(plainTokens["card-hover"], plain.colors.bgHover);
	assert.ok(contrast(plainTokens.accent!, plainTokens["on-accent"]!) >= 4.5);
	for (const key of COLOR_KEYS) assert.ok(Object.values(plainTokens).includes(plain.colors[key]), key);
});

/** OKLCH 的亮度（0–1），只用来比两块底色分不分得开。 */
function lightness(hex: string): number {
	const [r, g, b] = [1, 3, 5].map((offset) => {
		const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
		return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	const l = Math.cbrt(0.4122214708 * r + 0.5363137081 * g + 0.0514459683 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

test("其余原创预设的侧栏（外圈）都比会话窗暗一档，浅色的悬停在侧栏上也看得出", () => {
	for (const preset of PRESETS.filter(
		(skin) => !skin.id.endsWith("t3-code") && !skin.id.endsWith("clawd") && skin.id !== "dark-graphite" && skin.id !== "dark-teal",
	)) {
		const { bgRoot, bgMain, bgHover } = preset.colors;
		assert.ok(lightness(bgMain) - lightness(bgRoot) >= 0.035, `${preset.id}：侧栏 ${bgRoot} 和会话窗 ${bgMain} 太接近`);
		if (preset.base === "light" && !preset.backdrop) assert.ok(lightness(bgRoot) - lightness(bgHover) >= 0.02, `${preset.id}：侧栏上的悬停看不出来`);
	}
	for (const id of ["dark-graphite", "dark-teal"]) {
		const skin = PRESETS.find((preset) => preset.id === id)!;
		assert.ok(lightness(skin.colors.bgRoot) > lightness(skin.colors.bgMain), `${id} 外圈应亮于会话窗`);
		assert.ok(lightness(skin.colors.bgSidebar) > lightness(skin.colors.bgMain), `${id} 侧栏应亮于会话窗`);
	}
});

test("Clawd 浅色与深色预设保持正确明暗分层并保留完整细粒度 token 覆写", () => {
	const light = PRESETS.find((skin) => skin.id === "light-clawd")!;
	const dark = PRESETS.find((skin) => skin.id === "dark-clawd")!;
	assert.equal(light.base, "light");
	assert.equal(dark.base, "dark");
	assert.ok(lightness(light.colors.bgMain) > lightness(light.colors.bgRoot), "浅色外圈应灰于会话窗");
	assert.ok(lightness(light.colors.bgMain) > lightness(light.colors.bgSidebar), "浅色侧栏应灰于会话窗");
	assert.ok(lightness(dark.colors.bgRoot) > lightness(dark.colors.bgMain), "深色外圈应亮于会话窗");
	assert.ok(lightness(dark.colors.bgSidebar) > lightness(dark.colors.bgMain), "深色侧栏应亮于会话窗");
	const lightTokens = toSkin(parseSkin(light)).light!;
	const darkTokens = toSkin(parseSkin(dark)).dark!;
	assert.equal(lightTokens.shell, "oklch(0.981775 0.005392 95.099)");
	assert.equal(lightTokens.root, "oklch(0.965992 0.009326 99.984)");
	assert.equal(lightTokens.card, "oklch(0.948457 0.010853 95.166)");
	assert.equal(lightTokens.input, "oklch(1 0 0)");
	assert.equal(lightTokens["card-hover"], "rgb(127 127 127 / 0.14)");
	assert.equal(lightTokens["window-tint"], "color-mix(in srgb, oklch(0.965992 0.009326 99.984) 70%, transparent)");
	assert.equal(lightTokens["line-float"], "rgb(127 127 127 / 0.18)");
	assert.equal(lightTokens["inline-code-bg"], "rgb(127 127 127 / 0.16)");
	assert.equal(lightTokens["radius-panel"], "14px");
	assert.equal(lightTokens["code-tracking"], "-0.002em");
	assert.equal(darkTokens.shell, "oklch(0.213423 0 0)");
	assert.equal(darkTokens.root, "oklch(0.239292 0 0)");
	assert.equal(darkTokens.sidebar, "oklch(0.268618 0 0)");
	assert.equal(darkTokens.card, "oklch(0.268618 0 0)");
	assert.equal(darkTokens.input, "oklch(0.309186 0 0)");
	assert.equal(darkTokens.float, "oklch(0.285017 0 0)");
	assert.equal(darkTokens.elevated, "rgb(127 127 127 / 0.16)");
	assert.equal(darkTokens["window-tint"], "color-mix(in srgb, oklch(0.285017 0 0) 60%, transparent)");
	assert.equal(darkTokens.danger, "oklch(0.72 0.165 22)");
});

test("T3 Code 浅色会话窗亮于侧栏与外圈，深色侧栏与外圈亮于会话窗", () => {
	const light = PRESETS.find((skin) => skin.id === "light-t3-code")!;
	assert.ok(lightness(light.colors.bgMain) - lightness(light.colors.bgSidebar) >= 0.02, "浅色侧栏应明显灰于会话窗");
	assert.ok(lightness(light.colors.bgMain) > lightness(light.colors.bgRoot), "浅色外圈应灰于会话窗");

	const dark = PRESETS.find((skin) => skin.id === "dark-t3-code")!;
	assert.ok(lightness(dark.colors.bgSidebar) - lightness(dark.colors.bgMain) >= 0.02, "深色侧栏应明显亮于会话窗");
	assert.ok(lightness(dark.colors.bgRoot) > lightness(dark.colors.bgMain), "深色外圈应亮于会话窗");
});

test("色调皮肤由色相推出，外圈是纯渐变、不带颗粒；没有底纹的皮肤不写 root-image", () => {
	const tones = PRESETS.filter((preset) => preset.backdrop);
	assert.deepEqual(
		tones.map((tone) => tone.id),
		["light-tone-sky", "light-tone-lavender", "light-tone-celadon"],
	);
	for (const tone of tones) {
		// 渐变两端也要过文字对比度，parseSkin 原样保留底纹。
		assert.deepEqual(parseSkin(tone).backdrop, tone.backdrop);
		assert.equal(toSkin(tone).light!["root-image"], `linear-gradient(160deg, ${tone.backdrop!.from}, ${tone.backdrop!.to})`);
		assert.ok(contrast(tone.colors.accent, toSkin(tone).light!["on-accent"]!) >= 4.5);
	}
	assert.equal(toSkin(PRESETS[0]!).light!["root-image"], undefined);
	// 彩度为 0 时是灰：三个通道相同；白和黑的对比度是 21:1。
	const gray = oklch(0.5, 0, 0);
	assert.equal(gray.slice(1, 3).repeat(3), gray.slice(1));
	assert.equal(Math.round(contrast(oklch(1, 0, 0), oklch(0, 0, 0))), 21);
});

test("底纹只接受两个 #RRGGBB，文字压不住渐变两端时拒绝，颗粒不进皮肤", () => {
	const tone = PRESETS.find((preset) => preset.backdrop)!;
	for (const backdrop of [
		null,
		[],
		{ from: tone.backdrop!.from },
		{ ...tone.backdrop, from: "url(https://example.com)" },
		{ ...tone.backdrop, to: "linear-gradient(red, blue)" },
	])
		assert.throws(() => parseSkin({ ...tone, backdrop }), /invalidBackdrop/);
	assert.throws(() => parseSkin({ ...tone, backdrop: { ...tone.backdrop, to: tone.colors.textPrimary } }), /lowContrast/);
	// 别人分享的旧 JSON 里多带的 grain 丢掉，不存进作品。
	assert.deepEqual(parseSkin({ ...tone, backdrop: { ...tone.backdrop, grain: true } }).backdrop, tone.backdrop);
});

test("皮肤独立背景保存、映射和重启后保持，且不接受网络地址、SVG 或伪造图片", async (t) => {
	const source = {
		...PRESETS.find((skin) => skin.id === "dark-berry")!,
		name: "Nyx",
		background: {
			image: ONE_PIXEL_PNG,
			fit: "cover",
			effect: "grid",
			opacity: 0.52,
			onNewChat: true,
			inChat: true,
		},
	};
	const parsed = parseSkin(source);
	assert.deepEqual(parsed.background, source.background);
	assert.deepEqual(toSkin(parsed).background, source.background);
	const { store, dir, stop } = await fixture(t);
	const saved = await store.save(source, true);
	const active = saved.skins.find((skin) => skin.id === saved.activeId)!;
	assert.deepEqual(active.background, source.background);
	const reloaded = await (await createStudioStore(dir, stop.signal)).view();
	assert.deepEqual(reloaded.skins.find((skin) => skin.id === active.id)!.background, source.background);
	for (const image of ["https://example.com/nyx.webp", "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", ONE_PIXEL_PNG.replace("image/png", "image/webp")])
		assert.throws(() => parseSkin({ ...source, background: { ...source.background, image } }), /invalidBackground/);
});

test("拒绝缺失颜色、CSS/URL、非法模式、过长名和不可读的AI配色", () => {
	const valid = PRESETS[0]!;
	for (const invalid of [
		null,
		[],
		{ ...valid, name: " " },
		{ ...valid, name: "x".repeat(81) },
		{ ...valid, base: "system" },
		{ ...valid, colors: { ...valid.colors, textPrimary: undefined } },
		{ ...valid, colors: { ...valid.colors, accent: "url(https://example.com)" } },
		{ ...valid, colors: { ...valid.colors, textPrimary: valid.colors.bgMain } },
	])
		assert.throws(() => parseSkin(invalid));
	assert.deepEqual(Object.keys(parseSkin({ ...valid, tokens: undefined, ignored: true })).sort(), ["base", "colors", "name"]);
	assert.deepEqual(Object.keys(parseSkin({ ...valid, ignored: true })).sort(), ["base", "colors", "name", "tokens"]);
});

test("保存、切换、提取、删除及重启恢复；同名作品不覆盖", async (t) => {
	const { store, dir, stop } = await fixture(t);
	assert.equal((await store.view()).activeId, null);
	await store.apply("light-mint");
	let view = await store.saveCurrent("我的薄荷");
	const copy = view.skins.find((skin) => skin.id === view.activeId)!;
	assert.equal(copy.name, "我的薄荷");
	assert.equal(copy.builtin, false);
	assert.deepEqual(copy.colors, PRESETS.find((skin) => skin.id === "light-mint")!.colors);
	view = await store.save({ ...copy, id: "light-mint", builtin: true }, false);
	assert.equal(view.activeId, copy.id);
	assert.equal(view.skins.filter((skin) => skin.name === copy.name).length, 2);
	assert.deepEqual(await (await createStudioStore(dir, stop.signal)).view(), view);
	await assert.rejects(store.remove("light-mint"), /builtinSkin/);
	await assert.rejects(store.apply("unknown"), /missingSkin/);
	view = await store.remove(copy.id);
	assert.equal(view.activeId, null);
	assert.equal(view.skins.length, PRESETS.length + 1);
	await assert.rejects(store.saveCurrent("nothing"), /noCurrent/);
	await store.apply("dark-teal");
	assert.equal((await store.apply(null)).activeId, null);
});

test("并发保存串行落盘，失败不污染当前皮肤或下一次保存", async (t) => {
	const { store, dir } = await fixture(t);
	await Promise.all(Array.from({ length: 8 }, (_, index) => store.save({ ...PRESETS[0], name: `skin ${index}` }, false)));
	assert.equal((await store.view()).skins.length, PRESETS.length + 8);
	await store.apply("dark-berry");
	const before = await readFile(join(dir, "skins.json"), "utf8");
	await assert.rejects(store.save({ name: "broken" }, true));
	assert.equal(await readFile(join(dir, "skins.json"), "utf8"), before);
	assert.equal((await store.save(PRESETS[2], true)).skins.length, PRESETS.length + 9);
});

test("损坏的皮肤库不当空列表覆盖", async (t) => {
	const { dir, stop } = await fixture(t);
	const file = join(dir, "skins.json");
	for (const content of [
		"{broken",
		JSON.stringify({ custom: [{ ...PRESETS[0], id: "bad" }], activeId: null }),
		JSON.stringify({ custom: [], activeId: "missing" }),
	]) {
		await writeFile(file, content);
		await assert.rejects(createStudioStore(dir, stop.signal), /invalidLibrary/);
		assert.equal(await readFile(file, "utf8"), content);
	}
	await writeFile(file, "");
	await truncate(file, 31 * 1024 * 1024);
	await assert.rejects(createStudioStore(dir, stop.signal), /invalidLibrary/);
});

test("订阅立即读取、无面板时推送切换，取消和插件卸载解除等待", async (t) => {
	const { store, stop } = await fixture(t);
	const caller = new AbortController();
	const stream = store.watch({ signal: caller.signal });
	assert.equal((await stream.next()).value!.activeId, null);
	const pending = stream.next();
	await store.apply("dark-teal");
	assert.equal((await pending).value!.activeId, "dark-teal");
	// yield 与下一次 next 之间发生的变化也不能丢失。
	await store.apply("light-mint");
	assert.equal((await stream.next()).value!.activeId, "light-mint");
	const cancelled = stream.next();
	caller.abort();
	assert.equal((await cancelled).done, true);
	const second = store.watch({ signal: new AbortController().signal });
	await second.next();
	const unloaded = second.next();
	stop.abort();
	assert.equal((await unloaded).done, true);
});

test("AI工具真正保存并应用，列表只读，拒绝只读模式下的修改", async (t) => {
	const { dir } = await fixture(t);
	let tool: ToolDefinition | undefined;
	await plugin.apply({
		dataDir: dir,
		effect: (dispose: () => void) =>
			t.after(async () => {
				dispose();
			}),
		serve: () => {},
		tools: {
			register: (definition: ToolDefinition) => {
				tool = definition;
			},
		},
	} as unknown as PluginContext);
	assert.ok(tool);
	const run = { signal: new AbortController().signal } as ToolRun;
	assert.equal(tool.readsOnly?.({ action: "list" }), true);
	assert.equal(tool.readsOnly?.({ action: "apply" }), false);
	const background = { image: ONE_PIXEL_PNG, fit: "cover", effect: "grid", opacity: 0.52, onNewChat: true, inChat: true };
	const applied = await tool.execute({ action: "apply", ...PRESETS.find((skin) => skin.id === "dark-berry"), id: undefined, name: "AI 莓果", background }, run);
	assert.ok(!applied.isError, applied.output);
	assert.doesNotMatch(applied.output, /data:image/);
	const view = JSON.parse(applied.output);
	const active = view.skins.find((skin: { id: string }) => skin.id === view.activeId);
	assert.equal(active.name, "AI 莓果");
	assert.deepEqual(active.background, { fit: "cover", effect: "grid", opacity: 0.52, onNewChat: true, inChat: true, embedded: true, mediaType: "png" });
	const stored = JSON.parse(await readFile(join(dir, "skins.json"), "utf8"));
	assert.equal(stored.custom[0].background.image, ONE_PIXEL_PNG);
	const saved = await tool.execute({ action: "save", name: "只保存的副本" }, run);
	assert.equal(JSON.parse(saved.output).activeId, view.activeId, "save 不切换当前皮肤");
	const denied = await tool.execute({ action: "reset" }, { ...run, readOnly: true });
	assert.equal(denied.isError, true);
	assert.equal((await tool.execute({ action: "apply", id: "dark-teal", colors: PRESETS[0]!.colors }, run)).isError, true);
	const listed = await tool.execute({ action: "list" }, run);
	assert.equal(listed.isError, undefined);
	// 跟随系统、浅色、深色是应用的主题设置，工具不碰。
	assert.equal((await tool.execute({ action: "apply", id: "default-dark" }, run)).isError, true);
});

test("带底纹的作品保存、复制当前皮肤和重启后都保留底纹", async (t) => {
	const { store, dir, stop } = await fixture(t);
	await store.apply("light-tone-sky");
	const view = await store.saveCurrent("我的晴空");
	const copy = view.skins.find((skin) => skin.id === view.activeId)!;
	assert.deepEqual(copy.backdrop, PRESETS.find((skin) => skin.id === "light-tone-sky")!.backdrop);
	const reloaded = await (await createStudioStore(dir, stop.signal)).view();
	assert.deepEqual(reloaded.skins.find((skin) => skin.id === copy.id)!.backdrop, copy.backdrop);
});

test("扩展 tokens 支持合法细粒度覆写、保存、复制和重启恢复，拒绝未知 token 与危险 CSS", async (t) => {
	const base = PRESETS[0]!;
	const tokens = {
		card: "oklch(0.95 0.01 95)",
		input: "#FFFFFF",
		"card-hover": "rgb(127 127 127 / 0.14)",
		"window-tint": "color-mix(in srgb, oklch(0.96 0.01 99) 70%, transparent)",
		"inline-code-ring": "transparent",
		"syntax-variable": "var(--plume-ink)",
		contrast: "0.6",
		"code-line-height": "1.55",
		"code-tracking": "-0.002em",
		"radius-panel": "14px",
		"ui-size": "14px",
		"font-sans": 'ui-sans-serif, -apple-system, "Segoe UI", sans-serif',
	};
	const parsed = parseSkin({ ...base, name: "精细皮肤", tokens });
	assert.deepEqual(parsed.tokens, tokens);
	assert.equal(parseSkin({ ...base, tokens: {} }).tokens, undefined);
	const mapped = toSkin(parsed).light!;
	assert.equal(mapped.card, tokens.card);
	assert.equal(mapped["card-hover"], tokens["card-hover"]);
	assert.equal(mapped["radius-panel"], "14px");

	for (const badTokens of [
		null,
		[],
		{ "root-image": "linear-gradient(red, blue)" },
		{ unknown: "#112233" },
		{ card: "url(https://example.com/a.png)" },
		{ card: "red; background: url(https://example.com)" },
		{ "window-tint": "color-mix(in srgb, url(https://example.com) 50%, red)" },
		{ "syntax-variable": "var(--other-var)" },
		{ contrast: "1.5" },
		{ "code-line-height": "5" },
		{ "code-tracking": "2em" },
		{ "radius-panel": "100px" },
		{ "ui-size": "40px" },
		{ "font-sans": "Arial; } body { display: none }" },
	]) {
		assert.throws(() => parseSkin({ ...base, tokens: badTokens }), /invalidTokens/);
	}

	const { store, dir, stop } = await fixture(t);
	await store.apply("dark-clawd");
	const copied = await store.saveCurrent("我的 Clawd");
	const active = copied.skins.find((skin) => skin.id === copied.activeId)!;
	assert.deepEqual(active.tokens, PRESETS.find((skin) => skin.id === "dark-clawd")!.tokens);
	const reloaded = await (await createStudioStore(dir, stop.signal)).view();
	assert.deepEqual(reloaded.skins.find((skin) => skin.id === active.id)!.tokens, active.tokens);
});
