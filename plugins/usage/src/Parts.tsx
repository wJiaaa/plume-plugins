import { Text, Tooltip } from "@plume/ui";
import type { LucideIcon } from "@plume/ui/icons";
import type { ReactNode } from "react";
import { barValueLabel, Dot, seriesColor } from "./Bars.tsx";
import { formatCost } from "./format.ts";
import { fill, type Messages } from "./messages.ts";
import { ModelIcon } from "./ModelIcon.tsx";
import { type BarMetric, firstTokenOf, hitRateOf, metricOf, OTHER, type RequestTotals, type Series, speedOf, type Split } from "./requests.ts";

/** 供应商 id 换成名字。花销按 id 记，供应商删了以后只剩 id。 */
export type ProviderNames = Readonly<Record<string, string>>;

export function providerLabel(names: ProviderNames, id: string): string {
	return names[id]?.trim() || id;
}

export function seriesLabel(key: string, split: Split, names: ProviderNames, text: Messages): string {
	if (key === OTHER) return text.other;
	if (split === "provider") return providerLabel(names, key);
	if (split === "model") return key;
	const [model, provider] = key.split("\u0000");
	return `${model} · ${providerLabel(names, provider ?? "")}`;
}

function SeriesIcon({ seriesKey, split, names }: { seriesKey: string; split: Split; names: ProviderNames }) {
	if (seriesKey === OTHER) return null;
	if (split === "provider") return <ModelIcon model={seriesKey} name={providerLabel(names, seriesKey)} size={13} />;
	return <ModelIcon model={seriesKey.split("\u0000")[0] ?? seriesKey} size={13} />;
}

export function seconds(ms: number): string {
	return (ms / 1000).toFixed(1);
}

export function costText(totals: RequestTotals): string {
	const cost = formatCost(totals.cost) ?? "$0.00";
	// 有一部分查不到价，这个数只是下限。
	return totals.unpriced > 0 ? `≥${cost}` : `≈${cost}`;
}

/** 一个系列那一行小字：每一项只在有数的时候出现，免得一排「首字 — 秒」。 */
function seriesDetail(totals: RequestTotals, share: number, text: Messages): string[] {
	const parts = [fill(text.requestCount, { n: totals.requests.toLocaleString() }), costText(totals)];
	const speed = speedOf(totals);
	if (speed !== null) parts.push(fill(text.speedValue, { n: Math.round(speed) }));
	const first = firstTokenOf(totals);
	if (first !== null) parts.push(fill(text.firstTokenShort, { s: seconds(first) }));
	const hit = hitRateOf(totals);
	if (hit !== null) parts.push(fill(text.hitRate, { percent: `${Math.round(hit * 100)}%` }));
	parts.push(`${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`);
	return parts;
}

/** 图右边那一列：每个系列一块，数字、占比条、细节。点一下把它从图上拿掉：拿掉一个大头，剩下的才有刻度可读。 */
export function SeriesList({
	series,
	split,
	metric,
	names,
	hidden,
	onToggle,
	text,
}: {
	series: Series[];
	split: Split;
	metric: BarMetric;
	names: ProviderNames;
	hidden: ReadonlySet<string>;
	onToggle: (key: string) => void;
	text: Messages;
}) {
	return (
		<div className="usage-series">
			{series.map((each, index) => {
				const off = hidden.has(each.key);
				const color = seriesColor(each.key, index);
				const speed = speedOf(each.totals);
				const value =
					metric === "speed"
						? speed === null
							? "—"
							: fill(text.speedValue, { n: Math.round(speed) })
						: metric === "requests"
							? each.totals.requests.toLocaleString()
							: barValueLabel(metricOf(each.totals, metric), metric);
				const label = seriesLabel(each.key, split, names, text);
				return (
					<Tooltip key={each.key} label={off ? text.showSeries : text.hideSeries}>
						<button type="button" aria-pressed={!off} data-usage-series={each.key} onClick={() => onToggle(each.key)} className="usage-series-item">
							<div className="usage-series-row">
								<Dot color={color} hollow={off} />
								<SeriesIcon seriesKey={each.key} split={split} names={names} />
								<Text className="usage-grow usage-truncate">{label}</Text>
								<Text weight="medium" numeric className="usage-keep">
									{value}
								</Text>
							</div>
							<div className="usage-share">
								<div className="usage-share-fill" style={{ width: `${Math.max(each.share * 100, 1)}%`, background: color }} />
							</div>
							<Text as="div" size="detail" tone="faint" numeric className="usage-series-detail">
								{seriesDetail(each.totals, each.share, text).join(" · ")}
							</Text>
						</button>
					</Tooltip>
				);
			})}
		</div>
	);
}

/** 顶上那一排里的一格。 */
export function Kpi({ label, value, children, tone }: { label: string; value: ReactNode; children?: ReactNode; tone?: "ok" }) {
	return (
		<div className="usage-kpi">
			<Text as="div" size="detail" tone="muted" className="usage-truncate">
				{label}
			</Text>
			<Text as="div" size="heading" weight="semibold" numeric className={`usage-kpi-value usage-truncate ${tone === "ok" ? "usage-ok" : ""}`}>
				{value}
			</Text>
			<Text as="div" size="detail" tone="faint" numeric className="usage-kpi-detail">
				{children}
			</Text>
		</div>
	);
}

/** 一片什么都没有的地方：一个记号，加两三个字。记号只在空白大到一张卡片、一整块图表时才放。 */
export function EmptyHint({ icon: Icon, children }: { icon?: LucideIcon; children: ReactNode }) {
	return (
		<div data-empty="" className="usage-empty">
			{Icon && (
				<span className="usage-empty-mark">
					<svg width="44" height="44" viewBox="0 0 44 44" className="usage-empty-disc" aria-hidden>
						<circle cx="22" cy="22" r="22" />
					</svg>
					<Icon size={20} strokeWidth={1.5} aria-hidden />
				</span>
			)}
			<Text as="p" tone="faint" className="usage-empty-text">
				{children}
			</Text>
		</div>
	);
}
