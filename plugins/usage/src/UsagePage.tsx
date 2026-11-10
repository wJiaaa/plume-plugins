/**
 * 使用统计：每一次模型调用，按时间、供应商、模型来切。回答「这些请求是什么样的」：今天几点最忙、哪个模型在烧 token、
 * 哪个中转慢、首字要等几秒。数据是 agent 进程按小时合好的（`UsageRequestBucket`），经逻辑入口转过来，这里只做筛选和摆放。
 * 页头（标题和介绍）由宿主画，这里从工具条画起。
 */

import type { UsageRequestBucket, UsageScan } from "@plume/contract";
import { ActionSpinner, Button, InlineSelect, Input, Segmented, SettingsCard, SkeletonBar, Text, useI18n, useSlowLoad } from "@plume/ui";
import { CalendarDays, ChartLine, RefreshCw } from "@plume/ui/icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import { activityTotals } from "./activity.ts";
import { UsageBarChart } from "./Bars.tsx";
import { CacheMissCard, UsageBreakdown, UsageBreakdownSkeleton } from "./Breakdown.tsx";
import { dayKey, formatCompact } from "./format.ts";
import { heatmapWeeks } from "./heatmap.ts";
import { Heatmap } from "./Heatmap.tsx";
import { fill, MESSAGES, type Messages } from "./messages.ts";
import { costText, EmptyHint, Kpi, providerLabel, type ProviderNames, seconds, seriesLabel, SeriesList } from "./Parts.tsx";
import {
	type BarMetric,
	barsFor,
	dailyTotals,
	emptyTotals,
	filterRequests,
	firstTokenOf,
	hitRateOf,
	isHourly,
	metricOf,
	rangeBounds,
	type RequestRange,
	type RequestTotals,
	requestsCsv,
	requestTotals,
	slotsFor,
	speedOf,
	type Split,
} from "./requests.ts";

const WEEKS = 53;
const INTERVALS = ["0", "5", "30", "60"] as const;
type Interval = (typeof INTERVALS)[number];
type HeatMetric = "tokens" | "requests" | "cost";

/** 读花销：界面入口拿不到 agent 进程里的库，经逻辑入口（`ctx.serve`）转一手。 */
export function UsagePage({ scan: read }: { scan: () => PromiseLike<UsageScan> }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const [scan, setScan] = useState<UsageScan | null>(null);
	/** 「今天」从哪一刻算：跟着每次读走，页面开过零点、自动刷新还在跑时，今天得是新的那一天。 */
	const [scannedAt, setScannedAt] = useState(() => new Date());
	const [failed, setFailed] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const slow = useSlowLoad(scan === null && !failed);

	const load = useCallback(
		async (refresh = false) => {
			if (refresh) setRefreshing(true);
			setFailed(false);
			try {
				setScan(await read());
				setScannedAt(new Date());
			} catch {
				setFailed(true);
			} finally {
				setRefreshing(false);
			}
		},
		[read],
	);

	useEffect(() => {
		void load();
	}, [load]);

	return scan ? (
		<UsageRequests scan={scan} now={scannedAt} reload={load} refreshing={refreshing} text={text} />
	) : slow || failed ? (
		<UsageSkeleton failed={failed} text={text} />
	) : null;
}

function UsageSkeleton({ failed, text }: { failed: boolean; text: Messages }) {
	if (failed)
		return (
			<SettingsCard>
				<EmptyHint>{text.readFailed}</EmptyHint>
			</SettingsCard>
		);
	return (
		<div aria-busy="true" aria-live="polite" className="usage-root">
			<span className="usage-sr-only">{text.reading}</span>
			<SettingsCard className="usage-skeleton-kpis">
				{[0, 1, 2, 3, 4].map((index) => (
					<div key={index}>
						<SkeletonBar width="40%" height={10} />
						<div className="usage-skeleton-gap">
							<SkeletonBar width="70%" height={24} />
						</div>
					</div>
				))}
			</SettingsCard>
			<SettingsCard className="usage-card usage-skeleton-chart">
				<div className="usage-skeleton-bars">
					{[24, 38, 30, 62, 44, 78, 55, 70, 48, 66, 36, 58].map((height, index) => (
						<span key={index} className="plume-skeleton usage-skeleton-bar" style={{ height: `${height}%` }} />
					))}
				</div>
			</SettingsCard>
			<UsageBreakdownSkeleton />
		</div>
	);
}

