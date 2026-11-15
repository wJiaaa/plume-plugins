import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Locale, ModelCompletion, PluginContext } from "@plume/contract";
import type { WelcomeApi } from "../src/api.ts";
import plugin from "../src/index.ts";

let dir: string;
let dispose: (() => void)[];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-welcome-plugin-"));
	dispose = [];
});

afterEach(async () => {
	for (const stop of dispose) stop();
	await rm(dir, { recursive: true, force: true });
});

it.each<[string, string | Error, Locale, string]>([
	["空回复", "", "zh-CN", "模型回复中没有可显示的正文"],
	["清洗后没有正文", "<think>想想</think>", "zh-CN", "模型回复中没有可显示的正文"],
	["中文正文过长", "一".repeat(41), "zh-CN", "模型回复的正文过长（41 字符，上限 40）"],
	["英文正文过长", "a".repeat(111), "en", "模型回复的正文过长（111 字符，上限 110）"],
	["模型拒绝不完整回复", new Error("模型回复未完整结束（length）"), "zh-CN", "模型回复未完整结束（length）"],
])("%s：记录原因、保留旧文件，下次重试成功后才缓存", async (_name, reply, locale, reason) => {
	const file = join(dir, "line.json");
	const previous = JSON.stringify({ date: "2000-01-01", lines: { "zh-CN": { text: "昨天的话。" } }, recent: ["昨天的话。"] });
	await writeFile(file, previous);
	const complete = vi.fn<(request: ModelCompletion) => Promise<string>>();
	if (reply instanceof Error) complete.mockRejectedValueOnce(reply);
	else complete.mockResolvedValueOnce(reply);
	complete.mockResolvedValue("Clear is better than clever.\nRob Pike");
	const warn = vi.fn();
	let api: WelcomeApi | undefined;
	await plugin.apply({
		dataDir: dir,
		effect: (stop: () => void) => void dispose.push(stop),
		serve: (value: WelcomeApi) => void (api = value),
		model: { complete },
		log: { warn },
	} as unknown as PluginContext);

	expect(await api!.today(locale)).toBeUndefined();
	expect(complete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requireComplete: true, signal: expect.any(AbortSignal) }));
	expect(warn).toHaveBeenCalledExactlyOnceWith(`写今日一句失败：${reason}`);
	expect(await readFile(file, "utf8")).toBe(previous);

	const line = { text: "Clear is better than clever.", source: "Rob Pike" };
	expect(await api!.today(locale)).toEqual(line);
	expect(JSON.parse(await readFile(file, "utf8")).lines[locale]).toEqual(line);
	expect(await api!.today(locale)).toEqual(line);
	expect(complete).toHaveBeenCalledTimes(2);
	expect(warn).toHaveBeenCalledOnce();
});
