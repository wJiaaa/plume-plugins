/**
 * 使用统计背后的算术：区间、筛选、合计、按维度拆成柱。
 *
 * 和画图分开放：「今天按小时、其余按天」「第九名以后并成其他」「速度不能把每一小时的速度加起来」这几件事错了在
 * 截图上看不出来，一根高度不对的柱子和一根对的长得一样。
 */

import type { UsageRequestBucket } from "@plume/contract";
import { dayKey } from "./format.ts";

export type RequestRange = "today" | "7" | "30" | "all" | "custom";
export type Split = "model" | "modelProvider" | "provider";
export type BarMetric = "tokens" | "cost" | "requests" | "speed";

export interface RequestFilter {
	/** `YYYY-MM-DD`，两头都含。`null` 是不设限。 */
	from: string | null;
	to: string | null;
	provider: string | null;
	query: string;
}

export interface RequestTotals {
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** 新鲜 token：输入、输出加缓存写入，不含缓存读取。缓存读取是同一段前缀被一读再读，算进来的话长会话的总数没法读。 */
	tokens: number;
	cost: number;
	unpriced: number;
	timed: number;
	timedOutput: number;
	streamMs: number;
	firstTokens: number;
	firstTokenMs: number;
}

/** 第几名以后并成「其他」：再多，色板分不开，图例也读不过来。 */
const SERIES_LIMIT = 8;
export const OTHER = "\u0000other";

function shiftDay(day: string, by: number): string {
	const [year, month, date] = day.split("-").map(Number);
	return dayKey(new Date(year ?? 0, (month ?? 1) - 1, (date ?? 1) + by));
}

/** 区间换成两头的日期。自定义的两头填反了就对调，而不是给出一段空的。 */
export function rangeBounds(range: RequestRange, now: Date, custom: { from: string; to: string }): { from: string | null; to: string | null } {
	const today = dayKey(now);
	if (range === "today") return { from: today, to: today };
	if (range === "7" || range === "30") return { from: shiftDay(today, -(Number(range) - 1)), to: today };
	if (range === "all") return { from: null, to: null };
	const from = custom.from || null;
	const to = custom.to || null;
	return from && to && from > to ? { from: to, to: from } : { from, to };
}

/** 只有一天的区间按小时画，其余按天：一天画成一根柱子什么也看不出。 */
export function isHourly(bounds: { from: string | null; to: string | null }): boolean {
	return bounds.from !== null && bounds.from === bounds.to;
}

/** `describe` 给出这一行能被搜到的文字（模型、供应商名），怎么称呼它们由界面决定。 */
export function filterRequests<T extends Pick<UsageRequestBucket, "hour" | "provider" | "model">>(
	rows: T[],
	filter: RequestFilter,
	describe: (row: T) => string,
): T[] {
	const query = filter.query.trim().toLowerCase();
	return rows.filter((row) => {
		const day = row.hour.slice(0, 10);
		if (filter.from !== null && day < filter.from) return false;
		if (filter.to !== null && day > filter.to) return false;
		if (filter.provider !== null && row.provider !== filter.provider) return false;
		return !query || describe(row).toLowerCase().includes(query);
	});
}

export function emptyTotals(): RequestTotals {
	return {
		requests: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		tokens: 0,
		cost: 0,
		unpriced: 0,
		timed: 0,
		timedOutput: 0,
		streamMs: 0,
		firstTokens: 0,
		firstTokenMs: 0,
	};
}

function addTo(totals: RequestTotals, row: UsageRequestBucket): RequestTotals {
	totals.requests += row.requests;
	totals.input += row.input;
	totals.output += row.output;
	totals.cacheRead += row.cacheRead;
	totals.cacheWrite += row.cacheWrite;
	totals.tokens += row.input + row.output + row.cacheWrite;
	totals.cost += row.cost;
	totals.unpriced += row.unpriced;
	totals.timed += row.timed;
	totals.timedOutput += row.timedOutput;
	totals.streamMs += row.streamMs;
	totals.firstTokens += row.firstTokens;
	totals.firstTokenMs += row.firstTokenMs;
	return totals;
}

export function requestTotals(rows: UsageRequestBucket[]): RequestTotals {
	return rows.reduce(addTo, emptyTotals());
}

/** 输出 token/秒。按总输出除以总生成时间，不是各次速度的平均：一次 3 个 token 的回复不该和一次 3000 个的同等分量。 */
export function speedOf(totals: RequestTotals): number | null {
	return totals.streamMs > 0 ? totals.timedOutput / (totals.streamMs / 1000) : null;
}

/** 首字平均毫秒。 */
export function firstTokenOf(totals: RequestTotals): number | null {
	return totals.firstTokens > 0 ? totals.firstTokenMs / totals.firstTokens : null;
}

/** 缓存读取占全部输入的比例。 */
export function hitRateOf(totals: RequestTotals): number | null {
	const input = totals.input + totals.cacheRead + totals.cacheWrite;
	return input > 0 ? totals.cacheRead / input : null;
}

export function metricOf(totals: RequestTotals, metric: BarMetric): number {
	if (metric === "speed") return speedOf(totals) ?? 0;
	return totals[metric];
}

function seriesKey(row: Pick<UsageRequestBucket, "model" | "provider">, split: Split): string {
	if (split === "model") return row.model;
	if (split === "provider") return row.provider;
	return `${row.model}\u0000${row.provider}`;
}

