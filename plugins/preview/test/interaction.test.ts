import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { Message } from "@plume/contract";
import { withBridge } from "../src/bridge.ts";
import { draftArguments, draftDocument, draftPhase } from "../src/draft.ts";
import { partialJson } from "../src/partial-json.ts";
import { placements } from "../src/placement.ts";
import { readTweaks, TWEAKS_MESSAGE, TWEAK_SET_MESSAGE, tweakValue } from "../src/tweaks.ts";

test("流式 JSON 保留半截正文，忽略半截键及数字，限制深度且不污染原型", () => {
	const args = draftArguments({}, '{"title":"草稿","files":[{"path":"index.html","content":"<h1>\\u4f60');
	assert.equal(draftDocument(args)?.html, "<h1>你");
	assert.equal(draftPhase("<style>h1{"), "styles");
	assert.equal(draftPhase("<style></style><h1>"), "markup");
	assert.equal(draftPhase("<script>const a="), "script");
	const value = partialJson('{"__proto__":{"polluted":true},"number":12') as Record<string, unknown>;
	assert.equal(Object.getPrototypeOf(value), null);
	assert.equal("number" in value, false);
	assert.doesNotThrow(() => partialJson("[".repeat(100_000)));
	assert.doesNotThrow(() => partialJson('{"x":01,'));
	assert.equal(draftDocument({ path: "index.html" }), null);
	assert.deepEqual(
		draftDocument({
			files: [
				{ path: "page.html", content: "<p>ok" },
				{ path: "x.css", content: "p{}" },
			],
			entry: "page.html",
		}),
		{ html: "<p>ok", css: ["p{}"] },
	);
});

const call = (id: string, args: Record<string, unknown>) => ({
	role: "assistant",
	stopReason: "toolUse",
	content: [{ type: "toolCall", name: "preview", id, arguments: args }],
});
const checked = (id: string) => ({ role: "toolResult", toolCallId: id, details: { kind: "preview-check", id: "page" } });
const map = (messages: unknown[], running = true) => placements(messages as Message[], running);
test("检查草稿在同轮发布时原地交接，切片重查、失败和跨轮发布不抢位置", () => {
	const start = [call("check", { html: "<p>ok", check: true }), checked("check")];
	assert.deepEqual(map(start).get("check"), { waiting: true });
	const streaming = {
		role: "assistant",
		stopReason: "pending",
		content: [{ type: "toolCall", id: "publish", name: "preview", arguments: {}, argumentsText: '{"id":"pa' }],
	};
	assert.deepEqual(map([...start, streaming]).get("check"), { waiting: true });
	assert.deepEqual(map([...start, streaming]).get("publish"), { publishing: true });
	const reslice = [...start, call("slice", { id: "page", check: true }), checked("slice")];
	assert.deepEqual(map(reslice).get("check"), { waiting: true });
	assert.equal(map(reslice).has("slice"), false);
	const published = [...reslice, call("publish", { id: "page" })];
	assert.deepEqual(map(published).get("check"), { publishedBy: "publish" });
	assert.deepEqual(map(published).get("publish"), { publishing: true });
	assert.equal(map([...published, { role: "toolResult", toolCallId: "publish", isError: true }]).has("check"), false);
	assert.equal(map(start, false).size, 0);
	assert.equal(map([...start, { role: "user", content: [] }, call("publish", { id: "page" })]).size, 0);
});

test("旋钮只接收有效种类、数值、颜色与选项，数量受限", () => {
	const groups = readTweaks({
		[TWEAKS_MESSAGE]: [
			{
				label: "Design",
				controls: [
					{ id: "0.0", kind: "slider", label: "Size", min: 0, max: 10, step: 0.5, value: 4.24 },
					{ id: "0.1", kind: "color", value: "#ABCDEF" },
					{ id: "0.2", kind: "toggle", value: true },
					{ id: "0.3", kind: "select", options: ["a", "b"], value: "a" },
					{ id: "0.4", kind: "slider", min: 0, max: 2, step: 0, value: 1 },
					{ id: "__proto__", kind: "toggle", value: true },
				],
			},
		],
	});
	assert.equal(groups?.[0]?.controls.length, 4);
	assert.equal(groups![0]!.controls[0]!.value, 4);
	assert.equal(groups![0]!.controls[1]!.value, "#abcdef");
	assert.equal(tweakValue(groups![0]!.controls[0]!, Infinity), null);
	assert.equal(tweakValue(groups![0]!.controls[0]!, 100), 10);
	assert.equal(tweakValue(groups![0]!.controls[3]!, "c"), null);
	assert.equal(readTweaks(null), null);
	assert.equal(readTweaks({ [TWEAKS_MESSAGE]: Array(100).fill(groups![0]) })?.length, 12);
});

