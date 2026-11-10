import assert from "node:assert/strict";
import { test } from "node:test";
import { actionOf, prepareBlock, resolveBlock, spoken, type Block, type Drawing } from "../src/language.ts";
import { parseBlock } from "../src/parse.ts";

function block(source: string): Block {
	const parsed = prepareBlock(source, true);
	assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
	return parsed.block;
}
function elements(drawing: (Drawing | string)[]): Drawing[] {
	return drawing.flatMap((item) => (typeof item === "string" ? [] : [item, ...elements(item.children)]));
}

export const FORM = `<Card title="Booking">
<Row><Input name="seats" label="Seats" type="number" value={4}/><Select name="city" options={["Kyoto","Tainan"]}/></Row>
<Choice name="extras" multiple options={[{label:"Tea",value:"tea"},{label:"Notes",value:"notes"}]}/>
<Toggle name="remote"/>
<Grid cols={2}><Stat label="Total" value={seats * 1200}/><Text when={remote}>Remote in {city}</Text></Grid>
<Button send="Book {seats} seats in {city}" primary disabled={seats < 1}>Send</Button>
<Button set={{seats:4,city:"Kyoto",extras:[],remote:false}}>Reset</Button>
</Card>`;

test("全部基础组件、默认值和派生值可读", () => {
	const model = block(FORM);
	assert.deepEqual(model.initial, { seats: 4, city: "Kyoto", extras: [], remote: false });
	const drawing = elements(resolveBlock(model, { ...model.initial, seats: 7, city: "Tainan", remote: true, extras: ["notes"] }));
	assert.equal(drawing.find((item) => item.node.name === "Stat")?.props.value, 8400);
	assert.equal(drawing.find((item) => item.node.name === "Text")?.children.join(""), "Remote in Tainan");
	assert.equal(drawing.find((item) => item.node.name === "Text")?.props.when, true);
	const send = drawing.find((item) => item.node.name === "Button")!;
	const action = actionOf(model, send.node, { ...model.initial, seats: 7, extras: ["tea"] });
	assert.equal(action.words, "Book 7 seats in Kyoto");
	assert.equal(action.payload, 'Book 7 seats in Kyoto\n\n<interface-values>{"seats":7,"city":"Kyoto","extras":["tea"],"remote":false}</interface-values>');
});

test("set 和 send 同时使用时先更新值，再生成预览与实际提交", () => {
	const model = block('<Input name="n" value={2}/><Button set={{n:n+1}} send="Choose {n}">Choose</Button>');
	const button = elements(resolveBlock(model, model.initial)).find((item) => item.node.name === "Button")!;
	assert.deepEqual(actionOf(model, button.node, model.initial), { values: { n: 3 }, words: "Choose 3", payload: spoken("Choose 3", { n: 3 }) });
	assert.deepEqual(model.initial, { n: 2 });
});

test("数字选项保留原类型，单选不显示一个值却提交另一个", () => {
	const model = block(
		'<Select name="count" options={[{label:"Two",value:2},3]}/><Choice name="mode" options={["a","b"]}/><Button send="Choose {count}">Choose</Button>',
	);
	assert.deepEqual(model.initial, { count: 2, mode: "a" });
	assert.throws(() => resolveBlock(model, { count: "2", mode: "a" }));
	assert.throws(() => resolveBlock(model, { count: 2, mode: "missing" }));
	assert.throws(() => resolveBlock(model, { count: 2, mode: "a", extra: 1 }));
});

test("多个文本表达式、比较符、嵌套对象及引号边界", () => {
	const model = block('<Input name="n" value={2}/><Heading level={1}>Count {n}</Heading><Text>{n} {n < 3 ? "less" : "more"} {"<"} {"}"}</Text>');
	assert.equal(
		elements(resolveBlock(model, model.initial))
			.find((item) => item.node.name === "Text")!
			.children.join(""),
		"2 less < }",
	);
	assert.equal(block('<Card title={"quote > value"}><Text>{join(["x", "y"], " / ")}</Text></Card>').nodes.length, 1);
	assert.equal(block("<!-- note --><Text>plain &amp; text</Text>").nodes.length, 1);
});

test("流式标签原子出现；完整块不能漏掉未完成的尾部", () => {
	const prefix = '<Stack><Text>Ready</Text><Chart data={[{day:"Mon",n:';
	const parsed = parseBlock(prefix);
	assert.equal(parsed.problems.length, 0);
	assert.equal(parsed.incomplete, true);
	assert.equal(parsed.pending?.name, "Chart");
	assert.equal(parsed.pending?.parent, parsed.nodes[0]);
	assert.equal(prepareBlock(prefix, false).ok, true);
	assert.equal(prepareBlock(prefix, true).ok, false);
	for (const source of ["<Text>hello {1 +", "<Text>hello</Text><", "<Text>hello</Text><!--", "<Text>hello</Text></"])
		assert.equal(prepareBlock(source, true).ok, false, source);
	for (let index = 0; index < FORM.length; index++) assert.doesNotThrow(() => prepareBlock(FORM.slice(0, index), false));
});

