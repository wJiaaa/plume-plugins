/** 外框连着变时，停多久才算拖完。 */
const SETTLE_MS = 140;

export interface FrameSize {
	width: number;
	height: number;
}

/**
 * 页面的像素尺寸跟着外框走，但一串连着的变化只贴头尾两次。
 *
 * iframe 每换一次尺寸，里面的页面就要按新尺寸整张重排、重画，宿主这一帧要等它画完才交得出去。拖面板宽度时
 * 每帧都在换，一张带模糊滤镜、几百个动画元素的页面会把整个窗口拖到半帧率（同一页实测：每帧换尺寸 3 秒出 159 帧，
 * 尺寸不跟着换时 360 帧满帧）。所以第一下变化当场贴上（展开、内容长高这类一次性的变化不用等），之后接连来的
 * 只记下最后一个，停下 `wait` 毫秒再贴。拖动中外框比页面小时多出的部分被裁掉，大时露出一条底色，松手后对齐。
 *
 * 宽或高为 0 的不算（面板区收起、卡片折叠时），页面留着上一次的尺寸。
 */
export function settleSize(apply: (size: FrameSize) => void, wait = SETTLE_MS) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let last: FrameSize | undefined;
	let pending: FrameSize | undefined;
	const same = (a: FrameSize | undefined, b: FrameSize) => !!a && a.width === b.width && a.height === b.height;
	const put = (size: FrameSize) => {
		last = size;
		apply(size);
	};
	const quiet = () => {
		timer = undefined;
		const size = pending;
		pending = undefined;
		if (size && !same(last, size)) put(size);
	};
	return {
		update(size: FrameSize) {
			if (!(size.width > 0 && size.height > 0)) return;
			if (timer === undefined) {
				if (same(last, size)) return;
				put(size);
			} else {
				pending = size;
				clearTimeout(timer);
			}
			timer = setTimeout(quiet, wait);
		},
		dispose() {
			clearTimeout(timer);
			timer = undefined;
			pending = undefined;
		},
	};
}
