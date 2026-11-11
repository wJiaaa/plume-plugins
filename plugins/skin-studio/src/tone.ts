import { COLOR_KEYS, type SkinColors, type StudioSkin } from "./types.ts";

/** OKLCH 转 sRGB 的 #RRGGBB，超出色域的通道截到边上。 */
export function oklch(l: number, c: number, h: number): string {
	const angle = (h * Math.PI) / 180;
	const a = c * Math.cos(angle);
	const b = c * Math.sin(angle);
	const L = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const M = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const S = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
	const linear = [
		4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
		-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
		-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
	];
	const hex = linear.map((value) => {
		const encoded = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
		return Math.round(Math.min(1, Math.max(0, encoded)) * 255)
			.toString(16)
			.padStart(2, "0");
	});
	return `#${hex.join("")}`.toUpperCase();
}

/**
 * 一个色相 h、一个彩度 c 推出整套浅色皮肤：用 OKLCH，换色相时亮度看起来不变，几套色调一样干净。
 * 外圈（停靠侧栏）是一张粉彩底板，从 h 斜着滑到 h+24（颗粒质感由宿主的「磨砂」开关统一加，不在皮肤里）；正文是近白的纸，卡片、悬停、按下往色调里一档档加深；
 * 字和强调色用同一色相的深色。各档亮度在三套色调上都过了 parseSkin 的对比度，改动后由测试把关。
 */
export function toneSkin(id: string, name: string, h: number, c: number): StudioSkin {
	const values: Record<(typeof COLOR_KEYS)[number], string> = {
		bgRoot: oklch(0.87, c, h + 12),
		bgMain: oklch(0.995, c * 0.1, h),
		bgSidebar: oklch(0.92, c * 0.7, h),
		bgElevated: oklch(0.975, c * 0.35, h),
		bgHover: oklch(0.945, c * 0.45, h),
		bgActive: oklch(0.915, c * 0.6, h),
		textPrimary: oklch(0.26, c * 1.1, h),
		textSecondary: oklch(0.38, c * 1.1, h),
		textTertiary: oklch(0.5, c * 1.1, h),
		accent: oklch(0.52, c * 2.6 + 0.04, h),
		accentDim: oklch(0.93, c * 1.1, h),
		border: oklch(0.885, c * 0.5, h),
	};
	return {
		id,
		name,
		base: "light",
		builtin: true,
		colors: values satisfies SkinColors,
		backdrop: { from: oklch(0.875, c, h), to: oklch(0.865, c, h + 24) },
	};
}