test("未知组件、未知属性、错误语法及未支持内容全部拒绝", () => {
	const rejected = [
		"<Unknown><Text>Never silently lose this</Text></Unknown>",
		"<Tabs><Text>Only tabs allowed</Text></Tabs>",
		"<div>HTML</div>",
		"<constructor/>",
		'<Text html="x">No</Text>',
		'<Text constructor="x">No</Text>',
		'<Text style={{color:"var(--plume-danger)"}}>No</Text>',
		'<Text size="xl">No</Text>',
		'<Text tone="muted" tone="danger">No</Text>',
		"<Text><Card/></Text>",
		'<Input name="x">Lost child</Input>',
		'<Input name="x"/><Input name="x"/>',
		'<Input name="constructor"/>',
		'<Input name="true"/>',
		'<Input name="sum"/>',
		'<Input name={"x"}/>',
		'<Input name="x"/><Input name="y" value={x}/>',
		'<Input name="x"/><Select name="s" options={[x]}/>',
		"<Button>Nothing</Button>",
		'<Button send="">Empty</Button>',
		'<Button send="go"/>',
		"<Button set={{missing:1}}>Unknown state</Button>",
		'<Toggle name="x"/><Button set={{x:"wrong"}}>Wrong type</Button>',
		'<Input name="x"/><Button set={{x:{nested:1}}}>Wrong value</Button>',
		"<Text>{window.location}</Text>",
		"<Text>{alert(1)}</Text>",
		"<Text>{unknown}</Text>",
		"<Text>{1/0}</Text>",
		"<Text>{1 + }</Text>",
		'<Card title="Bad {unknown}"/>',
		'<Card title="Bad {1 +}"/>',
		'<Card title="Bad {"/>',
		"<Grid cols={0}/>",
		"<Heading level={4}>Wrong</Heading>",
		'<Text when={false} unknown="still bad">Hidden</Text>',
		"<Card><Text>Bad nesting</Card>",
		"<Text>Closed</Text></Text>",
		"<Text tone=muted>Not quoted</Text>",
		'<Chart kind="scatter" data={[]}/>',
		'<Table columns={["a"]} rows={[[1,2]]}/>',
		'<Select name="s" options={[]}/>',
		'<Choice name="c" options={["a","a"]}/>',
		'<Choice name="c" options={["a"]} value="b"/>',
	];
	for (const source of rejected) assert.equal(prepareBlock(source, true).ok, false, source);
	assert.equal(prepareBlock("<Text>" + "x".repeat(50000) + "</Text>", true).ok, false);
	assert.equal(prepareBlock("<Stack>".repeat(65) + "</Stack>".repeat(65), true).ok, false);
});

test("页签、滑杆、进度、提示和徽章与初始状态一致", () => {
	const model = block(
		'<Tabs name="view"><Tab title="Overview"><Slider name="n" min={2} max={10} step={2}/><Progress value={n} max={10}/><Badge tone="ok">Ready</Badge></Tab><Tab title="More"><Callout title="Note"><Text>Details</Text></Callout><Divider/></Tab></Tabs>',
	);
	assert.deepEqual(model.initial, { view: "Overview", n: 2 });
	assert.equal(elements(resolveBlock(model, { view: "More", n: 8 })).find((item) => item.node.name === "Progress")?.props.value, 8);
	assert.throws(() => resolveBlock(model, { view: "Missing", n: 8 }));
	assert.throws(() => resolveBlock(model, { view: "More", n: 11 }));
	assert.deepEqual(block('<Tabs><Tab title="One"/><Tab title="Two"/></Tabs>').initial, {});
	assert.deepEqual(block('<Toggle name="visible" value/><Tabs name="tab"><Tab title="One" when={visible}/></Tabs>').initial, { visible: true, tab: "One" });
	for (const source of [
		'<Tab title="outside"/>',
		"<Tabs/>",
		'<Tabs><Tab title="same"/><Tab title="same"/></Tabs>',
		'<Slider name="x" step={0}/>',
		'<Slider name="x" step={2} value={3}/>',
		'<Slider name="x" min={2} max={1}/>',
	])
		assert.equal(prepareBlock(source, true).ok, false, source);
	assert.equal(prepareBlock('<Tabs name="tab"><Tab title="First"><Text>Writing', false).ok, true);
});

test("Each 的嵌套作用域进入文字和按钮，set 后重新计算 send 而不发送局部变量", () => {
	const model = block(
		'<Input name="n" value={1}/><Each of={[{id:"a",list:[3,4]},{id:"b",list:[5]}]} as="row" index="i"><Each of={row.list} as="amount" index="j"><Text>{i}:{j}:{row.id}:{amount}</Text><Button set={{n:n+amount}} send="{row.id} {n}">Choose {amount}</Button></Each></Each>',
	);
	const drawing = elements(resolveBlock(model, model.initial));
	assert.deepEqual(
		drawing.filter((item) => item.node.name === "Text").map((item) => item.children.join("")),
		["0:0:a:3", "0:1:a:4", "1:0:b:5"],
	);
	const button = drawing.filter((item) => item.node.name === "Button")[2]!;
	assert.deepEqual(actionOf(model, button.node, model.initial, button.locals), { values: { n: 6 }, words: "b 6", payload: spoken("b 6", { n: 6 }) });
	assert.equal(new Set(drawing.map((item) => item.path)).size, drawing.length);
	for (const source of [
		'<Each of={[]} as="constructor"/>',
		'<Each of={[]} as={"row"}/>',
		'<Each of={[]} as="x" index="x"/>',
		'<Input name="item"/><Each of={[]}/>',
		"<Each of={[]}><Text>{unknown}</Text></Each>",
		"<Each of={[]}><Each of={[]}/></Each>",
	])
		assert.equal(prepareBlock(source, true).ok, false, source);
	assert.equal(prepareBlock(`<Each of={${JSON.stringify(Array(201).fill(1))}}><Text>{item}</Text></Each>`, true).ok, false);
	const list = JSON.stringify(Array(100).fill(1));
	assert.equal(prepareBlock(`<Each of={${list}} as="a"><Each of={${list}} as="b"><Text>{a+b}</Text></Each></Each>`, true).ok, false);
});
