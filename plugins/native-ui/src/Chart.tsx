import { Text, useI18n } from "@plume/ui";
import { useLayoutEffect, useState, type PointerEvent } from "react";
import { chartData, pieSlices, ticks } from "./data.ts";
import { DataTable } from "./content.tsx";
import { MESSAGES } from "./messages.ts";

const HEIGHT: Record<string, number> = { sm: 140, md: 200, lg: 280 };
const COLOURS = ["var(--plume-accent)", "var(--plume-chart-2)", "var(--plume-chart-3)", "var(--plume-chart-4)", "var(--plume-chart-5)", "var(--plume-chart-6)"];
function short(value: number): string {
	const amount = Math.abs(value);
	if (amount >= 1e9) return `${+(value / 1e9).toFixed(1)}B`;
	if (amount >= 1e6) return `${+(value / 1e6).toFixed(1)}M`;
	if (amount >= 1e4) return `${+(value / 1e3).toFixed(1)}k`;
	return String(+value.toPrecision(3));
}

export function Chart({ props }: { props: Record<string, unknown> }) {
	const messages = MESSAGES[useI18n().resolvedLocale];
	const { labels, keys, values } = chartData(props.data, props.x, props.y);
	const [element, box] = useState<HTMLDivElement | null>(null);
	const [width, setWidth] = useState(0);
	const [hover, setHover] = useState<number | null>(null);
	useLayoutEffect(() => {
		if (!element) return;
		const measure = () => setWidth(Math.round(element.getBoundingClientRect().width));
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [element]);
	if (!values.length)
		return (
			<Text size="label" tone="muted" role="status">
				{messages.empty}
			</Text>
		);
	const kind = props.kind ?? "bar";
	const unit = (props.unit as string | undefined) ?? "";
	const height = HEIGHT[(props.size as string) ?? "md"]!;
	const pie =
		kind === "pie"
			? pieSlices(
					values.map((row) => row[0]!),
					height / 2 - 4,
				)
			: null;
	const all = values.flat();
	const marks = ticks(Math.min(0, ...all), Math.max(0, ...all));
	const low = marks[0]!;
	const high = marks.at(-1)!;
	const gutter = Math.min(width * 0.35, Math.max(...marks.map((value) => short(value).length)) * 7 + 14);
	const plot = { left: gutter, right: Math.max(gutter + 1, width - 10), top: 12, bottom: height - 25 };
	const span = plot.right - plot.left;
	const step = span / values.length;
	const yAt = (value: number) => plot.bottom - ((value - low) / (high - low || 1)) * (plot.bottom - plot.top);
	const xAt = (index: number) =>
		kind === "bar" ? plot.left + step * (index + 0.5) : plot.left + (values.length === 1 ? span / 2 : (index / (values.length - 1)) * span);
	const every = Math.max(1, Math.ceil(values.length / Math.max(1, Math.floor(span / 72))));
	const focus = hover !== null && hover < values.length ? hover : null;
	const point = (event: PointerEvent<SVGRectElement>) => {
		const left = event.currentTarget.getBoundingClientRect().left;
		const at = kind === "bar" ? Math.floor((event.clientX - left) / step) : Math.round(((event.clientX - left) / span) * (values.length - 1));
		setHover(Math.min(values.length - 1, Math.max(0, at)));
	};
	return (
		<figure className="native-ui-chart" data-native-ui-chart={kind}>
			{pie ? (
				<div className="native-ui-pie">
					<Text as="div" size="label">
						<svg
							width={height}
							height={height}
							viewBox={`${-height / 2} ${-height / 2} ${height} ${height}`}
							role="img"
							aria-label={labels.map((label, at) => `${label}: ${pie.values[at]}${unit}`).join(", ")}
						>
							{pie.paths.map((path, at) => (
								<path
									key={at}
									d={path}
									fill={COLOURS[at % COLOURS.length]}
									fillRule="evenodd"
									opacity={focus === null || focus === at ? 1 : 0.35}
									className="native-ui-chart-mark"
									onPointerEnter={() => setHover(at)}
									onPointerLeave={() => setHover(null)}
								>
									<title>{`${labels[at]}: ${pie.values[at]}${unit}`}</title>
								</path>
							))}
							<text textAnchor="middle" dominantBaseline="central">
								{focus === null ? `${short(pie.total)}${unit}` : `${Math.round((pie.values[focus]! / (pie.total || 1)) * 100)}%`}
							</text>
						</svg>
					</Text>
					<div className="native-ui-pie-legend">
						{labels.map((label, at) => (
							<span key={at} className="native-ui-legend">
								<span aria-hidden className="native-ui-swatch" style={{ background: COLOURS[at % COLOURS.length] }} />
								<Text size="caption" tone="muted">
									{label}
								</Text>
								<Text size="caption" numeric>{`${short(pie.values[at]!)}${unit}`}</Text>
							</span>
						))}
					</div>
				</div>
			) : (
				<>
					<div ref={box} className="native-ui-chart-plot" style={{ height }}>
						<Text size="caption" as="div">
							{width > 0 && (
								<svg width={width} height={height} role="img" aria-label={`${messages.chart}: ${keys.join(", ")}${unit ? ` (${unit})` : ""}`}>
									{marks.map((value, at) => (
										<g key={at}>
											<line
												x1={plot.left}
												x2={plot.right}
												y1={yAt(value)}
												y2={yAt(value)}
												className="native-ui-chart-grid"
												strokeDasharray={value === 0 ? undefined : "2 3"}
											/>
											<text x={plot.left - 6} y={yAt(value)} textAnchor="end" dominantBaseline="central">
												{short(value)}
											</text>
										</g>
									))}
									{labels.map((label, index) =>
										index % every === 0 ? (
											<text key={index} x={xAt(index)} y={height - 6} textAnchor="middle">
												<title>{label}</title>
												{label.length > 10 ? label.slice(0, 10) : label}
											</text>
										) : null,
									)}
									{kind === "bar"
										? values.map((row, index) =>
												keys.map((key, at) => {
													const band = step * 0.72;
													const each = band / keys.length;
													const amount = row[at]!;
													return (
														<rect
															key={`${index}-${key}`}
															width={Math.max(0.1, each - (keys.length > 1 ? Math.min(2, each * 0.1) : 0))}
															height={plot.bottom - plot.top}
															style={{
																transform: `translate(${plot.left + step * index + (step - band) / 2 + each * at}px, ${yAt(Math.max(0, amount))}px) scaleY(${Math.abs(yAt(amount) - yAt(0)) / (plot.bottom - plot.top)})`,
															}}
															fill={COLOURS[at]}
															opacity={focus === null || focus === index ? 1 : 0.45}
															className="native-ui-chart-mark"
														>
															<title>{`${labels[index]} · ${key}: ${amount}${unit}`}</title>
														</rect>
													);
												}),
											)
										: keys.map((key, at) => (
												<g key={key}>
													{kind === "area" && (
														<path
															d={`M ${xAt(0)},${yAt(0)} L ${values.map((row, index) => `${xAt(index)},${yAt(row[at]!)}`).join(" L ")} L ${xAt(values.length - 1)},${yAt(0)} Z`}
															fill={COLOURS[at]}
															opacity={0.16}
														/>
													)}
													<polyline
														key={JSON.stringify(values.map((row) => row[at]))}
														points={values.map((row, index) => `${xAt(index)},${yAt(row[at]!)}`).join(" ")}
														fill="none"
														stroke={COLOURS[at]}
														strokeWidth={2}
														strokeLinejoin="round"
														strokeLinecap="round"
														className="native-ui-chart-mark"
													/>
													{values.length === 1 && <circle cx={xAt(0)} cy={yAt(values[0]![at]!)} r={3} fill={COLOURS[at]} />}
													{focus !== null && <circle cx={xAt(focus)} cy={yAt(values[focus]![at]!)} r={3.5} fill={COLOURS[at]} />}
												</g>
											))}
									<rect
										x={plot.left}
										y={plot.top}
										width={span}
										height={plot.bottom - plot.top}
										fill="transparent"
										onPointerMove={point}
										onPointerLeave={() => setHover(null)}
									/>
								</svg>
							)}
							{focus !== null && (
								<div className="native-ui-chart-tip" style={{ left: Math.min(Math.max(0, xAt(focus) + 8), Math.max(0, width - 180)) }}>
									<Text size="caption" weight="medium">
										{labels[focus]}
									</Text>
									{keys.map((key, at) => (
										<Text key={key} size="caption" numeric>{`${key}: ${values[focus]![at]}${unit}`}</Text>
									))}
								</div>
							)}
						</Text>
					</div>
					<figcaption className="native-ui-row" data-gap="sm">
						{keys.map((key, at) => (
							<span key={key} className="native-ui-legend">
								<span aria-hidden className="native-ui-swatch" style={{ background: COLOURS[at] }} />
								<Text size="caption" tone="muted">
									{key}
								</Text>
							</span>
						))}
						{unit && (
							<Text size="caption" tone="muted">
								{unit}
							</Text>
						)}
					</figcaption>
				</>
			)}
			<details className="native-ui-chart-data">
				<summary>
					<Text size="caption" tone="muted">
						{messages.details}
					</Text>
				</summary>
				<DataTable
					table={{
						header: [typeof props.x === "string" ? props.x : messages.chart, ...keys],
						cells: values.map((row, at) => [labels[at], ...row]),
						numeric: [false, ...keys.map(() => true)],
					}}
				/>
			</details>
		</figure>
	);
}
