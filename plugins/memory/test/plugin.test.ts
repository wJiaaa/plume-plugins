import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HookLayer, ModelCompletion, ModelContext, PluginContext, PromptSection, SessionSummary } from "@plume/contract";
import type { MemoryApi } from "../src/api.ts";
import plugin from "../src/index.ts";
import { MIN_AGE_MS } from "../src/extract.ts";
import { projectDir } from "../src/paths.ts";
import { recordLesson } from "../src/project-memory.ts";

let dir: string;
let dispose: (() => void)[];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-memory-plugin-"));
	dispose = [];
});

afterEach(async () => {
	for (const stop of dispose) stop();
	vi.useRealTimers();
	await rm(dir, { recursive: true, force: true });
});

async function harness(
	options: {
		sessions?: SessionSummary[];
		complete?: (request: ModelCompletion) => Promise<string>;
		finished?: () => void;
	} = {},
) {
	let layer: HookLayer<"model.context"> | undefined;
	let reset: ((sessionId: string) => void) | undefined;
	let deleted: ((sessionId: string) => void) | undefined;
	let api: MemoryApi | undefined;
	const ctx = {
		dataDir: dir,
		locale: () => "zh-CN",
		tools: { register() {} },
		hook: (_name: string, value: HookLayer<"model.context">) => void (layer = value),
		serve: (value: MemoryApi) => void (api = value),
		effect: (stop: () => void) => void dispose.push(stop),
		log: { info: options.finished ?? (() => {}), warn: options.finished ?? (() => {}) },
		notice: options.finished ?? (() => {}),
		model: { complete: options.complete },
		sessions: {
			list: async () => options.sessions ?? [],
			messages: async () => Array.from({ length: 6 }, () => ({ role: "user", content: [{ type: "text", text: "这个流程需要先跑检查" }], timestamp: 0 })),
			onContextReset: (listener: (sessionId: string) => void) => {
				reset = listener;
				return () => {};
			},
			onDeleted: (listener: (sessionId: string) => void) => void (deleted = listener),
		},
	} as unknown as PluginContext;
	await plugin.apply(ctx);
	const context = (sessionId: string, sections: PromptSection[] = []) =>
		layer!({ sessionId, cwd: dir, sections, tools: [] } as unknown as ModelContext, async (value) => value);
	return {
		api: api!,
		context,
		reset: (sessionId: string) => reset!(sessionId),
		deleted: (sessionId: string) => deleted!(sessionId),
		async memory(sessionId: string) {
			return (await context(sessionId)).sections.map((section) => section.text).join("\n");
		},
	};
}

it("上下文重建和删除的订阅释放指定快照；设置里的编辑立即作用于所有会话", async () => {
	const host = await harness();
	await host.api.add("原有偏好");
	const first = await host.memory("s1");
	await host.memory("s2");
	await recordLesson(projectDir(dir, dir), { text: "先构建插件再跑检查" });
	expect(await host.memory("s1")).toBe(first);
	host.reset("s1");
	expect(await host.memory("s1")).toContain("先构建插件再跑检查");
	expect(await host.memory("s2")).toBe(first);
	host.deleted("s2");
	expect(await host.memory("s2")).toContain("先构建插件再跑检查");
	await host.api.add("更新偏好");
	expect(await host.memory("s1")).toContain("更新偏好");
	expect(await host.memory("s2")).toContain("更新偏好");
});

