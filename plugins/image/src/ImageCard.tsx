/**
 * 对话里 `image_generate` 的卡片。
 *
 * 跑的时候是点阵在流动的底板，要几张占几块，按要的比例先把位置占好——没说比例的改图按原图的比例（开跑时报上来的
 * `shapeHint`）——画好了在原地从模糊变清晰，版面不挤一下。
 *
 * 图上面一行：画的时候说进行到哪一步（估计，见 `progress.ts`），重试时说在重试；画完是模型和尺寸，少了几张也说。
 *
 * 失败只有工具记下了原因时才画成一张卡片——额度用完、密钥没开这个模型，是人要去做点什么的事；别的情况、认不出的
 * `details` 都交回通用卡片。
 */

import type { ToolCardProps, UiContext } from "@plume/contract/ui";
import { ContextMenu, MenuItem, MenuSeparator, RollingText, Text, Tooltip, useI18n, useNow } from "@plume/ui";
import { Copy, CornerUpRight, Download, Image as ImageIcon, MessageSquarePlus, PanelRightOpen, PencilLine } from "@plume/ui/icons";
import { type MouseEvent, useState } from "react";
import { editInConversation } from "./gallery/actions.ts";
import { GALLERY_MESSAGES, MESSAGES } from "./messages.ts";
import { imageCanvasState } from "./image-state.ts";
import { expectedMs, progressAt, stageAt } from "./progress.ts";
import { type ImageGenerateDetails, lastProgress, readDetails } from "./types.ts";

const HEIGHT = 240;
const ICON = { size: 13, strokeWidth: 1.8 } as const;

type Words = (typeof MESSAGES)[keyof typeof MESSAGES];

/** 卡片标题里点名的那一句：提示词的第一行，太长截断。 */
export function promptSubject(args: Record<string, unknown>): string | undefined {
	const prompt = typeof args.prompt === "string" ? args.prompt.trim().split("\n")[0]?.trim() : "";
	if (!prompt) return undefined;
	return prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt;
}

