/**
 * 主机页、状态栏、文件面板共用的几样显示：字节、速率、百分比、模糊搜索、路径。
 */

export function bytes(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return "—";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let size = value;
	let unit = 0;
	while (size >= 1024 && unit < units.length - 1) {
		size /= 1024;
		unit++;
	}
	return `${size >= 100 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

export function rate(value: number | null | undefined): string {
	return value === null || value === undefined ? "—" : `${bytes(value)}/s`;
}

export function percent(value: number | null | undefined): string {
	return value === null || value === undefined ? "—" : `${value}%`;
}

/** 不分大小写的子序列匹配：「pat」认得出「prod-api-tokyo」。 */
export function fuzzyMatch(query: string, ...fields: string[]): boolean {
	const needle = query.trim().toLowerCase();
	if (!needle) return true;
	return fields.some((field) => {
		const haystack = field.toLowerCase();
		if (haystack.includes(needle)) return true;
		let position = 0;
		for (const char of needle.replace(/\s+/g, "")) {
			position = haystack.indexOf(char, position);
			if (position < 0) return false;
			position++;
		}
		return true;
	});
}

export function address(target: { username: string; host: string; port: number }): string {
	const host = target.host.includes(":") && !target.host.startsWith("[") ? `[${target.host}]` : target.host;
	return `${target.username}@${host}:${target.port}`;
}

export function parentPath(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	const index = trimmed.lastIndexOf("/");
	return index <= 0 ? "/" : trimmed.slice(0, index);
}

/** 标签输入框里用逗号或空格分开的几个词。 */
export function parseTags(value: string): string[] {
	// i18n-exempt：中文输入法打出的全角逗号也算分隔符，不是界面文字。
	return value
		.split(/[,，\s]+/)
		.map((tag) => tag.trim())
		.filter(Boolean);
}
