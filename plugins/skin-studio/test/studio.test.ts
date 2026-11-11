import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function fixture(t: { after(callback: () => Promise<void>): void }) {
	const dir = await mkdtemp(join(tmpdir(), "plume-skin-studio-"));
	const stop = new AbortController();
	t.after(async () => {
		stop.abort();
		await rm(dir, { recursive: true, force: true });
	});
	return { dir, stop, store: await createStudioStore(dir, stop.signal) };
}

test("八套预设均有12色，文字在所有表面可读，映射不丢角色", () => {
	assert.equal(PRESETS.length, 8);
	for (const preset of PRESETS) {
		const skin = parseSkin(preset);
		assert.equal(Object.keys(skin.colors).length, 12);
		const mapped = toSkin(skin);
		assert.equal(mapped.mode, skin.base);
		assert.equal(mapped.name, skin.name);
		assert.deepEqual(mapped.light, mapped.dark);
		const tokens = mapped.light!;
		assert.equal(tokens.root, skin.colors.bgRoot);
		assert.equal(tokens.shell, skin.colors.bgMain);
		assert.equal(tokens.input, skin.colors.bgElevated);
		assert.equal(tokens["ink-muted"], skin.colors.textSecondary);
		assert.equal(tokens["ink-faint"], skin.colors.textTertiary);
		assert.equal(tokens["accent-dim"], skin.colors.accentDim);
		assert.ok(contrast(tokens.accent!, tokens["on-accent"]!) >= 4.5);
		for (const key of COLOR_KEYS) assert.ok(Object.values(tokens).includes(skin.colors[key]), key);
	}
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

test("每套预设的侧栏（外圈）都比会话窗暗一档，浅色的悬停在侧栏上也看得出", () => {
	for (const preset of PRESETS) {
		const { bgRoot, bgMain, bgHover } = preset.colors;
		assert.ok(lightness(bgMain) - lightness(bgRoot) >= 0.035, `${preset.id}：侧栏 ${bgRoot} 和会话窗 ${bgMain} 太接近`);
		if (preset.base === "light" && !preset.backdrop) assert.ok(lightness(bgRoot) - lightness(bgHover) >= 0.02, `${preset.id}：侧栏上的悬停看不出来`);
	}
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
	assert.deepEqual(Object.keys(parseSkin({ ...valid, ignored: true })).sort(), ["base", "colors", "name"]);
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
	for (const content of [
		"{broken",
		JSON.stringify({ custom: [{ ...PRESETS[0], id: "bad" }], activeId: null }),
		JSON.stringify({ custom: [], activeId: "missing" }),
	]) {
		await writeFile(join(dir, "skins.json"), content);
		await assert.rejects(createStudioStore(dir, stop.signal), /invalidLibrary/);
		assert.equal(await readFile(join(dir, "skins.json"), "utf8"), content);
	}
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
	const applied = await tool.execute({ action: "apply", ...PRESETS.find((skin) => skin.id === "dark-berry"), id: undefined, name: "AI 莓果" }, run);
	assert.ok(!applied.isError, applied.output);
	const view = JSON.parse(applied.output);
	assert.equal(view.skins.find((skin: { id: string }) => skin.id === view.activeId).name, "AI 莓果");
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
