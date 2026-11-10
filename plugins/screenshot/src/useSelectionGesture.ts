/**
 * 框选那一半：指针在做什么、框在哪、光标该是什么样。
 *
 * 从 `ScreenshotOverlay.tsx` 拆出来的第二块，也是那个文件最大的一块。截图这件事有两个阶段——先
 * 框一块，再在上面画——而这一个文件同时拿着两阶段的全部状态：17 个 `useState` 里有 8 个属于框选，
 * 三个指针处理函数加起来 240 行，读的时候分不出哪一行在服务哪一个阶段。
 *
 * 这里管的是第一个阶段，加上「框好了」这个交接信号（`isAnnotating`）。第二阶段的东西一件都不在：
 * 标记由 `useAnnotator` 拿着，工具条的位置在 `useToolbarPlacement` 里。
 *
 * 放大镜的读数也在这里，理由是它和框选共用一次指针移动：同一个 `pointermove` 既要更新框、又要从
 * 冻结的桌面上取一个像素的颜色，而且「有框之后放大镜就该让开」这条规则只有同时看见两者才写得出来。
 */

import { useCallback, useState } from "react";

import { clampRect, hitHandle, insideRect, moveRect, rectFromPoints, resizeRect, HANDLE_CURSOR, type HANDLES } from "@plume/ui";
import type { LoupeReading } from "./ScreenshotLoupe.tsx";

type Point = { x: number; y: number };
type Rect = { x: number; y: number; width: number; height: number };
type Handle = (typeof HANDLES)[number];

/** 一次拖动到不了 10px 就不算框，算「点了一下」——见 `onPointerUp` 里那段。 */
const MIN_SELECTION = 10;

/** 抓角上那个把手的容差，单位是显示像素。 */
const HANDLE_GRAB = 10;

/**
 * 选区的边有多宽可以抓，显示像素。
 *
 * 8 比它所在的那条边看起来还窄，得瞄着抓。14 大约是这个平台上窗口调整大小那条边的宽度，而它装饰的那道线只有 1px——
 * 画得精确的地方，抓的范围要给得宽。
 *
 * 导出，是因为覆盖层还要照着它画那四条真实的抓取带（有元素在那儿，光标才是对的）——画出来的
 * 宽度和这里判定的宽度必须是同一个数，否则看得见的边和抓得到的边差一截。
 *
 * 标注时选区里面归画笔：在里面按下是画。区域还得能挪，所以抓的是边本身——眼睛本来就把那里读成截图的边，别的截图工具也都这样。
 */
export const EDGE_GRAB = 14;

type DragMode =
	| { kind: "none" }
	| { kind: "creating"; from: Point }
	| { kind: "moving"; from: Point; origin: Rect }
	| { kind: "resizing"; handle: Handle; origin: Rect };

/** 一个点是落在选区的边上，而不是在中间。 */
function onEdge(rect: Rect, at: Point, tolerance: number): boolean {
	if (!insideRect(rect, at)) return false;
	return at.x - rect.x <= tolerance || rect.x + rect.width - at.x <= tolerance || at.y - rect.y <= tolerance || rect.y + rect.height - at.y <= tolerance;
}

/**
 * 指针底下的窗口：第一个包含它的那个。
 *
 * 从前到后是窗口服务器给的顺序，也是点击时的判定顺序——高亮的就是点下去会点到的那个。
 */
function windowAt(windows: (Rect & { app: string })[] | undefined, at: Point): (Rect & { app: string }) | null {
	return windows?.find((w) => insideRect(w, at)) ?? null;
}

/** 这个 hook 要知道的、关于这一次截图的事。 */
export interface CaptureFrame {
	bounds: Rect;
	windows?: (Rect & { app: string })[];
	/** 覆盖层打开时指针已经在哪，用来在第一次移动之前就把窗口高亮点上。 */
	cursor?: Point | null;
}

export interface SelectionGesture {
	/** 框在哪，`null` 表示还没框。 */
	selection: Rect | null;
	/** 框好了，进入画的阶段。两阶段之间唯一的信号。 */
	isAnnotating: boolean;
	/** 覆盖层该显示的光标。 */
	cursor: string;
	/** 指针在哪（只在还没框的时候有值——有框之后放大镜要让开）。 */
	pointer: Point | null;
	/** 指针底下那个像素，给放大镜。 */
	reading: LoupeReading | null;
	/** 色值刚被复制过——放大镜自己那行「已复制」。 */
	copied: boolean;
	setCopied: (value: boolean) => void;
	/** 指针还没框时底下的那个窗口，用来高亮「整窗截图」。 */
	hoverWindow: (Rect & { app: string }) | null;
	onPointerDown: (event: React.PointerEvent) => void;
	onPointerMove: (event: React.PointerEvent) => void;
	onPointerUp: () => void;
	/** 新一轮开始：清空一切。`frame` 给了就顺手把指针底下那个窗口点上。 */
	reset: (frame?: CaptureFrame) => void;
}

