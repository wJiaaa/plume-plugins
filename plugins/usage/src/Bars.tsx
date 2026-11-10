import { Text } from "@plume/ui";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { axisTicks, CHART, chartTipPlacement, plotHeightFor, viewHeightFor } from "./chart.ts";
import { formatCompact, formatCost } from "./format.ts";
import { fill, type Messages } from "./messages.ts";
import { type BarMetric, type Bars, emptyTotals, merge, metricOf, OTHER, type RequestTotals, speedOf } from "./requests.ts";

/** 前三色是界面里已有的强调色，后五色接着用 `chart-*`。「其他」是灰的：它不是一个东西，只是剩下的那些。 */
const COLORS = [
	"var(--plume-accent)",
	"var(--plume-violet)",
	"var(--plume-ok)",
	"var(--plume-chart-3)",
	"var(--plume-chart-2)",
	"var(--plume-chart-5)",
	"var(--plume-chart-6)",
	"var(--plume-chart-4)",
];

export function seriesColor(key: string, index: number): string {
	return key === OTHER ? "var(--plume-ink-faint)" : (COLORS[index % COLORS.length] as string);
}

export function barValueLabel(value: number, metric: BarMetric): string {
	// 刻度和悬停要分得清小额费用，不能像摘要那样都写成「<$0.01」。
	if (metric === "cost") return value > 0 && value < 1 ? `$${Number(value.toPrecision(3))}` : (formatCost(value) ?? "$0");
	if (metric === "speed") return `${Math.round(value)}`;
	return formatCompact(value);
}

/** 横轴上隔几格写一个字：按小时每 3 小时一个，按天最多八个。 */
function labelStep(count: number, hourly: boolean): number {
	return hourly ? 3 : Math.max(1, Math.ceil(count / 8));
}

function slotLabel(slot: string, hourly: boolean): string {
	if (hourly) return `${slot.slice(11)}:00`;
	const [, month, day] = slot.split("-");
	return `${Number(month)}/${Number(day)}`;
}

interface Hover {
	index: number;
	x: number;
	y: number;
	plot: { top: number; bottom: number };
}

/**
 * 按格堆起来的柱子：每一格是一小时或一天，每一段是一个系列。速度不堆：两段 100 token/秒摞起来不是 200。速度每格只画一根，
 * 是那一格所有看得见的系列合起来的速度（总输出 ÷ 总生成时间），各系列自己的速度在气泡和右边的列表里。
 * 气泡用 fixed 定位，按窗口坐标放：卡片的 overflow 会把贴着右边那一格的气泡裁掉，fixed 不受它管。
 * 刻度的字号跟着外面那层 `Text` 的说明档：SVG 的单位按宽度换算成和像素一样大，字号直接继承就对。
 */
