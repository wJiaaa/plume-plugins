/**
 * 一张图，放大，旁边是它的来历，底下是说要怎么改的输入框。
 *
 * 从格子里点开时，图从格子飞到台上，关上时飞回格子，和对话里用看图器看图一样。格子里画的是整张图（每行都保持图的形状），
 * 所以飞行只是平移加缩放，没有裁切要遮。
 */

import type { UiContext } from "@plume/contract/ui";
import { Button, IconButton, motionReduced, PageTopRow, Scroller, Text, useI18n } from "@plume/ui";
import { ArrowLeft, ArrowUpRight, Check, ChevronLeft, ChevronRight, Copy, Download } from "@plume/ui/icons";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { editInConversation } from "./actions.ts";
import { EditBar } from "./EditBar.tsx";
import { TILE_THUMB } from "./GalleryGrid.tsx";
import { aspectOf } from "./layout.ts";
import { Lineage, useFamily } from "./Lineage.tsx";
import { GALLERY_MESSAGES as MESSAGES } from "../messages.ts";
import { type Drawn, drawingFor, type Entry, type GalleryIndex } from "./model.ts";
import { awaitEdit, openPicture } from "./store.ts";

/**
 * 台上的图和格子的圆角（`gallery.css` 里 `.image-gallery-frame` 和 `.image-gallery-tile` 的那两个 token）；飞行时从一个渐变到另一个，
 * 否则第一帧跳一下。格子那头要除以缩放，放大以后看着才和格子一样圆。
 */
const STAGE_RADIUS = "var(--plume-radius-panel)";
const tileRadius = (scale: number) => `calc(var(--plume-radius-field) / ${scale})`;

/** 读一个时长 token 的毫秒数。动画要数字，取值仍跟着 theme.css 走。 */
function tokenMs(name: string): number {
	const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	const value = Number.parseFloat(raw);
	if (!Number.isFinite(value)) return 0;
	return raw.endsWith("ms") ? value : value * 1000;
}

function motion() {
	const easing = getComputedStyle(document.documentElement).getPropertyValue("--plume-e-out").trim() || "ease-out";
	return { quick: tokenMs("--plume-t-quick"), base: tokenMs("--plume-t-base"), slow: tokenMs("--plume-t-slow"), easing };
}

/** 放得下的最大的这个形状的框，不比图本身大。 */
function contain(space: { width: number; height: number }, aspect: number, natural?: { width?: number; height?: number }): { width: number; height: number } {
	let width = Math.max(0, Math.min(space.width, space.height * aspect));
	if (natural?.width) width = Math.min(width, natural.width);
	return { width, height: width / aspect };
}

/** 把一个框画到另一个同形状的框上：平移和缩放。 */
function onto(from: DOMRect, to: DOMRect): { transform: string; scale: number } {
	const scale = from.width / Math.max(1, to.width);
	const dx = from.left + from.width / 2 - (to.left + to.width / 2);
	const dy = from.top + from.height / 2 - (to.top + to.height / 2);
	return { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, scale };
}

/** 格子里的那一格，在屏幕上能飞回去的话。 */
function tileOf(media: string): HTMLElement | null {
	const tile = document.querySelector<HTMLElement>(`[data-image-gallery-tile="${CSS.escape(media)}"]`);
	if (!tile) return null;
	tile.scrollIntoView({ block: "nearest" });
	return tile;
}

