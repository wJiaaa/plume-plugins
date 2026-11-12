import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message, PromptSection } from "@plume/contract";
import {
	acquireLock,
	extractMemory,
	findCandidates,
	isCandidate,
	MAX_SESSIONS,
	MIN_AGE_MS,
	PASS_INTERVAL_MS,
	renderSessions,
	runPass,
} from "../src/extract.ts";
import { createInjector, insertSections } from "../src/inject.ts";
import { readInjected, userInjectedFile } from "../src/injected.ts";
import {
	budgetMemory,
	forgetExtractedMemory,
	forgetLesson,
	projectMemorySection,
	MAX_LESSONS,
	parseLessons,
	readExtractedMemory,
	readLessons,
	recordLesson,
	redactSecrets,
	renderLessons,
	similar,
	writeLessons,
} from "../src/project-memory.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import { addMemoryEntry, clearAllMemory, formatMemoryForPrompt, loadMemory, memoryFile, removeMemoryEntry } from "../src/user-memory.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-memory-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const errors = { empty: "空的", unreadable: (file: string, reason: string) => `读不出 ${file}：${reason}` };

describe("教训", () => {
	it("新的在前；说同一件事的并成一条，换成新的措辞、挪到最前", async () => {
		expect(await recordLesson(dir, { text: "this repo uses pnpm, not npm" })).toEqual({ action: "added", total: 1 });
		expect(await recordLesson(dir, { text: "跑测试前先构建插件", context: "改了插件以后" })).toEqual({ action: "added", total: 2 });
		expect(await recordLesson(dir, { text: "use pnpm in this repo, never npm" })).toEqual({ action: "merged", total: 2 });
		const lessons = await readLessons(dir);
		expect(lessons.map((lesson) => lesson.text)).toEqual(["use pnpm in this repo, never npm", "跑测试前先构建插件"]);
		expect(lessons[1]?.context).toBe("改了插件以后");
	});

	it("并行记几条都落盘，最多留 100 条", async () => {
		await Promise.all(Array.from({ length: 5 }, (_, index) => recordLesson(dir, { text: `lesson ${"abcdefghij"[index]} unique${index}` })));
		expect(await readLessons(dir)).toHaveLength(5);
		await writeLessons(
			dir,
			Array.from({ length: MAX_LESSONS }, (_, index) => ({ text: `old${index} item${index}`, at: index + 1 })),
		);
		expect((await recordLesson(dir, { text: "brand new thing" })).total).toBe(MAX_LESSONS);
	});

	it("写进去之前把凭证换掉", async () => {
		await recordLesson(dir, { text: "key 是 sk-proj-abcdefghijklmnopqrstuv", context: "ghp_abcdefghijklmnopqrstuvwxyz" });
		const raw = await readFile(join(dir, "learned.md"), "utf8");
		expect(raw).not.toContain("sk-proj-abcdef");
		expect(raw).not.toContain("ghp_");
		expect(redactSecrets("AKIAABCDEFGHIJKLMNOP")).toBe("[已脱敏的凭证]");
	});

	it("按时间删一条；删不存在的答 false", async () => {
		await writeLessons(dir, [
			{ text: "a one", at: 2 },
			{ text: "b two", at: 1 },
		]);
		expect(await forgetLesson(dir, 2)).toBe(true);
		expect(await forgetLesson(dir, 2)).toBe(false);
		expect((await readLessons(dir)).map((lesson) => lesson.at)).toEqual([1]);
	});

	it("渲染和解析能来回；手写没时间戳的按文件修改时间记，按位置错开", async () => {
		const lessons = [
			{ text: "x", context: "y", at: 5 },
			{ text: "z", at: 4 },
		];
		expect(parseLessons(renderLessons(lessons))).toEqual(lessons);
		await writeFile(join(dir, "learned.md"), "- 手写一\n- 手写二\n  - 适用于：发版时\n");
		const when = new Date("2026-01-02T03:04:05Z");
		await utimes(join(dir, "learned.md"), when, when);
		expect(await readLessons(dir)).toEqual([
			{ text: "手写一", at: when.getTime() },
			{ text: "手写二", context: "发版时", at: when.getTime() - 1 },
		]);
	});

	it("相似按词的重合算，太短的词不算", () => {
		expect(similar("use pnpm not npm", "this repo uses pnpm not npm")).toBe(true);
		expect(similar("build the plugins first", "deploy on fridays")).toBe(false);
		expect(similar("a b", "a b")).toBe(false);
	});
});

