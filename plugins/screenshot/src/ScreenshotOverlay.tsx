/**
 * 全屏的原地截图浮层，用 `@plume/ui` 的标注器画。
 *
 * 这里碰头的有两套坐标，值得说清哪个是哪个。选区和每个指针事件用 CSS 像素，浮层窗口就是按它量的。标注器用快照自己的像素，
 * 在 Retina 屏上是两倍那么多。所以 `AnnotateCanvas` 拿到的是一个明确的 CSS 尺寸——它站着的那块屏幕，1:1——而不是任它按
 * 位图的尺寸排版，那会盖住两倍于它该盖的面积。
 *
 * 交给标注器的是*整张*快照，不是选区裁出来的一块；选区是开在它上面的一扇窗：一个绝对定位的框，底下整张画布按选区自己的
 * 偏移挪开。这样选区事后被挪动、调大小时，标记还钉在它们画上去的东西上——裁一块的话每次拖都得重裁，上面每个标记都会滑走。
 *
 * 宿主每次截图换一个 session，这个组件随之重新挂上（见 `ScreenOverlayProps`），所以一次截图的状态就是这个组件的状态，
 * 不用在两次截图之间手动清。
 */

import type { Remote, ScreenCapture, ScreenOverlayProps } from "@plume/contract/ui";
import {
	AnnotateCanvas,
	AnnotateToolbar,
	handlePoint,
	HANDLE_CURSOR,
	HANDLES,
	shortcutLabel,
	shortcutLetter,
	Text,
	useAnnotator,
	useI18n,
	useToolbarPlacement,
} from "@plume/ui";
import { Check, TriangleAlert } from "@plume/ui/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ScreenshotApi, WindowRect } from "./api.ts";
import { createCaptureActions } from "./capture-actions.ts";
import { MESSAGES } from "./messages.ts";
import { ScreenshotLoupe } from "./ScreenshotLoupe.tsx";
import { type SettingsStore, useSettings } from "./settings-store.ts";
import { EDGE_GRAB, useSelectionGesture } from "./useSelectionGesture.ts";

/**
 * 压暗出去用多久，和 screenshot.css 里 `.shot-layer` 的过渡（`--plume-t-quick`）是同一个数：淡完了才收窗口。
 * 进来也用它。短到不算拖之前的等待，长到读得出是过渡而不是跳——要解决的抱怨是截图一下子整个冒出来。
 */
const LEAVE_MS = 150;
/**
 * 「已复制色值」在截图*走了之后*还停多久，以及它自己走用多久。
 *
 * 它故意比浮层的内容活得长。颜色已经在剪贴板上，没什么可框的了，所以截图立刻走——和 Esc 一样快——确认留在真实的
 * 桌面上停够读完的时间，这正是它的用处。
 */
const TOAST_MS = 700;
/** 吐司自己走用多久，和 `.shot-toast-host` 的过渡（`--plume-t-base`）同一个数。 */
const TOAST_FADE_MS = 220;

/** 截图本身走了以后，桌面上那句确认说什么。成功和取色一样短；失败带上细节，好重试。 */
interface ToastMessage {
	text: string;
	detail?: string;
	/** 是不是失败，失败给警告标，不给勾。 */
	failed?: boolean;
}

