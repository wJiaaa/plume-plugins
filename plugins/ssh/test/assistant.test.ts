/**
 * 运维助手的一段是插件的独立会话，智能标题不给它起名：第一句够长时自己让模型起一句，短的留宿主默认的开头。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginContext } from "@plume/contract";
import { afterEach, describe, expect, it } from "vitest";
import { Assistant } from "../src/assistant.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(reply: string) {
	const dir = mkdtempSync(join(tmpdir(), "plume-ssh-assistant-"));
	dirs.push(dir);
	const prompts: string[] = [];
	const titles: Array<{ sessionId: string; title: string; automatic?: boolean }> = [];
	let named: () => void = () => {};
	const done = new Promise<void>((resolve) => (named = resolve));
	const ctx = {
		name: "plume.ssh",
		dataDir: dir,
		log: { warn: () => {} },
		model: {
			complete: async ({ prompt }: { prompt: string }) => {
				prompts.push(prompt);
				return reply;
			},
		},
		sessions: {
			list: async () => [],
			onDeleted: () => {},
			observe: () => {},
			create: async () => ({ id: "seg-1" }),
			send: async () => {},
			setTitle: async (sessionId: string, title: string, options?: { automatic?: boolean }) => {
				titles.push({ sessionId, title, automatic: options?.automatic });
				named();
			},
		},
	} as unknown as PluginContext;
	return { assistant: new Assistant(ctx, () => {}), prompts, titles, done };
}

describe("运维助手的名字", () => {
	it("一段的第一句够长时让模型起名，洗掉前缀和结尾标点，按自动起的名写回", async () => {
		const f = setup("标题：排查磁盘占满。");
		await f.assistant.ask("看看这台服务器为什么磁盘满了，顺便看看 nginx 日志");
		await f.done;
		expect(f.prompts[0]).toContain("看看这台服务器为什么磁盘满了");
		expect(f.titles).toEqual([{ sessionId: "seg-1", title: "排查磁盘占满", automatic: true }]);
		// 同一段里接着说不再起名。
		await f.assistant.ask("再看看内存，这一句也够长了吧还要再长一点");
		expect(f.prompts).toHaveLength(1);
	});

	it("短的第一句不花模型调用", async () => {
		const f = setup("不该用上");
		await f.assistant.ask("磁盘满了");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(f.prompts).toEqual([]);
		expect(f.titles).toEqual([]);
	});
});
