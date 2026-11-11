/**
 * 今日一句：发给模型什么、模型回来的怎么洗、按哪天算。
 *
 * 都是纯函数，逻辑入口只管什么时候调、存在哪。
 */

import type { Locale } from "@plume/contract";
import type { WelcomeLine } from "@plume/contract/ui";

/** 写一句最多等这么久；没回来就这次不显示，下次打开欢迎页再试。 */
export const LINE_TIMEOUT_MS = 20_000;

/** 两行短字，100 个 token 够了；这只是上限，服务商按实际生成的收费。 */
export const LINE_MAX_TOKENS = 100;

/** 记住最近这么多句，写新的时让模型避开，免得隔几天又是同一句。 */
export const RECENT_LINES = 30;

/** 洗完还超过这么长的不像一句话（模型写成了一段），丢掉、这次不显示。按码点数。 */
const TEXT_MAX: Record<Locale, number> = { "zh-CN": 40, en: 110 };
const SOURCE_MAX = 40;

// i18n-exempt：发给模型的提示词。
export const LINE_SYSTEM =
	"你给一个写代码的桌面应用写欢迎页上的「今日一句」，它显示在问候（早上好、下午好）下面。\n" +
	"规则：\n" +
	"1. 和写软件、做工程、解决问题或专注做事有关；可以是名人说过的话，也可以是你自己写的，给它署一个合适的出处（人名或书名）；\n" +
	"2. 语气克制、有点意思，不说教、不打鸡血、不用感叹号；\n" +
	"3. 只输出两行：第一行是这句话，第二行是出处；不要引号、书名号、编号、破折号，也不要别的话。";

/** 本机日期，`2026-11-11`：按这一天换句子。 */
export function localDate(now: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 发给模型的那句话：哪天、用哪种语言、多长，以及最近用过、要避开的几句。 */
export function linePrompt(locale: Locale, date: string, recent: readonly string[]): string {
	// i18n-exempt：发给模型的提示词。
	const language = locale === "en" ? "用英文写，这句话不超过 70 个字母。" : "用中文写，这句话不超过 24 个字。";
	// i18n-exempt：发给模型的提示词。
	const avoid = recent.length > 0 ? `\n别和最近用过的这几句重复，也别换个说法再写一遍：\n${recent.map((text) => `- ${text}`).join("\n")}` : "";
	// i18n-exempt：发给模型的提示词。
	return `今天是 ${date}，写今天的一句。${language}${avoid}`;
}

/** 去掉包在两头的引号、书名号。 */
function unquote(text: string): string {
	// i18n-exempt：认模型回复里的中文标点，不是给人看的字。
	return text.replace(/^[「『《“"'‘`]+|[」』》”"'’`]+$/g, "").trim();
}

/** 洗掉模型回复里不该显示的东西，拆成这句话和出处。洗完是空的、太长的返回 undefined。 */
export function parseLine(raw: string, locale: Locale): WelcomeLine | undefined {
	let body = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
	body = body.replace(/^```[a-z]*\n?([\s\S]*?)```$/i, "$1").trim();
	const rows = body
		.split("\n")
		.map((row) => row.trim())
		// i18n-exempt：认模型回复里的编号、列表记号。
		.map((row) => row.replace(/^(?:\d+[.、)]\s*|[-*•]\s+)/, ""))
		.filter(Boolean);
	let [text = "", source = ""] = rows;
	// 写成一行「这句话 —— 出处」的也认。
	if (!source) {
		const joined = /^(.*?)\s*(?:——|—|--|\s-\s)\s*([^—-]+)$/.exec(text);
		if (joined) [, text = "", source = ""] = joined;
	}
	// i18n-exempt：认模型回复里的前缀。
	text = unquote(text.replace(/^(?:今日一句|句子|Line|Quote)\s*[:：]\s*/i, ""));
	// i18n-exempt：认模型回复里的前缀。
	source = unquote(source.replace(/^(?:——|—|--|-)\s*/, "").replace(/^(?:出处|来源|Source)\s*[:：]\s*/i, ""));
	if (!text || [...text].length > TEXT_MAX[locale]) return undefined;
	return source && [...source].length <= SOURCE_MAX ? { text, source } : { text };
}