export function useSelectionGesture(options: {
	frame: CaptureFrame | null;
	/** 冻结的桌面那张画布，取色从它上面读。 */
	backdrop: React.RefObject<HTMLCanvasElement | null>;
	colorSpace: "srgb" | "display-p3";
}): SelectionGesture {
	const { frame, backdrop, colorSpace } = options;

	const [selection, setSelection] = useState<Rect | null>(null);
	const [dragMode, setDragMode] = useState<DragMode>({ kind: "none" });
	const [cursor, setCursor] = useState("crosshair");
	const [isAnnotating, setIsAnnotating] = useState(false);

	/**
	 * 还没框时指针所在的窗口。
	 *
	 * 截图快不快，大半在于能不能直接给出整个窗口：最常见的是「截这个窗口」，手动围着它拖一个框，既比窗口自己的边界慢，
	 * 又没它准。一旦有了框就不再重要——从那以后在调的是那个框。
	 */
	const [hoverWindow, setHoverWindow] = useState<(Rect & { app: string }) | null>(null);

	/**
	 * 指针在哪、底下是什么，给放大镜。
	 *
	 * 只留到有框为止：有东西可画之后，一个跟着指针的放大镜是挡着画，而不是帮着画。
	 */
	const [pointer, setPointer] = useState<Point | null>(null);
	const [reading, setReading] = useState<LoupeReading | null>(null);
	const [copied, setCopied] = useState(false);

	const reset = useCallback((next?: CaptureFrame) => {
		setSelection(null);
		setDragMode({ kind: "none" });
		setCursor("crosshair");
		setIsAnnotating(false);
		setCopied(false);
		setReading(null);
		// 不等第一次移动：浮层常常开在一个不会再动的指针底下。
		setPointer(next?.cursor ?? null);
		setHoverWindow(next?.cursor ? windowAt(next.windows, next.cursor) : null);
	}, []);

	const onPointerDown = (e: React.PointerEvent) => {
		if (!frame) return;
		/*
		 * 按在控件上不是按在屏幕上。
		 *
		 * 工具条浮在选区*外面*——按 `toolbarPosition` 在它下面——没有这一句，按在它上面的每一下都会落到函数最底下那条规则，
		 * 被读成「在别处开一个新框」。于是按任何一个工具按钮都会丢掉选区、回到空的十字线，这就是「点一个按钮就立马出现
		 * 新的截图」的全部原因。经 DOM 点按钮的测试看不出来：`element.click()` 只派发 click，根本没有指针事件。
		 */
		if ((e.target as HTMLElement).closest?.("[data-screenshot-ui]")) return;
		const pt: Point = { x: e.clientX, y: e.clientY };

		/*
		 * 这里接了这一下，画布就不能也接。
		 *
		 * 这段在捕获阶段跑，比 `AnnotateCanvas` 先看到按下。这对边上那条抓取带要紧：那里没有手柄元素，按下落在画布上，
		 * 画布开始一笔——然后冒泡到这里又挪了选区。于是每拖一次框都画出一条线。停止传播，调框和在上面画才是两个手势，
		 * 而不是一个手势同时做两件事。
		 */
		const take = () => {
			e.stopPropagation();
			(e.target as HTMLElement).setPointerCapture?.(e.pointerId);
		};

		if (selection) {
			const handle = hitHandle(selection, pt, HANDLE_GRAB);
			if (handle) {
				setDragMode({ kind: "resizing", handle, origin: selection });
				take();
				return;
			}
			if (insideRect(selection, pt)) {
				// 还没开始标注时整个框都能抓；之后只有边能抓，因为中间是画布。
				if (!isAnnotating || onEdge(selection, pt, EDGE_GRAB)) {
					setDragMode({ kind: "moving", from: pt, origin: selection });
					take();
				}
				// 否则这一下归 `AnnotateCanvas`，故意放它过去。
				return;
			}
		}

		/*
		 * 有了框之后，框外面什么都不做。
		 *
		 * 曾经这里会从头开一个新框，丢掉框好的那个和上面的每个标记——伸手去够工具条时在框外几像素按一下就很容易，
		 * 一整次截图就没了。框靠手柄调、靠边挪；外面的地方本来就不该做任何事，光标也这么说。
		 *
		 * 要重来按 Esc。
		 */
		if (selection) {
			e.stopPropagation();
			return;
		}

		// 还没有框时，在哪按下都开始一个。
		setIsAnnotating(false);
		setDragMode({ kind: "creating", from: pt });
		setSelection({ x: pt.x, y: pt.y, width: 0, height: 0 });
		take();
	};

	const onPointerMove = (e: React.PointerEvent) => {
		if (!frame) return;
		const pt: Point = { x: e.clientX, y: e.clientY };

		/*
		 * 有框之前放大镜跟着指针，有框之后让开。
		 *
		 * 从背景画布上取样：它存的是快照原始分辨率的像素，报出来的坐标是图自己的，颜色就是会存下去的那个。
		 */
		if (!selection) {
			setPointer(pt);
			const bg = backdrop.current;
			const scale = bg && frame.bounds.width ? bg.width / frame.bounds.width : 1;
			const px = Math.round(pt.x * scale);
			const py = Math.round(pt.y * scale);
			const ctx = bg?.getContext("2d", { colorSpace, willReadFrequently: true });
			if (ctx && px >= 0 && py >= 0 && px < (bg?.width ?? 0) && py < (bg?.height ?? 0)) {
				/*
				 * 报出来的色值要是 sRGB 的。
				 *
				 * 画布本身是显示器的空间（P3），里面存的数是 P3 的——直接读出来写成 #RRGGBB，得到的
				 * 是「屏幕上那个红」在 P3 里的坐标 EA3323，而不是任何人期待的 FF0000。取色器上的
				 * 值是要拿去填进 CSS 和设计稿的，那两处说的都是 sRGB。`getImageData` 的
				 * `colorSpace` 正是为这件事准备的：让浏览器替我们换算，而不是把坐标当颜色报出去。
				 */
				const [r, g, b] = ctx.getImageData(px, py, 1, 1, { colorSpace: "srgb" }).data;
				const hex = `#${[r, g, b]
					.map((n) => (n ?? 0).toString(16).padStart(2, "0"))
					.join("")
					.toUpperCase()}`;
				setReading({ x: px, y: py, hex });
			}
			setCopied(false);
		} else if (pointer) {
			setPointer(null);
		}

		if (dragMode.kind === "creating") {
			setSelection(clampRect(rectFromPoints(dragMode.from, pt), frame.bounds));
		} else if (dragMode.kind === "moving") {
			const dx = pt.x - dragMode.from.x;
			const dy = pt.y - dragMode.from.y;
			setSelection(moveRect(dragMode.origin, dx, dy, frame.bounds));
		} else if (dragMode.kind === "resizing") {
			setSelection(clampRect(resizeRect(dragMode.origin, dragMode.handle, pt), frame.bounds));
		} else if (!selection) {
			/*
			 * 还什么都没框，就把指针底下的窗口提供出来。
			 *
			 * 只在这个状态下：有了框之后它就是正在处理的东西，背后的窗口再亮起来，等于提议把它扔掉。
			 */
			setHoverWindow(windowAt(frame.windows, pt));
			setCursor("crosshair");
		} else {
			/*
			 * 有框，而且不在拖——那就只是在框上面移动，光标要说清这里能干什么。
			 *
			 * 上一个条件是 `!selection`，走到这里 `selection` 必然有值，所以只有一个 `else`，不是漏了一种情况。
			 */
			const handle = hitHandle(selection, pt, HANDLE_GRAB);
			if (handle) {
				setCursor(HANDLE_CURSOR[handle]);
				return;
			}
			if (insideRect(selection, pt)) {
				// 画布按手里的工具自己设光标；这里只管框。
				setCursor(!isAnnotating || onEdge(selection, pt, EDGE_GRAB) ? "move" : "default");
				return;
			}
			// 在已有的框外面：这里什么都不做，十字线会让人以为能做。对应 `onPointerDown` 里那条规则。
			setCursor("not-allowed");
		}
	};

	const onPointerUp = () => {
		if (dragMode.kind === "creating" && selection && frame) {
			if (selection.width < MIN_SELECTION || selection.height < MIN_SELECTION) {
				/*
				 * 按下没怎么动就松开，取底下那个窗口（有的话）。
				 *
				 * 两个手势开头一样，靠接下来发生了什么区分：拖了是手动框一块，没动就松开是指了一个窗口。底下没有窗口时——
				 * 桌面，或者读不到窗口的屏幕——它还是原来的意思：清掉选区。
				 */
				const whole = hoverWindow ? clampRect(hoverWindow, frame.bounds) : null;
				if (whole && whole.width >= MIN_SELECTION && whole.height >= MIN_SELECTION) {
					setSelection(whole);
					setIsAnnotating(true);
				} else {
					setSelection(null);
				}
			} else {
				setIsAnnotating(true);
			}
			setHoverWindow(null);
		}
		setDragMode({ kind: "none" });
	};

	return {
		selection,
		isAnnotating,
		cursor,
		pointer,
		reading,
		copied,
		setCopied,
		hoverWindow,
		onPointerDown,
		onPointerMove,
		onPointerUp,
		reset,
	};
}
