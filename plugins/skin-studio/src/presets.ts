// color-exempt：工坊的预设皮肤是持久化配色数据，供缩略图预览和 ui.skin 应用，不是固定界面色
import type { StudioSkin, SkinColors } from "./types.ts";
import { toneSkin } from "./tone.ts";
import { COLOR_KEYS } from "./types.ts";

/**
 * 预设是皮肤数据；提示字适度加深或提亮，保证选中底上的可读性。
 * 外圈（停靠侧栏）比会话窗暗一档（OKLCH 亮度约 0.04），两块分得开；浅色的悬停、按下再比外圈深，侧栏上也看得出。
 */
function preset(id: string, name: string, base: StudioSkin["base"], values: readonly string[]): StudioSkin {
	return { id, name, base, builtin: true, colors: Object.fromEntries(COLOR_KEYS.map((key, index) => [key, values[index]])) as SkinColors };
}

export const PRESETS: readonly StudioSkin[] = [
	preset("light-mint", "Mint Morning", "light", [
		"#E8EEEA",
		"#F6FBF8",
		"#EEF7F1",
		"#FFFFFF",
		"#DCE9E0",
		"#D2E6D9",
		"#173226",
		"#456253",
		"#657C6D",
		"#0E9F6E",
		"#D9F4E6",
		"#DCECE2",
	]),
	preset("light-peach", "Peach Cream", "light", [
		"#F2EAE8",
		"#FFF8F6",
		"#FDEEEC",
		"#FFFFFF",
		"#F7DFDC",
		"#F7D2CE",
		"#3A1F1D",
		"#7A4E49",
		"#926E69",
		"#E0527A",
		"#FBDCE6",
		"#F3DDD8",
	]),
	preset("dark-graphite", "Graphite", "dark", [
		"#121216",
		"#1B1C20",
		"#131417",
		"#222327",
		"#28292E",
		"#313239",
		"#F2F2F4",
		"#A7A8B2",
		"#8B8C98",
		"#6366F1",
		"#26264A",
		"#2B2C31",
	]),
	preset("dark-berry", "Midnight Berry", "dark", [
		"#130910",
		"#1D1219",
		"#140C12",
		"#25151F",
		"#2C1A25",
		"#38212E",
		"#F6EEF2",
		"#C39CAE",
		"#AE8396",
		"#E02A8B",
		"#3D1530",
		"#301C29",
	]),
	preset("dark-teal", "Deep Teal", "dark", [
		"#06171A",
		"#0F2124",
		"#0A1517",
		"#15292C",
		"#1A3134",
		"#20393C",
		"#EAF5F4",
		"#9FC0BF",
		"#7A9E9B",
		"#0D9488",
		"#0F3A35",
		"#1C3335",
	]),
	// 色调皮肤：只给色相和彩度，整套颜色和渐变外圈都由 OKLCH 推出来。
	toneSkin("light-tone-sky", "Clear Sky", 262, 0.055),
	toneSkin("light-tone-lavender", "Lavender Mist", 296, 0.058),
	toneSkin("light-tone-celadon", "Celadon", 172, 0.048),
];
