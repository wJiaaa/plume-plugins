import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@plume/contract";
import { problemsIn, withInterfaceNotes } from "../src/notes.ts";

test("诊断跳过其他代码围栏，识别无围栏组件、错误属性及未闭合围栏", () => {
	assert.deepEqual(problemsIn("````md\n```ui\n<Unknown/>\n```\n````"), []);
	assert.equal(problemsIn('<Card title="outside"/>').length, 1);
	assert.match(problemsIn('```UI\n<Text typo="bad">Hi</Text>\n```')[0]!, /unknown prop typo/);
	assert.match(problemsIn("~~~ui\n<Text>Hi</Text>")[0]!, /fence never closed/);
	assert.deepEqual(problemsIn("```ui\n<Text>Fine</Text>\n```"), []);
});
test("自动回报仅附在下一条真实用户消息副本，稳定去重，不改转录也不新增消息", () => {
	const user = (text: string, synthetic = false) => ({ role: "user", content: [{ type: "text", text }], synthetic });
	const messages = [
		user("start"),
		{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "```ui\n<Missing/>\n```" }] },
		user("continue", true),
		user("next"),
		user("later"),
	] as Message[];
	const original = structuredClone(messages);
	const next = withInterfaceNotes(messages);
	assert.deepEqual(messages, original);
	assert.equal(next.length, messages.length);
	assert.equal(next[2], messages[2]);
	assert.equal(next[4], messages[4]);
	assert.match(JSON.stringify(next[3]), /unknown component Missing/);
	assert.deepEqual(withInterfaceNotes(messages), next);
	assert.deepEqual(withInterfaceNotes(next), next);
	const beforeUser = messages.slice(0, 3);
	assert.equal(withInterfaceNotes(beforeUser), beforeUser);
});
