import { Text, Tooltip } from "@plume/ui";
import { type HeatDay, heatLevel, monthLabels } from "./heatmap.ts";
import { fill, type Messages } from "./messages.ts";

const SHADES = [0, 1, 2, 3, 4] as const;
/** 一格的边长和格间距，月份标签按它算横向位置。 */
const CELL = 11;
const GAP = 3;

/** 一格：SVG 画，圆角是图形的一部分（和柱状图的柱子一样），不随皮肤的圆角变。 */
function Cell({ level, future }: { level: number; future?: boolean }) {
	return (
		<svg width={CELL} height={CELL} className="usage-heat-cell" data-future={future || undefined} aria-hidden>
			<rect width={CELL} height={CELL} rx="2" className={`usage-shade-${level}`} />
		</svg>
	);
}

/** 一年的格子。按什么上色、气泡里写什么由调用方给：可以是 token、请求数或费用。 */
export function Heatmap({ grid, value, tip, text }: { grid: HeatDay[][]; value: (day: HeatDay) => number; tip: (day: HeatDay) => string; text: Messages }) {
	const labels = monthLabels(grid, (n) => fill(text.month, { n }));
	const busiest = Math.max(0, ...grid.flat().map(value));
	const now = Date.now();
	return (
		// 从右往左排：窄的时候先让出去的是最早那几周，今天总在看得见的地方。
		<div className="usage-heat" dir="rtl">
			<div dir="ltr" className="usage-heat-inner">
				<div className="usage-heat-months">
					{labels.map((label) => (
						<Text key={label.column} size="detail" tone="faint" className="usage-heat-month" style={{ left: label.column * (CELL + GAP) }}>
							{label.text}
						</Text>
					))}
				</div>
				<div className="usage-heat-grid">
					{grid.map((week) => (
						<div key={week[0]?.key} className="usage-heat-week">
							{week.map((day) => {
								const future = day.date.getTime() > now;
								const cell = <Cell level={heatLevel(value(day), busiest)} future={future} />;
								return future ? (
									<span key={day.key} className="usage-heat-slot">
										{cell}
									</span>
								) : (
									<Tooltip key={day.key} label={tip(day)} side="top">
										<span className="usage-heat-slot">{cell}</span>
									</Tooltip>
								);
							})}
						</div>
					))}
				</div>
				<Text as="div" size="detail" tone="faint" className="usage-heat-legend">
					<span className="usage-heat-less">{text.less}</span>
					{SHADES.map((level) => (
						<span key={level} role="img" aria-label={fill(text.bucket, { index: level })} className="usage-heat-slot">
							<Cell level={level} />
						</span>
					))}
					<span className="usage-heat-more">{text.more}</span>
				</Text>
			</div>
		</div>
	);
}
