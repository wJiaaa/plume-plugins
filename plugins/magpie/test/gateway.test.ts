/**
 * Magpie 的网关变成 Plume 的供应商：Magpie 写的形状怎么读、设置页的改和删怎么写回 `credentials.json`、
 * Magpie 选的模型怎么变成 Plume 的默认模型，断开时怎么换回来。
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRef, PluginContext, PluginProvider, ProviderSource } from "@plume/contract";
import { magpieGateway, magpieProvider } from "../src/gateway.ts";
import plugin from "../src/index.ts";

let dir: string;
let dispose: (() => void)[];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-magpie-gateway-"));
	dispose = [];
});

afterEach(async () => {
	for (const stop of dispose) stop();
	await rm(dir, { recursive: true, force: true });
});

const file = () => join(dir, "credentials.json");
const stored = async () => JSON.parse(await readFile(file(), "utf8")) as Record<string, unknown>;
const gateway = {
	baseUrl: "http://127.0.0.1:3425",
	apiKey: "magpie-plume",
	models: [{ id: "group/gpt-x", name: "GPT X", context: 400_000, efforts: ["none", "low", "high"] }],
};

/** 插件跑在一个假的本体上：默认模型是 `host.defaultModel`，设的时候和本体一样按现有的供应商校验。 */
async function start(host: { defaultModel?: ModelRef }) {
	let source: ProviderSource | undefined;
	const setDefaultModel = vi.fn(async (model: ModelRef) => {
		const [providerId, modelId] = [model.slice(0, model.indexOf("/")), model.slice(model.indexOf("/") + 1)];
		const found = source?.list().find((provider) => provider.id === providerId);
		if (!found?.models.some((entry) => entry.modelId === modelId) && providerId === "magpie") throw new Error(`没有模型 ${model}`);
		host.defaultModel = model;
	});
	await plugin.apply({
		name: "plume.magpie",
		dataDir: dir,
		log: { warn: () => {} },
		use: () => ({ offer: () => {} }),
		hook: () => {},
		effect: (stop: () => void) => void dispose.push(stop),
		providers: { provide: (next: ProviderSource) => void (source = next), defaultModel: async () => host.defaultModel, setDefaultModel },
	} as unknown as PluginContext);
	return { source: source!, setDefaultModel };
}

describe("Magpie 写的形状", () => {
	it("不完整就是没接；档位 none 是关闭，默认档落在中间；不知道的上限按新建模型的默认值", () => {
		expect(magpieProvider({})).toBeUndefined();
		expect(magpieProvider({ magpie: {} })).toBeUndefined();
		expect(magpieProvider({ magpie: { baseUrl: "http://x" } })).toBeUndefined();
		const provider = magpieProvider({ magpie: { ...gateway, models: [...gateway.models, { id: "plain" }, { name: "没 id" }] } })!;
		expect(provider).toMatchObject({ id: "magpie", name: "Magpie", api: "openai-responses", enabled: true, apiKey: "magpie-plume" });
		const [gpt, plain] = provider.models;
		expect(provider.models).toHaveLength(2);
		expect(gpt).toMatchObject({ modelId: "group/gpt-x", name: "GPT X", contextWindow: 400_000, maxOutputTokens: 32_000, supportsThinking: true });
		expect(gpt?.thinkingOptions?.map(({ id, isDefault }) => [id, isDefault ?? false])).toEqual([
			["off", false],
			["low", false],
			["high", true],
		]);
		expect(plain).toMatchObject({ modelId: "plain", name: "plain", contextWindow: 200_000 });
		expect(plain?.thinkingOptions).toBeUndefined();
	});

	it("写回时换成 Magpie 的字段名；手填的价格留着，按模型目录补的不存", () => {
		const provider = magpieProvider({ magpie: gateway })!;
		const [model] = provider.models;
		const edited: PluginProvider = {
			...provider,
			name: "公司网关",
			models: [
				{ ...model!, contextWindow: 500_000, pricing: { input: 3, output: 15, source: "catalog" } },
				{ ...model!, modelId: "manual", pricing: { input: 1, output: 2, source: "manual" } },
			],
		};
		const back = magpieGateway(edited);
		expect(back).toMatchObject({ name: "公司网关", baseUrl: gateway.baseUrl, apiKey: "magpie-plume" });
		expect(back.models[0]).toMatchObject({ id: "group/gpt-x", context: 500_000 });
		expect(back.models[0]).not.toHaveProperty("pricing");
		expect(back.models[1]?.pricing).toEqual({ input: 1, output: 2, source: "manual" });
		expect(magpieProvider({ magpie: back })?.models[0]?.contextWindow).toBe(500_000);
	});
});

