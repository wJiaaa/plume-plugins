import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { copyText } from "../src/copy.ts";
import { prepareBlock } from "../src/language.ts";
import { recall, remember, stateKey } from "../src/state.ts";

const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
	if (original) Object.defineProperty(globalThis, "localStorage", original);
	else Reflect.deleteProperty(globalThis, "localStorage");
});
function storage(initial = "[]") {
	let value = initial;
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: () => value,
			setItem: (_: string, next: string) => {
				value = next;
			},
		},
	});
	return () => value;
}
const code =
	'<Input name="name" label="Person" value="Ada"/><Tabs><Tab title="A"><Text>{name}</Text></Tab><Tab title="B"><Text when={false}>Hidden</Text><Text>Other tab</Text></Tab></Tabs><Button send="Choose {name}">Send</Button>';
function block() {
	const parsed = prepareBlock(code, true);
	assert.ok(parsed.ok);
	return parsed.block;
}
test("按会话和源码恢复值、页签及回执，并限制为最近 200 个块", () => {
	const read = storage();
	const key = stateKey("one", code);
	const saved = { values: { name: "Grace" }, tabs: { "1": "B" }, sent: { payload: "Choose Grace", button: "2", values: { name: "Grace" } } };
	remember(key, saved);
	assert.deepEqual(recall(key, block()), saved);
	assert.deepEqual(recall(stateKey("two", code), block()).values, {});
	assert.deepEqual(recall(stateKey("one", code + " "), block()).values, {});
	for (let at = 0; at < 201; at++) remember(String(at), { values: {}, tabs: {} });
	assert.equal(JSON.parse(read()).length, 200);
	assert.deepEqual(recall(key, block()).values, {});
});
test("损坏或不可用的存储不阻止使用；错误字段不恢复", () => {
	storage('[null,[1,{}],["x",null]]');
	assert.deepEqual(recall("x", block()).values, {});
	remember("x", { values: { name: { wrong: true } }, tabs: {} });
	assert.deepEqual(recall("x", block()).values, {});
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		get() {
			throw new Error("denied");
		},
	});
	assert.doesNotThrow(() => remember("x", { values: {}, tabs: {} }));
	assert.deepEqual(recall("x", block()).values, {});
});
test("复制当前值、全部页签、选择标签及表图数据，隐藏内容和按钮不进入副本", () => {
	storage();
	remember(stateKey("one", code), { values: { name: "Grace" }, tabs: { "1": "B" } });
	const text = copyText({ sessionId: "one", code })!;
	assert.match(text, /Person: Grace/);
	assert.match(text, /\*\*A\*\*/);
	assert.match(text, /Other tab/);
	assert.doesNotMatch(text, /Ada|Hidden|Send|Choose|<Input/);
	const more =
		'<Choice name="x" label="Option" options={[{label:"Shown",value:"private-id"}]}/><Slider name="n" value={3} unit="kg"/><Toggle name="yes" value/><Each of={["first","second"]}><Badge>{item}</Badge></Each><Progress label="Done" value={34}/><Table columns={["a|b"]} rows={[["one\\ntwo"]]}/><Chart kind="area" x="day" y="n" data={[{day:"Tue",n:3}]}/>';
	const copied = copyText({ sessionId: "one", code: more })!;
	assert.match(copied, /Option: Shown/);
	assert.match(copied, /n: 3kg/);
	assert.match(copied, /yes: ✓/);
	assert.match(copied, /first\nsecond/);
	assert.match(copied, /Done: 34%/);
	assert.match(copied, /a\\\|b/);
	assert.match(copied, /Tue \| 3/);
	assert.equal(copyText({ sessionId: "one", code: "<Unknown/>" }), undefined);
	assert.equal(copyText({ sessionId: "one", code: "<!-- source only -->" }), undefined);
});
