/**
 * 对话里已经有的图，最新的在前——`image_generate` 的 `#1`、`#2` 指的就是它们。
 *
 * 用编号不用 id：模型看不到附件的 id，它看到的是图本身。「最新那张」是人指刚贴的图、指刚画的图时共同的说法，
 * 两种在这里按同一条规则数。数的是每条消息，从最新的往回：附件、之前画的、别的工具交回的图（截图、读进来的 PNG）。
 * 只把点到的那张从磁盘读出来：一段长对话里可能有几百张。
 */

import type { Message } from "@plume/contract";
import { IMAGE_TOOL } from "./types.ts";

/** 对话里的一张图，还没读：留在消息里的小图带着像素，挪进媒体目录的只有名字。 */
export interface Picture {
	data?: string;
	media?: string;
	mimeType: string;
}

function picturesOf(message: Message): Picture[] {
	if (message.role === "assistant") return [];
	/*
	 * 画出来的图按工具自己的记录数，不按内容：结果的内容里也带着给模型看的图，但超过大小的那张不在里面，
	 * 只有 `details` 每张都记着。两边都读的话每张图算两次。
	 */
	if (message.role === "toolResult" && message.toolName === IMAGE_TOOL) {
		const details = message.details as { images?: { media?: string; mimeType?: string }[] } | undefined;
		if (details?.images) return details.images.flatMap((image) => (image.media ? [{ media: image.media, mimeType: image.mimeType ?? "image/png" }] : []));
	}
	return message.content.flatMap((part) =>
		part.type === "image" && (part.data || part.media)
			? [{ ...(part.data ? { data: part.data } : {}), ...(part.media ? { media: part.media } : {}), mimeType: part.mimeType }]
			: [],
	);
}

/** 全部的图，最新的在前，一张都不读。同一个文件出现几次只算一次。 */
export function conversationPictures(messages: readonly Message[]): Picture[] {
	const all: Picture[] = [];
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message) all.push(...picturesOf(message));
	}
	const seen = new Set<string>();
	return all.filter((picture) => {
		if (!picture.media) return true;
		if (seen.has(picture.media)) return false;
		seen.add(picture.media);
		return true;
	});
}
