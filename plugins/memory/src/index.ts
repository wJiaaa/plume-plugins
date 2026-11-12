/**
 * plume.memory 的逻辑入口，跑在 agent 进程。
 *
 * - 用户记忆、项目记忆经 `model.context` 各插一段系统提示词，每个会话冻结一份（见 inject.ts）；项目记忆关着时对模型藏起 `learn`。
 * - `learn` 把教训记进这个项目的 `learned.md`（见 project-memory.ts）。
 * - 后台总结（见 extract.ts）：开了以后，最近在用的那个项目空闲满 5 分钟（没有会话在跑）就跑一次，同一个项目一天最多一次；写了东西才弹一条提示。
 * - 设置分区经 `ctx.serve` 读写（接口见 api.ts）。
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "@plume/contract";
import type { LessonView, MemoryApi, ProjectMemoryView } from "./api.ts";
import { runPass } from "./extract.ts";
import { readText, writeAtomic } from "./files.ts";
import { createInjector, insertSections } from "./inject.ts";
import { EXTRACTED_KEY, projectInjectedFile, readInjected, userInjectedFile } from "./injected.ts";
import { learnTool } from "./learn.ts";
import { MESSAGES } from "./messages.ts";
import { memoryHome, projectDir } from "./paths.ts";
import { forgetAllLessons, forgetExtractedMemory, forgetLesson, readExtractedMemory, readLessons } from "./project-memory.ts";
import { createSettings } from "./settings.ts";
import { addMemoryEntry, clearAllMemory, loadMemory, removeMemoryEntry } from "./user-memory.ts";

/** 一轮结束（或刚加载）之后，等多久算「空闲」：人多半还会接着说，别在他两句话之间跑。 */
const IDLE_MS = 5 * 60 * 1000;
/** 多久看一眼空闲没有。只读会话摘要，真正跑不跑由空闲和每个项目的一天一次决定。 */
const POLL_MS = 60 * 1000;

