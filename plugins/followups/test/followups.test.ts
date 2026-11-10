import { describe, expect, it } from "vitest";
import type { AssistantMessage, Message } from "@plume/contract";
import { followups, matchFollowup, nextFollowup, shownText, withoutFollowups } from "../src/followups.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const REPLY = "修好了，e2e 还没跑。\n\n:followup[把登录页的 e2e 跑一遍，失败的话贴出第一条报错]";
const HINT = "把登录页的 e2e 跑一遍，失败的话贴出第一条报错";

function reply(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "t",
		model: "t",
		usage,
		stopReason,
		timestamp: 2,
	} as unknown as AssistantMessage;
}

const asked: Message = { role: "user", content: [{ type: "text", text: "修一下登录跳转" }], timestamp: 1 };

describe("matchFollowup", () => {
	it("写完了的标记：要填的那句、结束位置", () => {
		const source = "好了 :followup[把登录页的 e2e 跑一遍] 后面";
		expect(matchFollowup(source, source.indexOf(":"))).toEqual({ prompt: "把登录页的 e2e 跑一遍", end: source.indexOf(" 后面") });
		expect(matchFollowup(":followup[数组 a[0\\] 越界了，修一下]", 0)?.prompt).toBe("数组 a[0] 越界了，修一下");
	});

	it("没写完、跨了行、空的都不算", () => {
		for (const source of [":followup[跑测试", ":followup[跑\n测试]", ":followup[  ]", "::followup[跑测试]", ":followups[跑测试]"]) {
			expect(matchFollowup(source, 0), source).toBeNull();
		}
	});
});

describe("followups", () => {
	it("代码块、行内代码和转义里的不算", () => {
		const text = ["写法是 `:followup[a]`。", "```md", ":followup[b]", "```", "\\:followup[c]", ":followup[真的这一句]"].join("\n");
		expect(followups(text).map((item) => item.prompt)).toEqual(["真的这一句"]);
	});
});

describe("withoutFollowups", () => {
	it("独占的那一行整行拿掉，不留空行；别的原样", () => {
		expect(withoutFollowups("修好了。\n\n:followup[跑一下 e2e]\n")).toBe("修好了。");
		expect(withoutFollowups("修好了。 :followup[跑一下 e2e]")).toBe("修好了。");
		expect(withoutFollowups("硬换行  \n修好了。\n\n:followup[x]")).toBe("硬换行  \n修好了。");
		expect(withoutFollowups("`:followup[x]` 是写法")).toBe("`:followup[x]` 是写法");
		expect(withoutFollowups("没有标记\n\n")).toBe("没有标记\n\n");
	});
});

describe("shownText", () => {
	it("写到一半的标记不露出语法，写完了照常拿掉", () => {
		expect(shownText("好了。 :followup[把 e2e")).toBe("好了。");
		expect(shownText("好了。\n\n:fol")).toBe("好了。");
		expect(shownText("好了。 :followup[把 e2e 跑一遍]")).toBe("好了。");
		expect(shownText("比例 3:2")).toBe("比例 3:2");
		expect(shownText("看 :followup[a\n下一行")).toBe("看 :followup[a\n下一行");
	});

	it("代码块里写到一半的照原样", () => {
		expect(shownText("```\n:followup[a")).toBe("```\n:followup[a");
	});
});

describe("nextFollowup", () => {
	it("最新那条写完了的回复里的第一句", () => {
		expect(nextFollowup([asked, reply(`${REPLY}\n:followup[第二句]`)])).toBe(HINT);
	});

	it("人又开口了、还在写、停在工具调用上、没写标记时都没有", () => {
		expect(nextFollowup([asked, reply(REPLY), { ...asked, timestamp: 3 }])).toBeUndefined();
		expect(nextFollowup([asked, reply(REPLY, "pending")])).toBeUndefined();
		expect(nextFollowup([asked, reply(REPLY, "toolUse")])).toBeUndefined();
		expect(nextFollowup([asked, reply("修好了。")])).toBeUndefined();
	});

	it("运行时塞进来的消息不算人开口", () => {
		const nudge: Message = { role: "user", content: [{ type: "text", text: "继续" }], timestamp: 3, synthetic: true };
		expect(nextFollowup([asked, reply(REPLY), nudge])).toBe(HINT);
	});

	it("有收尾答复时不读播报那段", () => {
		const message = reply("");
		message.content = [
			{ type: "text", text: "先看看。 :followup[播报里的]", phase: "commentary" },
			{ type: "text", text: REPLY, phase: "final_answer" },
		];
		expect(nextFollowup([asked, message])).toBe(HINT);
	});
});