test("页面桥在真实事件派发中才发送，绑定修改批量应用且只重绘一次", async () => {
	const handlers = new Map<string, ((event: unknown) => void)[]>();
	const sent: unknown[] = [];
	const parent = { postMessage: (data: unknown) => sent.push(data) };
	const context: Record<string, unknown> = {
		parent,
		location: { hash: "#inline=" },
		URLSearchParams,
		TextEncoder,
		document: { documentElement: { classList: { add() {} } } },
		ResizeObserver: class {
			observe() {}
		},
		setTimeout() {},
		addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
	};
	context.window = context;
	const script = /<script>([\s\S]*?)<\/script>/.exec(withBridge("<p>test"))![1]!;
	runInNewContext(script, context);
	const plume = context.plume as { send(text: string): boolean; setState(value: unknown): boolean };
	assert.equal(plume.setState({ count: 1 }), true);
	assert.ok(sent.some((item) => (item as { preview?: string }).preview === "state"));
	assert.equal(plume.send("load"), false);
	const gesture = { isTrusted: true, eventPhase: 2 };
	handlers.get("click")![0]!(gesture);
	assert.equal(plume.send("human"), true);
	assert.equal(plume.send("duplicate"), false);
	gesture.eventPhase = 0;
	assert.equal(plume.send("timer"), false);
	runInNewContext(
		'var model={size:2,on:true};var draws=0;plume.tweak({label:"Design",onChange:function(){draws++}}).slider(model,"size",{min:0,max:10}).toggle(model,"on");',
		context,
	);
	await Promise.resolve();
	assert.ok(sent.some((item) => readTweaks(item)?.length === 1));
	const update = {
		[TWEAK_SET_MESSAGE]: [
			{ id: "0.0", value: 5 },
			{ id: "0.1", value: false },
		],
	};
	for (const handler of handlers.get("message")!) handler({ source: {}, data: update });
	assert.equal(context.draws, 0);
	for (const handler of handlers.get("message")!) handler({ source: parent, data: update });
	assert.equal(context.draws, 1);
	assert.equal((context.model as { size: number }).size, 5);
});

test("应用不在前台时页面停在当前帧：rAF 攒着、动画暂停，回来时一起放行；取消攒着的回调也算数", () => {
	const handlers = new Map<string, ((event: unknown) => void)[]>();
	const parent = { postMessage() {} };
	const queued = new Map<number, () => void>();
	let next = 0;
	const animation = { playState: "running", pause: () => (animation.playState = "paused"), play: () => (animation.playState = "running") };
	const context: Record<string, unknown> = {
		parent,
		location: { hash: "#inline=" },
		URLSearchParams,
		TextEncoder,
		document: { documentElement: { classList: { add() {} } }, getAnimations: () => [animation] },
		ResizeObserver: class {
			observe() {}
		},
		setTimeout() {},
		requestAnimationFrame: (callback: () => void) => (queued.set(++next, callback), next),
		cancelAnimationFrame: (id: number) => queued.delete(id),
		addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
	};
	context.window = context;
	runInNewContext(/<script>([\s\S]*?)<\/script>/.exec(withBridge("<p>test"))![1]!, context);
	const pause = (value: boolean, source: unknown = parent) => {
		for (const handler of handlers.get("message")!) handler({ source, data: { preview: "pause", value } });
	};
	const frame = context.requestAnimationFrame as (callback: () => void) => number;
	const cancel = context.cancelAnimationFrame as (id: number) => void;
	const ran: string[] = [];

	frame(() => ran.push("before"));
	assert.equal(queued.size, 1, "在前台时照常交给浏览器");
	pause(true, {});
	assert.equal(animation.playState, "running", "别处来的消息不算");
	pause(true);
	assert.equal(animation.playState, "paused");
	frame(() => ran.push("held"));
	cancel(frame(() => ran.push("cancelled")));
	assert.equal(queued.size, 1, "停着时攒在页面里，不交给浏览器");
	pause(false);
	assert.equal(animation.playState, "running");
	for (const callback of queued.values()) callback();
	queued.clear();
	assert.deepEqual(ran, ["before", "held"]);

	// 焦点从页面里直接离开应用：外面的窗口收不到事件，页面自己的 blur 接住；回到前台时卡片放行。
	for (const handler of handlers.get("blur")!) handler({});
	assert.equal(animation.playState, "paused");
	const moved = frame(() => ran.push("moved"));
	pause(false);
	assert.equal(animation.playState, "running");
	assert.equal(queued.size, 1);
	cancel(moved);
	assert.equal(queued.size, 0, "放行后取消攒过的回调，取消的是交给浏览器的那一个");
});
