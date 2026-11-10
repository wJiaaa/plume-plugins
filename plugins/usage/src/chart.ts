/**
 * 柱状图的坐标系，以及悬停气泡放哪。和组件分开放：这是值得测的算术，测它不该要挂 React、量一个测试环境里不排版的布局。
 * 气泡是会悄悄错的那部分：人最常指的是最后一格，紧贴窗口右边，气泡得翻到左边去。
 */

/**
 * SVG 自己的坐标。宽固定，高不固定：图和右边的系列列表在一行，一行有最高那一格那么高，所以高度跟着给它的盒子走，
 * 按宽度推出来的比例换算，两个方向上一个单位一样多像素：字不被拉长，线不被加粗。
 */
export const CHART = { width: 640, height: 212, left: 52, right: 12, top: 12, bottom: 28 } as const;

/** 一个盒子对应的 viewBox 高度，和固定的宽同一个单位。 */
export function viewHeightFor(box: { width: number; height: number }): number {
	if (!(box.width > 0) || !(box.height > 0)) return CHART.height;
	return Math.round(Math.max(CHART.top + CHART.bottom + 80, (CHART.width * box.height) / box.width));
}

export function plotHeightFor(viewHeight: number): number {
	return viewHeight - CHART.top - CHART.bottom;
}

/**
 * 数值轴：一个整的步长，顶端是比最高那根柱子高出整数个步长的地方。把最高的四等分会得到 0.5、1.5 个请求，印出来是
 * 「1」「2」，顺着轴往下重复；次数不能拆，所以 `whole` 时步长至少是 1，也跳过 2.5。只有费用是小数。
 */
export function axisTicks(maximum: number, whole: boolean): number[] {
	if (!(maximum > 0)) return [0];
	const raw = maximum / 4;
	const power = 10 ** Math.floor(Math.log10(raw));
	const steps = whole ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10];
	const step = Math.max(whole ? 1 : 0, (steps.find((each) => each * power >= raw) ?? 10) * power);
	const count = Math.ceil(maximum / step - 1e-9);
	return Array.from({ length: count + 1 }, (_, index) => index * step);
}

const GAP = 14;
const MARGIN = 8;

/**
 * 气泡放在十字线旁边，不压着指针，不出窗口。放旁边而不是下面：读的是穿过图的那条竖线，压在指针下面的气泡正好盖住它在说的那几根柱子。
 * 先放右边，放不下翻到左边。竖直方向跟着指针，但只在图的那一条里：放开了跟，指在图顶上时气泡会爬到图例和切换按钮上，
 * 把改它内容的控件盖住。比图还高时再放开。最后按窗口夹一次。
 */
export function chartTipPlacement(
	anchor: { x: number; y: number },
	tip: { width: number; height: number },
	viewport: { width: number; height: number },
	plot?: { top: number; bottom: number },
): { left: number; top: number } {
	const right = anchor.x + GAP;
	const left = anchor.x - GAP - tip.width;
	const fitsRight = right + tip.width <= viewport.width - MARGIN;
	const fitsLeft = left >= MARGIN;
	// 两边都放不下时取地方大的那边，剩下的交给夹。
	const preferred = fitsRight ? right : fitsLeft ? left : anchor.x > viewport.width / 2 ? left : right;

	let top = anchor.y - tip.height / 2;
	if (plot && plot.bottom - plot.top >= tip.height) top = Math.max(plot.top, Math.min(top, plot.bottom - tip.height));
	return {
		left: Math.max(MARGIN, Math.min(preferred, Math.max(MARGIN, viewport.width - tip.width - MARGIN))),
		top: Math.max(MARGIN, Math.min(top, Math.max(MARGIN, viewport.height - tip.height - MARGIN))),
	};
}
