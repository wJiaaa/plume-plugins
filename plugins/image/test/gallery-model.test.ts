/**
 * 画廊的数据整理：按名字找图、家谱的节点、搜索、「在对话中查看」滚到哪张、从画廊改的图画好了是哪张。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Gallery, GalleryInput, GalleryPicture } from "../src/api.ts";
import { askText, changesGallery, drawingFor, editedFrom, indexGallery, matches } from "../src/gallery/model.ts";

const name = (letter: string) => `${letter.repeat(40)}.png`;

const picture = (media: string, at: number, extra: Partial<GalleryPicture> = {}): GalleryPicture => ({
	media,
	mimeType: "image/png",
	index: 1,
	toolCallId: `call-${media.slice(0, 4)}`,
	nth: 0,
	count: 1,
	at,
	prompt: "a dog",
	model: { id: "m", name: "Model" },
	sources: [],
	sessionId: "s1",
	...extra,
});

const input = (media: string, at: number, extra: Partial<GalleryInput> = {}): GalleryInput => ({ media, mimeType: "image/png", at, sessionId: "s1", ...extra });

const gallery = (pictures: GalleryPicture[], inputs: GalleryInput[] = []): Gallery => ({
	pictures,
	inputs,
	sessions: [{ id: "s1", title: "小狗的帽子", archived: false, createdAt: 0, updatedAt: 0 }],
});

test("首次生成立即刷新，已有会话改名归档或删除会刷新，普通消息不重读", () => {
	assert.equal(changesGallery({ sessionId: "new", type: "messages", tools: ["image_generate"] }, null), true);
	assert.equal(changesGallery({ sessionId: "s1", type: "messages", tools: ["read"] }, gallery([])), false);
	assert.equal(changesGallery({ sessionId: "s1", type: "messages" }, gallery([])), false);
	assert.equal(changesGallery({ sessionId: "s1", type: "summary" }, gallery([])), true);
	assert.equal(changesGallery({ sessionId: "other", type: "summary" }, gallery([])), false);
	assert.equal(changesGallery({ sessionId: "s1", type: "deleted" }, null), true);
});

test("画出来的新的在前，同一次调用里按第几张排；附件不进格子", () => {
	const index = indexGallery(
		gallery([picture(name("a"), 1), picture(name("b"), 2, { nth: 0, count: 2 }), picture(name("c"), 2, { nth: 1, count: 2 })], [input(name("d"), 0)]),
	);
	assert.deepEqual(
		index.drawn.map((entry) => entry.media),
		[name("c"), name("b"), name("a")],
	);
	assert.equal(index.byMedia.get(name("d"))?.kind, "given");
	assert.equal(index.sessions.get("s1")?.title, "小狗的帽子");
});

test("家谱的节点：画出来的接在来源上，标注副本接在它标注的那张上，不在画廊里的来源不算", () => {
	const index = indexGallery(
		gallery(
			[picture(name("a"), 1), picture(name("b"), 3, { sources: [name("m"), name("x")] })],
			[input(name("m"), 2, { from: name("a") }), input(name("n"), 2)],
		),
	);
	assert.deepEqual(index.nodes.get(name("b"))?.parents, [name("m")]);
	assert.deepEqual(index.nodes.get(name("m"))?.parents, [name("a")]);
	assert.deepEqual(index.nodes.get(name("n"))?.parents, []);
});

test("同一张图既是附件又是画出来的：按画出来的算", () => {
	const index = indexGallery(gallery([picture(name("a"), 1)], [input(name("a"), 0)]));
	assert.equal(index.byMedia.get(name("a"))?.kind, "drawn");
});

test("说过的话拿掉附件的标记；认不出的方括号原样留着", () => {
	const ask = (text: string, attachments: { name: string; label?: string }[]) => ({
		...picture(name("a"), 1),
		kind: "drawn" as const,
		ask: { text, at: 1, index: 0, attachments },
	});
	assert.equal(askText(ask("把 【图片 1】 里的狗戴上帽子", [{ name: "image.png", label: "图片 1" }])), "把 里的狗戴上帽子");
	assert.equal(askText(ask("这个【重要】别改 【a.png】", [{ name: "a.png" }])), "这个【重要】别改");
	assert.equal(askText(ask("【图片 1】和【图片 1】", [{ name: "x.png", label: "图片 1" }])), "和【图片 1】");
	assert.equal(askText({ ...picture(name("a"), 1), kind: "drawn" }), "");
});

test("搜索：每个词都要在说过的话、提示词或会话标题里", () => {
	const entry = { ...picture(name("a"), 1, { prompt: "A corgi wearing a red hat" }), kind: "drawn" as const };
	const session = { id: "s1", title: "小狗的帽子", archived: false, createdAt: 0, updatedAt: 0 };
	assert.ok(matches(entry, session, ""));
	assert.ok(matches(entry, session, "corgi HAT"));
	assert.ok(matches(entry, session, "帽子 red"));
	assert.ok(!matches(entry, session, "corgi cat"));
});

test("「在对话中查看」：附件跳到用它画的最早那张", () => {
	const index = indexGallery(
		gallery([picture(name("b"), 5, { sources: [name("d")] }), picture(name("c"), 3, { sources: [name("d")] })], [input(name("d"), 1)]),
	);
	const given = index.byMedia.get(name("d"));
	assert.ok(given);
	assert.equal(drawingFor(given, index)?.media, name("c"));
	const lone = indexGallery(gallery([], [input(name("e"), 1)]));
	assert.equal(drawingFor(lone.byMedia.get(name("e")) ?? given, lone), null);
});

test("从画廊改的图：发出以后、用原图或它的标注副本画的最早那张", () => {
	const read = gallery(
		[
			picture(name("a"), 1),
			picture(name("b"), 20, { sources: [name("m")] }),
			picture(name("c"), 30, { sources: [name("a")] }),
			picture(name("d"), 5, { sources: [name("a")] }),
		],
		[input(name("m"), 15, { from: name("a") })],
	);
	assert.equal(editedFrom(read, name("a"), 10)?.media, name("b"));
	assert.equal(editedFrom(read, name("a"), 25)?.media, name("c"));
	assert.equal(editedFrom(read, name("a"), 40), undefined);
	assert.equal(editedFrom(read, name("c"), 0), undefined);
});
