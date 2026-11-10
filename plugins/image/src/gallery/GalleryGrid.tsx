/**
 * 相册：每天一个标题，底下一行行按图自己的形状排开的图（`justify`）。
 */

import type { UiContext } from "@plume/contract/ui";
import { Text, Tooltip, useI18n } from "@plume/ui";
import { Layers } from "@plume/ui/icons";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { familyOf } from "./lineage-tree.ts";
import { aspectOf, byDay, justify } from "./layout.ts";
import { GALLERY_MESSAGES as MESSAGES } from "../messages.ts";
import { askText, type Drawn, type GalleryIndex } from "./model.ts";

/** 格子里那张图的长边：一行最高的格子在 2× 屏上也清楚，字节只有原图的零头。 */
export const TILE_THUMB = 800;
const GAP = 8;

export function GalleryGrid({
	ui,
	entries,
	index,
	narrow,
	onOpen,
}: {
	ui: UiContext;
	entries: Drawn[];
	index: GalleryIndex;
	narrow: boolean;
	onOpen: (media: string, tile: HTMLElement) => void;
}) {
	const { resolvedLocale, formatDate } = useI18n();
	const m = MESSAGES[resolvedLocale];
	const box = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const el = box.current;
		if (!el) return;
		setWidth(el.clientWidth);
		const observer = new ResizeObserver(() => setWidth(el.clientWidth));
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	const sections = useMemo(() => byDay(entries, (entry) => entry.at), [entries]);
	// 每张图的来历有几步，画在格子的角标上。一家子走一遍就够。
	const families = useMemo(() => {
		const sizes = new Map<string, number>();
		for (const entry of entries) {
			if (sizes.has(entry.media)) continue;
			const family = familyOf(entry.media, index.nodes);
			for (const member of family) sizes.set(member.id, family.length);
		}
		return sizes;
	}, [entries, index.nodes]);

	const today = new Date();
	const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
	const heading = (day: number) => {
		if (day === midnight) return m.today;
		// 按日历退一天，不减 24 小时：夏令时切换那天只有 23 或 25 小时。
		if (day === new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime()) return m.yesterday;
		const sameYear = new Date(day).getFullYear() === today.getFullYear();
		return formatDate(day, sameYear ? { month: "long", day: "numeric", weekday: "short" } : { year: "numeric", month: "long", day: "numeric" });
	};

	return (
		<div ref={box} data-image-gallery-grid="" className="image-gallery-grid">
			{width > 0 &&
				sections.map((section) => {
					const rows = justify(
						section.items.map((entry) => aspectOf(entry)),
						width,
						{ target: narrow ? 150 : 220, gap: GAP },
					);
					return (
						<section key={section.day} data-image-gallery-day={section.day} className="image-gallery-day">
							<Text as="h2" weight="medium" className="image-gallery-day-head">
								{heading(section.day)}
								<Text size="caption" tone="faint" numeric>
									{section.items.length}
								</Text>
							</Text>
							<div className="image-gallery-rows" style={{ gap: GAP }}>
								{rows.map((row, at) => (
									<div key={at} className="image-gallery-row" style={{ gap: GAP }}>
										{row.tiles.map((tile) => {
											const entry = section.items[tile.index];
											if (!entry) return null;
											return (
												<Tile
													key={entry.media}
													src={ui.mediaUrl(entry.media, TILE_THUMB)}
													entry={entry}
													width={tile.width}
													height={tile.height}
													family={families.get(entry.media) ?? 1}
													chainTip={m.chainTip(families.get(entry.media) ?? 1)}
													session={index.sessions.get(entry.sessionId)?.title ?? ""}
													onOpen={onOpen}
												/>
											);
										})}
									</div>
								))}
							</div>
						</section>
					);
				})}
		</div>
	);
}

const Tile = memo(function Tile({
	src,
	entry,
	width,
	height,
	family,
	chainTip,
	session,
	onOpen,
}: {
	src: string;
	entry: Drawn;
	width: number;
	height: number;
	family: number;
	chainTip: string;
	session: string;
	onOpen: (media: string, tile: HTMLElement) => void;
}) {
	const [loaded, setLoaded] = useState(false);
	const words = askText(entry) || entry.prompt;
	return (
		<button
			type="button"
			data-image-gallery-tile={entry.media}
			aria-label={words}
			onClick={(event) => onOpen(entry.media, event.currentTarget)}
			className="image-gallery-tile"
			style={{ width, height }}
		>
			{/* 没有缩略图可取，格子里就是原图：懒加载，离开视口的不读。 */}
			<img
				src={src}
				alt=""
				draggable={false}
				loading="lazy"
				decoding="async"
				onLoad={() => setLoaded(true)}
				data-loaded={loaded ? "" : undefined}
				className="image-gallery-picture"
			/>
			{family > 1 && (
				<Tooltip label={chainTip}>
					<span className="image-gallery-chip" aria-label={chainTip}>
						<Layers size={11} strokeWidth={2} />
						<Text size="caption" weight="semibold" numeric>
							{family}
						</Text>
					</span>
				</Tooltip>
			)}
			<span aria-hidden className="image-gallery-caption">
				<Text size="detail" className="image-gallery-caption-words">
					{words}
				</Text>
				{session && (
					<Text size="caption" className="image-gallery-caption-session">
						{session}
					</Text>
				)}
			</span>
		</button>
	);
});