export function GalleryDetail({
	ui,
	entry,
	index,
	order,
	origin,
	narrow,
	onArrived,
	onClose,
}: {
	ui: UiContext;
	entry: Entry;
	index: GalleryIndex;
	order: Drawn[];
	/** 从哪一格点开的，从它飞出来；不是刚从格子点开时为空。 */
	origin: HTMLElement | null;
	narrow: boolean;
	onArrived: () => void;
	onClose: () => void;
}) {
	const { resolvedLocale, formatDate } = useI18n();
	const m = MESSAGES[resolvedLocale];
	const backdrop = useRef<HTMLDivElement>(null);
	const stage = useRef<HTMLDivElement>(null);
	const frame = useRef<HTMLButtonElement>(null);
	const chrome = useRef<HTMLElement[]>([]);
	const [space, setSpace] = useState<{ width: number; height: number } | null>(null);
	const [marked, setMarked] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const leaving = useRef(false);
	const back = useRef<HTMLElement>(null);
	// 键盘跟着图走：Tab 在这一层的控件里转，不跑到底下藏着的相册里。
	useEffect(() => {
		back.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
	}, []);
	const family = useFamily(entry.media, index);
	const session = index.sessions.get(entry.sessionId);
	const running = ui.useSession(entry.sessionId)?.summary.running ?? false;
	// 项目按现在的名字说：会话只记着项目的 id。
	const project = ui.useProjects().find((one) => one.id === session?.project)?.name;
	const drawing = drawingFor(entry, index);
	const at = order.findIndex((item) => item.media === entry.media);
	const src = ui.mediaUrl(entry.media);

	useLayoutEffect(() => {
		const el = stage.current;
		if (!el) return;
		// 图和台的边留着空：是摆在页面上，不是塞满页面。
		const measure = () => setSpace({ width: el.clientWidth - 2 * (narrow ? 16 : 40), height: el.clientHeight - 24 });
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [narrow]);

	const aspect = aspectOf(entry.kind === "drawn" ? entry : {});
	const box = space ? contain(space, aspect, entry.kind === "drawn" ? entry : undefined) : null;

	// 到达：底色和控件淡入，图从格子飞过来。只在第一次量好的那一帧做一次。
	const arrived = useRef(false);
	useLayoutEffect(() => {
		if (!box || arrived.current) return;
		arrived.current = true;
		onArrived();
		if (motionReduced()) return;
		const { base, slow, easing } = motion();
		backdrop.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: base, easing });
		for (const part of chrome.current)
			part.animate(
				[
					{ opacity: 0, transform: "translateY(6px)" },
					{ opacity: 1, transform: "none" },
				],
				{ duration: base, delay: 70, easing, fill: "backwards" },
			);
		const el = frame.current;
		if (!el || !origin?.isConnected) return;
		const { transform, scale } = onto(origin.getBoundingClientRect(), el.getBoundingClientRect());
		origin.style.visibility = "hidden";
		const flight = el.animate(
			[
				{ transform, borderRadius: tileRadius(scale) },
				{ transform: "none", borderRadius: STAGE_RADIUS },
			],
			{ duration: slow, easing },
		);
		const settle = () => {
			origin.style.visibility = "";
		};
		flight.addEventListener("finish", settle);
		flight.addEventListener("cancel", settle);
		// 只在第一次量好的那一帧：之后的变化都不是到达。
		// oxlint-disable-next-line exhaustive-deps
	}, [box]);

	const close = () => {
		if (leaving.current) return;
		leaving.current = true;
		const el = frame.current;
		if (motionReduced() || !el) {
			onClose();
			return;
		}
		const { quick, base, slow, easing } = motion();
		const fade = { duration: base, easing, fill: "forwards" } as const;
		backdrop.current?.animate([{ opacity: 1 }, { opacity: 0 }], fade);
		for (const part of chrome.current) part.animate([{ opacity: 1 }, { opacity: 0 }], { ...fade, duration: quick });
		const tile = entry.kind === "drawn" ? tileOf(entry.media) : null;
		let flight: Animation;
		if (tile) {
			const { transform, scale } = onto(tile.getBoundingClientRect(), el.getBoundingClientRect());
			tile.style.visibility = "hidden";
			flight = el.animate(
				[
					{ transform: "none", borderRadius: STAGE_RADIUS },
					{ transform, borderRadius: tileRadius(scale) },
				],
				{ duration: slow, easing, fill: "forwards" },
			);
			flight.addEventListener("finish", () => {
				tile.style.visibility = "";
			});
		} else {
			flight = el.animate(
				[
					{ opacity: 1, transform: "none" },
					{ opacity: 0, transform: "scale(0.96)" },
				],
				fade,
			);
		}
		flight.addEventListener("finish", onClose);
	};

	const step = (delta: number) => {
		if (at < 0 || order.length < 2) return;
		const next = order[(at + delta + order.length) % order.length];
		if (next) openPicture(next.media);
	};

	// 翻到另一张，上一张上做的标注不跟过来。
	useEffect(() => {
		setMarked(null);
		setCopied(false);
	}, [entry.media]);

	const closeRef = useRef(close);
	closeRef.current = close;
	const stepRef = useRef(step);
	stepRef.current = step;
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const typing = event.target instanceof HTMLElement && event.target.closest("input, textarea, [contenteditable='true']");
			// 看图器或别的对话框在上面，键归它。
			if (event.defaultPrevented || document.querySelector("[aria-modal='true']")) return;
			if (event.key === "Escape" && !typing) {
				event.preventDefault();
				closeRef.current();
			} else if (!typing && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
				event.preventDefault();
				stepRef.current(event.key === "ArrowLeft" ? -1 : 1);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const keep = (el: HTMLElement | null) => {
		if (el && !chrome.current.includes(el)) chrome.current.push(el);
	};

	const zoom = (edit: boolean) => {
		ui.openImage([{ src, alt: entry.kind === "drawn" ? entry.prompt : "", onAttach: setMarked }], 0, { from: frame.current, edit });
	};

	const reveal = () => {
		if (!drawing) return;
		ui.revealToolCall(drawing.sessionId, drawing.toolCallId).catch(() => ui.notify(m.conversationGone, "error"));
	};

	const sendEdit = async (words: string) => {
		const since = Date.now();
		const sent = await editInConversation(ui, m, entry, words, marked ?? undefined);
		if (sent) {
			// 新图到了，画廊开在它上面，而不是开在改它的那张上。
			if (words.trim()) awaitEdit(entry.media, since);
			setMarked(null);
		}
		return sent;
	};

	const copy = (text: string) => {
		navigator.clipboard.writeText(text).then(
			() => {
				setCopied(true);
				window.setTimeout(() => setCopied(false), 1500);
			},
			(error: unknown) => ui.notify(String(error), "error"),
		);
	};

	return (
		<div data-image-gallery-detail={entry.media} className="image-gallery-detail">
			<div ref={backdrop} aria-hidden className="image-gallery-backdrop" />
			<div className="image-gallery-main">
				{/* 返回、翻页这一行坐在窗口顶行上（页面登记了 topRow），从顶边开始。 */}
				<PageTopRow
					start
					ref={(el) => {
						keep(el);
						back.current = el;
					}}
					className="image-gallery-bar"
				>
					<IconButton data-image-gallery-close="" label={m.back} icon={<ArrowLeft size={16} />} onClick={close} />
					<span className="image-gallery-spacer" />
					{at >= 0 && order.length > 1 && (
						<div className="image-gallery-steps">
							<Text size="caption" tone="faint" numeric>
								{at + 1} / {order.length}
							</Text>
							<IconButton label={m.previous} icon={<ChevronLeft size={16} />} onClick={() => step(-1)} />
							<IconButton label={m.next} icon={<ChevronRight size={16} />} onClick={() => step(1)} />
						</div>
					)}
				</PageTopRow>
				<div ref={stage} className="image-gallery-stage">
					{box && (
						<button
							ref={frame}
							type="button"
							data-image-gallery-stage=""
							aria-label={m.zoom}
							onClick={() => zoom(false)}
							className="image-gallery-frame"
							style={{ width: box.width, height: box.height }}
						>
							{/* 相册里那张缩略图（已经在缓存里）先垫着，原图解完盖上去，换图时不闪一下空底。 */}
							<img src={ui.mediaUrl(entry.media, TILE_THUMB)} alt="" draggable={false} />
							<img key={entry.media} src={src} alt={entry.kind === "drawn" ? entry.prompt : ""} draggable={false} decoding="async" />
						</button>
					)}
				</div>
				<div ref={keep} className="image-gallery-edit-row">
					<EditBar
						ui={ui}
						marked={marked}
						running={running}
						onAnnotate={() => zoom(true)}
						onUnmark={() => setMarked(null)}
						onSend={sendEdit}
						sessionId={entry.sessionId}
					/>
				</div>
			</div>
			<aside ref={keep} data-image-gallery-panel="" className="image-gallery-panel">
				<Scroller className="image-gallery-panel-scroll" contentClassName="image-gallery-panel-content">
					<section>
						<button type="button" data-image-gallery-session="" disabled={!drawing} onClick={reveal} className="image-gallery-session">
							<Text size="title" weight="semibold">
								{session?.title || m.untitled}
							</Text>
						</button>
						<Text as="p" size="caption" tone="faint" className="image-gallery-when">
							{formatDate(entry.at, { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })}
							{project ? ` · ${project}` : ""}
						</Text>
						<div className="image-gallery-actions">
							<Button size="sm" data-image-gallery-locate="" icon={<ArrowUpRight size={14} />} disabled={!drawing} onClick={reveal}>
								{m.inConversation}
							</Button>
							<IconButton
								label={m.save}
								icon={<Download size={15} />}
								onClick={() => void ui.saveImage(src).catch((error: unknown) => ui.notify(String(error), "error"))}
							/>
						</div>
					</section>

					<section>
						<Text as="h3" size="detail" tone="muted" weight="medium" className="image-gallery-section-head">
							{m.lineage}
							<Text size="caption" tone="faint" weight="normal" numeric>
								{m.steps(family.length)}
							</Text>
						</Text>
						<Lineage ui={ui} current={entry.media} index={index} onSelect={(media) => openPicture(media)} />
					</section>

					{entry.kind === "drawn" && (
						<section>
							<Text as="h3" size="detail" tone="muted" weight="medium" className="image-gallery-section-head image-gallery-section-head-split">
								{m.prompt}
								<IconButton
									size="xs"
									label={copied ? m.copied : m.copy}
									icon={copied ? <Check size={13} /> : <Copy size={13} />}
									onClick={() => copy(entry.prompt)}
								/>
							</Text>
							<Text as="p" data-image-gallery-prompt="" className="image-gallery-prompt">
								{entry.prompt}
							</Text>
							{entry.revisedPrompt && entry.revisedPrompt !== entry.prompt && (
								<Text as="p" size="detail" tone="muted" className="image-gallery-revised">
									{m.revised}
									{entry.revisedPrompt}
								</Text>
							)}
						</section>
					)}

					{entry.kind === "drawn" && (
						<section>
							<Text as="h3" size="detail" tone="muted" weight="medium" className="image-gallery-section-head">
								{m.details}
							</Text>
							<dl className="image-gallery-facts">
								<Fact name={m.model} value={entry.model.name} />
								<Fact name={m.size} value={entry.width && entry.height ? `${entry.width} × ${entry.height}` : ""} />
								<Fact name={m.ratio} value={entry.aspectRatio ?? m.auto} />
								<Fact name={m.quality} value={entry.quality ?? m.auto} />
								<Fact name={m.duration} value={entry.durationMs ? `${(entry.durationMs / 1000).toFixed(1)}s` : ""} />
							</dl>
						</section>
					)}
				</Scroller>
			</aside>
		</div>
	);
}

function Fact({ name, value }: { name: string; value: string }) {
	if (!value) return null;
	return (
		<>
			<dt>
				<Text size="detail" tone="faint">
					{name}
				</Text>
			</dt>
			<dd className="image-gallery-fact-value">
				<Text size="detail">{value}</Text>
			</dd>
		</>
	);
}