export function imageCard(ui: UiContext) {
	return function ImageCard({ sessionId, call, status, progress, result, fallback }: ToolCardProps) {
		const locale = useI18n().resolvedLocale;
		const text = MESSAGES[locale];
		const galleryText = GALLERY_MESSAGES[locale];
		const running = status === "running";
		const details = readDetails(result?.details) ?? (running ? lastProgress(progress) : null);
		// 只有亲眼看着它画的这一次才过渡宽度、播落地；翻历史记录时尺寸直接取记下的宽高。
		const [live] = useState(running);
		const [mountedAt] = useState(() => Date.now());
		// 只在画的时候走的钟：百分比是读数，不是节拍。
		const now = useNow(running, 400);
		const [menu, setMenu] = useState<{ x: number; y: number; index: number } | null>(null);

		const ratio = ratioOf(call.args.aspect_ratio) ?? (details?.shapeHint && details.shapeHint > 0 ? details.shapeHint : 1);
		const count = Math.max(1, Math.min(4, Math.round(Number(details?.count ?? call.args.count) || 1)));
		const images = result && !result.isError ? (details?.images ?? []) : [];

		if (images.length === 0) {
			if (!running)
				return details?.error && result?.isError ? <DrawFailed text={text} error={details.error} model={details.modelName ?? ""} /> : <>{fallback}</>;
			const done = progressAt(now - (details?.startedAt ?? mountedAt), expectedMs(details?.model ?? "", details?.quality, count, details?.edit ?? false));
			return (
				<figure className="plume-image-card" data-image-card="drawing">
					<Caption text={details?.retry ? text.retrying : text.stage[stageAt(done)]} />
					<div className="plume-image-card-row">
						{Array.from({ length: count }, (_, index) => (
							<div
								key={index}
								role="img"
								aria-label={text.generating}
								className="plume-image-canvas"
								data-canvas="pending"
								style={{ width: HEIGHT * ratio, aspectRatio: ratio }}
							>
								{index === count - 1 && (
									<Text size="caption" weight="medium" numeric className="plume-image-percent">
										{Math.round(done * 100)}%
									</Text>
								)}
							</div>
						))}
					</div>
				</figure>
			);
		}

		const summary = promptSubject(call.args) ?? text.generateImage;
		const shots = images.map((image, index) => {
			const src = ui.mediaUrl(image.media);
			return {
				media: image.media,
				src,
				alt: text.imageAlt(summary, index + 1),
				ratio: sizeOf(image),
				// 标注完按「完成」，带标注的副本进这张图所在会话的输入框；记下是从哪张图标的，画廊的链路靠它接上。
				onAttach: (dataUrl: string) => void attach(ui, sessionId, dataUrl, image.media),
			};
		});
		const first = images[0];
		const missing = details?.count ? details.count - images.length : 0;
		const caption = [
			details?.modelName,
			images.length === 1 && first?.width && first.height ? `${first.width}×${first.height}` : undefined,
			missing > 0 ? text.partial(missing) : undefined,
		]
			.filter(Boolean)
			.join(" · ");
		const target = menu ? images[menu.index] : undefined;

		return (
			<figure className="plume-image-card" data-image-card="done">
				{caption && <Caption text={caption} />}
				<div className="plume-image-card-row">
					{shots.map((shot, index) => (
						<Shot
							key={shot.media}
							text={text}
							src={shot.src}
							alt={shot.alt}
							ratio={shot.ratio ?? ratio}
							glide={live}
							onOpen={(frame) => ui.openImage(shots, index, { from: frame })}
							onEdit={(frame) => ui.openImage([shot], 0, { from: frame, edit: true })}
							onDownload={() => void ui.saveImage(shot.src)}
							onMenu={(event) => {
								event.preventDefault();
								event.stopPropagation();
								setMenu({ x: event.clientX, y: event.clientY, index });
							}}
						/>
					))}
				</div>
				<ContextMenu anchor={menu && target ? { x: menu.x, y: menu.y } : null} onClose={() => setMenu(null)}>
					{target && (
						<>
							<MenuItem
								icon={<PanelRightOpen {...ICON} />}
								onClick={() => void ui.openMediaFile(target.media, sessionId).catch((error: unknown) => ui.notify(String(error), "error"))}
							>
								{text.openInTab}
							</MenuItem>
							<MenuItem icon={<MessageSquarePlus {...ICON} />} onClick={() => void editInConversation(ui, galleryText, { sessionId, media: target.media }, "")}>
								{text.addToChat}
							</MenuItem>
							<MenuItem icon={<Copy {...ICON} />} onClick={() => void ui.copyImage(ui.mediaUrl(target.media))}>
								{text.copy}
							</MenuItem>
							<MenuSeparator />
							<MenuItem
								icon={<CornerUpRight {...ICON} />}
								onClick={() => void ui.revealMediaFile(target.media).catch((error: unknown) => ui.notify(String(error), "error"))}
							>
								{ui.revealMediaLabel()}
							</MenuItem>
							<MenuItem icon={<Download {...ICON} />} onClick={() => void ui.saveImage(ui.mediaUrl(target.media))}>
								{text.downloadCopy}
							</MenuItem>
						</>
					)}
				</ContextMenu>
			</figure>
		);
	};
}

function attach(ui: UiContext, sessionId: string, dataUrl: string, from: string): Promise<void> {
	const comma = dataUrl.indexOf(",");
	const mimeType = /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? "image/png";
	if (comma < 0 || !isComposerType(mimeType)) return Promise.resolve();
	return ui.draftInSession(sessionId, { text: "", images: [{ data: dataUrl.slice(comma + 1), mimeType, from }] });
}

function isComposerType(mimeType: string): mimeType is "image/png" | "image/jpeg" | "image/webp" | "image/gif" {
	return mimeType === "image/png" || mimeType === "image/jpeg" || mimeType === "image/webp" || mimeType === "image/gif";
}

function Caption({ text }: { text: string }) {
	return (
		<Text as="p" size="detail" tone="muted" className="plume-image-card-caption">
			<RollingText>{text}</RollingText>
		</Text>
	);
}

/**
 * 一张图的位置：外层是框（圆角、点阵、悬停按钮），里面一颗按钮负责打开。
 *
 * 看图器从框起飞而不是从里面那颗按钮：框才有圆角，按钮读出来是 0，图会从直角飞出去。
 */