describe("提示词里的段", () => {
	it("用户记忆：没有就是空的", () => {
		expect(formatMemoryForPrompt([])).toBe("");
		expect(formatMemoryForPrompt([{ id: "1", content: "喜欢 bun", createdAt: 0, updatedAt: 0 }])).toBe(
			"<user_memory>\nRelevant user preferences, facts, and persistent memory learned across sessions:\n- 喜欢 bun\n</user_memory>",
		);
	});

	it("项目记忆：每条标记下的日期，推断的接在后面、标明可信度低", () => {
		expect(projectMemorySection([], "  ")).toEqual({ text: "", files: [] });
		const at = new Date(2026, 10, 4, 9).getTime();
		const { text, files } = projectMemorySection(
			[
				{ text: "用 pnpm", context: "装依赖时", at },
				{ text: "手写的", at: 0 },
			],
			"- 改完要跑 check",
		);
		expect(text.startsWith("<project_memory>\n以前在这个项目里学到的")).toBe(true);
		expect(text).toContain(
			"- 用 pnpm（装依赖时） · 2026-11-04 记下\n- 手写的\n\n从过去的会话里推断出来的（可信度低于上面几条，与代码冲突时以代码为准）：\n- 改完要跑 check\n</project_memory>",
		);
		// 两截各算各的文件：推断的那截从它前面的空行起算 MEMORY.md。
		expect(files).toEqual([
			{ name: "learned.md", chars: text.indexOf("\n\n从过去的会话") },
			{ name: "MEMORY.md", chars: text.length - text.indexOf("\n\n从过去的会话") },
		]);
		const inferredOnly = projectMemorySection([], "- 只有推断的");
		expect(inferredOnly.text).toContain("用 `learn` 更新它。\n从过去的会话里推断出来的");
		expect(inferredOnly.files).toEqual([{ name: "MEMORY.md", chars: inferredOnly.text.length }]);
	});

	it("太长的截在 200 行以内，闭合标签还在", () => {
		const long = Array.from({ length: 300 }, (_, index) => `- line ${index}`).join("\n");
		expect(budgetMemory(long).split("\n").length).toBeLessThan(205);
		expect(projectMemorySection([], long).text.endsWith("</project_memory>")).toBe(true);
	});

	it("插在项目指令前面，没有时插在工作目录前面，都没有接在最后", () => {
		const extra = [{ id: "userMemory", text: "U" }];
		const ids = (sections: PromptSection[]) => insertSections(sections, extra).map((section) => section.id);
		expect(
			ids([
				{ id: "identity", text: "" },
				{ id: "projectInstructions", text: "" },
				{ id: "workspace", text: "" },
			]),
		).toEqual(["identity", "userMemory", "projectInstructions", "workspace"]);
		expect(
			ids([
				{ id: "identity", text: "" },
				{ id: "workspace", text: "" },
			]),
		).toEqual(["identity", "userMemory", "workspace"]);
		expect(ids([{ id: "identity", text: "" }])).toEqual(["identity", "userMemory"]);
	});

	it("一个会话里冻结；设置里改过以后重读；记下进过提示词的时间", async () => {
		const project = join(dir, "project");
		const injector = createInjector(dir);
		await addMemoryEntry(dir, "第一条", errors);
		const first = await injector.sections("s1", project, DEFAULT_SETTINGS);
		await addMemoryEntry(dir, "第二条", errors);
		await recordLesson(project, { text: "learned mid session" });
		expect(await injector.sections("s1", project, DEFAULT_SETTINGS)).toEqual(first);
		expect(first.map((section) => section.id)).toEqual(["userMemory"]);
		// 新会话读到新的；两段都标成记忆，上下文用量按类别认、不认段名。
		const second = await injector.sections("s2", project, DEFAULT_SETTINGS);
		expect(second.map((section) => [section.id, section.category])).toEqual([
			["userMemory", "memory"],
			["projectMemory", "memory"],
		]);
		injector.invalidate();
		const fresh = await injector.sections("s1", project, DEFAULT_SETTINGS);
		expect(fresh[0]?.text).toContain("第二条");
		// 开关换了就按新的读。
		expect(await injector.sections("s1", project, { ...DEFAULT_SETTINGS, user: false, project: false })).toEqual([]);
		expect(Object.keys(await readInjected(userInjectedFile(dir)))).toHaveLength(1);
	});

	it("刷新只影响指定会话，下次请求读入用户记忆、learn 和后台总结的变化", async () => {
		const project = join(dir, "project");
		const injector = createInjector(dir);
		await addMemoryEntry(dir, "原来的偏好", errors);
		const first = await injector.sections("s1", project, DEFAULT_SETTINGS);
		await injector.sections("s2", project, DEFAULT_SETTINGS);
		await addMemoryEntry(dir, "新的偏好", errors);
		await recordLesson(project, { text: "这个仓库要先构建插件" });
		await writeFile(join(project, "MEMORY.md"), "- 只在星期五发布\n");
		expect(await injector.sections("s1", project, DEFAULT_SETTINGS)).toEqual(first);

		injector.refresh("s1");
		const refreshed = await injector.sections("s1", project, DEFAULT_SETTINGS);
		expect(refreshed.find((section) => section.id === "userMemory")?.text).toContain("新的偏好");
		expect(refreshed.find((section) => section.id === "projectMemory")?.text).toContain("这个仓库要先构建插件");
		expect(refreshed.find((section) => section.id === "projectMemory")?.text).toContain("只在星期五发布");
		expect(await injector.sections("s2", project, DEFAULT_SETTINGS)).toEqual(first);

		await writeFile(join(project, "learned.md"), "- 手工改正后的教训\n");
		expect(await injector.sections("s1", project, DEFAULT_SETTINGS)).toEqual(refreshed);
		injector.refresh("s1");
		const edited = (await injector.sections("s1", project, DEFAULT_SETTINGS)).find((section) => section.id === "projectMemory")?.text;
		expect(edited).toContain("手工改正后的教训");
		expect(edited).not.toContain("这个仓库要先构建插件");
	});
});

