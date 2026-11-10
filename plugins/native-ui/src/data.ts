/** 数据一旦不合法就报错，不截断、不把缺失数字伪装成零。 */
import { text } from "./expression.ts";
export function record(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
export function scalar(value: unknown): value is string | number | boolean | null {
	return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}
export interface Option {
	value: string;
	label: string;
	original: string | number;
}
export function optionsOf(options: unknown): Option[] {
	if (!Array.isArray(options) || !options.length || options.length > 100) throw new Error("options need 1–100 entries");
	const out = options.map((option): Option => {
		if (record(option)) {
			if (Object.keys(option).some((key) => key !== "label" && key !== "value")) throw new Error("unknown option key");
			const value = option.value ?? option.label;
			if (
				(typeof value !== "string" && typeof value !== "number") ||
				(typeof value === "number" && !Number.isFinite(value)) ||
				(option.label !== undefined && typeof option.label !== "string")
			)
				throw new Error("invalid option");
			return { value: text(value), original: value, label: text(option.label ?? value) };
		}
		if ((typeof option !== "string" && typeof option !== "number") || (typeof option === "number" && !Number.isFinite(option)))
			throw new Error("invalid option");
		return { value: text(option), original: option, label: text(option) };
	});
	if (out.some((option) => !option.value || !option.label.trim()) || new Set(out.map((option) => option.value)).size !== out.length)
		throw new Error("empty or duplicate option");
	return out;
}

export interface TableData {
	header: string[];
	cells: unknown[][];
	numeric: boolean[];
}
export function tableData(props: Record<string, unknown>): TableData {
	const { columns, rows, data } = props;
	if ((rows !== undefined && data !== undefined) || (rows === undefined && data === undefined)) throw new Error("use rows or data");
	if (columns !== undefined && (!Array.isArray(columns) || !columns.length || !columns.every((key) => typeof key === "string" && key.trim())))
		throw new Error("invalid columns");
	let header = columns as string[] | undefined;
	let cells: unknown[][];
	if (data !== undefined) {
		if (!Array.isArray(data) || data.some((row) => !record(row))) throw new Error("data must be records");
		header ??= data.length ? Object.keys(data[0] as Record<string, unknown>) : [];
		if (data.some((row) => Object.keys(row as object).length !== header!.length || header!.some((key) => !Object.hasOwn(row as object, key))))
			throw new Error("columns must cover every data key");
		cells = data.map((row) => header!.map((key) => (row as Record<string, unknown>)[key]));
	} else {
		if (!header || !Array.isArray(rows) || rows.some((row) => !Array.isArray(row) || row.length !== header!.length))
			throw new Error("rows need matching columns");
		cells = rows as unknown[][];
	}
	if (header.length > 30 || cells.length > 500 || new Set(header).size !== header.length || cells.some((row) => row.some((cell) => !scalar(cell))))
		throw new Error("invalid table cells or size");
	return {
		header,
		cells,
		numeric: header.map((_, at) => cells.length > 0 && cells.every((row) => row[at] === null || row[at] === "" || typeof row[at] === "number")),
	};
}

export interface ChartData {
	rows: Record<string, unknown>[];
	labels: string[];
	keys: string[];
	values: number[][];
}
/** 标签、系列推断与声明语法共用，数字字符串只允许有限十进制。 */
export function chartData(data: unknown, x: unknown, y: unknown): ChartData {
	if (!Array.isArray(data) || data.length > 500 || data.some((row) => !record(row))) throw new Error("chart data must be up to 500 records");
	const rows = data as Record<string, unknown>[];
	const first = rows[0] ?? {};
	const label =
		(x as string | undefined) ??
		Object.keys(first).find((key) => typeof first[key] === "string" && !(typeof y === "string" ? y === key : Array.isArray(y) && y.includes(key)));
	const keys =
		y === undefined
			? Object.keys(first).filter((key) => key !== label && typeof first[key] === "number")
			: typeof y === "string"
				? [y]
				: Array.isArray(y) && y.every((key) => typeof key === "string")
					? (y as string[])
					: null;
	if (!keys || keys.length > 6 || (rows.length > 0 && !keys.length) || new Set(keys).size !== keys.length || keys.some((key) => !key || key === label))
		throw new Error("invalid chart series");
	const labels = rows.map((row, at) => {
		if (!label) return String(at + 1);
		if (!Object.hasOwn(row, label) || !scalar(row[label])) throw new Error("missing chart label");
		return text(row[label]);
	});
	const values = rows.map((row) =>
		keys.map((key) => {
			if (!Object.hasOwn(row, key)) throw new Error("missing chart number");
			const raw = row[key];
			const amount =
				typeof raw === "number" ? raw : typeof raw === "string" && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(raw.trim()) ? Number(raw) : Number.NaN;
			if (!Number.isFinite(amount)) throw new Error("invalid chart number");
			return amount;
		}),
	);
	const all = values.flat();
	if (all.length) ticks(Math.min(0, ...all), Math.max(0, ...all));
	return { rows, labels, keys, values };
}

export function ticks(low: number, high: number): number[] {
	const span = high - low || Math.abs(high) || 1;
	const rough = span / 4;
	if (!Number.isFinite(span) || rough === 0) throw new Error("chart range cannot form a finite axis");
	const power = 10 ** Math.floor(Math.log10(rough));
	const step = [1, 2, 2.5, 5, 10].map((value) => value * power).find((value) => value >= rough) ?? rough;
	const start = Math.floor(low / step) * step;
	const out: number[] = [];
	for (let index = 0; index <= 8; index++) {
		const value = start + step * index;
		if (!Number.isFinite(value)) throw new Error("chart axis overflow");
		out.push(value);
		if (value >= high && out.length > 1) break;
	}
	return out;
}

/** 环图取首个系列，负值不占扇区；整圆拆成两段弧，避免起终点重合后消失。 */
export function pieSlices(values: number[], radius: number): { total: number; values: number[]; paths: string[] } {
	const amounts = values.map((value) => Math.max(0, value));
	const total = amounts.reduce((sum, value) => sum + value, 0);
	if (!Number.isFinite(total)) throw new Error("pie total overflow");
	let angle = -Math.PI / 2;
	const inner = radius * 0.58;
	const point = (at: number, r: number) => `${r * Math.cos(at)} ${r * Math.sin(at)}`;
	const paths = amounts.map((value) => {
		if (!value) return "";
		const start = angle;
		const sweep = (value / total) * Math.PI * 2;
		angle += sweep;
		const large = sweep > Math.PI ? 1 : 0;
		return sweep >= Math.PI * 2 - 1e-6
			? `M ${point(start, radius)} A ${radius} ${radius} 0 1 1 ${point(start + Math.PI, radius)} A ${radius} ${radius} 0 1 1 ${point(start, radius)} M ${point(start, inner)} A ${inner} ${inner} 0 1 0 ${point(start + Math.PI, inner)} A ${inner} ${inner} 0 1 0 ${point(start, inner)} Z`
			: `M ${point(start, radius)} A ${radius} ${radius} 0 ${large} 1 ${point(angle, radius)} L ${point(angle, inner)} A ${inner} ${inner} 0 ${large} 0 ${point(start, inner)} Z`;
	});
	return { total, values: amounts, paths };
}