export function ScreenshotOverlay({
	session,
	ready,
	finish,
	cancel,
	pin,
	copy,
	passThrough,
	onEscape,
	api,
	screen,
	store,
}: ScreenOverlayProps & { api: Remote<ScreenshotApi>; screen: ScreenCapture; store: SettingsStore }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const settings = useSettings(store);
	const { bounds, colorSpace } = session;

	const bgCanvasRef = useRef<HTMLCanvasElement | null>(null);

	/**
	 * 比截图活得长的那句确认，或者 null。三件事以它结束——取了色、下载了、钉住了——各有各的话说，所以状态里放的是话本身。
	 * `copied` 另外放：放大镜自己那行「已复制」是另一处的另一件事。
	 */
	const [toast, setToast] = useState<ToastMessage | null>(null);
	const [captureActions] = useState(createCaptureActions);
	useEffect(() => {
		captureActions.reset(session.id);
		return () => captureActions.reset();
	}, [captureActions, session.id]);

	/*
	 * 屏幕上的窗口，截图开始时问一次逻辑入口。查到之前是空的：那几十毫秒里只能手动框，查到后指针底下的窗口当场亮起来。
	 */
	const [windows, setWindows] = useState<WindowRect[]>([]);
	useEffect(() => {
		let alive = true;
		void api.listWindows(bounds).then((list) => {
			if (alive) setWindows(list);
		});
		return () => {
			alive = false;
		};
	}, [api, bounds]);
	const frame = useMemo(() => ({ bounds, windows, cursor: session.cursor }), [bounds, windows, session.cursor]);

	/*
	 * 框选那一半在 `useSelectionGesture` 里：框、拖动模式、光标、窗口高亮，以及放大镜的读数。这里只管渲染和交付。
	 */
	const gesture = useSelectionGesture({ frame, backdrop: bgCanvasRef, colorSpace });
	const { selection, isAnnotating, cursor, pointer, reading, copied, hoverWindow } = gesture;
	/*
	 * 单独解出来，下面的依赖数组才能只写它们。`gesture` 每次渲染都是新对象，写进依赖数组会让订阅每渲染一次就拆一次重建一次。
	 */
	const { reset: resetGesture, setCopied: setColourCopied } = gesture;

	/*
	 * 浮层常常开在一个不会再动的指针底下，等第一次移动就太晚了：一开始和窗口列表到了时，都按指针现在的位置把窗口点上。
	 * 已经开始框了就不动，那会丢掉正在框的那一块。
	 */
	const selecting = selection !== null;
	useEffect(() => {
		if (!selecting) resetGesture(frame);
		// 只在窗口列表到了的时候重来，不跟着选区变：`selecting` 故意不进依赖。
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- 见上
	}, [frame, resetGesture]);

	/* 工具条画在哪，连同它的尺寸测量和拖动，都在 `useToolbarPlacement` 里。 */
	const toolbar = useToolbarPlacement(selection, bounds);
	const snapshot = useMemo(
		() => ({
			pixels: new Uint8Array(session.snapshot.pixels.buffer, session.snapshot.pixels.byteOffset, session.snapshot.pixels.byteLength),
			width: session.snapshot.width,
			height: session.snapshot.height,
		}),
		[session.snapshot],
	);
	const annotator = useAnnotator(snapshot, { session: session.id, colorSpace });
	const { ready: snapshotReady, image: snapshotImage, revision: snapshotRevision } = annotator;

	/*
	 * 定格的屏幕，按拍下时的分辨率。
	 *
	 * 底层位图是快照自己的像素数，不是屏幕的逻辑尺寸：按逻辑尺寸的话，Retina 截图先被压成一半分辨率再拉回去铺满屏幕，
	 * 按下快捷键后看到的第一件事是桌面变糊。
	 */
	useEffect(() => {
		if (!snapshotReady) return;
		const img = snapshotImage.current;
		const canvas = bgCanvasRef.current;
		if (!img || !canvas) return;
		/*
		 * `willReadFrequently` 在这里，跟取色那一处保持完全一致的参数。一块画布的色彩空间由第一次 `getContext` 定下，
		 * 之后传什么都会被忽略——两处的参数必须一模一样，不然谁先跑谁说了算。
		 */
		const ctx = canvas.getContext("2d", { colorSpace, willReadFrequently: true });
		if (!ctx) return;
		canvas.width = img.width;
		canvas.height = img.height;
		ctx.drawImage(img.source, 0, 0);
		/*
		 * 立刻说，故意不等 `requestAnimationFrame`。
		 *
		 * 等一帧看起来更稳妥，实际会死锁：这段跑的窗口在这条消息到达之前一直是隐藏的，隐藏的页面不合成，里面的 rAF 回调
		 * 永远不跑。也没必要——`drawImage` 已经把快照写进画布的位图，`show()` 之后的第一帧就有它。
		 */
		ready();
	}, [snapshotReady, snapshotRevision, snapshotImage, colorSpace, ready]);

	/*
	 * 进来和出去，是淡入淡出而不是一刀切。
	 *
	 * 淡的不是定格的快照——它就是它盖住的那块屏幕的照片，立刻显示按构造就看不出来。淡的是压暗和提示，那是说「你现在在
	 * 截图」的部分：屏幕在一拍里暗下去，而不是整个在一帧里到达。
	 *
	 * 从 `ready` 之后的第一帧开始淡入：窗口显示之前这一页不合成，rAF 不跑，回调来的时候窗口已经在屏幕上了。在那之前开始
	 * 过渡，它会直接落在终点上，那正是要去掉的生硬。计时器只是保险，万一那一帧没来，生硬一点的浮层也好过永远看不见的。
	 */
	const [entered, setEntered] = useState(false);
	const [leaving, setLeaving] = useState(false);
	/** 取色的确认是不是正在走。见 `leaveWithToast`。 */
	const [toastLeaving, setToastLeaving] = useState(false);
	useEffect(() => {
		if (!snapshotReady) return;
		const frameId = requestAnimationFrame(() => setEntered(true));
		const safety = setTimeout(() => setEntered(true), 2000);
		return () => {
			cancelAnimationFrame(frameId);
			clearTimeout(safety);
		};
	}, [snapshotReady]);

	/**
	 * 先放出去的动画，再做那件事。有守卫，第二下 Esc 不会触发两次。
	 *
	 * 守卫是 ref、计时器设在任何 updater 外面，这不是风格问题。state 的 updater 必须是状态的纯函数——React 一次提交里可能调它
	 * 不止一次，返回值和现在一样时也可能根本不调。在那里面排计时器，截图交不交得出去就成了掷硬币：按「完成」，看着它淡出，
	 * 然后永远停在截图状态里，剪贴板上什么都没有。
	 */
	const leavingRef = useRef(false);
	const leaveThen = useCallback(
		(act: () => void) => {
			if (leavingRef.current) return;
			leavingRef.current = true;
			setLeaving(true);
			captureActions.after(LEAVE_MS, act);
		},
		[captureActions],
	);

	const handleCancel = useCallback(() => {
		leaveThen(() => cancel());
	}, [leaveThen, cancel]);

	/*
	 * 主进程听到的 Esc。截图期间 Esc 是全局快捷键，全局快捷键从不作为 keydown 到达这里——下面那个按键处理只在注册失败时才用得上。
	 * 没有这一句，Esc 由主进程直接收起，没有淡出，每一层在一帧里全没了。
	 */
	useEffect(() => onEscape(handleCancel), [onEscape, handleCancel]);

	/**
	 * 像 Esc 那样离开，让确认比截图活得长。
	 *
	 * 截图立刻走，正如 Esc 让它走的那样；那句话在真实的桌面上多停一会儿。`leaving` 用 Esc 那一下 把压暗、放大镜和定格的
	 * 画面拿走；吐司在那一层外面，按自己的钟走。中间窗口还在——透明的，只显示那句话——`passThrough` 让主进程放点击穿过去，
	 * 屏幕看起来正常的那一刻用起来也就正常了。
	 *
	 * 另外两件不往 Plume 交东西就结束的事共用它：下载、钉图。三件事要的形状一样——截图现在走，答案停一拍——不同的只是答案说什么。
	 */
	const leaveWithToast = useCallback(
		(message: ToastMessage, holdMs = TOAST_MS) => {
			if (leavingRef.current) return;
			leavingRef.current = true;
			setToast(message);
			setLeaving(true);
			passThrough(true);
			captureActions.after(LEAVE_MS + holdMs, () => setToastLeaving(true));
			captureActions.after(LEAVE_MS + holdMs + TOAST_FADE_MS, () => cancel());
		},
		[captureActions, passThrough, cancel],
	);

	// Esc，以及放大镜在读色时的 ⌘C。
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				handleCancel();
				return;
			}
			/*
			 * 十字线下的颜色，进剪贴板。只在还没有选区时——正是放大镜在屏幕上的时候；有了能标注的东西之后，复制归正在编辑的那个。
			 * 用 `shortcutLetter`：俄文布局下 C 键打出来是「с」，Ctrl+C 还是那个键。
			 */
			if ((e.metaKey || e.ctrlKey) && shortcutLetter(e) === "c" && reading && !selection) {
				e.preventDefault();
				/*
				 * 取色就是这一趟的全部，所以它结束截图。来是为了那个值，它已经在剪贴板上，没什么可框的——取完还停在截图状态，
				 * 用户就得再去关掉一个已经用完的东西。确认停一拍，屏幕恢复之前答案看得见。
				 */
				void navigator.clipboard?.writeText(reading.hex).then(
					() => {
						setColourCopied(true);
						leaveWithToast({ text: text.colourCopied });
					},
					() => setColourCopied(false),
				);
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [handleCancel, reading, selection, leaveWithToast, setColourCopied, text]);

	/**
	 * 选区和上面的标记，按它自己的分辨率从标注过的画布上裁出来。
	 *
	 * 直接从活的画布上读，不经 `render()` 再解一次码：画布本来就是要的那张图，只是多了框外的部分。三个按钮要同一张图——完成、
	 * 下载、置顶——都在淡出之前调，图里是标记本身，不是淡到一半的它们。
	 */
	const crop = useCallback((): string | null => {
		const source = annotator.canvas.current;
		if (!source || !selection) return null;

		const scale = source.width / bounds.width;
		const out = document.createElement("canvas");
		out.width = Math.max(1, Math.round(selection.width * scale));
		out.height = Math.max(1, Math.round(selection.height * scale));
		/*
		 * 裁出来的这张也在同一个色彩空间里，交出去的文件才是对的。`drawImage` 跨空间会转一道，而 `toDataURL` 会按画布自己的
		 * 空间给 PNG 写上对应的 ICC——空间不对的话，这一步就是把偏色固化进文件里。
		 */
		const ctx = out.getContext("2d", { colorSpace });
		if (!ctx) return null;
		ctx.drawImage(source, Math.round(selection.x * scale), Math.round(selection.y * scale), out.width, out.height, 0, 0, out.width, out.height);
		return out.toDataURL("image/png");
	}, [annotator, selection, bounds, colorSpace]);

	/**
	 * 先把正在打的字落下，再做要图的那件事。
	 *
	 * 文字在被提交之前是画布上的一个 `<textarea>`，提交它的是这个输入框失去焦点——工具条故意从不让它失焦，写字时按「粗」
	 * 改的是这段字而不是结束它。代价是：打一段字、没点别处就按完成，出来的图里没有屏幕上明明看得见的那几个字。
	 *
	 * 那一帧不能省。`flushText` 是一次状态更新，画布由 effect 重画——它返回时那段字在历史里，还不在任何位图里。两帧而不是
	 * 一帧：重画是被动 effect，React 在排它的那次提交之后才跑，同一帧里裁会读到重画之前的画布。
	 */
	const withText = useCallback(
		(then: () => void) => {
			if (!annotator.flushText()) {
				then();
				return;
			}
			requestAnimationFrame(() => requestAnimationFrame(then));
		},
		[annotator],
	);

	const handleFinish = useCallback(() => {
		withText(() => {
			const png = crop();
			if (!png) return;
			// 设了保存位置就每次留一份；没设就只进剪贴板，不往磁盘上堆文件。
			if (settings.saveLocation.trim()) {
				api.save(png, settings.saveLocation).catch((error: unknown) => {
					// i18n-exempt：日志。
					console.error("[screenshot] 保存截图文件失败:", error);
				});
			}
			leaveThen(() => void finish(settings.copyToClipboard ? png : undefined));
		});
	}, [withText, crop, settings, api, leaveThen, finish]);

	/**
	 * 把这块留在桌面上，成为一个自己的窗口。
	 *
	 * `at` 是选区换回屏幕坐标——浮层的原点是这块屏幕的，加回屏幕自己的偏移。窗口正好开在那里，钉图读起来才是截图留在了原地，
	 * 而不是别处冒出一个新东西。不要吐司：图本身就是确认，它落在定格画面原来的位置上，再盖一句话是说屏幕已经说过的事。
	 */
	const handlePin = useCallback(() => {
		withText(() => {
			const png = crop();
			if (!png || !selection) return;
			const at = {
				x: Math.round(bounds.x + selection.x),
				y: Math.round(bounds.y + selection.y),
				width: Math.round(selection.width),
				height: Math.round(selection.height),
			};
			leaveThen(() => void pin(png, at));
		});
	}, [withText, crop, selection, bounds, leaveThen, pin]);

	/** 只有写成了才结束截图；目标写不进去时选区留着，能再试。 */
	const handleDownload = useCallback(() => {
		if (leavingRef.current || !captureActions.startDownload(session.id)) return;
		setToast(null);
		withText(() => {
			if (!captureActions.isCurrent(session.id)) return;
			const png = crop();
			if (!png) {
				captureActions.finishDownload(session.id);
				return;
			}
			// 目标按此刻的设置定，空着是桌面：下载就是要一个文件。
			const write = async () => {
				const dir = settings.downloadLocation.trim() || (await screen.desktopDirectory());
				await api.save(png, dir);
				// 剪贴板和磁盘是两回事：可选的那一份没复制成，不该把已经写好的文件说成保存失败。
				if (settings.copyToClipboard) await copy(png).catch(() => undefined);
			};
			void write()
				.then(
					() => {
						if (captureActions.isCurrent(session.id)) leaveWithToast({ text: text.saved }, 3500);
					},
					(error: unknown) => {
						if (captureActions.isCurrent(session.id))
							setToast({ text: text.saveFailed, detail: error instanceof Error ? error.message : String(error), failed: true });
					},
				)
				.finally(() => captureActions.finishDownload(session.id));
		});
	}, [captureActions, session.id, withText, crop, settings, screen, api, copy, leaveWithToast, text]);

	const toolbarAt = toolbar.at;
	const loupeScale = bgCanvasRef.current && bounds.width ? bgCanvasRef.current.width / bounds.width : 1;

	return (
		<div
			className="shot-overlay"
			data-capture="active"
			data-window-count={windows.length}
			/*
			 * 拖工具条时整块屏幕都说正在拖。把手上的 `grabbing` 不够：拖开几像素指针就离开了它，之后经过的地方各有各的光标——
			 * 区域外是十字线，不让点的地方是禁止——手在把手上握紧，然后一路变回十字线，读起来像拖动被丢了。
			 */
			style={{ cursor: toolbar.dragging ? "grabbing" : cursor }}
			/*
			 * 在这里按下拖动是框选，永远不是拖页面。浮层是一张图上的画布，浏览器自己的拖放正好把这个手势读成把图拖到别处——
			 * 按住期间十字线换成「不能放在这里」。没有地方可放：这个窗口就是整块屏幕。
			 */
			onDragStart={(e) => e.preventDefault()}
			// 捕获阶段：框自己的手势先定，画布才轮得到开始一笔。
			onPointerDownCapture={gesture.onPointerDown}
			onPointerMove={gesture.onPointerMove}
			onPointerUp={gesture.onPointerUp}
		>
			{/* 定格的屏幕，立刻显示，故意不淡：它是已经在那里的东西的照片，没有什么可以从那里淡出。 */}
			<canvas
				ref={bgCanvasRef}
				draggable={false}
				data-screenshot-backdrop
				className="shot-backdrop"
				/*
				 * 带确认的离开一开始就立刻拿走，不淡。取色之后是确认在*真实的*桌面上再停一拍；定格的那份还留着的话，那一拍里桌面
				 * 看起来没反应——点下去了，什么都没发生，因为屏幕上是一张照片。其余的离开都留着它直到窗口走。
				 */
				style={{ opacity: leaving && toast ? 0 : 1 }}
			/>

			{/*
			 * `pointer-events: none`，里面要被碰的东西自己说。一层吞掉按下的全屏层会挡在用户和浮层自己的处理之间——框是在根上拖的，不在这里。
			 */}
			<div className="shot-layer" style={{ opacity: leaving || !entered ? 0 : 1 }}>
				{/* 选区外的压暗 */}
				{selection && (
					<svg className="shot-fill">
						<defs>
							<mask id="cutout">
								<rect width="100%" height="100%" className="shot-mask-keep" />
								<rect x={selection.x} y={selection.y} width={selection.width} height={selection.height} className="shot-mask-hole" />
							</mask>
						</defs>
						<rect width="100%" height="100%" className="shot-dim" mask="url(#cutout)" />
					</svg>
				)}

				{/*
				 * 框出区域之前不说一个字。指针经过时窗口亮起来，比一句话更讲得清这个手势，而屏幕正中的一条横幅正好压在要截的东西上。
				 * 只留压暗，它就是在说「截图中」。
				 */}
				{!selection && !hoverWindow && <div className="shot-dim-all" />}

				{/*
				 * 正在提供的那个窗口，画成它会变成的那块区域。框里不压暗、框外压暗，和选区本身是同一种说法——按下去看到的东西不变，
				 * 变的只是它的身份。尺寸显示出来，一个程序的两个窗口叠在一起时，靠它才知道是不是对的那个。
				 */}
				{!selection && hoverWindow && (
					<>
						<svg className="shot-fill">
							<defs>
								<mask id="window-cutout">
									<rect width="100%" height="100%" className="shot-mask-keep" />
									<rect x={hoverWindow.x} y={hoverWindow.y} width={hoverWindow.width} height={hoverWindow.height} className="shot-mask-hole" />
								</mask>
							</defs>
							<rect width="100%" height="100%" className="shot-dim" mask="url(#window-cutout)" />
						</svg>
						<div
							data-window-highlight
							className="shot-window"
							style={{ left: hoverWindow.x, top: hoverWindow.y, width: hoverWindow.width, height: hoverWindow.height }}
						>
							<Text as="span" size="caption" numeric className="shot-window-size">
								{Math.round(hoverWindow.width)} × {Math.round(hoverWindow.height)}
							</Text>
						</div>
					</>
				)}

				{/*
				 * 透过选区看到的标注器。外框就是那块区域并按它裁切；里面那层把整屏的画布按区域的偏移往左上挪回去，透出来的正好是会存下的
				 * 那部分。裁切也把框外的画布拿出了命中测试，框外的按下才能开一个新框。
				 */}
				{isAnnotating && selection && (
					<div className="shot-window-onto" style={{ left: selection.x, top: selection.y, width: selection.width, height: selection.height }}>
						<div className="shot-shift" style={{ left: -selection.x, top: -selection.y }}>
							<AnnotateCanvas annotator={annotator} zoom={1} style={{ width: bounds.width, height: bounds.height, background: "transparent" }} />
						</div>
					</div>
				)}

				{/* 还能决定区域放哪的时候显示放大镜。在压暗那层外面：放大一块压暗了的屏幕，报的颜色就错了。 */}
				{!selection && pointer && (
					<ScreenshotLoupe
						source={bgCanvasRef.current}
						at={pointer}
						scale={loupeScale}
						viewport={bounds}
						reading={reading}
						copied={copied}
						colorSpace={colorSpace}
						text={text}
						copyHint={shortcutLabel(text.copyColour)}
					/>
				)}

				{/* 选区的边和调大小的手柄 */}
				{selection && (
					<div data-selection className="shot-selection" style={{ left: selection.x, top: selection.y, width: selection.width, height: selection.height }}>
						{/*
						 * 沿边四条，唯一的用处是带着光标。在这个容器上设 `cursor: move` 一有东西可标注就不管用了：标注画布盖满整个区域，
						 * 带着自己的光标，CSS 取的是指针下那个元素的光标——子元素总赢。画布上面的真实元素两半一起解决：光标是它们的，
						 * 按下落在它们身上而不是开始一笔。它们不拦事件，事件照样到浮层自己的处理里，被读成挪动。
						 */}
						{(
							[
								["top", { left: 0, right: 0, top: -EDGE_GRAB / 2, height: EDGE_GRAB }],
								["bottom", { left: 0, right: 0, bottom: -EDGE_GRAB / 2, height: EDGE_GRAB }],
								["left", { top: 0, bottom: 0, left: -EDGE_GRAB / 2, width: EDGE_GRAB }],
								["right", { top: 0, bottom: 0, right: -EDGE_GRAB / 2, width: EDGE_GRAB }],
							] as const
						).map(([side, box]) => (
							<div key={side} className="shot-edge" style={box} />
						))}

						{HANDLES.map((h) => {
							const pt = handlePoint({ x: 0, y: 0, width: selection.width, height: selection.height }, h);
							// 认名字，不认「是选区的第几个孩子」：数子元素会把上面四条边一起数进去。
							return <div key={h} data-selection-handle={h} className="shot-handle" style={{ left: pt.x, top: pt.y, cursor: HANDLE_CURSOR[h] }} />;
						})}
					</div>
				)}

				{/*
				 * 标成控件，双保险。`data-screenshot-ui` 是 `onPointerDown` 认的；这里再拦下按下，它就根本到不了浮层的处理，以后加的规则
				 * 也不会把工具条读成屏幕的一部分。只拦按下，不拦移动和松开：工具条就在选区正下方，从右下角手柄调大小的结尾指针正落在它上面，
				 * 在这里吞掉的 `pointerup` 到不了浮层，浮层就以为还在拖。
				 *
				 * 光标设成默认是修 bug：工具条浮在选区*外面*，已有选区外面的一切都是 `not-allowed`，光标会继承下来。
				 */}
				{isAnnotating && toolbarAt && (
					<div
						ref={toolbar.measure}
						data-screenshot-ui
						data-annotate-bar
						className="shot-toolbar"
						style={{ left: toolbarAt.x, top: toolbarAt.y }}
						onPointerDown={(e) => e.stopPropagation()}
					>
						<AnnotateToolbar
							annotator={annotator}
							onCancel={handleCancel}
							onSave={handleFinish}
							onPin={handlePin}
							onDownload={handleDownload}
							onGrab={toolbar.startDrag}
							grabbing={toolbar.dragging}
							canReplace={false}
							saveLabel={text.done}
							cancelLabel={text.cancel}
							requireDirty={false}
							// 气泡往远离区域的方向开，也就是工具条的另一边；总往上开会落进两者之间的缝里，压在要标注的区域底部。
							propertiesSide={toolbarAt.side === "below" ? "below" : "above"}
						/>
					</div>
				)}
			</div>

			{/*
			 * 答案，在屏幕正中——故意在上面那层外面。那一层里都是截图，截图在这些事一做完就走，用 Esc 那一下；这个不走：颜色在剪贴板上了，
			 * 或者文件在磁盘上了，这句话就是在说这个——它在真实的桌面上多停一拍再自己走。居中而不放在指针旁边，因为这时人已经不看指针了。
			 */}
			{toast && (
				<div data-screenshot-toast className="shot-toast-host" style={{ opacity: toastLeaving ? 0 : 1 }}>
					<div className="shot-toast" data-failed={toast.failed || undefined}>
						{toast.failed ? <TriangleAlert size={44} strokeWidth={2.2} /> : <Check size={44} strokeWidth={2.2} />}
						<Text as="span" size="label" className="shot-toast-text">
							{toast.text}
						</Text>
						{toast.detail && (
							<Text as="span" size="caption" className="shot-toast-detail">
								{toast.detail}
							</Text>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