it("后台总结要求完整回复，拒绝后原样保留 MEMORY.md、learned.md 和读取游标", async () => {
	vi.useFakeTimers();
	const now = Date.now();
	const project = projectDir(dir, dir);
	await mkdir(project, { recursive: true });
	await writeFile(join(project, "MEMORY.md"), "- 原来的第一条\n- 截断后本来会丢掉的第二条\n");
	await writeFile(join(project, "learned.md"), "- 刻意记下的\n");
	await writeFile(join(project, ".cursor"), "1");
	let finish: (() => void) | undefined;
	const finished = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const complete = vi.fn(async () => {
		throw new Error("模型回复不完整");
	});
	const host = await harness({
		sessions: [{ id: "s1", title: "会话", kind: "top", project: "p1", cwd: dir, createdAt: 0, updatedAt: now - MIN_AGE_MS - 1, running: false }],
		complete,
		finished: () => finish!(),
	});
	await host.api.setSettings({ extraction: true });
	await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
	await finished;
	expect(complete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requireComplete: true, signal: expect.any(AbortSignal) }));
	expect(await readFile(join(project, "MEMORY.md"), "utf8")).toBe("- 原来的第一条\n- 截断后本来会丢掉的第二条\n");
	expect(await readFile(join(project, "learned.md"), "utf8")).toBe("- 刻意记下的\n");
	expect(await readFile(join(project, ".cursor"), "utf8")).toBe("1");
});

it("后台总结只跑最近在用的项目，等它空闲满 5 分钟：有会话在跑不算空闲，同一段空闲只跑一次", async () => {
	vi.useFakeTimers();
	const now = Date.now();
	const other = join(dir, "other");
	await mkdir(other);
	const old = now - MIN_AGE_MS - 1;
	const sessions: SessionSummary[] = [
		{ id: "s1", title: "正在跑", kind: "top", project: "p1", cwd: dir, createdAt: 0, updatedAt: now, running: true },
		{ id: "s0", title: "早先的", kind: "top", project: "p1", cwd: dir, createdAt: 0, updatedAt: old, running: false },
		{ id: "s2", title: "别的项目", kind: "top", project: "p2", cwd: other, createdAt: 0, updatedAt: old - 1, running: false },
	];
	let finish: (() => void) | undefined;
	const finished = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const complete = vi.fn(async () => "（没有）");
	const host = await harness({ sessions, complete, finished: () => finish!() });
	await host.api.setSettings({ extraction: true });
	await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
	// 在跑：等着，也不去跑别的项目。
	expect(complete).not.toHaveBeenCalled();

	sessions[0] = { ...sessions[0]!, running: false, updatedAt: Date.now() };
	await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
	expect(complete).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(60 * 1000);
	await finished;
	expect(complete).toHaveBeenCalledOnce();
	const prompt = (complete.mock.calls[0] as unknown as [ModelCompletion])[0].prompt;
	// 刚结束的那个还不满 12 小时，不读；别的项目的也不读。
	expect(prompt).toContain("## 会话 s0");
	expect(prompt).not.toContain("## 会话 s1");
	expect(prompt).not.toContain("## 会话 s2");
	await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
	expect(complete).toHaveBeenCalledOnce();
});

it("按类别认段：记忆插在项目指令（conventions）前面，后台总结的「当前指令」是全局（instructions）和项目指令的原文", async () => {
	vi.useFakeTimers();
	const old = Date.now() - MIN_AGE_MS - 1;
	const complete = vi.fn(async () => "（没有）");
	let finish: (() => void) | undefined;
	const finished = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const host = await harness({
		sessions: [{ id: "s0", title: "早先的", kind: "top", project: "p1", cwd: dir, createdAt: 0, updatedAt: old, running: false }],
		complete,
		finished: () => finish!(),
	});
	await host.api.add("偏好");
	const sections: PromptSection[] = [
		{ id: "guidelines", text: "准则", category: "guidelines" },
		{ id: "userInstructions", text: "<global>全局</global>", category: "instructions" },
		{ id: "projectInstructions", text: "<project>项目</project>", category: "conventions" },
		{ id: "workspace", text: "工作目录" },
	];
	const result = await host.context("s1", sections);
	expect(result.sections.map((section) => section.id)).toEqual(["guidelines", "userInstructions", "userMemory", "projectInstructions", "workspace"]);
	await host.api.setSettings({ extraction: true });
	await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
	await finished;
	const prompt = (complete.mock.calls[0] as unknown as [ModelCompletion])[0].prompt;
	expect(prompt).toContain("## 当前指令\n<global>全局</global>\n\n<project>项目</project>");
});