describe("用户记忆", () => {
	it("加、删、清空；连着加几条都在", async () => {
		await Promise.all([addMemoryEntry(dir, " a ", errors), addMemoryEntry(dir, "b", errors)]);
		const entries = await loadMemory(dir);
		expect(entries.map((entry) => entry.content).sort()).toEqual(["a", "b"]);
		expect(await removeMemoryEntry(dir, entries[0]?.id ?? "", errors)).toBe(true);
		expect(await loadMemory(dir)).toHaveLength(1);
		await clearAllMemory(dir);
		expect(await loadMemory(dir)).toEqual([]);
		await expect(addMemoryEntry(dir, "  ", errors)).rejects.toThrow("空的");
	});

	it("文件坏了：注入当成空，写入停下、不覆盖", async () => {
		await writeFile(memoryFile(dir), "{坏的");
		expect(await loadMemory(dir)).toEqual([]);
		await expect(addMemoryEntry(dir, "新的", errors)).rejects.toThrow("读不出");
		expect(await readFile(memoryFile(dir), "utf8")).toBe("{坏的");
	});
});

const HOUR = 60 * 60 * 1000;
const NOW = new Date(2026, 10, 5, 12).getTime();
const say = (role: "user" | "assistant", text: string): Message =>
	role === "user"
		? { role, content: [{ type: "text", text }], timestamp: 0 }
		: {
				role,
				content: [{ type: "text", text }],
				api: "anthropic-messages",
				provider: "p",
				model: "m",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: 0,
			};
const talk = (count = 6) => Array.from({ length: count }, (_, index) => say(index % 2 ? "assistant" : "user", `第 ${index} 句`));

describe("后台总结的候选", () => {
	it("12 小时到 30 天之间、上次读过之后动过、没在跑的", () => {
		expect(isCandidate({ updatedAt: NOW - 13 * HOUR, running: false }, NOW)).toBe(true);
		expect(isCandidate({ updatedAt: NOW - 11 * HOUR, running: false }, NOW)).toBe(false);
		expect(isCandidate({ updatedAt: NOW - 31 * 24 * HOUR, running: false }, NOW)).toBe(false);
		expect(isCandidate({ updatedAt: NOW - 13 * HOUR, running: true }, NOW)).toBe(false);
		expect(isCandidate({ updatedAt: NOW - 13 * HOUR, running: false }, NOW, NOW - 13 * HOUR)).toBe(false);
	});

	it("少于 6 条消息的跳过，最多读 40 个，按年龄先筛再读消息", async () => {
		const sessions = Array.from({ length: 50 }, (_, index) => ({ id: `s${index}`, updatedAt: NOW - (13 + index) * HOUR, running: false }));
		sessions.unshift({ id: "young", updatedAt: NOW - HOUR, running: false });
		const read: string[] = [];
		const found = await findCandidates(
			sessions,
			async (id) => {
				read.push(id);
				return id === "s0" ? talk(2) : talk();
			},
			NOW,
		);
		expect(found).toHaveLength(MAX_SESSIONS);
		expect(found[0]?.id).toBe("s1");
		expect(read).not.toContain("young");
	});

	it("会话压成用户和助手的话，不带工具结果和 synthetic，先脱敏", () => {
		const messages: Message[] = [
			say("user", "token sk-abcdefghijklmnopqrstuvwx"),
			{ role: "user", content: [{ type: "text", text: "继续" }], timestamp: 0, synthetic: true },
			say("assistant", "好"),
		];
		expect(renderSessions([{ id: "a", updatedAt: 0, messages }])).toBe("## 会话 a\n用户：token [已脱敏的凭证]\n助手：好");
	});
});

