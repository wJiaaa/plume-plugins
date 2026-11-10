/**
 * 画廊对对话做的事：把一张图连同要怎么改，送回它所在的对话。
 */

import type { ComposerImage, UiContext } from "@plume/contract/ui";
import type { GalleryMessages } from "../messages.ts";

const MIME_TYPES: readonly ComposerImage["mimeType"][] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** 把一张图读成 `data:` URL。 */
async function readDataUrl(src: string): Promise<string> {
	const response = await fetch(src);
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const blob = await response.blob();
	return await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});
}

/**
 * 再要一次这张图，改过的：发进它自己的对话，带着这张图。
 *
 * 字节原样送回去，附件就是媒体目录里和这张图同一个文件——从它改出来的图记作从这张改的，来历接得上。
 * 标注副本是一张新图，作为 `marked` 进来，记着它标注的是哪张。
 *
 * 有字就直接发出去，和输入框里按发送一样；没字就打开对话，图挂在输入框里等人补一句。
 */
export async function editInConversation(
	ui: Pick<UiContext, "mediaUrl" | "draftInSession" | "notify">,
	m: GalleryMessages,
	picture: { sessionId: string; media: string },
	words: string,
	marked?: string,
): Promise<boolean> {
	const src = ui.mediaUrl(picture.media);
	const dataUrl = marked ?? (src ? await readDataUrl(src).catch(() => null) : null);
	const comma = dataUrl?.indexOf(",") ?? -1;
	const mimeType = MIME_TYPES.find((type) => dataUrl?.startsWith(`data:${type};`));
	if (!dataUrl || comma < 0 || !mimeType) {
		ui.notify(m.unreadable, "error");
		return false;
	}
	const text = words.trim();
	try {
		await ui.draftInSession(picture.sessionId, {
			text,
			images: [{ data: dataUrl.slice(comma + 1), mimeType, ...(marked ? { from: picture.media } : {}) }],
			send: Boolean(text),
		});
	} catch {
		ui.notify(m.conversationGone, "error");
		return false;
	}
	return true;
}
