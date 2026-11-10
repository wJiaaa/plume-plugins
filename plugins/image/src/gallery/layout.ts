/**
 * 画廊的行：每张图保持自己的形状，满的一行正好和列一样宽。
 *
 * 不排成方格：画出来的图什么形状都有——1:1、16:9 的海报、9:16 的手机壁纸——裁成方的，一张宽图只剩三分之一。
 * 一行等高、宽度加起来正好是列宽，每张都完整，两边还都对齐。
 */

interface PlacedTile {
	/** 在排版的那份列表里的位置。 */
	index: number;
	width: number;
	height: number;
}

export interface PlacedRow {
	tiles: PlacedTile[];
	height: number;
}

/** 宽高比，按图记下的尺寸；没记尺寸的按方图算。 */
export function aspectOf(size: { width?: number; height?: number }): number {
	const { width, height } = size;
	if (!width || !height || width <= 0 || height <= 0) return 1;
	// 收在合理范围里：一张 1×40 的横幅不收的话，会占满一整行却只有一根线那么高。
	return Math.min(4, Math.max(0.25, width / height));
}

/**
 * 把图排成接近 `target` 高的行。
 *
 * 一行一直加图，直到再加一张就低于目标高度；然后在加这一张和不加之间，取离目标近的那个高度。
 * 最后一行不拉到边：三张图撑满一整行，会比别的行高出一倍。
 */
export function justify(aspects: readonly number[], width: number, options: { target: number; gap: number }): PlacedRow[] {
	const { target, gap } = options;
	if (width <= 0) return [];
	const rows: PlacedRow[] = [];
	const fit = (from: number, to: number) => {
		let sum = 0;
		for (let i = from; i < to; i++) sum += aspects[i] ?? 1;
		return (width - gap * (to - from - 1)) / sum;
	};
	const close = (from: number, to: number, height: number) => {
		const tiles: PlacedTile[] = [];
		for (let i = from; i < to; i++) tiles.push({ index: i, width: (aspects[i] ?? 1) * height, height });
		rows.push({ tiles, height });
	};
	let start = 0;
	while (start < aspects.length) {
		let end = start + 1;
		while (end < aspects.length && fit(start, end + 1) >= target) end++;
		if (end === aspects.length) {
			// 剩下的按目标高度放得下、甚至更高：这是最后一行，停在目标高度。
			const height = Math.min(target, fit(start, end));
			close(start, end, height);
			break;
		}
		const without = fit(start, end);
		const withNext = fit(start, end + 1);
		if (Math.abs(withNext - target) < Math.abs(without - target)) end++;
		close(start, end, fit(start, end));
		start = end;
	}
	return rows;
}

/** 一天的图，新的一天在前。`day` 是当地的零点，给标题用。 */
export interface DaySection<T> {
	day: number;
	items: T[];
}

/** 按当地日期分组，同一天里保持给定的顺序。 */
export function byDay<T>(items: readonly T[], at: (item: T) => number): DaySection<T>[] {
	const sections: DaySection<T>[] = [];
	const index = new Map<number, DaySection<T>>();
	for (const item of items) {
		const date = new Date(at(item));
		const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
		let section = index.get(day);
		if (!section) {
			section = { day, items: [] };
			index.set(day, section);
			sections.push(section);
		}
		section.items.push(item);
	}
	return sections.sort((a, b) => b.day - a.day);
}
