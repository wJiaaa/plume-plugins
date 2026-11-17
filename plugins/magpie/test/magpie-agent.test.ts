/** 启用时写出 Magpie 用的 Agent 插件：路径指着这个插件的数据目录，Magpie 能加载；内容没变不重写。 */

import { access, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentFiles, writeAgent } from "../src/magpie-agent.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-magpie-agent-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("Magpie 用的 Agent 插件", () => {
	it("家目录下的路径写成 ~，指着这个插件的数据目录", () => {
		const script = agentFiles("/home/u/.plume/plugin-data/plume.magpie", "/home/u/.plume", "/home/u")["plume.agent.js"]!;
		expect(script).toContain('"dir": "~/.plume/plugin-data/plume.magpie"');
		expect(script).toContain('"config": "~/.plume/plugin-data/plume.magpie/credentials.json"');
		expect(script).toContain('"skills": "~/.plume/skills"');
		expect(agentFiles("/data/plume.magpie", "/data", "/home/u")["plume.agent.js"]).toContain('"dir": "/data/plume.magpie"');
	});

	it("写出来能当 ES 模块加载，connect 交回 Magpie 要写的键；再写一遍内容没变不重写", async () => {
		await mkdir(join(dir, "data", "magpie-agent"), { recursive: true });
		const agentDir = await writeAgent(join(dir, "data"), dir);
		expect(agentDir).toBe(join(dir, "data", "plume"));
		await expect(access(join(dir, "data", "magpie-agent"))).rejects.toThrow();
		expect(await readFile(join(agentDir, "README.md"), "utf8")).toMatch(/^# Plume\n/);
		expect(JSON.parse(await readFile(join(agentDir, "package.json"), "utf8")).magpie.agent).toBe("./plume.agent.js");
		const loaded = await import(join(agentDir, "plume.agent.js"));
		expect(loaded.agent).toMatchObject({ id: "plume", prefix: "magpie/", model: "defaultModel" });
		expect(loaded.agent.icon).toMatch(/^data:image\/png;base64,/);
		expect(Object.keys(loaded.connect({ gateway: { url: "u", key: "k" }, models: [] }))).toEqual(["magpie.baseUrl", "magpie.apiKey", "magpie.models"]);
		const before = (await stat(join(agentDir, "plume.agent.js"))).mtimeMs;
		await new Promise((resolve) => setTimeout(resolve, 20));
		await writeAgent(join(dir, "data"), dir);
		expect((await stat(join(agentDir, "plume.agent.js"))).mtimeMs).toBe(before);
	});
});
