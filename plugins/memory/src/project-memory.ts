/**
 * 项目记忆：这个仓库教会我们的，按项目存，换个项目不带过去。
 *
 * 「这个仓库用 pnpm 不用 npm」在这里成立，换个目录就不成立；记成全局的，下一个项目里它是一条错的事实，照样被用上。
 *
 * 两个文件，分开是有用的：
 *
 *   `learned.md` 是刻意记下的——`learn` 工具，或者人手改。后台总结从不碰它。
 *   `MEMORY.md` 是后台读会话总结出来的，整份重写；敢整份重写，正因为刻意记下的那一半在别处。
 */

import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inTurn, readText, writeAtomic } from "./files.ts";

export interface Lesson {
	/** 一两句话，具体、能照着做。 */
	text: string;
	/** 什么时候适用，看教训本身不明显时才有。 */
	context?: string;
	/** 毫秒时间戳。存的顺序是新的在前。 */
	at: number;
}

/** 记忆进这个项目的每一次请求：不设上限，就是一份不知不觉涨了几个月的每轮开销。 */
export const MAX_LESSONS = 100;
export const MAX_LESSON_CHARS = 2000;
const MAX_CONTEXT_CHARS = 400;
const MEMORY_LINE_LIMIT = 200;
const MEMORY_CHAR_LIMIT = 25_000;

/**
 * 后台总结读到哪儿了：这个时间之前结束的会话已经合并进 `MEMORY.md`。
 *
 * 只对现存的 `MEMORY.md` 有意义，所以丢掉那个文件时一起删：人丢掉它是要重新总结，留着游标的话下一次只读新会话，
 * 旧会话里的结论再也回不来。
 */
export const EXTRACT_CURSOR = ".cursor";

/**
 * 公开的凭证前缀。模型刚看完一份配置文件，「记住 API key 是 sk-proj-…」是它很可能得出的结论；
 * 记忆是最糟的落脚处：它此后进这个项目的每一次请求，而那个文件没人去读。
 */
