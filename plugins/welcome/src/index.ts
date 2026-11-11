/**
 * plume.welcome 的逻辑入口，跑在 agent 进程：欢迎页问候下面的「今日一句」。
 *
 * 每种界面语言每天第一次要时让默认模型写一句，存进插件数据目录的 `line.json`，当天再要直接给存好的，一天只调一次模型。
 * 没配模型、超时、出错、写出来不像一句话时这次不给（欢迎页显示宿主默认的那一行），也不记下来，下次打开欢迎页再试。
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locale, Plugin } from "@plume/contract";
import type { WelcomeLine } from "@plume/contract/ui";
import type { WelcomeApi } from "./api.ts";
import { LINE_MAX_TOKENS, LINE_SYSTEM, LINE_TIMEOUT_MS, linePrompt, localDate, parseLine, RECENT_LINES } from "./line.ts";

/** `line.json`：哪天、那天各语言的一句，和最近写过的几句（新的在前）。 */
interface Stored {
	date: string;
	lines: Partial<Record<Locale, WelcomeLine>>;
	recent: string[];
}

async function readJson(file: string): Promise<Record<string, unknown>> {
	return await readFile(file, "utf8").then(
		(text) => JSON.parse(text) as Record<string, unknown>,
		() => ({}),
	);
}

/** 先写临时文件再改名：写到一半退出不会留下半个文件。 */
async function writeJson(file: string, value: unknown): Promise<void> {
	await writeFile(`${file}.tmp`, JSON.stringify(value, null, 2));
	await rename(`${file}.tmp`, file);
}

export default {
	name: "plume.welcome",
	async apply(ctx) {
		const lineFile = join(ctx.dataDir, "line.json");
		let stored: Stored | undefined;
		/** 文件排着队写：两种语言同时写好时不互相盖掉。 */
		let writing: Promise<void> = Promise.resolve();
		/** 正在写的那一句，按「日期/语言」记：欢迎页连着开几次只调一次模型。 */
		const pending = new Map<string, Promise<WelcomeLine | undefined>>();
		const stopped = new AbortController();
		ctx.effect(() => stopped.abort());

		async function load(): Promise<Stored> {
			if (stored) return stored;
			const saved = await readJson(lineFile);
			stored = {
				date: typeof saved.date === "string" ? saved.date : "",
				lines: saved.lines && typeof saved.lines === "object" ? (saved.lines as Stored["lines"]) : {},
				recent: Array.isArray(saved.recent) ? saved.recent.filter((text): text is string => typeof text === "string") : [],
			};
			return stored;
		}

		async function compose(date: string, locale: Locale): Promise<WelcomeLine | undefined> {
			try {
				const reply = await ctx.model.complete({
					systemPrompt: LINE_SYSTEM,
					prompt: linePrompt(locale, date, (await load()).recent),
					maxTokens: LINE_MAX_TOKENS,
					signal: AbortSignal.any([stopped.signal, AbortSignal.timeout(LINE_TIMEOUT_MS)]),
				});
				const line = parseLine(reply, locale);
				if (!line) {
					// i18n-exempt：日志。
					ctx.log.warn(`今日一句写出来不像一句话，这次不显示：${reply.slice(0, 200)}`);
					return undefined;
				}
				writing = writing
					.catch(() => undefined)
					.then(async () => {
						const current = await load();
						const next: Stored = {
							date,
							lines: { ...(current.date === date ? current.lines : {}), [locale]: line },
							recent: [line.text, ...current.recent.filter((text) => text !== line.text)].slice(0, RECENT_LINES),
						};
						await writeJson(lineFile, next);
						stored = next;
					});
				await writing;
				return line;
			} catch (error) {
				// 插件停了是我们自己叫停的，不算失败。
				// i18n-exempt：日志。
				if (!stopped.signal.aborted) ctx.log.warn(`写今日一句失败：${error instanceof Error ? error.message : String(error)}`);
				return undefined;
			}
		}

		ctx.serve({
			today: async (locale: Locale) => {
				const date = localDate(new Date());
				const current = await load();
				const saved = current.date === date ? current.lines[locale] : undefined;
				if (saved) return saved;
				const key = `${date}/${locale}`;
				let job = pending.get(key);
				if (!job) {
					job = compose(date, locale).finally(() => pending.delete(key));
					pending.set(key, job);
				}
				return await job;
			},
		} satisfies WelcomeApi);
	},
} satisfies Plugin;
