/**
 * 画廊读到了什么、开着哪张图。
 *
 * 放在模块里而不是页面里：离开画廊再回来，页面会重新挂上，空着从头读的话，刚才还在屏幕上的图上面会先闪一层骨架。
 */

import { useSyncExternalStore } from "react";
import type { Gallery } from "../api.ts";
import { editedFrom } from "./model.ts";

interface GalleryState {
	gallery: Gallery | null;
	/** `loading` 只到第一次有东西可看为止；之后再读，就地换掉屏幕上的。 */
	status: "idle" | "loading" | "ready" | "error";
	error: string;
	/** 详情里开着的图，按媒体目录里的名字。 */
	open: string | null;
	query: string;
}

let state: GalleryState = { gallery: null, status: "idle", error: "", open: null, query: "" };
const listeners = new Set<() => void>();

function set(next: Partial<GalleryState>): void {
	state = { ...state, ...next };
	for (const listener of listeners) listener();
}

export function useGallery<T>(select: (state: GalleryState) => T): T {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => select(state),
	);
}

let reading: Promise<void> | null = null;
let again = false;
/**
 * 屏幕上那份和它读出来时的样子。几乎每次重读拿回来的都和手上的一样：换成一个新对象的话，相册里每一格都要白白重画一遍。
 */
let lastRead: { gallery: Gallery; text: string } | null = null;

/**
 * 再读一遍。正在读的时候又叫，就让那一次读完再转一圈，而不是另起一次：读到一半画好的图照样能接住。
 */
export function refreshGallery(api: { gallery(): PromiseLike<Gallery> }): Promise<void> {
	if (reading) {
		again = true;
		return reading;
	}
	reading = (async () => {
		do {
			again = false;
			if (!state.gallery) set({ status: "loading" });
			try {
				const read = await api.gallery();
				const text = JSON.stringify(read);
				const held = state.gallery;
				const gallery = held && held === lastRead?.gallery && text === lastRead.text ? held : read;
				lastRead = { gallery, text };
				set({ gallery, status: "ready", error: "" });
				arrived(gallery);
			} catch (error) {
				set({ status: state.gallery ? "ready" : "error", error: error instanceof Error ? error.message : String(error) });
			}
		} while (again);
	})().finally(() => {
		reading = null;
	});
	return reading;
}

export function openPicture(media: string | null): void {
	set({ open: media });
}

export function setGalleryQuery(query: string): void {
	set({ query });
}

/** 从画廊发出去的一次修改，等着它画出来，好让画廊换到结果上。 */
let awaiting: { from: string; since: number } | null = null;

/** 等多久。回复问了一句话而没画图时，过很久以后不该突然把画廊拽走。 */
const AWAIT_MS = 10 * 60_000;

export function awaitEdit(from: string, since = Date.now()): void {
	awaiting = { from, since };
	// 发送返回前结果也可能已经读到，不能只等下一次会话变更。
	if (state.gallery) arrived(state.gallery);
}

/** 等着的修改画好了：开着的还是原图时换成它；人已经翻到别的图上，就不拽回来。 */
function arrived(gallery: Gallery): void {
	if (!awaiting) return;
	if (Date.now() - awaiting.since > AWAIT_MS) {
		awaiting = null;
		return;
	}
	const made = editedFrom(gallery, awaiting.from, awaiting.since);
	if (!made) return;
	const { from } = awaiting;
	awaiting = null;
	if (state.open === from) set({ open: made.media });
}
