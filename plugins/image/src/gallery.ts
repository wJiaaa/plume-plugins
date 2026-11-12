/**
 * 画廊的数据：所有会话里画过的图，各自从哪来。
 *
 * 插件读不到会话库，只能一个个会话读消息：第一次打开画廊把会话都读一遍，之后只重读 `updatedAt` 变了的。
 * 只算侧栏里的会话（`kind` 是 top）：子会话（子智能体、侧边聊天）画的图在父会话里看不到，跳过去要打开插件的面板；
 * 插件的独立会话不在侧栏里，跳不过去。
 */

import type { SessionAccess } from "@plume/contract";
import type { Gallery, GalleryInput, GalleryPicture } from "./api.ts";
import { type Drawings, drawingsIn } from "./lineage.ts";

export class GalleryReader {
	/** 每个会话画过的图，和读它时会话的 `updatedAt`。 */
	private readonly read = new Map<string, { updatedAt: number; drawings: Drawings }>();

	constructor(private readonly sessions: Pick<SessionAccess, "list" | "messages">) {}

	async list(): Promise<Gallery> {
		const summaries = (await this.sessions.list()).filter((summary) => summary.kind === "top");
		const live = new Set<string>();
		for (const summary of summaries) {
			live.add(summary.id);
			if (this.read.get(summary.id)?.updatedAt === summary.updatedAt) continue;
			const messages = await this.sessions.messages(summary.id).catch(() => null);
			if (messages) this.read.set(summary.id, { updatedAt: summary.updatedAt, drawings: drawingsIn(messages) });
		}
		for (const id of this.read.keys()) if (!live.has(id)) this.read.delete(id);

		// 分叉连图一起复制过去，而且一定晚于原会话：先按建的先后排，每张图就记在画它的那个会话名下。
		const ordered = summaries.filter((summary) => this.read.has(summary.id)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
		const pictures = new Map<string, GalleryPicture>();
		for (const summary of ordered) {
			for (const picture of this.read.get(summary.id)?.drawings.drawn ?? [])
				if (!pictures.has(picture.media)) pictures.set(picture.media, { ...picture, sessionId: summary.id });
		}
		// 和某张画出来的图一个字节都不差的附件，就是那张图，又附上来改。
		const inputs = new Map<string, GalleryInput>();
		for (const summary of ordered) {
			for (const input of this.read.get(summary.id)?.drawings.given ?? []) {
				if (!pictures.has(input.media) && !inputs.has(input.media)) inputs.set(input.media, { ...input, sessionId: summary.id });
			}
		}
		const used = new Set([...pictures.values(), ...inputs.values()].map((picture) => picture.sessionId));
		return {
			pictures: [...pictures.values()].sort((a, b) => a.at - b.at || a.nth - b.nth),
			inputs: [...inputs.values()],
			sessions: ordered
				.filter((summary) => used.has(summary.id))
				.map((summary) => ({
					id: summary.id,
					title: summary.title,
					...(summary.project ? { project: summary.project } : {}),
					archived: summary.archived === true,
					createdAt: summary.createdAt,
					updatedAt: summary.updatedAt,
				})),
		};
	}

	/** 会话删掉了：它的图跟着从画廊里消失。 */
	forget(sessionId: string): void {
		this.read.delete(sessionId);
	}
}
