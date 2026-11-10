/**
 * 画廊：每个对话里画过的图，像相册一样按天排开；点一张，看它是怎么一步步变成这样的。
 *
 * 开着一张图时，相册还挂在底下：关上回到原来滚到的地方，图也能飞回它来的那一格。
 */

import type { Remote, UiContext } from "@plume/contract/ui";
import { Button, PageTopRow, Scroller, SearchField, SkeletonBar, Text, useI18n, useLiveRefresh, useNarrow } from "@plume/ui";
import { Images } from "@plume/ui/icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ImageApi } from "../api.ts";
import { GalleryDetail } from "./GalleryDetail.tsx";
import { GalleryGrid } from "./GalleryGrid.tsx";
import { GALLERY_MESSAGES as MESSAGES } from "../messages.ts";
import { changesGallery, indexGallery, matches } from "./model.ts";
import { openPicture, refreshGallery, setGalleryQuery, useGallery } from "./store.ts";

/** 页面窄于这个宽度时，格子排矮一点、详情的右栏挪到图下面。 */
const NARROW = 760;

export function GalleryPage({ ui, api }: { ui: UiContext; api: Remote<ImageApi> }) {
	const { resolvedLocale } = useI18n();
	const m = MESSAGES[resolvedLocale];
	const [narrow, measure] = useNarrow(NARROW);
	const gallery = useGallery((state) => state.gallery);
	const status = useGallery((state) => state.status);
	const error = useGallery((state) => state.error);
	const query = useGallery((state) => state.query);
	const open = useGallery((state) => state.open);

	const refresh = useCallback(() => refreshGallery(api), [api]);
	useLiveRefresh(refresh, false);
	useEffect(
		() =>
			ui.onSessionsChanged((change) => {
				// 消息落盘以后才重读，生成结束事件本身还读不到工具结果。
				if (changesGallery(change, gallery)) void refresh();
			}),
		[ui, gallery, refresh],
	);

	const index = useMemo(() => (gallery ? indexGallery(gallery) : null), [gallery]);
	const shown = useMemo(() => (index ? index.drawn.filter((entry) => matches(entry, index.sessions.get(entry.sessionId), query)) : []), [index, query]);
	/**
	 * 图是从哪一格点开的，飞进来用。只给那一张、只用一次：回到画廊时还开着的图不是从格子点开的，不该看起来像。
	 */
	const [origin, setOrigin] = useState<{ media: string; tile: HTMLElement } | null>(null);
	const onOpen = useCallback((media: string, tile: HTMLElement) => {
		setOrigin({ media, tile });
		openPicture(media);
	}, []);

	const opened = open ? index?.byMedia.get(open) : undefined;
	// 开着的图所在的会话被删了，就没什么可看的了。
	useEffect(() => {
		if (open && index && !index.byMedia.has(open)) openPicture(null);
	}, [open, index]);

	return (
		<div ref={measure} data-image-gallery="" data-narrow={narrow ? "" : undefined} className="image-gallery-page">
			{/* 开着一张图时相册照样排着——图要飞回去——但不接键盘。 */}
			<div inert={Boolean(opened)} className="image-gallery-album">
				{/* 相册上面那一行空着拖窗口；页面自己画它，是因为详情要从顶边开始。 */}
				<PageTopRow start />
				<Scroller className="image-gallery-scroll" contentClassName="image-gallery-content">
					<header className="image-gallery-header">
						<div className="image-gallery-heading">
							<Text as="h1" size="heading" weight="semibold">
								{m.title}
							</Text>
							<Text as="p" tone="muted" data-image-gallery-count="" className="image-gallery-count">
								{index ? m.count(index.drawn.length) : " "}
							</Text>
						</div>
						{index && index.drawn.length > 0 && (
							<SearchField
								value={query}
								onChange={setGalleryQuery}
								placeholder={m.search}
								className="image-gallery-search"
								onEscape={() => setGalleryQuery("")}
							/>
						)}
					</header>
					{!index && status !== "error" && <GallerySkeleton narrow={narrow} label={m.loading} />}
					{!index && status === "error" && (
						<div className="image-gallery-state">
							<Text as="p" tone="muted">
								{m.loadFailed(error)}
							</Text>
							<Button size="sm" onClick={() => void refresh()}>
								{m.retry}
							</Button>
						</div>
					)}
					{index && index.drawn.length === 0 && (
						<div data-image-gallery-empty="" className="image-gallery-state image-gallery-empty">
							<Images size={28} strokeWidth={1.5} className="image-gallery-empty-icon" />
							<Text as="p" size="body">
								{m.empty}
							</Text>
							<Text as="p" tone="muted" className="image-gallery-empty-hint">
								{m.emptyHint}
							</Text>
						</div>
					)}
					{index && index.drawn.length > 0 && shown.length === 0 && (
						<Text as="p" tone="muted" className="image-gallery-state">
							{m.noMatch}
						</Text>
					)}
					{index && shown.length > 0 && <GalleryGrid ui={ui} entries={shown} index={index} narrow={narrow} onOpen={onOpen} />}
				</Scroller>
			</div>
			{opened && index && (
				<GalleryDetail
					ui={ui}
					entry={opened}
					index={index}
					order={shown}
					origin={origin?.media === opened.media ? origin.tile : null}
					narrow={narrow}
					onArrived={() => setOrigin(null)}
					onClose={() => {
						openPicture(null);
						setOrigin(null);
					}}
				/>
			)}
		</div>
	);
}

/** 第一次读还没回来时页面的样子：一个日期标题的高度，然后两行格子。 */
function GallerySkeleton({ narrow, label }: { narrow: boolean; label: string }) {
	const widths = narrow ? [160, 120, 150] : [220, 300, 220, 170, 260];
	return (
		<div role="status" aria-label={label} className="image-gallery-skeleton">
			<SkeletonBar width="64px" height={12} className="image-gallery-skeleton-head" />
			{[0, 1].map((row) => (
				<div key={row} className="image-gallery-skeleton-row">
					{widths.map((width, at) => (
						<span key={at} className="image-gallery-skeleton-tile" style={{ flex: `${width} 1 0` }}>
							<SkeletonBar width="100%" height={narrow ? 140 : 200} className="image-gallery-skeleton-block" />
						</span>
					))}
				</div>
			))}
		</div>
	);
}
