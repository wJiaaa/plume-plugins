/**
 * 一张图的来历，从上往下：它经过的每一张图排成一列，旁边是当时说的话。
 *
 * 几何是 `lineageTree` 的：图不离开这一列，紧跟在原图下面的修改用短直线挂着，别的线沿左边的槽往下走、拐进它画出的那张。
 * 通到台上这张图的那几段用强调色，不管一家子分了多少叉，先读到的都是它自己的来路。
 */

import type { UiContext } from "@plume/contract/ui";
import { Text, Tooltip, useI18n } from "@plume/ui";
import { useLayoutEffect, useMemo, useRef } from "react";
import { familyOf, lineageTree, type TreeLink } from "./lineage-tree.ts";
import { GALLERY_MESSAGES as MESSAGES } from "../messages.ts";
import { askText, type GalleryIndex } from "./model.ts";

const ROW = 64;
const THUMB = 44;
/** 缩略图的长边：44px 的格子在 2× 屏上要 88 像素，取宿主常用的 128 一档，和别处共用盘上那份。 */
const THUMB_EDGE = 128;
const TOP = (ROW - THUMB) / 2;
/** 线在图前面停下：连着两张图却不碰到它们，也不碰当前那张外面的圈。 */
const CLEAR = 4;
const RADIUS = 5;
/** 两道槽之间、列到第一道槽的距离。 */
const LANE = 9;
const FIRST = 11;
/** 高亮的底从图左边这么远开始，槽里的线留在它外面。 */
const INSET = 6;

export function useFamily(media: string, index: GalleryIndex) {
	return useMemo(() => familyOf(media, index.nodes), [media, index.nodes]);
}

export function Lineage({ ui, current, index, onSelect }: { ui: UiContext; current: string; index: GalleryIndex; onSelect: (media: string) => void }) {
	const { resolvedLocale, formatDate } = useI18n();
	const m = MESSAGES[resolvedLocale];
	const family = useFamily(current, index);
	const { order, links, lanes } = useMemo(() => lineageTree(family, current), [family, current]);
	// 图这一列从哪开始：有槽时让过槽，也不贴着高亮的边。
	const column = lanes > 0 ? FIRST + 3 + (lanes - 1) * LANE : INSET;
	const list = useRef<HTMLOListElement>(null);
	// 台上那张图换了，列表跟着把它留在视野里；来历很长时底下的往上滚。
	useLayoutEffect(() => {
		list.current?.querySelector<HTMLElement>("[aria-current='step']")?.scrollIntoView({ block: "nearest" });
	}, [current]);

	return (
		<ol ref={list} data-image-lineage="" className="image-lineage" style={{ height: order.length * ROW }}>
			{order.map((node) => {
				const entry = index.byMedia.get(node.id);
				if (!entry) return null;
				const active = node.id === current;
				/*
				 * 放进来而不是画出来的图，说它是什么，不说当时要了什么：带着它的那句话是下一步的要求，说两遍读起来像两次请求。
				 */
				const words = entry.kind === "given" ? (entry.from ? m.markedStep : m.givenStep) : askText(entry) || m.noWords;
				const kind = entry.kind === "given" ? "" : entry.sources.length ? m.edited : m.drawn;
				const meta = [
					kind,
					formatDate(entry.at, { hour: "2-digit", minute: "2-digit" }),
					entry.kind === "drawn" && entry.count > 1 ? `${entry.nth + 1}/${entry.count}` : "",
				]
					.filter(Boolean)
					.join(" · ");
				return (
					<li key={node.id} style={{ height: ROW, paddingLeft: column - INSET }}>
						<Tooltip label={words}>
							<button
								type="button"
								data-image-lineage-step={node.id}
								aria-current={active ? "step" : undefined}
								onClick={() => onSelect(node.id)}
								className="image-lineage-step"
								style={{ paddingLeft: INSET }}
							>
								<img
									src={ui.mediaUrl(node.id, THUMB_EDGE)}
									alt=""
									draggable={false}
									loading="lazy"
									decoding="async"
									className="image-lineage-thumb"
									data-current={active ? "" : undefined}
									style={{ width: THUMB, height: THUMB }}
								/>
								<span className="image-lineage-text">
									<Text tone={entry.kind === "drawn" ? "default" : "muted"} className="image-lineage-line-text">
										{words}
									</Text>
									<Text size="caption" tone="faint" className="image-lineage-line-text">
										{meta}
									</Text>
								</span>
							</button>
						</Tooltip>
					</li>
				);
			})}
			<Links links={links} column={column} rows={order.length} />
		</ol>
	);
}

/** 所有的线画成一条路径；通到台上那张的最后画、压在上面、用强调色。 */
function Links({ links, column, rows }: { links: TreeLink[]; column: number; rows: number }) {
	if (links.length === 0) return null;
	const middle = (row: number) => row * ROW + ROW / 2;
	const centre = column + THUMB / 2;
	const edge = column - CLEAR;
	const draw = (link: TreeLink) => {
		if (link.lane === null) return `M ${centre} ${link.from * ROW + TOP + THUMB + CLEAR} V ${link.to * ROW + TOP - CLEAR}`;
		const x = column - FIRST - link.lane * LANE;
		const top = middle(link.from);
		const bottom = middle(link.to);
		// 从左边出来，拐个弯，沿槽往下，再拐个弯进左边。
		return `M ${edge} ${top} H ${x + RADIUS} Q ${x} ${top} ${x} ${top + RADIUS} V ${bottom - RADIUS} Q ${x} ${bottom} ${x + RADIUS} ${bottom} H ${edge}`;
	};
	const quiet = links.filter((link) => !link.onPath).map(draw);
	const path = links.filter((link) => link.onPath).map(draw);
	return (
		<svg aria-hidden className="image-lineage-links" width={column + THUMB} height={rows * ROW}>
			{quiet.length > 0 && <path d={quiet.join(" ")} className="image-lineage-link" />}
			{path.length > 0 && <path d={path.join(" ")} className="image-lineage-link" data-on-path="" />}
		</svg>
	);
}