const SECRET_PATTERNS: RegExp[] = [
	/\bsk-(?:[A-Za-z0-9]+-)*[A-Za-z0-9]{16,}/g,
	/\bghp_[A-Za-z0-9]{20,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/g,
	/\bAKIA[A-Z0-9]{16}/g,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
];

export function redactSecrets(text: string): string {
	let out = text;
	// i18n-exempt：写进记忆文件、发给模型的占位，不随界面语言变。
	for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[已脱敏的凭证]");
	return out;
}

/**
 * 两条教训说的是不是同一件事。
 *
 * 比词的重合而不是比字符串：同一条教训学两次，两次措辞都不一样——「用 pnpm 不是 npm」和「这个仓库的包管理器是 pnpm」是一条，
 * 两条都存既花上下文，又让上限来得更早。故意做得粗糙：向量比较更准，但要在一条必须离线、立刻完成的路上调一次模型。
 */
export function similar(a: string, b: string, threshold = 0.6): boolean {
	const tokens = (text: string) =>
		new Set(
			text
				.toLowerCase()
				// 反引号写成 \x60：字面的反引号会让检查文案的脚本以为模板字符串从这里开始。
				.replace(/[\x60*_#>[\]()|]/g, " ")
				// 按不是字母、数字、汉字的字符切。
				.split(/[^\p{L}\p{N}]+/u)
				.filter((token) => token.length > 1),
		);
	const left = tokens(a);
	const right = tokens(b);
	if (left.size === 0 || right.size === 0) return false;
	let shared = 0;
	for (const token of left) if (right.has(token)) shared += 1;
	return shared / Math.min(left.size, right.size) >= threshold;
}

export async function readLessons(dir: string): Promise<Lesson[]> {
	const file = join(dir, "learned.md");
	const raw = await readText(file);
	if (raw === null) return [];
	// 手写条目没有时间戳时按文件最后修改时间记：文件不变，读几次都是同一个日期、同一份提示词。
	const modified = await stat(file)
		.then((info) => Math.floor(info.mtimeMs))
		.catch(() => 0);
	return parseLessons(raw, modified);
}

/**
 * 加一条，或者并进它重复的那一条。返回是哪一种：「记下了」和「你早就知道了」是两个答案，
 * 后者成立时说成前者，模型会一直写同一句话的变体。
 */
export function recordLesson(dir: string, lesson: Omit<Lesson, "at">): Promise<{ action: "added" | "merged"; total: number }> {
	return inTurn(join(dir, "learned.md"), async () => {
		const text = redactSecrets(lesson.text.trim()).slice(0, MAX_LESSON_CHARS);
		const context = lesson.context?.trim() ? redactSecrets(lesson.context.trim()).slice(0, MAX_CONTEXT_CHARS) : undefined;
		const existing = await readLessons(dir);
		const duplicate = existing.findIndex((entry) => similar(entry.text, text));
		const now = Date.now();
		// 重复的那条挪到最前、换成新的措辞，而不是丢掉新的：被说两次说明它要紧，第二次的说法多半来自一次真的纠正。
		const next =
			duplicate >= 0
				? [{ text, context: context ?? existing[duplicate]?.context, at: now }, ...existing.filter((_, index) => index !== duplicate)]
				: [{ text, context, at: now }, ...existing];
		const capped = next.slice(0, MAX_LESSONS);
		await writeLessons(dir, capped);
		return { action: duplicate >= 0 ? "merged" : "added", total: capped.length };
	});
}

/**
 * 忘掉一条。按 `at` 认而不是按文字：两条可能被改写得几乎一样，`recordLesson` 故意把它们合并；它从不给两条同一个时间。
 * 返回有没有删掉东西，分得清「删了」和「本来就没了」（两个窗口开着同一个项目就会有后者）。
 */
export function forgetLesson(dir: string, at: number): Promise<boolean> {
	return inTurn(join(dir, "learned.md"), async () => {
		const existing = await readLessons(dir);
		const next = existing.filter((lesson) => lesson.at !== at);
		if (next.length === existing.length) return false;
		await writeLessons(dir, next);
		return true;
	});
}

export function forgetAllLessons(dir: string): Promise<void> {
	return inTurn(join(dir, "learned.md"), () => writeLessons(dir, []));
}

/**
 * 丢掉后台总结的那一份。它是从旧会话整份写出来的，总结错了的修法是丢掉让它重写，而不是去找那一句改。
 * 删文件而不是清空：不存在是其余代码本来就会读的状态，空文件是同一件事的第二种说法。
 */
export async function forgetExtractedMemory(dir: string): Promise<boolean> {
	try {
		await rm(join(dir, "MEMORY.md"));
		await rm(join(dir, EXTRACT_CURSOR), { force: true });
		return true;
	} catch {
		return false;
	}
}

export async function writeLessons(dir: string, lessons: Lesson[]): Promise<void> {
	await writeAtomic(join(dir, "learned.md"), renderLessons(lessons));
}

/** markdown 而不是 JSON：人要能打开它改掉错的那条。改不了的记忆就一直错下去。 */
export function renderLessons(lessons: Lesson[]): string {
	// i18n-exempt：记忆文件的内容，给打开它的人和模型看，不随界面语言变。
	const lines = [
		"# 这个项目学到的",
		"",
		"由 `learn` 工具写入，也可以手改。自动巩固不会覆盖这个文件。",
		"过时的条目请直接删掉——记忆库里一条过时的事实比没有这条更糟，模型会照着它做决定。",
		"",
	];
	for (const lesson of lessons) {
		lines.push(`- ${lesson.text}`);
		// i18n-exempt：同上，`parseLessons` 按这几个字认回来。
		if (lesson.context) lines.push(`  - 适用于：${lesson.context}`);
		lines.push(`  <!-- at:${lesson.at} -->`);
	}
	return `${lines.join("\n")}\n`;
}

/**
 * 读回 `renderLessons` 写的，容得下人手改时删掉了时间戳。
 *
 * 没有时间戳的条目记在 `untimedAt`（读文件时传文件修改时间），不能用「现在」：日期进系统提示词，每次读都标成今天，
 * 既让手写的旧条目看起来刚记下，又让提示词每天变一次、缓存跟着作废。按位置各减 1 毫秒，按 `at` 删时两条手写条目不会撞在一起。
 */
export function parseLessons(raw: string, untimedAt = 0): Lesson[] {
	const lessons: Lesson[] = [];
	let current: Lesson | null = null;
	for (const line of raw.split("\n")) {
		const bullet = /^-\s+(.*)$/.exec(line);
		if (bullet) {
			if (current) lessons.push(current);
			current = { text: (bullet[1] ?? "").trim(), at: untimedAt - lessons.length };
			continue;
		}
		if (!current) continue;
		// i18n-exempt：认 `renderLessons` 写下的那几个字。
		const context = /^\s+-\s+适用于：(.*)$/.exec(line);
		if (context) {
			current.context = (context[1] ?? "").trim();
			continue;
		}
		const at = /<!--\s*at:(\d+)\s*-->/.exec(line);
		if (at) current.at = Number(at[1]);
	}
	if (current) lessons.push(current);
	return lessons.filter((lesson) => lesson.text.length > 0);
}

/** 后台总结的那一份，去掉给人看的文件头：它对模型没有意义，不该在这个项目的每次请求里花掉。 */
export async function readExtractedMemory(dir: string): Promise<string> {
	const raw = await readText(join(dir, "MEMORY.md"));
	if (raw === null) return "";
	// i18n-exempt：认 `extract.ts` 写下的文件头。
	const body = raw.split("\n").filter((line) => !line.startsWith("#") && !line.startsWith("由后台抽取") && !line.startsWith("要保留的内容"));
	return body.join("\n").trim();
}

export async function writeExtractedMemory(dir: string, content: string): Promise<void> {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "MEMORY.md"), content, "utf8");
}

/** 截在 200 行、25,000 字以内，在加包裹的标签之前截，截断不会把闭合标签截掉。 */
export function budgetMemory(content: string): string {
	const lines = content.split("\n");
	if (lines.length <= MEMORY_LINE_LIMIT && content.length <= MEMORY_CHAR_LIMIT) return content;
	let excerpt = lines.slice(0, MEMORY_LINE_LIMIT).join("\n");
	if (excerpt.length > MEMORY_CHAR_LIMIT) {
		const newline = excerpt.lastIndexOf("\n", MEMORY_CHAR_LIMIT);
		excerpt = excerpt.slice(0, newline > 0 ? newline : MEMORY_CHAR_LIMIT);
		if (/[\uD800-\uDBFF]$/.test(excerpt)) excerpt = excerpt.slice(0, -1);
	}
	return `${excerpt}\n\n[Memory excerpt: limited to 200 lines and 25,000 characters. Consult the project's memory files for details; keep the index concise.]`;
}

/** 本地日期 `YYYY-MM-DD`，和对话里环境信息给的「今天」同一种写法。 */
function day(at: number): string {
	const date = new Date(at);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * 放进系统提示词的那一段；什么都没有时是空的（一个空的 `<project_memory>` 只是几个 token 的噪音，外加让人纳闷记忆去哪了）。
 *
 * 每条标上记下的日期：年龄是让模型打折扣的依据。三个月前记下的「这个仓库用 npm」，没有日期时模型对着 `pnpm-lock.yaml`
 * 照样跑 `npm install`——记忆压过了文件。写日期而不是「3 天前」：相对年龄每天跳，提示词跟着变、缓存跟着作废。
 */
/**
 * 连同这段的哪几截来自哪个文件（给上下文用量按文件列）：刻意记下的那截算 `learned.md`，推断的那截算 `MEMORY.md`，
 * 说明文字算在前一截里；截断截进了刻意记下的那截时分不开，整段算 `learned.md`。
 */
export function projectMemorySection(lessons: Lesson[], extracted = ""): { text: string; files: Array<{ name: "learned.md" | "MEMORY.md"; chars: number }> } {
	if (lessons.length === 0 && !extracted.trim()) return { text: "", files: [] };
	// i18n-exempt：发给模型的提示词。
	const learned = lessons
		.map((lesson) => `- ${lesson.text}${lesson.context ? `（${lesson.context}）` : ""}${lesson.at > 0 ? ` · ${day(lesson.at)} 记下` : ""}`)
		.join("\n");
	// 推断出来的要比刻意记下的低一档。
	// i18n-exempt：发给模型的提示词。
	const inferred = extracted.trim() ? `\n\n从过去的会话里推断出来的（可信度低于上面几条，与代码冲突时以代码为准）：\n${extracted.trim()}` : "";
	const body = budgetMemory(learned ? learned + inferred : inferred.slice(2));
	// i18n-exempt：发给模型的提示词。
	const prefix =
		"<project_memory>\n" +
		"以前在这个项目里学到的，按新旧排，每条标了记下的时间。它们说的是当时，不一定是现在：" +
		"凡是能从仓库里核实的（配置文件、lockfile、脚本、README），动手前先看一眼再用；" +
		"和你看到的代码或文件矛盾时，以代码为准，并考虑用 `learn` 更新它。\n";
	const text = `${prefix}${body}\n</project_memory>`;
	if (learned && inferred && body.startsWith(`${learned}\n\n`)) {
		const head = prefix.length + learned.length;
		return {
			text,
			files: [
				{ name: "learned.md", chars: head },
				{ name: "MEMORY.md", chars: text.length - head },
			],
		};
	}
	return { text, files: [{ name: learned ? "learned.md" : "MEMORY.md", chars: text.length }] };
}
