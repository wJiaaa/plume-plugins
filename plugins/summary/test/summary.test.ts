/**
 * 会话摘要：材料（只要人和 agent 说的话、够数才要、有上一份时只给之后的）、清理模型的回复、一轮结束静下来才生成，和存取。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import type { AssistantMessage, Message } from "@plume/contract";
import { SummaryStore } from "../src/store.ts";
import { cleanSessionSummary, lastSpoken, SUMMARY_MAX_CHARS, summarizeAfterTurn, summaryMaterial } from "../src/summary.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (timestamp: number, text: string, synthetic = false): Message => ({
	role: "user",
	timestamp,
	content: [{ type: "text", text }],
	...(synthetic ? { synthetic } : {}),
});
const assistant = (timestamp: number, content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant",
	content,
	api: "anthropic-messages",
	provider: "p",
	model: "m",
	usage,
	stopReason: "stop",
	timestamp,
});

it("摘要材料：只要人和 agent 说的话，工具调用里只捡改动过的文件；有上一份时只给之后的", () => {
	const messages: Message[] = [
		user(-2, "先看看列表"),
		user(-1, "再看看详情"),
		user(1, "修一下滚动位置"),
		assistant(2, [
			{ type: "toolCall", id: "a", name: "edit", arguments: { path: "src/scroll.ts" } },
			{ type: "toolCall", id: "b", name: "read", arguments: { path: "src/other.ts" } },
		]),
		{ role: "toolResult", toolCallId: "a", toolName: "edit", content: [{ type: "text", text: "工具输出不该进材料" }], isError: false, timestamp: 3 },
		assistant(4, [{ type: "text", text: "改成按锚点恢复了" }]),
		user(5, "运行时插进来的", true),
	];
	const material = summaryMaterial(messages);
	expect(material?.upto).toBe(4);
	expect(material?.prompt).toMatch(/\[用户\] 修一下滚动位置\n\[agent\] 改成按锚点恢复了/);
	expect(material?.prompt).toMatch(/src\/scroll\.ts/);
	expect(material?.prompt).not.toMatch(/src\/other\.ts|工具输出|运行时插进来的/);
	expect(lastSpoken(messages)).toBe(4);
	expect(summaryMaterial(messages, { text: "x", upto: 4 })).toBeNull();
	// 人说得不够多就不要：两句不够。
	expect(summaryMaterial([user(1, "一"), user(2, "二")])).toBeNull();
});

it("摘要清理：去前缀、引号、换行，超长截到卡片放得下", () => {
	expect(cleanSessionSummary("摘要：「在修滚动。\n下一步提交。」")).toBe("在修滚动。 下一步提交。");
	expect(cleanSessionSummary("<think>想想</think>```\nRecap: done\n```")).toBe("done");
	const long = cleanSessionSummary("字".repeat(400));
	expect([...long]).toHaveLength(SUMMARY_MAX_CHARS);
});

it("摘要：一轮结束、静够了才要；下一轮开始了就撤掉，到点时还在跑也不要", async () => {
	const idle = 40;
	const ran: string[] = [];
	const after = summarizeAfterTurn({ busy: (id) => id === "busy", run: async (id) => void ran.push(id), idleMs: idle });
	after.observe("a", false);
	await sleep(idle / 2);
	after.observe("a", true);
	after.observe("b", false);
	after.observe("busy", false);
	await sleep(idle * 2);
	expect(ran).toEqual(["b"]);
	after.observe("a", false);
	await sleep(idle * 2);
	expect(ran).toEqual(["b", "a"]);
	after.dispose();
});

it("摘要一个会话一个文件，删会话时删掉；会话 id 走不出目录", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-summary-"));
	dirs.push(dir);
	const store = new SummaryStore(dir);
	expect(await store.read("a")).toBeNull();
	await store.save("a", { text: "一", upto: 1, updatedAt: 10 });
	await store.save("a", { text: "二", upto: 2, updatedAt: 20 });
	expect(await store.read("a")).toEqual({ text: "二", upto: 2, updatedAt: 20 });
	await store.remove("a");
	expect(await store.read("a")).toBeNull();
	await expect(store.read("../a")).rejects.toThrow(/Invalid session id/);
});