export default {
	name: "plume.memory",
	async apply(ctx) {
		const { dataDir } = ctx;
		const settings = await createSettings(dataDir);
		const injector = createInjector(dataDir);
		ctx.sessions.onContextReset(injector.refresh);
		ctx.sessions.onDeleted(injector.refresh);
		/**
		 * 每个项目最近一次请求里的指令段（项目指令、全局指令）原文。后台总结拿它告诉模型哪些已经每轮都在、不用再记；
		 * 只在内存里：重启以后这个项目跑过一轮才有，没有时总结的输入里这一项是空的。
		 */
		const instructions = new Map<string, string>();
		const errors = () => ({ empty: MESSAGES[ctx.locale()].emptyContent, unreadable: MESSAGES[ctx.locale()].unreadable });

		/** 这个工作目录的记忆目录；写之前调，好让设置里列得出这个项目。 */
		async function projectFor(cwd: string): Promise<string> {
			const home = memoryHome(cwd);
			const dir = projectDir(dataDir, home);
			if ((await readText(join(dir, "project.json")).catch(() => null)) === null) await writeAtomic(join(dir, "project.json"), JSON.stringify({ path: home }));
			return dir;
		}

		ctx.tools.register(learnTool({ enabled: () => settings.get().project, projectDir: projectFor }));

		ctx.hook("model.context", async (input, next) => {
			const current = settings.get();
			const dir = projectDir(dataDir, memoryHome(input.cwd));
			// 人写的指令按类别（`PromptSection.category`）认：全局的 `instructions`，项目里的 `conventions`。
			const said = input.sections.filter((section) => section.category === "instructions" || section.category === "conventions").map((section) => section.text);
			instructions.set(dir, said.join("\n\n"));
			const extra = await injector.sections(input.sessionId, dir, current);
			return next({
				...input,
				sections: insertSections(input.sections, extra),
				// 隐藏不等于禁用：执行时 `learn` 自己再看一次开关。
				tools: current.project ? input.tools : input.tools.filter((tool) => tool.name !== "learn"),
			});
		});

		/** 设置里可选的项目：开在项目里的会话的目录，加上已经存了记忆的目录，最近用过的在前。 */
		async function projects(): Promise<string[]> {
			const seen = new Map<string, number>();
			for (const session of await ctx.sessions.list()) {
				if (!session.project) continue;
				const home = memoryHome(session.cwd);
				seen.set(home, Math.max(seen.get(home) ?? 0, session.updatedAt));
			}
			const root = join(dataDir, "projects");
			for (const name of await readdir(root).catch(() => [])) {
				const path = await readText(join(root, name, "project.json"))
					.then((raw) => (raw === null ? undefined : (JSON.parse(raw) as { path?: unknown }).path))
					.catch(() => undefined);
				if (typeof path === "string" && !seen.has(path)) seen.set(path, 0);
			}
			return [...seen].sort((a, b) => b[1] - a[1]).map(([path]) => path);
		}

		async function projectMemory(path: string): Promise<ProjectMemoryView> {
			const dir = projectDir(dataDir, path);
			const [lessons, extracted, injected, modified] = await Promise.all([
				readLessons(dir),
				readExtractedMemory(dir),
				readInjected(projectInjectedFile(dir)),
				stat(join(dir, "MEMORY.md"))
					.then((info) => info.mtimeMs)
					.catch(() => undefined),
			]);
			const view: LessonView[] = lessons.map((lesson) => ({
				...lesson,
				...(injected[lesson.text] === undefined ? {} : { lastInjectedAt: injected[lesson.text] }),
			}));
			return {
				lessons: view,
				...(extracted
					? {
							extracted: {
								text: extracted,
								...(modified === undefined ? {} : { updatedAt: Math.floor(modified) }),
								...(injected[EXTRACTED_KEY] === undefined ? {} : { lastInjectedAt: injected[EXTRACTED_KEY] }),
							},
						}
					: {}),
			};
		}

		/** 人在设置里改了记忆或开关，之后作废快照：他要的是改动从下一次请求起就生效。 */
		const edited = <T>(result: T): T => {
			injector.invalidate();
			return result;
		};

		const api: MemoryApi = {
			settings: async () => settings.get(),
			setSettings: async (change) => edited(await settings.set(change)),
			model: async () => settings.model(),
			setModel: (model) => settings.setModel(model),
			async list() {
				const [entries, injected] = await Promise.all([loadMemory(dataDir), readInjected(userInjectedFile(dataDir))]);
				return entries.map((entry) => (injected[entry.id] === undefined ? entry : { ...entry, lastInjectedAt: injected[entry.id] }));
			},
			add: async (content) => edited(await addMemoryEntry(dataDir, content, errors())),
			remove: async (id) => edited(await removeMemoryEntry(dataDir, id, errors())),
			clear: async () => edited(await clearAllMemory(dataDir)),
			projects,
			projectMemory,
			forgetLesson: async (path, at) => edited(await forgetLesson(projectDir(dataDir, path), at)),
			forgetExtracted: async (path) => edited(await forgetExtractedMemory(projectDir(dataDir, path))),
			async forgetAll(path) {
				const dir = projectDir(dataDir, path);
				await forgetAllLessons(dir);
				await forgetExtractedMemory(dir);
				edited(undefined);
			},
		};
		ctx.serve(api);

		const stop = new AbortController();
		const loadedAt = Date.now();
		let busy = false;
		/** 已经为哪一段空闲跑过（项目和它空闲起的那一刻）：同一段空闲只跑一次，有了新动静才再跑。 */
		let handled = "";
		/**
		 * 最近在用的那个项目空闲满 5 分钟就跑它。只看它，不轮一遍所有项目：问的是「人刚才在干的这个项目，历史会话里有没有值得记的」，
		 * 别的项目等人回到那里再说。「最近在用」是最近有动静的、开在项目里的会话所在的项目。
		 */
		async function check(): Promise<void> {
			const current = settings.get();
			if (busy || !current.project || !current.extraction) return;
			busy = true;
			try {
				const all = await ctx.sessions.list();
				// 只总结开在项目里的会话：不属于项目的聊天共用一个目录，话题各不相干，总结不出「这个仓库」的约定。
				const latest = all.find((session) => session.project && session.kind === "top");
				if (!latest) return;
				const homes = new Map<string, string>();
				const homeOf = (cwd: string) => homes.get(cwd) ?? homes.set(cwd, memoryHome(cwd)).get(cwd)!;
				const home = homeOf(latest.cwd);
				const mine = all.filter((session) => session.project && homeOf(session.cwd) === home);
				// 有会话在跑（子会话也算）就不是空闲：人还在这个项目里干活。
				if (mine.some((session) => session.running)) return;
				const idleSince = Math.max(loadedAt, ...mine.map((session) => session.updatedAt));
				if (Date.now() - idleSince < IDLE_MS || handled === `${home}\0${idleSince}`) return;
				handled = `${home}\0${idleSince}`;
				const dir = await projectFor(home);
				// 子会话（侧边聊天、子 Agent）是挂在会话下面的支线，读父会话就够了；插件的独立会话不是人在这个项目里的对话。
				const sessions = mine.filter((session) => session.kind === "top");
				const result = await runPass({
					dir,
					sessions,
					read: (sessionId) => ctx.sessions.messages(sessionId),
					instructions: instructions.get(dir) ?? "",
					complete: (systemPrompt, prompt) => {
						const model = settings.model();
						return ctx.model.complete({ systemPrompt, prompt, ...(model ? { model } : {}), requireComplete: true, signal: stop.signal });
					},
				});
				// 只有真写了东西才说：「这几次会话里没什么值得记的」是最常见的正确结果，报出来就是每天一条关于什么都没发生的提示。
				if (result.memory) ctx.notice(latest.id, MESSAGES[ctx.locale()].passUpdated(result.sessions));
				else if (result.skipped && result.sessions > 0) ctx.log.info(`${home}：${result.skipped}`);
			} catch (error) {
				ctx.log.warn(`后台总结出错：${error instanceof Error ? error.message : String(error)}`);
			} finally {
				busy = false;
			}
		}
		const timer = setInterval(() => void check(), POLL_MS);
		timer.unref?.();
		ctx.effect(() => {
			clearInterval(timer);
			stop.abort();
		});
	},
} satisfies Plugin;
