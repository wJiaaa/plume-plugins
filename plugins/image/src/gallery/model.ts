/**
 * 画廊的数据，按页面要的样子摆好：按名字找图、每张图的一家子、搜索。
 *
 * 逻辑入口交来画出来的图（`pictures`）、输进生图却不是画出来的图（`inputs`：附件、截图）和两者指向的会话。
 * 格子里只列画出来的；一段来历从它最早的那张图起头，不管那张是不是画出来的。
 *
 * 不引 React 和 `@plume/ui`：测试直接跑这里。
 */

import type { Gallery, GalleryInput, GalleryPicture, GallerySession } from "../api.ts";
import type { SessionChange } from "@plume/contract/ui";
import { IMAGE_TOOL } from "../types.ts";
import type { FamilyNode } from "./lineage-tree.ts";

export type Drawn = { kind: "drawn" } & GalleryPicture;
export type Entry = Drawn | ({ kind: "given" } & GalleryInput);

export interface GalleryIndex {
	/** 画出来的图，新的在前：格子的顺序，也是 ← → 翻的顺序。 */
	drawn: Drawn[];
	byMedia: ReadonlyMap<string, Entry>;
	sessions: ReadonlyMap<string, GallerySession>;
	/** 每张图在家谱里的节点，给 `familyOf`。 */
	nodes: ReadonlyMap<string, FamilyNode>;
}

/** 只在新图落盘或画廊已有会话的资料变化时重读。 */
export function changesGallery(change: SessionChange, gallery: Gallery | null): boolean {
	if (change.type === "messages") return change.tools?.includes(IMAGE_TOOL) ?? false;
	return change.type === "deleted" || Boolean(gallery?.sessions.some((session) => session.id === change.sessionId));
}

export function indexGallery(gallery: Gallery): GalleryIndex {
	const byMedia = new Map<string, Entry>();
	for (const input of gallery.inputs) byMedia.set(input.media, { kind: "given", ...input });
	for (const picture of gallery.pictures) byMedia.set(picture.media, { kind: "drawn", ...picture });
	const nodes = new Map<string, FamilyNode>();
	for (const entry of byMedia.values()) {
		nodes.set(entry.media, {
			id: entry.media,
			at: entry.at,
			index: entry.kind === "drawn" ? entry.nth : -1,
			// 标注过的副本挂在它标注的那张图下面，来历经过这一步标注接下去。
			parents: (entry.kind === "drawn" ? entry.sources : entry.from ? [entry.from] : []).filter((source) => byMedia.has(source)),
		});
	}
	const drawn = [...byMedia.values()].filter((entry): entry is Drawn => entry.kind === "drawn").sort((a, b) => b.at - a.at || b.nth - a.nth);
	return { drawn, byMedia, sessions: new Map(gallery.sessions.map((session) => [session.id, session])), nodes };
}

/**
 * 人打的字，拿掉附件在里面留下的 【图片 1】 标记。
 *
 * 标记写的是附件在界面上的名字（`label`），没有才是文件名；第二个 【图片 1】 认第二个叫这个名字的附件。
 * 认不出的 【…】 原样留着：中文里方括号是普通标点。
 */
export function askText(entry: Entry): string {
	const ask = entry.ask;
	if (!ask) return "";
	const names = ask.attachments.map((file) => file.label ?? file.name);
	let text = ask.text;
	if (names.length && text.includes("【")) {
		const taken = new Set<number>();
		let out = "";
		let at = 0;
		while (at < text.length) {
			const open = text.indexOf("【", at);
			if (open === -1) break;
			const close = text.indexOf("】", open + 1);
			if (close === -1) break;
			const name = text.slice(open + 1, close);
			const file = names.findIndex((candidate, index) => candidate === name && !taken.has(index));
			if (file === -1) {
				out += text.slice(at, open + 1);
				at = open + 1;
				continue;
			}
			taken.add(file);
			out += text.slice(at, open);
			at = close + 1;
		}
		text = (out + text.slice(at)).replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n");
	}
	return text.trim();
}

/** 拿去和说过的话、模型写的提示词、会话标题比；每个词都要对上。 */
export function matches(entry: Entry, session: GallerySession | undefined, query: string): boolean {
	const needle = query.trim().toLocaleLowerCase();
	if (!needle) return true;
	const haystack = [askText(entry), entry.kind === "drawn" ? entry.prompt : "", session?.title ?? ""].join("\n").toLocaleLowerCase();
	return needle.split(/\s+/).every((word) => haystack.includes(word));
}

/** 这张图本身；是输入的话，用它画出的最早那张：「在对话中查看」滚到的就是它。 */
export function drawingFor(entry: Entry, index: GalleryIndex): Drawn | null {
	if (entry.kind === "drawn") return entry;
	return index.drawn.filter((picture) => picture.sources.includes(entry.media)).sort((a, b) => a.at - b.at)[0] ?? null;
}

/**
 * 从画廊发出去的一次修改画出了哪张：`since` 以后、用 `from` 本身或它的标注副本画的，最早的那张。
 * 标注副本也算：修改拿到的就是那份副本。
 */
export function editedFrom(gallery: Gallery, from: string, since: number): GalleryPicture | undefined {
	const copies = new Set(gallery.inputs.filter((input) => input.from === from).map((input) => input.media));
	return gallery.pictures
		.filter((picture) => picture.at >= since && picture.sources.some((source) => source === from || copies.has(source)))
		.sort((a, b) => a.at - b.at)[0];
}
