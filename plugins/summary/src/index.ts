/**
 * plume.summary 的逻辑入口，跑在 agent 进程：每轮结束、静下来一分钟后，让模型把会话写成一段摘要，存在插件数据目录。
 *
 * 什么时候生成跟着运行状态走（`ctx.sessions.observe` 的 `running`），不管环境卡片开没开：花钱只跟「这个会话刚干完一段活」走，
 * 翻旧会话只读存着的那份。做成单独的插件，是因为它会在后台调模型：要不要这笔花销，按装不装来选。
 *
 * 用哪个模型在设置 › 智能体 › 会话里选，存在 `settings.json`；没选就用这个会话自己的模型。调模型时不带 `sessionId`：
 * 花销记在会话之外，会话的用量不因为一份摘要跟着变。
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "@plume/contract";
import type { StoredSummary, SummaryApi, SummaryState } from "./api.ts";
import { SummaryStore } from "./store.ts";
import { cleanSessionSummary, SUMMARY_MAX_TOKENS, SUMMARY_SYSTEM, SUMMARY_TIMEOUT_MS, summarizeAfterTurn, summaryMaterial } from "./summary.ts";

export default {
	name: "plume.summary",
	// 侧栏里的每个会话一轮干完都可能要写摘要，得知道每个会话什么时候在跑：要看全部会话。
	observe: "all",
	async apply(ctx) {
		const store = new SummaryStore(ctx.dataDir);
		const lifecycle = new AbortController();
		ctx.effect(() => lifecycle.abort());

		const settingsFile = join(ctx.dataDir, "settings.json");
		const saved = await readFile(settingsFile, "utf8").then(
			(text) => (JSON.parse(text) as { model?: unknown }).model,
			() => undefined,
		);
		let chosenModel = typeof saved === "string" ? saved : undefined;
		let writing: Promise<void> = Promise.resolve();

		/** 正在跑的会话：到点时它已经接上下一轮就不要。 */
		const running = new Set<string>();
		/** 后台正在生成、上一次失败的原因；只在这次运行里记，重启后从存着的那份开始。 */
		const states = new Map<string, { pending: boolean; error?: string }>();
		const inFlight = new Map<string, Promise<SummaryState>>();
		/** 界面上在看的：每次变了叫它们一声，它们自己重读。 */
		const watchers = new Map<string, Set<() => void>>();
		const changed = (id: string) => {
			for (const wake of watchers.get(id) ?? []) wake();
		};
		const stateOf = async (id: string): Promise<SummaryState> => ({ summary: await store.read(id), pending: false, ...states.get(id) });

		async function generate(id: string): Promise<StoredSummary | null> {
			const previous = await store.read(id);
			const meta = await ctx.sessions.get(id);
			// 只给侧栏里的会话写：子会话（子 Agent、侧边聊天）和插件的独立会话没有环境卡片，不为它们花钱。
			if (!meta || meta.kind !== "top") return previous;
			const tools = ctx.tools.list();
			const material = summaryMaterial(await ctx.sessions.messages(id), (name) => tools.find((tool) => tool.name === name)?.kind, previous);
			// 没有新材料：不发请求，原来那份就是答案。
			if (!material) return previous;
			// 选的模型、会话记着的模型已经不在了就往下退，都不在就用默认模型。
			const models = await ctx.sessions.models();
			const model = [chosenModel, meta.model].find((ref) => ref && models.some((entry) => entry.id === ref));
			const reply = await ctx.model.complete({
				systemPrompt: SUMMARY_SYSTEM,
				prompt: material.prompt,
				...(model ? { model } : {}),
				maxTokens: SUMMARY_MAX_TOKENS,
				signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(SUMMARY_TIMEOUT_MS)]),
			});
			const text = cleanSessionSummary(reply);
			// 回了空话：上一份还在就留着它，只往后挪「覆盖到哪」，免得同一段材料一直被重新送去。
			if (!text && !previous) return null;
			const next: StoredSummary = { text: text || previous!.text, upto: material.upto, updatedAt: Date.now() };
			// 生成的这几秒里会话可能被删了：不让一份摘要留下来。
			if (!(await ctx.sessions.get(id))) return null;
			await store.save(id, next);
			return next;
		}

		/** 同一个会话同时只跑一次：后台到点的和人点的「重试」要的是同一份。 */
		function summarize(id: string): Promise<SummaryState> {
			const current = inFlight.get(id);
			if (current) return current;
			states.set(id, { pending: true });
			changed(id);
			const next = generate(id)
				.then(
					(summary): SummaryState => {
						states.delete(id);
						return { summary, pending: false };
					},
					async (error: unknown): Promise<SummaryState> => {
						const message = error instanceof Error ? error.message : String(error);
						// i18n-exempt：日志。
						if (!lifecycle.signal.aborted) ctx.log.warn(`会话摘要生成失败：${message}`);
						states.set(id, { pending: false, error: message });
						return { summary: await store.read(id), pending: false, error: message };
					},
				)
				.finally(() => {
					inFlight.delete(id);
					changed(id);
				});
			inFlight.set(id, next);
			return next;
		}

		const afterTurn = summarizeAfterTurn({ busy: (id) => running.has(id), run: async (id) => void (await summarize(id)) });
		ctx.effect(() => afterTurn.dispose());
		ctx.sessions.observe(({ sessionId, event }) => {
			if (event.type !== "running") return;
			if (event.running) running.add(sessionId);
			else running.delete(sessionId);
			afterTurn.observe(sessionId, event.running);
		});
		ctx.sessions.onDeleted((id) => {
			afterTurn.cancel(id);
			running.delete(id);
			states.delete(id);
			void store.remove(id).catch(() => undefined);
			changed(id);
		});

		const checked = (id: unknown): string => {
			if (typeof id !== "string" || !id) throw new Error("sessionId is required");
			return id;
		};
		ctx.serve({
			async *watch(sessionId, call) {
				const id = checked(sessionId);
				let dirty = true;
				let wake: (() => void) | undefined;
				const listener = () => {
					dirty = true;
					wake?.();
				};
				const stop = () => wake?.();
				let set = watchers.get(id);
				if (!set) watchers.set(id, (set = new Set()));
				set.add(listener);
				call.signal.addEventListener("abort", stop);
				try {
					while (!call.signal.aborted) {
						if (!dirty) await new Promise<void>((resolve) => (wake = resolve));
						wake = undefined;
						if (call.signal.aborted) break;
						dirty = false;
						yield await stateOf(id);
					}
				} finally {
					call.signal.removeEventListener("abort", stop);
					set.delete(listener);
					if (!set.size) watchers.delete(id);
				}
			},
			async summarize(sessionId) {
				const id = checked(sessionId);
				if (!(await ctx.sessions.get(id))) throw new Error(`No such session: ${id}`);
				return summarize(id);
			},
			model: async () => chosenModel,
			setModel(next) {
				const value = typeof next === "string" && next ? next : undefined;
				writing = writing
					.catch(() => undefined)
					.then(async () => {
						await writeFile(`${settingsFile}.tmp`, JSON.stringify(value ? { model: value } : {}, null, 2));
						await rename(`${settingsFile}.tmp`, settingsFile);
						chosenModel = value;
					});
				return writing;
			},
		} satisfies SummaryApi);
	},
} satisfies Plugin;
