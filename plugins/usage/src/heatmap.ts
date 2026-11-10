/**
 * 按天排成格子的用量。算术和画分开：「哪一格是今天」「第一列从哪天起」是会错的两件事，错一天的格子在截图上和对的一模一样。
 */

import { dayKey } from "./format.ts";

export interface HeatDay {
	key: string;
	date: Date;
}

/**
 * 最近 `weeks` 周，一周一列，旧的在前，最后一列是 `now` 所在的那一周。列从周一开始；最后一列补到周末，整张是矩形，
 * 补出来的是将来的日子，画得淡一点，不留成洞（像缺了数据）。
 */
export function heatmapWeeks(now: Date, weeks: number): HeatDay[][] {
	const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
	const grid: HeatDay[][] = [];
	for (let w = 0; w < weeks; w++) {
		const column: HeatDay[] = [];
		for (let d = 0; d < 7; d++) {
			const date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - (weeks - 1 - w) * 7 + d);
			column.push({ key: dayKey(date), date });
		}
		grid.push(column);
	}
	return grid;
}

/**
 * 一天该是五档里的哪一档，0 是没有。按最忙那天切，不按固定的 token 数：一下午的问答和一周的重构没有同一把尺。
 * 按档而不按线性：一个特别大的日子会把其他日子都压成最浅的一档。
 */
export function heatLevel(value: number, busiest: number): 0 | 1 | 2 | 3 | 4 {
	if (value <= 0 || busiest <= 0) return 0;
	const share = value / busiest;
	if (share > 0.6) return 4;
	if (share > 0.3) return 3;
	if (share > 0.1) return 2;
	return 1;
}

/** 两个月份标签之间至少隔几列；再近，三个字宽的两个标签在 28px 里叠在一起。 */
const MIN_LABEL_GAP = 4;

/** 每一列开始一个新月份的地方一个标签；离上一个太近的不画，不叠着画。`name` 给出月份（1–12）怎么写。 */
export function monthLabels(grid: HeatDay[][], name: (month: number) => string): { column: number; text: string }[] {
	const labels: { column: number; text: string }[] = [];
	let seen = -1;
	let lastAt = -99;
	grid.forEach((column, index) => {
		const first = column[0];
		if (!first) return;
		const month = first.date.getMonth();
		if (month === seen || index >= grid.length - 1) return;
		seen = month;
		if (index - lastAt < MIN_LABEL_GAP) return;
		labels.push({ column: index, text: name(month + 1) });
		lastAt = index;
	});
	return labels;
}
