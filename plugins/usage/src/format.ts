/**
 * 使用统计上的数字，短到放得进一格。同一个量在卡片、柱子的刻度、悬停气泡里都要写，各自取整的话，
 * 两处对不上，三处都不可信了。
 */

/** `1.2M`、`3.4k`、`860`。 */
export function formatCompact(value: number): string {
	if (!Number.isFinite(value)) return "0";
	if (value >= 1_000_000_000) {
		const b = value / 1_000_000_000;
		return `${b >= 100 ? b.toFixed(0) : b.toFixed(1)}B`;
	}
	if (value >= 1_000_000) {
		const m = value / 1_000_000;
		return `${m >= 100 ? m.toFixed(0) : m.toFixed(1)}M`;
	}
	if (value >= 10_000) {
		const k = value / 1000;
		return `${k >= 100 ? k.toFixed(0) : k.toFixed(1)}k`;
	}
	return Math.round(value).toLocaleString();
}

/**
 * 值得写出来的费用。不到万分之一美元什么都不写；不到半美分写「<$0.01」：读了三个文件的一次调用只花零点几美分，
 * 写成 $0.00 读起来像免费。
 */
export function formatCost(value: number): string | null {
	if (!(value > 0.0001)) return null;
	if (value < 0.005) return "<$0.01";
	return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

/** 本地日期的 `YYYY-MM-DD`：花销按本机时区切小时，日子也按本机算。 */
export function dayKey(date: Date): string {
	return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, "0")}-${`${date.getDate()}`.padStart(2, "0")}`;
}

/** `850ms`、`3.2s`、`42s`、`5m07s`、`2h05m`：累计耗时能到几个小时，一律写秒就读不了了。 */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0s";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 9_950) return `${(ms / 1000).toFixed(1)}s`;
	const total = Math.round(ms / 1000);
	if (total < 60) return `${total}s`;
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	if (hours > 0) return `${hours}h${`${minutes}`.padStart(2, "0")}m`;
	return `${minutes}m${`${total % 60}`.padStart(2, "0")}s`;
}