describe("插件的供应商", () => {
	it("启用时建好只给本人读写的空文件；Magpie 写了网关当场出现", async () => {
		const { source } = await start({});
		expect((await stat(file())).mode & 0o777).toBe(0o600);
		expect(source.list()).toEqual([]);
		await writeFile(file(), JSON.stringify({ magpie: gateway }));
		await vi.waitFor(() => expect(source.list().map((provider) => provider.id)).toEqual(["magpie"]), { timeout: 5_000 });
	});

	it("设置页的改写回 magpie 块、别的键不动；删除只拿掉 magpie 块", async () => {
		await writeFile(file(), JSON.stringify({ magpie: gateway, defaultModel: "magpie/group/gpt-x", other: 1 }), { mode: 0o600 });
		const { source } = await start({});
		await source.save({ ...source.list()[0]!, name: "改过的" });
		expect(await stored()).toMatchObject({ magpie: { name: "改过的", apiKey: "magpie-plume" }, defaultModel: "magpie/group/gpt-x", other: 1 });
		expect(source.list()[0]?.name).toBe("改过的");
		await source.remove("magpie");
		expect(await stored()).toEqual({ defaultModel: "magpie/group/gpt-x", other: 1 });
		expect(source.list()).toEqual([]);
		expect((await stat(file())).mode & 0o777).toBe(0o600);
	});
});

describe("默认模型", () => {
	it("Magpie 选了模型就设成默认；断开时换回原来的", async () => {
		const host: { defaultModel?: ModelRef } = { defaultModel: "p-own/m1" };
		await writeFile(file(), JSON.stringify({ magpie: gateway, defaultModel: "magpie/group/gpt-x" }));
		await start(host);
		expect(host.defaultModel).toBe("magpie/group/gpt-x");
		// Magpie 断开：逐键恢复，`magpie` 留成 `{}`、`defaultModel` 删掉。
		await writeFile(file(), JSON.stringify({ magpie: {} }));
		await vi.waitFor(() => expect(host.defaultModel).toBe("p-own/m1"), { timeout: 5_000 });
	});

	it("重启时 Magpie 没改过就不动人后来在 Plume 里选的；断开时人另选过的也不换回", async () => {
		const host: { defaultModel?: ModelRef } = { defaultModel: "p-own/m1" };
		await writeFile(file(), JSON.stringify({ magpie: gateway, defaultModel: "magpie/group/gpt-x" }));
		await start(host);
		for (const stop of dispose.splice(0)) stop();
		host.defaultModel = "p-own/m2";
		const { setDefaultModel } = await start(host);
		expect(setDefaultModel).not.toHaveBeenCalled();
		expect(host.defaultModel).toBe("p-own/m2");
		await writeFile(file(), JSON.stringify({ magpie: {} }));
		await vi.waitFor(async () => expect(JSON.parse(await readFile(join(dir, "default-model.json"), "utf8"))).toEqual({}), { timeout: 5_000 });
		expect(host.defaultModel).toBe("p-own/m2");
		expect(setDefaultModel).not.toHaveBeenCalled();
	});

	it("Plume 关着时 Magpie 换了模型，启动时跟上；设不上的不记、下次再试", async () => {
		const host: { defaultModel?: ModelRef } = { defaultModel: "p-own/m1" };
		await writeFile(file(), JSON.stringify({ magpie: gateway, defaultModel: "magpie/none" }));
		await start(host);
		expect(host.defaultModel).toBe("p-own/m1");
		for (const stop of dispose.splice(0)) stop();
		await writeFile(file(), JSON.stringify({ magpie: gateway, defaultModel: "magpie/group/gpt-x" }));
		await start(host);
		expect(host.defaultModel).toBe("magpie/group/gpt-x");
		expect(JSON.parse(await readFile(join(dir, "default-model.json"), "utf8"))).toEqual({ applied: "magpie/group/gpt-x", previous: "p-own/m1" });
	});
});