/** 选项按用量排：最常用的在最上面，而不是按字母把一个只调过两次的排到第一个。 */
function optionsOf(rows: UsageRequestBucket[], pick: (row: UsageRequestBucket) => string): string[] {
	const counts = new Map<string, number>();
	for (const row of rows) counts.set(pick(row), (counts.get(pick(row)) ?? 0) + row.requests);
	return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value]) => value);
}

function download(name: string, text: string): void {
	// 带 BOM：没有它，Excel 会把中文的供应商名按本地编码读成乱码。
	const url = URL.createObjectURL(new Blob(["﻿", text], { type: "text/csv;charset=utf-8" }));
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 日期框：产品输入框的外观（`plume-field`），紧凑一档放进工具条。 */
function DateInput({ value, onChange, label, min, max }: { value: string; onChange: (value: string) => void; label: string; min?: string; max?: string }) {
	return (
		<Input
			type="date"
			value={value}
			min={min}
			max={max}
			onChange={(event) => onChange(event.target.value)}
			aria-label={label}
			data-plume-field=""
			className="plume-field plume-field-compact usage-date"
		/>
	);
}

function UsageRequests({
	scan,
	now,
	reload,
	refreshing,
	text,
}: {
	scan: UsageScan;
	now: Date;
	reload: (refresh?: boolean) => Promise<void>;
	refreshing: boolean;
	text: Messages;
}) {
	const names: ProviderNames = scan.providerNames;
	const [range, setRange] = useState<RequestRange>("today");
	const [custom, setCustom] = useState(() => {
		const today = new Date();
		return { from: dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6)), to: dayKey(today) };
	});
	const [provider, setProvider] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [metric, setMetric] = useState<BarMetric>("tokens");
	const [split, setSplitState] = useState<Split>("modelProvider");
	const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
	const [heatMetric, setHeatMetric] = useState<HeatMetric>("tokens");
	const [interval, setIntervalChoice] = useState<Interval>("0");

	// 换了拆分维度，系列整批换掉，上一批关掉的那些没有意义了。
	const setSplit = useCallback((next: Split) => {
		setSplitState(next);
		setHidden(new Set());
	}, []);
	const toggle = useCallback((key: string) => {
		setHidden((current) => {
			const next = new Set(current);
			if (!next.delete(key)) next.add(key);
			return next;
		});
	}, []);

	// 自动刷新只在窗口看得见的时候跑。
	useEffect(() => {
		const every = Number(interval);
		if (!every) return;
		const timer = window.setInterval(() => {
			if (document.visibilityState === "visible") void reload();
		}, every * 1000);
		return () => window.clearInterval(timer);
	}, [interval, reload]);

	const bounds = useMemo(() => rangeBounds(range, now, custom), [range, now, custom]);
	const hourly = isHourly(bounds);
	const describe = useCallback(
		(row: Pick<UsageRequestBucket, "model" | "provider">) => [row.model, providerLabel(names, row.provider), row.provider].join(" "),
		[names],
	);
	// 热力图只吃筛选、不吃区间：它看的是一整年里这一类请求的节奏。
	const filtered = useMemo(
		() => filterRequests(scan.requests, { from: null, to: null, provider, query }, describe),
		[scan.requests, provider, query, describe],
	);
	const rows = useMemo(() => filterRequests(filtered, { ...bounds, provider: null, query: "" }, describe), [filtered, bounds, describe]);
	const totals = useMemo(() => requestTotals(rows), [rows]);
	const activity = useMemo(() => activityTotals(rows, scan.archived), [rows, scan.archived]);
	const slots = useMemo(() => slotsFor(bounds, rows, now), [bounds, rows, now]);
	const bars = useMemo(() => barsFor(rows, split, metric, slots, hourly), [rows, split, metric, slots, hourly]);
	const byDay = useMemo(() => dailyTotals(filtered), [filtered]);
	const grid = useMemo(() => heatmapWeeks(now, WEEKS), [now]);
	const providers = useMemo(() => optionsOf(scan.requests, (row) => row.provider), [scan.requests]);

	const speed = speedOf(totals);
	const first = firstTokenOf(totals);
	const hit = hitRateOf(totals);

	const exportCsv = () =>
		download(
			`plume-requests-${bounds.from ?? "all"}_${bounds.to ?? dayKey(now)}.csv`,
			requestsCsv(rows, (id) => providerLabel(names, id)),
		);

	return (
		<div data-usage-requests="true" className="usage-root">
			<div className="usage-toolbar">
				<Segmented
					value={range}
					onChange={setRange}
					options={[
						{ value: "today", label: text.today },
						{ value: "7", label: text.days7 },
						{ value: "30", label: text.days30 },
						{ value: "all", label: text.all },
						{ value: "custom", label: text.custom },
					]}
				/>
				{range === "custom" && (
					<Text size="detail" tone="faint" className="usage-dates">
						<DateInput
							value={custom.from}
							max={custom.to || dayKey(now)}
							onChange={(from) => setCustom((current) => ({ ...current, from }))}
							label={text.customFrom}
						/>
						<span>–</span>
						<DateInput
							value={custom.to}
							min={custom.from}
							max={dayKey(now)}
							onChange={(to) => setCustom((current) => ({ ...current, to }))}
							label={text.customTo}
						/>
					</Text>
				)}
				<div className="usage-push">
					<InlineSelect
						compact
						ariaLabel={text.autoRefresh}
						value={interval}
						onChange={setIntervalChoice}
						options={INTERVALS.map((value) => ({
							value,
							label: value === "0" ? text.autoRefreshOff : value === "60" ? text.everyMinute : fill(text.everySeconds, { n: Number(value) }),
						}))}
					/>
					<Button
						label={text.refresh}
						onClick={() => void reload(true)}
						disabled={refreshing}
						icon={refreshing ? <ActionSpinner size={14} /> : <RefreshCw size={14} strokeWidth={1.8} />}
					/>
				</div>
			</div>

			<div className="usage-toolbar usage-toolbar-second">
				<InlineSelect
					compact
					ariaLabel={text.provider}
					value={provider ?? ""}
					onChange={(next) => setProvider(next || null)}
					options={[{ value: "", label: text.allProviders }, ...providers.map((value) => ({ value, label: providerLabel(names, value) }))]}
				/>
				<div className="usage-push">
					<Input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={text.searchRequests}
						aria-label={text.searchRequests}
						data-plume-field=""
						className="plume-field plume-field-compact usage-search"
					/>
					<Button data-usage-export="" onClick={exportCsv} disabled={rows.length === 0}>
						{text.exportCsv}
					</Button>
				</div>
			</div>

			<Text as="div" size="detail" tone="faint" className="usage-note">
				{text.requestsNote}
			</Text>

			<SettingsCard aria-label={text.metrics} className="usage-kpis" data-usage-request-kpis="true">
				<Kpi label="Token" value={formatCompact(totals.tokens)}>
					<div>
						{[
							fill(text.partInput, { n: formatCompact(totals.input) }),
							fill(text.partOutput, { n: formatCompact(totals.output) }),
							fill(text.partCacheWrite, { n: formatCompact(totals.cacheWrite) }),
						].join(" · ")}
					</div>
				</Kpi>
				<Kpi label={text.metricRequests} value={totals.requests.toLocaleString()}>
					{totals.requests > 0 && <div>{fill(text.perRequest, { n: formatCompact(totals.tokens / totals.requests) })}</div>}
				</Kpi>
				<Kpi label={text.cost} value={costText(totals)} tone="ok">
					<div>{totals.unpriced > 0 ? fill(text.costUnpriced, { n: totals.unpriced }) : text.costEstimated}</div>
				</Kpi>
				<Kpi label={text.kpiHitRate} value={hit === null ? "—" : `${(hit * 100).toFixed(1)}%`}>
					<div className="usage-meter">
						<div className="usage-meter-fill" style={{ width: `${(hit ?? 0) * 100}%` }} />
					</div>
					<div className="usage-meter-label">{fill(text.partCacheRead, { n: formatCompact(totals.cacheRead) })}</div>
				</Kpi>
				<Kpi label={text.kpiSpeed} value={speed === null ? "—" : fill(text.speedValue, { n: Math.round(speed) })}>
					<div>{speed === null ? text.noTiming : fill(text.timedCount, { n: totals.timed })}</div>
					{/* 整段到达的回复有首字没有速度，两个次数才会不同；相同时再写一遍只是重复。 */}
					{first !== null && (
						<div>
							{fill(text.firstTokenAvg, { s: seconds(first) })}
							{totals.firstTokens !== totals.timed && ` · ${fill(text.timedCount, { n: totals.firstTokens })}`}
						</div>
					)}
				</Kpi>
			</SettingsCard>

			<SettingsCard className="usage-card usage-chart-card">
				<div className="usage-card-head">
					<Segmented
						value={metric}
						onChange={setMetric}
						options={[
							{ value: "tokens", label: "Token" },
							{ value: "cost", label: text.cost },
							{ value: "requests", label: text.metricRequests },
							{ value: "speed", label: text.metricSpeed },
						]}
					/>
					<div className="usage-split">
						<Text size="detail" tone="faint">
							{text.splitBy}
						</Text>
						<Segmented
							value={split}
							onChange={setSplit}
							options={[
								{ value: "model", label: text.model },
								{ value: "modelProvider", label: text.splitModelProvider },
								{ value: "provider", label: text.provider },
							]}
						/>
					</div>
				</div>
				{rows.length === 0 ? (
					<EmptyHint icon={ChartLine}>{text.noRequests}</EmptyHint>
				) : (
					<div className="usage-chart-body">
						<UsageBarChart bars={bars} metric={metric} hourly={hourly} hidden={hidden} labelOf={(key) => seriesLabel(key, split, names, text)} text={text} />
						<div className="usage-series-scroll" data-usage-series-list="true">
							<SeriesList series={bars.series} split={split} metric={metric} names={names} hidden={hidden} onToggle={toggle} text={text} />
						</div>
					</div>
				)}
			</SettingsCard>

			<UsageBreakdown tokens={totals} activity={activity} text={text} />
			<CacheMissCard tokens={totals} activity={activity} text={text} />

			<SettingsCard className="usage-card" data-usage-heatmap="true">
				<div className="usage-card-head">
					<div>
						<Text as="div" weight="medium">
							{text.heatmapTitle}
						</Text>
						<Text as="div" size="detail" tone="faint" className="usage-card-detail">
							{fill(text.heatmapDetail, { n: WEEKS })}
						</Text>
					</div>
					<Segmented
						value={heatMetric}
						onChange={setHeatMetric}
						options={[
							{ value: "tokens", label: "Token" },
							{ value: "requests", label: text.metricRequests },
							{ value: "cost", label: text.cost },
						]}
					/>
				</div>
				{byDay.size === 0 ? (
					<EmptyHint icon={CalendarDays}>{text.noRecords}</EmptyHint>
				) : (
					<div className="usage-heat-body">
						<Heatmap
							grid={grid}
							value={(day) => metricOf(byDay.get(day.key) ?? emptyTotals(), heatMetric)}
							tip={(day) => heatTip(day.key, byDay.get(day.key), text)}
							text={text}
						/>
					</div>
				)}
			</SettingsCard>

			<Text as="div" size="detail" tone="faint" numeric className="usage-footer" data-usage-request-footer="true">
				{[
					fill(text.requestCount, { n: totals.requests.toLocaleString() }),
					fill(text.partInput, { n: formatCompact(totals.input) }),
					fill(text.partOutput, { n: formatCompact(totals.output) }),
					fill(text.partCacheWrite, { n: formatCompact(totals.cacheWrite) }),
					fill(text.partCacheRead, { n: formatCompact(totals.cacheRead) }),
				].join(" · ")}
			</Text>
		</div>
	);
}

function heatTip(key: string, totals: RequestTotals | undefined, text: Messages): string {
	const [, month, day] = key.split("-");
	const date = `${Number(month)}/${Number(day)}`;
	if (!totals || totals.requests === 0) return date;
	return [
		date,
		fill(text.dayTokens, { n: formatCompact(totals.tokens) }),
		fill(text.requestCount, { n: totals.requests.toLocaleString() }),
		costText(totals),
	].join(" · ");
}
