import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { Remote, Skin, UiContext } from "@plume/contract/ui";
import type { SkinStudioApi } from "../src/api.ts";
import type { StudioView } from "../src/types.ts";
import { PRESETS } from "../src/presets.ts";
import { createStudioStore } from "../src/ui-store.ts";

function fixture() {
	let deliver: ((value: IteratorResult<StudioView, void>) => void) | undefined;
	let cancelled = false;
	const call = {
		[Symbol.asyncIterator]() {
			return this;
		},
		next: () =>
			new Promise<IteratorResult<StudioView, void>>((resolve) => {
				deliver = resolve;
			}),
		cancel: () => {
			cancelled = true;
			deliver?.({ done: true, value: undefined });
		},
	};
	const applied: Array<Skin | null> = [];
	const ui = { skin: (skin: Skin | null) => applied.push(skin) } as UiContext;
	const api = { watch: () => call } as unknown as Remote<SkinStudioApi>;
	const store = createStudioStore(ui, api);
	return {
		store,
		applied,
		cancelled: () => cancelled,
		async push(view: StudioView) {
			deliver?.({ done: false, value: view });
			await setImmediate();
		},
	};
}

test("启用即订阅，无需挂载面板；保存未应用作品不抢皮肤优先级", async () => {
	const { store, applied, push, cancelled } = fixture();
	store.start();
	const first: StudioView = { skins: structuredClone([...PRESETS]), activeId: "light-mint" };
	await push(first);
	assert.equal(applied.length, 1);
	assert.equal(applied[0]!.mode, "light");
	await push({ ...first, skins: [...first.skins, { ...PRESETS[0]!, id: "new", builtin: false }] });
	assert.equal(applied.length, 1);
	await push({ ...first, activeId: "dark-berry" });
	assert.equal(applied.length, 2);
	assert.equal(applied[1]!.mode, "dark");
	await push({ ...first, activeId: null });
	assert.equal(applied[2], null);
	store.dispose();
	assert.equal(cancelled(), true);
});

test("原生默认配色清除数据色值，三模式独立应用并在恢复时撤下", async () => {
	const { store, applied, push } = fixture();
	store.start();
	const view = { skins: structuredClone([...PRESETS]), activeId: "dark-berry" };
	await push(view);
	for (const mode of ["system", "light", "dark"] as const) {
		await push({ ...view, activeId: `default-${mode}` });
		assert.deepEqual(applied.at(-1), { name: "Plume", mode });
	}
	const count = applied.length;
	await push({ ...view, activeId: "default-dark" });
	assert.equal(applied.length, count, "同一个默认模式不重复注册");
	await push({ ...view, activeId: null });
	assert.equal(applied.at(-1), null);
	store.dispose();
});

test("停用后延迟到达的广播不会重新注册皮肤", async () => {
	const { store, applied, push } = fixture();
	store.start();
	store.dispose();
	await push({ skins: structuredClone([...PRESETS]), activeId: "dark-teal" });
	assert.deepEqual(applied, []);
	assert.equal(store.active(), false);
});
