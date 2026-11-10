/**
 * 钉在桌面上的一张截图：一张图、一个关闭按钮，别的什么都没有。
 *
 * 这一页就是钉图窗口的全部。窗口在加载前已经被宿主按图的尺寸开好，所以这里几乎没有布局可言——图正好铺满窗口，
 * 别的都画在它上面。
 *
 * 拖动是手写的，不用 `-webkit-app-region: drag`，这是这个文件里唯一的设计决定。拖动区由窗口服务器处理，页面在里面
 * 收不到指针：没有 `pointermove`，也没有 `:hover`。关闭按钮应该在指针移到图上时出现，用拖动区就等于拿要的功能换了
 * 底下那个功能。经 IPC 挪窗口每帧一条消息，两样都保住。
 */

import type { PinnedShotProps } from "@plume/contract/ui";
import { useI18n } from "@plume/ui";
import { X } from "@plume/ui/icons";
import { useEffect, useRef, useState } from "react";
import { MESSAGES } from "./messages.ts";

export function PinnedShot({ image, ready, close, dragStart, dragMove }: PinnedShotProps) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const [hovered, setHovered] = useState(false);
	/** 窗口是不是正被拖着，图的光标跟着说。 */
	const [dragging, setDragging] = useState(false);
	/** 拖动开始时指针在哪，屏幕坐标。 */
	const from = useRef<{ x: number; y: number } | null>(null);

	/*
	 * 图真的画上了才说，不是图到了就说。
	 *
	 * 窗口建的时候是隐藏的，这条消息才让它显示。内容还没画就显示的透明窗口，是一块带阴影的桌面——很短，但钉图发生在
	 * 截图结束的那一刻，那本来就是这个功能最忙的一帧。
	 */
	useEffect(() => {
		const img = new Image();
		img.onload = () => requestAnimationFrame(() => ready());
		// 解不出来的图也得把窗口亮出来，不然屏幕上就有一个看不见、关不掉的置顶窗口。
		img.onerror = () => ready();
		img.src = image.src;
	}, [image, ready]);

	/*
	 * 拖动的后半段挂在窗口上，不挂在图上。
	 *
	 * 两个原因，第二个才是这样写的理由。指针动得比窗口跟得快时，两次事件之间图会被甩在后面，拖到一半就停了。而那个
	 * 显而易见的修法——在图上 `setPointerCapture`——会让渲染进程在拖动结束的那一下之后时不时完全不再响应输入：一个被
	 * 捕获的指针，在一个自己也在追着这个指针跑的窗口里。挂在窗口上的监听两样问题都没有，事后也不用释放什么。
	 *
	 * 用 `screenX`/`screenY` 不用 `clientX`：窗口跟着拖动在动，指针在窗口里的位置几乎不变——按窗口内坐标量出来的
	 * 偏移接近零，窗口哪儿也去不了。
	 *
	 * 每帧一条消息。`pointermove` 可能比屏幕刷新来得勤，每条都让主进程挪一次窗口；多出来的那几次看不见，还要合成器去抵消。
	 */
	useEffect(() => {
		if (!dragging) return;
		let queued: { dx: number; dy: number } | null = null;
		let frame = 0;
		const flush = () => {
			frame = 0;
			if (!queued) return;
			dragMove(queued.dx, queued.dy);
			queued = null;
		};
		const move = (event: PointerEvent) => {
			const start = from.current;
			if (!start) return;
			queued = { dx: Math.round(event.screenX - start.x), dy: Math.round(event.screenY - start.y) };
			if (!frame) frame = requestAnimationFrame(flush);
		};
		const end = () => {
			from.current = null;
			setDragging(false);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", end);
		window.addEventListener("pointercancel", end);
		return () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", end);
			window.removeEventListener("pointercancel", end);
			if (frame) cancelAnimationFrame(frame);
		};
	}, [dragging, dragMove]);

	// Esc 关掉指针所在的那张，也就是有焦点的那张。
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				close();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [close]);

	return (
		<div
			data-pinned="shown"
			// 拖动时整个窗口都是握紧的手，关闭按钮也是：窗口追着指针跑，指针一直在窗口里。
			className="shot-pinned"
			data-dragging={dragging || undefined}
			onPointerEnter={() => setHovered(true)}
			onPointerLeave={() => {
				// 拖动时不算：窗口在追指针，指针一直在离开窗口。
				if (!from.current) setHovered(false);
			}}
			onDragStart={(event) => event.preventDefault()}
		>
			<img
				src={image.src}
				alt={text.pinnedTitle}
				draggable={false}
				data-pinned-image
				/*
				 * 图边上一圈细线，画在图里面。
				 *
				 * macOS 给无边框窗口一圈阴影，在那里就够了；Windows 和 Linux 给透明窗口什么都不给，钉在白色文档上的一张白色文档
				 * 截图就没有边——看起来是底下那份的一部分。往里画的线只占图最外一圈像素，三个系统上一样。
				 */
				className="shot-pinned-image"
				/*
				 * 图就是窗口的标题栏。按下在这里接，后面的拖动在窗口上跟（见上面的 effect）。不用 `setPointerCapture`，理由同上。
				 */
				onPointerDown={(event) => {
					if (event.button !== 0) return;
					event.preventDefault();
					from.current = { x: event.screenX, y: event.screenY };
					setDragging(true);
					dragStart();
				}}
			/>

			{/*
			 * 关闭按钮压在图的角上，不放在图旁边。
			 *
			 * 放旁边窗口就得比图大，而透明的边不是空地：Electron 按窗口的框做命中测试，那圈边会吞掉每一下点向背后东西的点击。
			 */}
			<button
				type="button"
				data-pinned-close
				aria-label={text.pinnedClose}
				onPointerDown={(event) => event.stopPropagation()}
				onClick={() => close()}
				className="shot-pinned-close"
				// 不显示时整个让开：不接本该给图的按下，从右上角拖也照样能拖。
				data-shown={hovered || undefined}
			>
				<X size={13} strokeWidth={2.4} />
			</button>
		</div>
	);
}
