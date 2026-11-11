import { describe, expect, it } from "vitest";
import { linePrompt, localDate, parseLine } from "../src/line.ts";

describe("按哪天算", () => {
	it("本机日期，月、日补零", () => {
		expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
		expect(localDate(new Date(2026, 10, 11, 0, 0))).toBe("2026-11-11");
	});
});

describe("发给模型的话", () => {
	it("按界面语言给长度，带上要避开的几句", () => {
		const prompt = linePrompt("zh-CN", "2026-11-11", ["简单是可靠的前提。"]);
		expect(prompt).toContain("今天是 2026-11-11");
		expect(prompt).toContain("用中文写");
		expect(prompt).toContain("- 简单是可靠的前提。");
		expect(linePrompt("en", "2026-11-11", [])).toContain("用英文写");
		expect(linePrompt("en", "2026-11-11", [])).not.toContain("别和最近用过的");
	});
});

describe("洗模型的回复", () => {
	it("两行：这句话和出处", () => {
		expect(parseLine("简单是可靠的前提。\nEdsger Dijkstra", "zh-CN")).toEqual({ text: "简单是可靠的前提。", source: "Edsger Dijkstra" });
	});

	it("去掉引号、书名号、编号、前缀和出处前的破折号", () => {
		expect(parseLine("“清楚胜过聪明。”\n——《Go 谚语》", "zh-CN")).toEqual({ text: "清楚胜过聪明。", source: "Go 谚语" });
		expect(parseLine("1. 今日一句：先让它能用。\n出处：Kent Beck", "zh-CN")).toEqual({ text: "先让它能用。", source: "Kent Beck" });
		expect(parseLine("<think>想想</think>\n```\nClear is better than clever.\nRob Pike\n```", "en")).toEqual({
			text: "Clear is better than clever.",
			source: "Rob Pike",
		});
	});

	it("写成一行「这句话 —— 出处」的也拆开", () => {
		expect(parseLine("过早优化是万恶之源。——Donald Knuth", "zh-CN")).toEqual({ text: "过早优化是万恶之源。", source: "Donald Knuth" });
		expect(parseLine("Talk is cheap. Show me the code. - Linus Torvalds", "en")).toEqual({
			text: "Talk is cheap. Show me the code.",
			source: "Linus Torvalds",
		});
	});

	it("没有出处时只有这句话", () => {
		expect(parseLine("慢慢来，比较快。", "zh-CN")).toEqual({ text: "慢慢来，比较快。" });
	});

	it("空的、太长的不要", () => {
		expect(parseLine("   ", "zh-CN")).toBeUndefined();
		expect(parseLine("一".repeat(41), "zh-CN")).toBeUndefined();
		expect(parseLine("a".repeat(111), "en")).toBeUndefined();
	});
});
