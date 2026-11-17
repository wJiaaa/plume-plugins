import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookLayer, ModelContext, PluginContext, PromptSection } from "@plume/contract";
import { INSTRUCTIONS_CHAR_LIMIT, readInstructions, readMcpServers, withInstructions } from "../src/library.ts";
import plugin from "../src/index.ts";

let dir: string;
let dispose: (() => void)[];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-magpie-"));
	dispose = [];
});

afterEach(async () => {
	for (const stop of dispose) stop();
	await rm(dir, { recursive: true, force: true });
});

const log = () => {
	const warnings: string[] = [];
	return { warnings, warn: (message: string) => void warnings.push(message) };
};

describe("全局指令", () => {
	it("去掉 BOM；没有文件是空串、不留诊断；过长的只放开头", async () => {
		const sink = log();
		expect(await readInstructions(dir, sink)).toBe("");
		await writeFile(join(dir, "AGENTS.md"), "\uFEFF  共享规则  \n");
		expect(await readInstructions(dir, sink)).toBe("共享规则");
		expect(sink.warnings).toEqual([]);
		await writeFile(join(dir, "AGENTS.md"), "x".repeat(INSTRUCTIONS_CHAR_LIMIT + 10));
		expect((await readInstructions(dir, sink)).length).toBe(INSTRUCTIONS_CHAR_LIMIT);
		expect(sink.warnings).toHaveLength(1);
	});

	it("单独一段插在第一段项目约定前面；没有项目约定放在最后；没有指令不加", () => {
		const identity: PromptSection = { id: "a", text: "A", category: "identity" };
		const conventions: PromptSection = { id: "b", text: "B", category: "conventions" };
		const placed = withInstructions([identity, conventions], "共享规则");
		expect(placed.map((section) => section.id)).toEqual(["a", "magpieInstructions", "b"]);
		expect(placed[1]).toMatchObject({ category: "instructions" });
		expect(placed[1]?.text).toContain("共享规则");
		expect(withInstructions([identity], "共享规则").map((section) => section.id)).toEqual(["a", "magpieInstructions"]);
		expect(withInstructions([identity], "")).toEqual([identity]);
	});
});

describe("MCP 服务", () => {
	it("没有文件是空的一组；读不懂是 null，诊断里不转述原文", async () => {
		const sink = log();
		expect(await readMcpServers(dir, sink)).toEqual({});
		await writeFile(join(dir, "mcp.json"), "\uFEFF" + JSON.stringify({ mcpServers: { local: { command: "node" } } }));
		expect(await readMcpServers(dir, sink)).toEqual({ local: { command: "node" } });
		await writeFile(join(dir, "mcp.json"), '{"secret":"do-not-log",broken');
		expect(await readMcpServers(dir, sink)).toBeNull();
		await writeFile(join(dir, "mcp.json"), JSON.stringify({ mcpServers: [] }));
		expect(await readMcpServers(dir, sink)).toBeNull();
		expect(sink.warnings).toHaveLength(2);
		expect(sink.warnings.every((message) => !message.includes("do-not-log"))).toBe(true);
	});
});

describe("插件", () => {
	async function start() {
		const offers: [string, string, Record<string, unknown> | null][] = [];
		let layer: HookLayer<"model.context"> | undefined;
		await plugin.apply({
			name: "plume.magpie",
			dataDir: dir,
			log: { warn: () => {} },
			use: () => ({ offer: (owner: string, label: string, servers: Record<string, unknown> | null) => void offers.push([owner, label, servers]) }),
			hook: (_name: string, fn: HookLayer<"model.context">) => void (layer = fn),
			effect: (stop: () => void) => void dispose.push(stop),
			providers: { provide: () => {}, defaultModel: async () => undefined, setDefaultModel: async () => {} },
		} as unknown as PluginContext);
		return { offers, layer: () => layer! };
	}

	it("启动时登记一次；Magpie 改了、撤回了当场重登记", async () => {
		const { offers } = await start();
		await vi.waitFor(() => expect(offers).toEqual([["plume.magpie", "Magpie", {}]]));
		await writeFile(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { local: { command: "node" } } }));
		await vi.waitFor(() => expect(offers.at(-1)).toEqual(["plume.magpie", "Magpie", { local: { command: "node" } }]), { timeout: 5_000 });
		await rm(join(dir, "mcp.json"));
		await vi.waitFor(() => expect(offers.at(-1)).toEqual(["plume.magpie", "Magpie", {}]), { timeout: 5_000 });
	});

	it("每次调模型前现读全局指令，放在里层组好的项目约定前面", async () => {
		const { layer } = await start();
		const conventions: PromptSection = { id: "project", text: "P", category: "conventions" };
		const run = () => layer()({ sections: [] } as unknown as ModelContext, async (input) => ({ ...input, sections: [...input.sections, conventions] }));
		expect((await run()).sections).toEqual([conventions]);
		await writeFile(join(dir, "AGENTS.md"), "共享规则");
		expect((await run()).sections.map((section) => section.id)).toEqual(["magpieInstructions", "project"]);
	});
});