export function UsageBarChart({
	bars,
	metric,
	hourly,
	hidden,
	labelOf,
	text,
}: {
	bars: Bars;
	metric: BarMetric;
	hourly: boolean;
	hidden: ReadonlySet<string>;
	labelOf: (key: string) => string;
	text: Messages;
}) {
	const svgRef = useRef<SVGSVGElement>(null);
	const [viewHeight, setViewHeight] = useState<number>(CHART.height);
	const [hover, setHover] = useState<Hover | null>(null);
	const plotHeight = plotHeightFor(viewHeight);
	const count = bars.slots.length;
	const width = CHART.width - CHART.left - CHART.right;
	const slotWidth = count > 0 ? width / count : width;
	const barWidth = Math.max(1, Math.min(28, slotWidth * 0.64));

	const visible = useMemo(() => bars.series.map((series, index) => ({ series, index })).filter(({ series }) => !hidden.has(series.key)), [bars, hidden]);
	/** 每格看得见的系列合起来；速度柱和气泡的合计读它。 */
	const shown = useMemo(
		() =>
			bars.slots.map((_, slot) => {
				const totals = emptyTotals();
				for (const { series } of visible) merge(totals, series.slots[slot] as RequestTotals);
				return totals;
			}),
		[bars, visible],
	);
	const ticks = axisTicks(Math.max(0, ...shown.map((totals) => metricOf(totals, metric))), metric !== "cost");
	const axisTop = ticks.at(-1) || 1;
	const scale = (value: number) => (value / axisTop) * plotHeight;
	const baseline = CHART.top + plotHeight;

	useEffect(() => {
		const svg = svgRef.current;
		if (!svg) return;
		const measure = () => setViewHeight(viewHeightFor(svg.getBoundingClientRect()));
		const observer = new ResizeObserver(measure);
		observer.observe(svg);
		measure();
		return () => observer.disconnect();
	}, []);

	const showing = hover !== null;
	useEffect(() => {
		if (!showing) return;
		const clear = () => setHover(null);
		window.addEventListener("scroll", clear, true);
		window.addEventListener("blur", clear);
		return () => {
			window.removeEventListener("scroll", clear, true);
			window.removeEventListener("blur", clear);
		};
	}, [showing]);

	const track = (event: React.PointerEvent) => {
		const box = svgRef.current?.getBoundingClientRect();
		if (!box || count === 0) return setHover(null);
		const x = ((event.clientX - box.left) / box.width) * CHART.width;
		const index = Math.floor((x - CHART.left) / slotWidth);
		if (index < 0 || index >= count) return setHover(null);
		const screenX = box.left + ((CHART.left + (index + 0.5) * slotWidth) / CHART.width) * box.width;
		setHover((previous) =>
			previous && previous.index === index && previous.y === event.clientY
				? previous
				: { index, x: screenX, y: event.clientY, plot: { top: box.top, bottom: box.bottom } },
		);
	};

	const step = labelStep(count, hourly);
	const at = hover && hover.index < count ? hover : null;
	const motion = "usage-bar";

	return (
		<Text as="div" size="caption" numeric className="usage-bars" data-usage-bars={metric} onPointerMove={track} onPointerLeave={() => setHover(null)}>
			<svg
				ref={svgRef}
				viewBox={`0 0 ${CHART.width} ${viewHeight}`}
				preserveAspectRatio="none"
				className="usage-bars-svg"
				role="img"
				aria-label={text.requestChart}
			>
				{ticks.map((tick) => {
					const y = baseline - scale(tick);
					return (
						<g key={tick}>
							<line x1={CHART.left} x2={CHART.width - CHART.right} y1={y} y2={y} stroke="var(--plume-line)" strokeWidth="1" />
							<text x={CHART.left - 8} y={y + 4} textAnchor="end" fill="var(--plume-ink-faint)">
								{tick === 0 ? "0" : barValueLabel(tick, metric)}
							</text>
						</g>
					);
				})}

				{at && (
					<rect x={CHART.left + at.index * slotWidth} y={CHART.top} width={slotWidth} height={plotHeight} fill="var(--plume-card-hover)" pointerEvents="none" />
				)}

				{bars.slots.map((slot, slotIndex) => {
					const x = CHART.left + slotIndex * slotWidth + (slotWidth - barWidth) / 2;
					if (metric === "speed") {
						const height = scale(speedOf(shown[slotIndex] as RequestTotals) ?? 0);
						return (
							<rect
								key={slot}
								data-bar-slot={slot}
								x={x}
								width={barWidth}
								rx="1.5"
								fill="var(--plume-accent)"
								className={motion}
								style={{ y: baseline - height, height }}
							/>
						);
					}
					let top = baseline;
					return (
						<g key={slot} data-bar-slot={slot}>
							{visible.map(({ series, index }) => {
								const height = scale(metricOf(series.slots[slotIndex] as RequestTotals, metric));
								top -= height;
								return <rect key={series.key} x={x} width={barWidth} fill={seriesColor(series.key, index)} className={motion} style={{ y: top, height }} />;
							})}
						</g>
					);
				})}

				{bars.slots.map((slot, index) =>
					index % step === 0 ? (
						<text key={slot} x={CHART.left + (index + 0.5) * slotWidth} y={viewHeight - 6} textAnchor="middle" fill="var(--plume-ink-faint)">
							{slotLabel(slot, hourly)}
						</text>
					) : null,
				)}
			</svg>
			{at && (
				<BarTip
					anchor={at}
					title={tipTitle(bars.slots[at.index] as string, hourly)}
					rows={visible.map(({ series, index }) => ({
						key: series.key,
						label: labelOf(series.key),
						color: seriesColor(series.key, index),
						totals: series.slots[at.index] as RequestTotals,
					}))}
					total={shown[at.index] as RequestTotals}
					metric={metric}
					text={text}
				/>
			)}
		</Text>
	);
}

