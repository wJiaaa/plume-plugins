/**
 * `image_generate`：用人配好的生图模型画图、改图。
 *
 * 和网页搜索一样不弹审批卡：它把一段提示词（和要改的图）发给人自己配好的供应商，拿回几张图，本机上什么都不改。
 * 用哪个模型、花谁的钱是人的决定：默认是设置里选的那个（没选就是第一个生图模型），模型只在人点了名时传 `model`。
 * 一个生图模型都没有时，这个工具不进工具表（见 index.ts 的 `model.context`）。
 *
 * 图存进会话的媒体目录，和会话把消息里的图挪出去用的是同一个按内容起的名字：会话稍后挪这张图时落到同一个文件上，
 * 不会多存一份。不写进项目目录：人要的可能只是看一眼，要放进项目时模型拿着结果里的路径自己复制，那一步照常走写文件的审批。
 */

import { readFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { ImageFailure, ImageInput, ImageModel, PluginContext, PromptSection, ToolDefinition, ToolOutput, ToolRun } from "@plume/contract";
import { MESSAGES } from "./messages.ts";
import { conversationPictures, type Picture } from "./pictures.ts";
import { ASPECT_RATIOS, IMAGE_TOOL, type ImageGenerateDetails, PROGRESS_SEPARATOR, QUALITIES } from "./types.ts";

/** 出图慢：gpt-image 的高质量档一张就要一两分钟，经中转要 4K 的 Gemini 更久。 */
const IMAGE_TIMEOUT_MS = 5 * 60_000;
/** 交给模型看的图最大多少：再大，多数对话模型的接口会整条拒掉。 */
const MAX_SHOWN_BYTES = 5 * 1024 * 1024;
/** 编辑接口单张的上限比对话里看图宽，但一张二十兆的图多半是选错了文件。 */
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_INPUTS = 8;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

/**
 * 什么时候画、画完说多少：加进系统提示词的 Guidelines，只在这个工具在场时加。
 * 不写进 description——那里讲的是怎么调，这两条是对整段对话的约束。
 * 代码画得准的图交给代码；装了交互网页（`preview`）时也点它的名，没装就不提一个不存在的工具。
 */
// i18n-exempt：发给模型的提示词
function imageGuidelines(hasPreview: boolean): string[] {
	return [
		`When the user asks for a picture — an illustration, icon, poster, photo, logo, sticker — or asks to change one, use \`image_generate\`. A chart, diagram or UI that code can draw exactly is better done with code${hasPreview ? " or `preview`" : ""}.`,
		"The picture is shown to the user as it arrives. Afterwards say at most a sentence; don't describe what was drawn unless asked.",
	];
}

/** 把这两条接在准则那段后面。准则那段按类别（`PromptSection.category`）找，不认提供它的插件定的段名。 */
export function withImageGuidelines(sections: PromptSection[], hasPreview: boolean): PromptSection[] {
	const extra = imageGuidelines(hasPreview)
		.map((line) => `- ${line}`)
		.join("\n");
	return sections.map((section) => (section.category === "guidelines" ? { ...section, text: `${section.text}\n${extra}` } : section));
}

/** 文件头认出来的图片类型；PNG、JPEG、WebP 以外的是 null。 */
function sniff(bytes: Uint8Array): ImageType | null {
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
	if (String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
	return null;
}

/** 给模型看的路径：工作目录里的写相对路径，外面的写绝对路径。 */
function shownPath(cwd: string, path: string): string {
	const rel = relative(cwd, path);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

function seconds(ms: number): string {
	return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

function wait(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) return `${Math.ceil(ms / 1000)} seconds`;
	if (minutes < 60) return `${minutes} minutes`;
	return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
}

/** 输入图的宽高比，从文件头读；读不出来是 undefined。只认 PNG 和 JPEG 的头：改图的输入多是这两种，读不出来卡片照正方形占位。 */
function shapeOf(input: ImageInput | undefined): number | undefined {
	if (!input) return undefined;
	const bytes = Buffer.from(input.data.slice(0, 64 * 1024), "base64");
	let width = 0;
	let height = 0;
	if (sniff(bytes) === "image/png" && bytes.length >= 24) {
		width = bytes.readUInt32BE(16);
		height = bytes.readUInt32BE(20);
	} else if (sniff(bytes) === "image/jpeg") {
		let at = 2;
		while (at + 9 < bytes.length && bytes[at] === 0xff) {
			const marker = bytes[at + 1] ?? 0;
			if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
				at += 2;
				continue;
			}
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				height = bytes.readUInt16BE(at + 5);
				width = bytes.readUInt16BE(at + 7);
				break;
			}
			at += 2 + bytes.readUInt16BE(at + 2);
		}
	}
	return width > 0 && height > 0 ? width / height : undefined;
}

/** 没画成时给模型的那句话，让它能跟人说一件真的事：额度用完了就别再试，key 不让用就去改设置。 */
// i18n-exempt：发给模型的工具结果
function failureText(model: string, failure: ImageFailure): string {
	const detail = (failure.detail ?? "").slice(0, 600);
	if (failure.hint === "check-billing") {
		const when = failure.retryAfterMs ? ` It resets in about ${wait(failure.retryAfterMs)}.` : "";
		return `${model} has no quota left.${when} Tell the user; trying again now will fail the same way.`;
	}
	if (failure.hint === "blocked") {
		return `The provider refused this request under its content policy (${detail.slice(0, 300)}). Tell the user it was refused; the same request will be refused the same way, so don't retry it unchanged.`;
	}
	if (failure.hint === "check-key") {
		return `The provider refused ${model} for this key (${detail.slice(0, 300)}). The user may need to allow the model for the key, or use a provider address whose group includes it. Don't retry.`;
	}
	return `Image generation with ${model} failed: ${failure.summary}. ${detail}`;
}

interface ImageArgs {
	prompt?: unknown;
	images?: unknown;
	aspect_ratio?: unknown;
	quality?: unknown;
	count?: unknown;
	background?: unknown;
	model?: unknown;
}

const failed = (output: string): ToolOutput => ({ output, isError: true });

export function imageTool(ctx: PluginContext): ToolDefinition {
	/**
	 * `#1`、`#2` 或路径；第一个取不到的，回一句给模型看的话。
	 *
	 * 每张输入另按媒体目录里的名字记一份，结果里存成 `sources`，画廊据此画出改图的链路。还不在媒体目录里的图
	 * （工作区的文件、留在消息里的小图）按内容存进去：文件以后改了，链路的起点照样画得出。
	 */
	// i18n-exempt：下面交回的都是给模型的话
	async function inputsFor(refs: string[], run: ToolRun): Promise<{ inputs: ImageInput[]; sources: string[] } | string> {
		if (refs.length > MAX_INPUTS) return `At most ${MAX_INPUTS} images can go into one call; ${refs.length} were given.`;
		let pictures: Picture[] | null = null;
		const inputs: ImageInput[] = [];
		const sources: string[] = [];
		for (const raw of refs) {
			const ref = raw.trim();
			const numbered = /^#\s*(\d+)$/.exec(ref);
			if (numbered) {
				pictures ??= conversationPictures(await ctx.sessions.messages(run.sessionId).catch(() => []));
				const picture = pictures[Number(numbered[1]) - 1];
				const loaded = picture?.data ? { data: picture.data, mimeType: picture.mimeType } : picture?.media ? await ctx.media.read(picture.media) : null;
				if (!loaded) {
					return pictures.length === 0
						? `There are no images in this conversation, so "${ref}" refers to nothing. Ask the user to attach the picture.`
						: `"${ref}" is out of range: this conversation has ${pictures.length} image${pictures.length === 1 ? "" : "s"} (#1 is the newest).`;
				}
				inputs.push({ ...loaded, ...(picture?.media ? { name: picture.media } : {}) });
				sources.push(picture?.media ?? (await ctx.media.save(loaded)).name);
				continue;
			}
			const absolute = resolve(run.cwd, ref);
			const media = ctx.media.nameOf(absolute);
			if (media) {
				const loaded = await ctx.media.read(media);
				if (!loaded) return `Could not read ${ref}.`;
				inputs.push({ ...loaded, name: media });
				sources.push(media);
				continue;
			}
			const outside = relative(run.cwd, absolute).startsWith("..") || isAbsolute(relative(run.cwd, absolute));
			if (outside) {
				const decision = await run.ask({
					kind: "view",
					title: MESSAGES[ctx.locale()].readOutside(basename(absolute)),
					detail: absolute,
					subject: absolute,
				});
				if (decision === "reject") return `The user declined reading ${shownPath(run.cwd, absolute)}.`;
			}
			const bytes = await readFile(absolute).catch(() => null);
			if (!bytes) return `Could not read ${ref}.`;
			if (bytes.length > MAX_INPUT_BYTES) return `${ref} is ${Math.round(bytes.length / 1048576)}MB; images over 20MB cannot be sent.`;
			const mimeType = sniff(bytes);
			if (!mimeType) return `${ref} is not a PNG, JPEG or WebP image.`;
			const data = bytes.toString("base64");
			inputs.push({ data, mimeType, name: basename(absolute) });
			sources.push((await ctx.media.save({ data, mimeType })).name);
		}
		return { inputs, sources };
	}

	return {
		name: IMAGE_TOOL,
		// i18n-exempt：工具说明是给模型的
		description:
			"Generate images, or edit existing ones, with the image model the user configured.\n\n" +
			"Write `prompt` as a complete brief: subject, composition, setting, style or medium, lighting, colour, and any text that must appear (quoted, verbatim). " +
			"Keep the user's language for text inside the picture. For an edit, say what to change and what must stay the same.\n\n" +
			'To edit or use pictures as reference, list them in `images`: "#1" is the newest image in this conversation — something the user attached, or an earlier result — "#2" the one before it, and so on. ' +
			"A file can be given by path, including the path an earlier result reported.\n\n" +
			"Pass `model` only when the user names an image model.",
		parameters: {
			type: "object",
			properties: {
				prompt: { type: "string", description: "The full brief for the image model." },
				images: {
					type: "array",
					items: { type: "string" },
					description: `Pictures to edit or draw from, at most ${MAX_INPUTS}: "#1" for the newest image in the conversation, "#2" for the one before, or a file path.`,
				},
				aspect_ratio: {
					type: "string",
					enum: ["auto", ...ASPECT_RATIOS],
					description: "Shape of the picture. auto lets the model decide (an edit keeps the input's shape).",
				},
				quality: {
					type: "string",
					enum: ["auto", ...QUALITIES],
					description: "Detail. high and max are slower and cost more; max is the largest the model offers (4K where supported). Default auto.",
				},
				count: { type: "integer", minimum: 1, maximum: 4, description: "How many variations. Default 1." },
				background: {
					type: "string",
					enum: ["auto", "transparent", "opaque"],
					description: "transparent for stickers, icons and logos, where the model supports it.",
				},
				model: { type: "string", description: 'Only when the user names an image model, e.g. "gpt-image-1".' },
			},
			required: ["prompt"],
			additionalProperties: false,
		},
		mutating: false,
		asks: true,
		// 导出会话成 Markdown 时这次调用写成的那一行（英文，和本体给自己工具的说法一样）。
		describe(args) {
			const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
			return prompt ? `Generate image ${prompt.split("\n")[0]!.slice(0, 80)}` : "Generate image";
		},
		// i18n-exempt：下面交回的都是给模型的话
		async execute(rawArgs, run): Promise<ToolOutput> {
			const args = rawArgs as ImageArgs;
			const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
			if (!prompt) return failed("`prompt` is required: describe the picture to draw.");
			const asked = typeof args.model === "string" && args.model.trim() ? args.model.trim() : undefined;
			const found = await ctx.model.findImageModel(asked, run.sessionId);
			if (!found.model) {
				if (found.reason === "none")
					return failed("No image model is configured. Tell the user to add one in Settings → Models (for example gpt-image-1 or gemini-3.1-flash-image).");
				const names = found.candidates.map((row: ImageModel) => `${row.modelId} (${row.provider})`).join(", ");
				return failed(
					found.reason === "ambiguous"
						? `"${asked}" matches more than one image model: ${names}. Pass one of these exactly.`
						: `No image model called "${asked}" is configured. Available: ${names}. Use one of these, or tell the user to add the model in Settings → Models.`,
				);
			}
			const model = found.model;

			const refs = Array.isArray(args.images) ? args.images.filter((ref): ref is string => typeof ref === "string" && ref.trim() !== "") : [];
			const given = await inputsFor(refs, run);
			if (typeof given === "string") return failed(given);
			const { inputs, sources } = given;

			const ratio =
				typeof args.aspect_ratio === "string" && args.aspect_ratio !== "auto" && (ASPECT_RATIOS as readonly string[]).includes(args.aspect_ratio)
					? args.aspect_ratio
					: undefined;
			const quality = (QUALITIES as readonly string[]).includes(String(args.quality)) ? (args.quality as (typeof QUALITIES)[number]) : undefined;
			const background = args.background === "transparent" || args.background === "opaque" ? args.background : undefined;
			const count = Math.max(1, Math.min(4, Math.round(Number(args.count) || 1)));
			const deadline = AbortSignal.timeout(IMAGE_TIMEOUT_MS);
			const signal = AbortSignal.any([run.signal, deadline]);
			const startedAt = Date.now();
			const shapeHint = ratio ? undefined : shapeOf(inputs[0]);
			const base: ImageGenerateDetails = {
				kind: IMAGE_TOOL,
				model: model.id,
				modelName: model.name,
				...(ratio ? { aspectRatio: ratio } : {}),
				...(quality ? { quality } : {}),
				count,
				edit: inputs.length > 0,
				...(sources.length ? { sources } : {}),
				startedAt,
				...(shapeHint ? { shapeHint } : {}),
			};
			const report = (details: ImageGenerateDetails) => run.progress(`${JSON.stringify(details)}${PROGRESS_SEPARATOR}`);
			// 图还没有，先把形状和模型交给卡片：画布按形状占位，进度按模型估。
			report(base);

			// 重试只报在等的那一段：等完了把 `retry` 撤掉，卡片回到说阶段，不会一直写着「正在重试」到出图。
			let waited: ReturnType<typeof setTimeout> | undefined;
			let result;
			try {
				result = await ctx.model.image({
					model: model.id,
					prompt,
					...(inputs.length ? { images: inputs } : {}),
					...(ratio ? { aspectRatio: ratio } : {}),
					...(quality ? { quality } : {}),
					count,
					...(background ? { background } : {}),
					signal,
					onRetry: (retry) => {
						clearTimeout(waited);
						report({ ...base, retry });
						waited = setTimeout(() => report(base), retry.delayMs);
					},
				});
			} catch (error) {
				if (run.signal.aborted || !deadline.aborted) throw error;
				const minutes = IMAGE_TIMEOUT_MS / 60_000;
				return failed(`Image generation with ${model.name} timed out: no answer in ${minutes} minutes.`);
			} finally {
				clearTimeout(waited);
			}
			if (!result.ok) {
				return { output: failureText(model.name, result.failure), isError: true, details: { ...base, error: result.failure } satisfies ImageGenerateDetails };
			}

			const saved = await Promise.all(
				result.images.map(async (image) => {
					const { name, path } = await ctx.media.save(image);
					return { ...image, media: name, path, bytes: Math.floor((image.data.length * 3) / 4) };
				}),
			);
			const shown = saved.filter((image) => image.bytes <= MAX_SHOWN_BYTES && (IMAGE_TYPES as readonly string[]).includes(image.mimeType));
			const oversized = saved.length - shown.length;
			const first = saved[0];
			const dims = first?.width ? ` (${first.width}×${first.height})` : "";
			const lines = [
				`Drew ${saved.length} image${saved.length === 1 ? "" : "s"} with ${model.name}${dims} in ${seconds(Date.now() - startedAt)}; shown to the user in the conversation.`,
				`Saved: ${saved.map((image) => shownPath(run.cwd, image.path)).join(", ")}. To edit one, pass its path — or #1 for the newest image in the conversation — in \`images\`.`,
			];
			if (result.failures?.length) lines.push(`${result.failures.length} of ${count} did not arrive: ${result.failures[0]}.`);
			if (result.revisedPrompt) lines.push(`The provider rewrote the prompt as: ${result.revisedPrompt}`);
			// 不说这句，模型会在回复末尾补一个指向这个路径的「下载原图」链接——图就在它上面。
			lines.push("Don't link the picture or repeat its path in your reply unless the user wants the file — they are already looking at it.");
			if (oversized)
				lines.push(
					`${oversized} of them ${oversized === 1 ? "is" : "are"} over ${MAX_SHOWN_BYTES / 1048576}MB and not attached for you to see; the files are saved as usual.`,
				);
			return {
				output: lines.join("\n"),
				images: shown.map((image) => ({ data: image.data, mimeType: image.mimeType as ImageType })),
				details: {
					...base,
					paths: saved.map((image) => image.path),
					images: saved.map(({ media, mimeType, width, height }) => ({ media, mimeType, ...(width ? { width, height } : {}) })),
					references: inputs.length,
					route: result.route,
					...(result.revisedPrompt ? { revisedPrompt: result.revisedPrompt } : {}),
					...(result.failures?.length ? { failures: result.failures } : {}),
				} satisfies ImageGenerateDetails,
			};
		},
	};
}
