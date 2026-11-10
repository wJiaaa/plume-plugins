/**
 * 还没框出区域时跟着指针走的放大镜。
 *
 * 两件事，其实是同一件事。放大到看得清单个像素，它就说清十字线正落在哪个像素上——选区才落得在边上，而不是往里差一像素。
 * 十字线下的那个像素有颜色，顺手把颜色读出来不花什么：截图工具本来就是对着屏幕的那个东西，像样的截图工具都能顺手取色。
 *
 * 从定格的快照上取样，不是从实时屏幕上。快照就是截图会包含的东西，所以放大镜报的和文件里的不可能对不上——而且它已经
 * 解码好了，每帧只是几百个像素的 `drawImage`。
 */

import { Text } from "@plume/ui";
import { useLayoutEffect, useRef } from "react";
import type { Messages } from "./messages.ts";

/** 放大镜里一共显示多少个快照像素宽。 */
const SPAN = 17;
/** 放大镜在屏幕上的大小。 */
const SIZE = 132;

export interface LoupeReading {
	/** 快照像素，取色器的坐标说的就是这个。 */
	x: number;
	y: number;
	hex: string;
}

export function ScreenshotLoupe({
	source,
	at,
	scale,
	viewport,
	reading,
	copied,
	colorSpace = "srgb",
	text,
	copyHint,
}: {
	/** 定格的屏幕，原始分辨率。 */
	source: HTMLCanvasElement | null;
	/** 指针在哪，CSS 像素。 */
	at: { x: number; y: number };
	/** 每 CSS 像素多少快照像素。 */
	scale: number;
	viewport: { width: number; height: number };
	reading: LoupeReading | null;
	copied: boolean;
	/**
	 * 快照那块画布的色彩空间，放大镜用同一个。两块画布空间不同时 `drawImage` 会在中间转一道，放大镜里的颜色就跟它下面
	 * 那片屏幕不是同一个——而放大镜存在的全部意义就是看清这一格到底是什么颜色。
	 */
	colorSpace?: PredefinedColorSpace;
	text: Messages;
	/** 「按 ⌘C 复制色值」，按本机键盘写好的。 */
	copyHint: string;
}) {
	const glass = useRef<HTMLCanvasElement | null>(null);

	/*
	 * 在这一帧画出来之前画，和挪动方框在同一次提交里。
	 *
	 * 放在画完之后（`useEffect`）时，放大镜的第一帧是一个空的黑方块，之后每次挪动都是方框到了新位置、里面还是旧像素——
	 * 十字线下的读数比十字线慢一帧。指针移动不是离散事件，React 不会在画之前先跑完被动的 effect。
	 */
	useLayoutEffect(() => {
		const el = glass.current;
		const ctx = el?.getContext("2d", { colorSpace });
		if (!el || !ctx || !source) return;
		const half = SPAN / 2;
		ctx.imageSmoothingEnabled = false;
		ctx.clearRect(0, 0, el.width, el.height);
		// 快照的一小块，放大到一个快照像素是一个看得见的方格。
		ctx.drawImage(source, at.x * scale - half, at.y * scale - half, SPAN, SPAN, 0, 0, el.width, el.height);
	}, [source, at.x, at.y, scale, colorSpace]);

	/*
	 * 在指针旁边，永远不出屏幕。会伸出去时翻到另一边，选区最常结束的那个角落里它才用得上。
	 */
	const pad = 18;
	const boxW = SIZE;
	const boxH = SIZE + 44;
	const left = at.x + pad + boxW > viewport.width ? at.x - pad - boxW : at.x + pad;
	const top = at.y + pad + boxH > viewport.height ? at.y - pad - boxH : at.y + pad;
	const cell = `${(1 / SPAN) * 100}%`;
	const middle = `${(Math.floor(SPAN / 2) / SPAN) * 100}%`;

	return (
		<div data-loupe className="shot-loupe" style={{ left, top, width: boxW }}>
			<div className="shot-loupe-glass" style={{ height: SIZE }}>
				<canvas ref={glass} width={SIZE} height={SIZE} />
				{/*
				 * 十字线标的是报出来的那个像素，不是镜片的正中。两者按构造是同一处——那一小块是以指针为中心取的——画在 DOM 里，
				 * 不进那块每帧重画的画布。
				 */}
				<span className="shot-loupe-hline" />
				<span className="shot-loupe-vline" />
				<span className="shot-loupe-cell" style={{ left: middle, top: middle, width: cell, height: cell }} />
			</div>
			<Text as="div" size="caption" numeric className="shot-loupe-readout">
				<div className="shot-loupe-line">
					<span className="shot-loupe-key">{text.coordinates}</span>
					<span>{reading ? `${reading.x}, ${reading.y}` : "—"}</span>
				</div>
				<div className="shot-loupe-line">
					<span className="shot-loupe-key">{text.colour}</span>
					<span className="shot-loupe-colour">
						<span className="shot-loupe-swatch" style={{ background: reading?.hex ?? "transparent" }} />
						{reading?.hex ?? "—"}
					</span>
				</div>
				<div className="shot-loupe-hint">{copied ? text.copied : copyHint}</div>
			</Text>
		</div>
	);
}