function tipTitle(slot: string, hourly: boolean): string {
	if (!hourly) return slot.replaceAll("-", "/");
	const hour = Number(slot.slice(11));
	return `${slot.slice(0, 10).replaceAll("-", "/")} ${`${hour}`.padStart(2, "0")}:00–${`${hour + 1}`.padStart(2, "0")}:00`;
}

/** 图例和气泡里的色点：SVG 画的圆，不随皮肤的圆角变。`hollow` 是从图上拿掉的系列，只剩一圈。 */
export function Dot({ color, hollow }: { color: string; hollow?: boolean }) {
	return (
		<svg width="8" height="8" viewBox="0 0 8 8" className="usage-dot" aria-hidden>
			{hollow ? <circle cx="4" cy="4" r="3.25" fill="none" stroke={color} strokeWidth="1.5" /> : <circle cx="4" cy="4" r="4" fill={color} />}
		</svg>
	);
}

function BarTip({
	anchor,
	title,
	rows,
	total,
	metric,
	text: words,
}: {
	anchor: Hover;
	title: string;
	rows: { key: string; label: string; color: string; totals: RequestTotals }[];
	total: RequestTotals;
	metric: BarMetric;
	text: Messages;
}) {
	const ref = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const placed = chartTipPlacement(
			anchor,
			{ width: el.offsetWidth, height: el.offsetHeight },
			{ width: window.innerWidth, height: window.innerHeight },
			anchor.plot,
		);
		el.style.left = `${Math.round(placed.left)}px`;
		el.style.top = `${Math.round(placed.top)}px`;
		el.style.visibility = "visible";
	});
	const text = (totals: RequestTotals) =>
		metric === "speed"
			? speedOf(totals) === null
				? "—"
				: fill(words.speedValue, { n: Math.round(speedOf(totals) ?? 0) })
			: barValueLabel(metricOf(totals, metric), metric);
	const lit = rows.filter((row) => row.totals.requests > 0);
	return (
		<div ref={ref} role="tooltip" data-chart-tip="" className="usage-tip" style={{ left: 0, top: 0, visibility: "hidden" }}>
			<Text as="div" size="detail" weight="medium" numeric>
				{title}
			</Text>
			{lit.length === 0 ? (
				<Text as="div" size="detail" tone="faint" className="usage-tip-empty">
					{words.noRequestsInSlot}
				</Text>
			) : (
				<div className="usage-tip-rows">
					{lit.map((row) => (
						<div key={row.key} className="usage-tip-row">
							<Dot color={row.color} />
							<Text size="detail" tone="muted" className="usage-grow usage-truncate">
								{row.label}
							</Text>
							<Text size="detail" numeric className="usage-keep">
								{text(row.totals)}
							</Text>
						</div>
					))}
				</div>
			)}
			{lit.length > 1 && (
				<div className="usage-tip-row usage-tip-total">
					<Text size="detail" tone="faint" className="usage-grow">
						{words.total}
					</Text>
					<Text size="detail" weight="medium" numeric className="usage-keep">
						{text(total)}
					</Text>
				</div>
			)}
		</div>
	);
}
