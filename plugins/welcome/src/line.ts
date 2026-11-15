/**
 * 今日一句：发给模型什么、模型回来的怎么洗、按哪天算。
 *
 * 都是纯函数，逻辑入口只管什么时候调、存在哪。
 */

import type { Locale } from "@plume/contract";
import type { WelcomeLine } from "@plume/contract/ui";

/** 写一句最多等这么久；没回来就这次不显示，下次打开欢迎页再试。 */
export const LINE_TIMEOUT_MS = 20_000;

/** 回复的 token 上限；是否完整收尾另由模型调用检查。 */
export const LINE_MAX_TOKENS = 100;

/** 记住最近这么多句，写新的时让模型避开，免得隔几天又是同一句。 */
export const RECENT_LINES = 30;

/** 正文长度上限，按码点数；超长时这次不显示。 */
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

/** 洗掉模型回复里不该显示的东西，拆成这句话和出处。正文为空或太长时抛错，说明原因。 */
export function parseLine(raw: string, locale: Locale): WelcomeLine {
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
	// i18n-exempt：日志中的失败原因。
	if (!text) throw new Error("模型回复中没有可显示的正文");
	const length = [...text].length;
	// i18n-exempt：日志中的失败原因。
	if (length > TEXT_MAX[locale]) throw new Error(`模型回复的正文过长（${length} 字符，上限 ${TEXT_MAX[locale]}）`);
	return source && [...source].length <= SOURCE_MAX ? { text, source } : { text };
}