/** 柱子的横轴：按小时是那一天的 24 格，按天是区间里的每一天。没有下界时从有记录的第一天起。 */
export function slotsFor(bounds: { from: string | null; to: string | null }, rows: UsageRequestBucket[], now: Date): string[] {
	if (isHourly(bounds)) return Array.from({ length: 24 }, (_, hour) => `${bounds.from} ${`${hour}`.padStart(2, "0")}`);
	const to = bounds.to ?? dayKey(now);
	const earliest = rows.reduce<string | null>((first, row) => (first === null || row.hour < first ? row.hour : first), null)?.slice(0, 10);
	const from = bounds.from ?? earliest ?? to;
	const slots: string[] = [];
	// 上限防一个手滑填成 1900 年的自定义区间画出几万根柱子。
	for (let day = from; day <= to && slots.length < 3660; day = shiftDay(day, 1)) slots.push(day);
	return slots;
}

export interface Series {
	key: string;
	totals: RequestTotals;
	/** 这一系列按当前口径的数值占全部的比例。速度没有占比可言，按请求数。 */
	share: number;
	/** 每一格的合计，和 `Bars.slots` 一一对应。 */
	slots: RequestTotals[];
}

export interface Bars {
	slots: string[];
	series: Series[];
}

export function barsFor(rows: UsageRequestBucket[], split: Split, metric: BarMetric, slots: string[], hourly: boolean): Bars {
	const at = new Map(slots.map((slot, index) => [slot, index]));
	const bySeries = new Map<string, Series>();
	for (const row of rows) {
		const index = at.get(hourly ? row.hour : row.hour.slice(0, 10));
		const key = seriesKey(row, split);
		const series = bySeries.get(key) ?? { key, totals: emptyTotals(), share: 0, slots: slots.map(() => emptyTotals()) };
		bySeries.set(key, series);
		addTo(series.totals, row);
		const slot = index === undefined ? undefined : series.slots[index];
		if (slot) addTo(slot, row);
	}
	const rankBy: BarMetric = metric === "speed" ? "requests" : metric;
	const ranked = [...bySeries.values()].sort((a, b) => metricOf(b.totals, rankBy) - metricOf(a.totals, rankBy) || b.totals.requests - a.totals.requests);
	const kept = ranked.slice(0, SERIES_LIMIT);
	const rest = ranked.slice(SERIES_LIMIT);
	if (rest.length > 0) {
		const other: Series = { key: OTHER, totals: emptyTotals(), share: 0, slots: slots.map(() => emptyTotals()) };
		for (const each of rest) {
			merge(other.totals, each.totals);
			each.slots.forEach((slot, index) => merge(other.slots[index] as RequestTotals, slot));
		}
		kept.push(other);
	}
	const sum = kept.reduce((total, each) => total + metricOf(each.totals, rankBy), 0);
	for (const each of kept) each.share = sum > 0 ? metricOf(each.totals, rankBy) / sum : 0;
	return { slots, series: kept };
}

export function merge(into: RequestTotals, from: RequestTotals): void {
	for (const key of Object.keys(into) as (keyof RequestTotals)[]) into[key] += from[key];
}

/** 每天一个数，给热力图：不受区间限制，只受筛选限制，看的是这一类请求的节奏。 */
export function dailyTotals(rows: UsageRequestBucket[]): Map<string, RequestTotals> {
	const byDay = new Map<string, RequestTotals>();
	for (const row of rows) {
		const day = row.hour.slice(0, 10);
		byDay.set(day, addTo(byDay.get(day) ?? emptyTotals(), row));
	}
	return byDay;
}

const CSV_COLUMNS = [
	"hour",
	"provider",
	"model",
	"requests",
	"input",
	"output",
	"cacheRead",
	"cacheWrite",
	"cost",
	"timed",
	"timedOutput",
	"streamMs",
	"firstTokens",
	"firstTokenMs",
	"unpriced",
] as const;

function csvCell(value: string | number): string {
	// CSV 引号只隔开列，挡不住表格公式；外来的字符串先明确标成文本。
	const text = typeof value === "string" && /^(?:\s*[=+\-@]|[\t\r\n])/.test(value) ? `'${value}` : String(value);
	const quoted = text.includes('"') || text.includes(",") || text.includes("\n") || text.includes("\r");
	return quoted ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * 筛出来的那些，每小时每组一行。不是逐条请求的流水：花销本来就只合到小时。列名用英文：CSV 是交给表格软件和脚本的，
 * 列名跟着界面语言变，换一次语言脚本就读不懂了。`provider` 写名字，另起一列 `providerId`：id 认得准，名字看得懂。
 * `unpriced` 留着查不到价的请求数，否则零费用分不清是免费还是不知道。
 */
export function requestsCsv(rows: UsageRequestBucket[], providerName: (id: string) => string): string {
	const header = [...CSV_COLUMNS.slice(0, 2), "providerId", ...CSV_COLUMNS.slice(2)];
	const lines = [...rows]
		.sort((a, b) => a.hour.localeCompare(b.hour) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
		.map((row) =>
			[
				row.hour,
				providerName(row.provider),
				row.provider,
				row.model,
				row.requests,
				row.input,
				row.output,
				row.cacheRead,
				row.cacheWrite,
				row.cost.toFixed(6),
				row.timed,
				row.timedOutput,
				row.streamMs,
				row.firstTokens,
				row.firstTokenMs,
				row.unpriced,
			]
				.map(csvCell)
				.join(","),
		);
	return [header.join(","), ...lines].join("\n");
}
