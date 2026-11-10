/**
 * 一个会话里 `image_generate` 画的每张图各是从哪来的。
 *
 * 一张图改几轮就是一条链——狗、戴帽子的狗、抱着狗的女孩——每一环都是一次调用，输入是更早的图。结果里记着输入
 * （`details.sources`）。图按媒体目录里的名字认，那是内容的哈希：分叉过去的同一张、附进别的会话再改的同一张，都是同一个节点。
 */

import type { Message, UserMessage } from "@plume/contract";
import { IMAGE_TOOL, type ImageGenerateDetails } from "./types.ts";

/** 媒体目录里的名字（sha1 加扩展名）；路径取最后一段。认不出是空串。 */
function mediaName(value: string): string {
	const base = value.replace(/^.*[/\\]/, "");
	return /^[a-f0-9]{40}\.(png|jpg|webp|gif)$/.test(base) ? base : "";
}

/** 人说了什么才有这张图：调用之前最近一条人打的消息。 */
interface Ask {
	text: string;
	at: number;
	/** 它在会话消息里的位置。 */
	index: number;
	/** 随它发的文件，按标记里的名字：界面从 `text` 里拿掉 【图片 1】 这样的标记。 */
	attachments: { name: string; label?: string }[];
}

export interface DrawnPicture {
	media: string;
	mimeType: string;
	width?: number;
	height?: number;
	/** 结果在会话消息里的位置。 */
	index: number;
	toolCallId: string;
	/** 这次调用画的第几张、一共几张。 */
	nth: number;
	count: number;
	/** 什么时候到的。 */
	at: number;
	prompt: string;
	revisedPrompt?: string;
	model: { id: string; name: string };
	aspectRatio?: string;
	quality?: string;
	durationMs?: number;
	/** 输进去的图；只凭文字画的是空的。 */
	sources: string[];
	ask?: Ask;
}

/** 输进一次生图、但不是这里画的图：附件、截图。 */
export interface GivenPicture {
	media: string;
	mimeType: string;
	/** 它在这个会话里第一次出现的位置；从没出现过（按路径给的文件）时没有。 */
	index?: number;
	at: number;
	/** 人发它的那条消息。 */
	ask?: Ask;
	/** 它是哪张图的标注副本（`ImageContent.from`）：链路从那张接着往前。 */
	from?: string;
}

export interface Drawings {
	drawn: DrawnPicture[];
	given: GivenPicture[];
}

/** 人打的：不是规则的纠正、催它继续，也不是送回来的报告。 */
function spokenByPerson(message: UserMessage): boolean {
	return !message.synthetic && !message.delivery?.length;
}

/** 够写下任何一句关于图的要求；贴进来的一篇文档不算。 */
const ASK_CHARS = 600;

function askOf(message: UserMessage, index: number): Ask {
	const typed = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n");
	return {
		text: (message.displayText ?? typed).trim().slice(0, ASK_CHARS),
		at: message.timestamp,
		index,
		attachments: (message.attachments ?? []).map((file) => ({ name: file.name, ...(file.label ? { label: file.label } : {}) })),
	};
}

const mimeOfName = (media: string): string =>
	media.endsWith(".jpg") ? "image/jpeg" : media.endsWith(".webp") ? "image/webp" : media.endsWith(".gif") ? "image/gif" : "image/png";

/** 这个会话里画过的每张图，最早的在前，连同各自从哪来。 */
export function drawingsIn(messages: readonly Message[]): Drawings {
	const calls = new Map<string, { prompt: string; ask?: Ask }>();
	/** 每张图第一次出现在哪：人的附件、别的工具的结果、画出来的。 */
	const seen = new Map<string, { index: number; at: number; mimeType: string; ask?: Ask; from?: string }>();
	const drawn: DrawnPicture[] = [];
	let ask: Ask | undefined;

	const see = (media: string | undefined, mimeType: string, index: number, at: number, by?: Ask, from?: string) => {
		const name = mediaName(media ?? "");
		const source = mediaName(from ?? "");
		if (name && !seen.has(name)) seen.set(name, { index, at, mimeType, ...(by ? { ask: by } : {}), ...(source && source !== name ? { from: source } : {}) });
	};

	messages.forEach((message, index) => {
		if (!message || typeof message.role !== "string") return;
		if (message.role === "user") {
			const said = spokenByPerson(message) ? askOf(message, index) : undefined;
			if (said) ask = said;
			for (const part of message.content) if (part.type === "image") see(part.media, part.mimeType, index, message.timestamp, said, part.from);
			return;
		}
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type !== "toolCall" || part.name !== IMAGE_TOOL) continue;
				const prompt = (part.arguments as { prompt?: unknown } | undefined)?.prompt;
				calls.set(part.id, { prompt: typeof prompt === "string" ? prompt.trim() : "", ...(ask ? { ask } : {}) });
			}
			return;
		}
		for (const part of message.content) if (part.type === "image") see(part.media, part.mimeType, index, message.timestamp);
		if (message.toolName !== IMAGE_TOOL) return;
		const details = message.details as Partial<ImageGenerateDetails> | undefined;
		// 画成了的结果带着图，失败的只有 `error`。
		if (message.isError || !details?.images?.length) return;
		const call = calls.get(message.toolCallId);
		const sources = Array.isArray(details.sources) ? details.sources.map(mediaName).filter(Boolean) : [];
		const count = details.images.length;
		details.images.forEach((image, nth) => {
			const media = mediaName(image.media ?? "");
			if (!media) return;
			see(media, image.mimeType, index, message.timestamp);
			drawn.push({
				media,
				mimeType: image.mimeType || mimeOfName(media),
				...(image.width ? { width: image.width, height: image.height } : {}),
				index,
				toolCallId: message.toolCallId,
				nth,
				count,
				at: message.timestamp,
				prompt: call?.prompt ?? "",
				...(details.revisedPrompt ? { revisedPrompt: details.revisedPrompt } : {}),
				model: { id: details.model ?? "", name: details.modelName ?? details.model ?? "" },
				...(details.aspectRatio ? { aspectRatio: details.aspectRatio } : {}),
				...(details.quality ? { quality: details.quality } : {}),
				// 结果在调用结束时写下，它的时间减去 `startedAt` 就是花了多久。
				...(details.startedAt ? { durationMs: Math.max(0, message.timestamp - details.startedAt) } : {}),
				sources: [...new Set(sources)].filter((source) => source !== media),
				...(call?.ask ? { ask: call.ask } : {}),
			});
		});
	});

	const drawnHere = new Set(drawn.map((picture) => picture.media));
	const given = new Map<string, GivenPicture>();
	for (const picture of drawn) {
		for (const source of picture.sources) {
			if (drawnHere.has(source) || given.has(source)) continue;
			const first = seen.get(source);
			given.set(
				source,
				first
					? {
							media: source,
							mimeType: first.mimeType || mimeOfName(source),
							index: first.index,
							at: first.at,
							...(first.ask ? { ask: first.ask } : {}),
							...(first.from ? { from: first.from } : {}),
						}
					: { media: source, mimeType: mimeOfName(source), at: picture.ask?.at ?? picture.at },
			);
		}
	}
	return { drawn, given: [...given.values()] };
}