describe("后台总结", () => {
	const candidates = [{ id: "a", updatedAt: NOW - 13 * HOUR, messages: talk() }];

	it("写下 MEMORY.md，读回来不带文件头；输入里有刻意记下的和上一版", async () => {
		await recordLesson(dir, { text: "刻意记下的那条" });
		await writeFile(join(dir, "MEMORY.md"), "# 从会话里总结的\n\n- 上一版的条目\n");
		let input = "";
		const result = await extractMemory(dir, { instructions: "<project_instructions>x</project_instructions>", candidates }, async (_system, prompt) => {
			input = prompt;
			return "- 改完要跑 pnpm check\n";
		});
		expect(result).toEqual({ memory: "- 改完要跑 pnpm check", sessions: 1, answered: true });
		expect(input).toContain("## 当前指令\n<project_instructions>x</project_instructions>");
		expect(input).toContain("## 刻意记下的条目\n- 刻意记下的那条");
		expect(input).toContain("## 上一版推断记忆\n- 上一版的条目");
		expect(await readExtractedMemory(dir)).toBe("- 改完要跑 pnpm check");
		expect(await stat(join(dir, ".lock")).catch(() => null)).toBeNull();
	});

	it("答「（没有）」时原样留着上一版，但算读过", async () => {
		await writeFile(join(dir, "MEMORY.md"), "- 旧的\n");
		const result = await extractMemory(dir, { instructions: "", candidates }, async () => "（没有）");
		expect(result).toMatchObject({ memory: "", answered: true });
		expect(await readExtractedMemory(dir)).toBe("- 旧的");
	});

	it("模型出错不写、不算读过；别人拿着锁时不跑", async () => {
		const failed = await extractMemory(dir, { instructions: "", candidates }, async () => {
			throw new Error("没有模型");
		});
		expect(failed.answered).toBeUndefined();
		expect(failed.skipped).toContain("没有模型");
		const release = await acquireLock(dir);
		expect(await acquireLock(dir)).toBeNull();
		expect((await extractMemory(dir, { instructions: "", candidates }, async () => "- x")).skipped).toBeDefined();
		await release?.();
	});

	it("丢掉 MEMORY.md 时游标一起丢，下次从头读", async () => {
		await writeFile(join(dir, "MEMORY.md"), "- x\n");
		await writeFile(join(dir, ".cursor"), "1");
		expect(await forgetExtractedMemory(dir)).toBe(true);
		expect(await stat(join(dir, ".cursor")).catch(() => null)).toBeNull();
		expect(await forgetExtractedMemory(dir)).toBe(false);
	});

	it("一天最多一次；读过了游标走到 12 小时前那条线，模型出错时不走", async () => {
		const sessions = [{ id: "a", updatedAt: NOW - 13 * HOUR, running: false }];
		const read = async () => talk();
		let calls = 0;
		const failing = async () => {
			calls += 1;
			throw new Error("x");
		};
		await runPass({ dir, sessions, read, instructions: "", complete: failing, now: NOW });
		expect(await stat(join(dir, ".cursor")).catch(() => null)).toBeNull();
		expect((await runPass({ dir, sessions, read, instructions: "", complete: failing, now: NOW + HOUR })).skipped).toBe("离上次不到一天");
		expect(calls).toBe(1);

		const later = NOW + PASS_INTERVAL_MS;
		const done = await runPass({ dir, sessions, read, instructions: "", complete: async () => "- 新的", now: later });
		expect(done.memory).toBe("- 新的");
		expect(await readFile(join(dir, ".cursor"), "utf8")).toBe(String(later - MIN_AGE_MS));
		// 游标之前的会话不再读。
		const again = await runPass({ dir, sessions, read, instructions: "", complete: async () => "- 不该到这里", now: later + PASS_INTERVAL_MS });
		expect(again.sessions).toBe(0);
	});
});