function Shot({
	text,
	src,
	alt,
	ratio,
	glide,
	onOpen,
	onEdit,
	onDownload,
	onMenu,
}: {
	text: Words;
	src: string;
	alt: string;
	ratio: number;
	glide: boolean;
	onOpen: (frame: HTMLElement) => void;
	onEdit: (frame: HTMLElement) => void;
	onDownload: () => void;
	onMenu: (event: MouseEvent<HTMLElement>) => void;
}) {
	const [loaded, setLoaded] = useState(false);
	const [failed, setFailed] = useState(false);
	// 模型不一定照请求的尺寸出图，载入后以图本身的比例为准。
	const [aspect, setAspect] = useState(ratio);
	const frameOf = (event: MouseEvent<HTMLElement>) => event.currentTarget.closest<HTMLElement>(".plume-image-canvas") as HTMLElement;
	return (
		<div
			className="plume-image-canvas"
			data-canvas={imageCanvasState(loaded, failed)}
			{...(glide ? { "data-glide": "" } : {})}
			onContextMenu={onMenu}
			style={{ width: HEIGHT * aspect, aspectRatio: aspect }}
		>
			{failed ? (
				<div data-image-load-error role="img" aria-label={text.loadFailed} className="plume-image-load-error">
					<ImageIcon {...ICON} aria-hidden />
					<Text size="label" tone="muted">
						{text.loadFailed}
					</Text>
				</div>
			) : (
				<button type="button" aria-label={alt} className="plume-image-open" onClick={(event) => onOpen(frameOf(event))}>
					<img
						alt={alt}
						src={src}
						draggable={false}
						onError={() => setFailed(true)}
						onLoad={(event) => {
							const { naturalWidth, naturalHeight } = event.currentTarget;
							if (naturalWidth > 0 && naturalHeight > 0) setAspect(naturalWidth / naturalHeight);
							setLoaded(true);
						}}
						className="plume-image-shot"
						// 看着它画的这一次从模糊变清晰；翻出来的老图直接淡入。
						{...(loaded ? { "data-shown": glide ? "reveal" : "fade" } : {})}
					/>
				</button>
			)}
			{loaded && !failed && (
				<div className="plume-image-actions">
					<button type="button" className="plume-image-action" aria-label={text.edit} onClick={(event) => onEdit(frameOf(event))}>
						<PencilLine size={14} strokeWidth={2} />
						<Text size="detail" weight="medium">
							{text.edit}
						</Text>
					</button>
					<Tooltip label={text.download} side="top">
						<button type="button" className="plume-image-action" data-icon-only="" aria-label={text.download} onClick={onDownload}>
							<Download size={15} strokeWidth={2} />
						</button>
					</Tooltip>
				</div>
			)}
		</div>
	);
}

/** `45s`、`12m`、`1h 53m`——和回合计时同一种写法，哪种语言读起来都一样。 */
function span(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function DrawFailed({ text, error, model }: { text: Words; error: NonNullable<ImageGenerateDetails["error"]>; model: string }) {
	let title = text.failed;
	let note = error.summary;
	if (error.hint === "check-billing") {
		title = text.quotaSpent(model);
		note = error.retryAfterMs ? text.resetsIn(span(error.retryAfterMs)) : "";
	} else if (error.hint === "check-key") {
		title = text.notAllowed(model);
		note = text.notAllowedHint;
	} else if (error.hint === "blocked") {
		title = text.refused;
		note = text.refusedHint;
	}
	const detail = error.detail?.slice(0, 400);
	const line = note ? (
		<Text as="p" size="caption" tone="faint">
			{note}
		</Text>
	) : null;
	return (
		<div className="plume-image-failed" data-image-card="error">
			<ImageIcon size={16} strokeWidth={1.8} />
			<div className="plume-image-failed-body">
				<Text as="p">{title}</Text>
				{line && detail ? (
					<Tooltip label={detail} side="top">
						{line}
					</Tooltip>
				) : (
					line
				)}
			</div>
		</div>
	);
}

/** `"16:9"` 取宽高比；`auto`、没给或读不懂的是 null。 */
function ratioOf(value: unknown): number | null {
	const match = typeof value === "string" ? /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value.trim()) : null;
	return match && Number(match[1]) > 0 && Number(match[2]) > 0 ? Number(match[1]) / Number(match[2]) : null;
}

/** 工具从文件头读到的宽高：图还没载入，位置就已经是它的样子。 */
function sizeOf(image: { width?: number; height?: number }): number | undefined {
	return image.width && image.height ? image.width / image.height : undefined;
}
