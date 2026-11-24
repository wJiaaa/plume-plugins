// color-exempt：工坊的预设皮肤是持久化配色数据，供缩略图预览和 ui.skin 应用，不是固定界面色
import type { SkinTokenOverrides } from "./tokens.ts";
import type { StudioSkin, SkinColors } from "./types.ts";
import { toneSkin } from "./tone.ts";
import { COLOR_KEYS } from "./types.ts";

/**
 * 预设是皮肤数据；提示字适度加深或提亮，保证选中底上的可读性。
 * 外圈（停靠侧栏）比会话窗暗一档（OKLCH 亮度约 0.04），两块分得开；浅色的悬停、按下再比外圈深，侧栏上也看得出。
 */
function preset(id: string, name: string, base: StudioSkin["base"], values: readonly string[], tokens?: SkinTokenOverrides): StudioSkin {
	return {
		id,
		name,
		base,
		builtin: true,
		colors: Object.fromEntries(COLOR_KEYS.map((key, index) => [key, values[index]])) as SkinColors,
		...(tokens && { tokens }),
	};
}

const CLAWD_LIGHT_TOKENS: SkinTokenOverrides = {
	bg: "oklch(0.981775 0.005392 95.099)",
	fg: "oklch(0.190839 0.001983 106.586)",
	accent: "oklch(0.617148 0.137546 39.043)",
	contrast: "0.6",
	shell: "oklch(0.981775 0.005392 95.099)",
	root: "oklch(0.965992 0.009326 99.984)",
	"accent-dim": "oklch(0.939407 0.010879 95.168)",
	sidebar: "oklch(0.948457 0.010853 95.166)",
	card: "oklch(0.948457 0.010853 95.166)",
	"card-hover": "rgb(127 127 127 / 0.14)",
	elevated: "rgb(127 127 127 / 0.10)",
	input: "oklch(1 0 0)",
	float: "oklch(1 0 0)",
	knob: "oklch(1 0 0)",
	shade: "#000000",
	"window-tint": "color-mix(in srgb, oklch(0.965992 0.009326 99.984) 70%, transparent)",
	line: "oklch(0.914896 0.012258 96.433)",
	"line-soft": "oklch(0.923736 0.013538 97.452)",
	"line-float": "rgb(127 127 127 / 0.18)",
	ink: "oklch(0.190839 0.001983 106.586)",
	"ink-muted": "#6B6A64",
	"ink-faint": "oklch(0.523305 0.009312 99.011)",
	danger: "oklch(0.539595 0.150235 33.015)",
	warning: "oklch(0.578908 0.117736 66.435)",
	"on-accent": "oklch(1 0 0)",
	"code-bg": "oklch(0.965992 0.009326 99.984)",
	"code-fg": "oklch(0.358974 0.005073 106.652)",
	"code-line-height": "1.55",
	"code-tracking": "-0.002em",
	"inline-code-bg": "rgb(127 127 127 / 0.16)",
	"inline-code-fg": "oklch(0.358974 0.005073 106.652)",
	"inline-code-ring": "transparent",
	"radius-panel": "14px",
	"radius-field": "7px",
	"radius-item": "7px",
	"radius-menu": "10px",
	"font-sans": 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
	"ui-size": "14px",
	"code-size": "13px",
};

const CLAWD_DARK_TOKENS: SkinTokenOverrides = {
	bg: "oklch(0.213423 0 0)",
	fg: "oklch(0.952413 0.001331 286.374)",
	accent: "oklch(0.67242 0.13084 38.756)",
	contrast: "0.6",
	shell: "oklch(0.213423 0 0)",
	root: "oklch(0.239292 0 0)",
	"accent-dim": "oklch(0.353423 0.071962 38.756)",
	sidebar: "oklch(0.268618 0 0)",
	card: "oklch(0.268618 0 0)",
	"card-hover": "rgb(127 127 127 / 0.14)",
	elevated: "rgb(127 127 127 / 0.16)",
	input: "oklch(0.309186 0 0)",
	float: "oklch(0.285017 0 0)",
	knob: "oklch(1 0 0)",
	shade: "#000000",
	"window-tint": "color-mix(in srgb, oklch(0.285017 0 0) 60%, transparent)",
	line: "oklch(0.301184 0 0)",
	"line-soft": "oklch(0.268618 0 0)",
	"line-float": "rgb(127 127 127 / 0.18)",
	ink: "oklch(0.952413 0.001331 286.374)",
	"ink-muted": "#A3A3A3",
	"ink-faint": "oklch(0.649201 0.001179 197.129)",
	danger: "oklch(0.72 0.165 22)",
	warning: "oklch(0.760661 0.11705 70.938)",
	"on-accent": "oklch(1 0 0)",
	"code-bg": "oklch(0.239292 0 0)",
	"code-fg": "oklch(0.92494 0 0)",
	"code-line-height": "1.55",
	"code-tracking": "-0.002em",
	"inline-code-bg": "rgb(127 127 127 / 0.16)",
	"inline-code-fg": "oklch(0.92494 0 0)",
	"inline-code-ring": "transparent",
	"radius-panel": "14px",
	"radius-field": "7px",
	"radius-item": "7px",
	"radius-menu": "10px",
	"font-sans": 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
	"ui-size": "14px",
	"code-size": "13px",
};

const LIGHT_INTERACTION_TOKENS: SkinTokenOverrides = {
	"card-hover": "color-mix(in srgb, var(--plume-fg) 6%, transparent)",
	elevated: "color-mix(in srgb, var(--plume-fg) 11%, transparent)",
	"line-soft": "color-mix(in srgb, var(--plume-fg) 8%, transparent)",
};

const DARK_INTERACTION_TOKENS: SkinTokenOverrides = {
	"card-hover": "color-mix(in srgb, var(--plume-fg) 7.5%, transparent)",
	elevated: "color-mix(in srgb, var(--plume-fg) 14%, transparent)",
	"line-soft": "color-mix(in srgb, var(--plume-fg) 9%, transparent)",
};

export const PRESETS: readonly StudioSkin[] = [
	// 复刻 t3code 的默认主题：面、线和强调色取自 T3_CODE_*_THEME_COLORS；浅色保持会话窗最白、侧栏与外圈微灰，
	// 深色保持会话窗更黑、侧栏与外圈略亮，使主窗口、停靠侧栏（宿主以 OKLab 6:4 混 shell 与 sidebar）与设置弹窗分层方向一致。
	preset(
		"light-t3-code",
		"T3 Code Light",
		"light",
		["#F7F7F8", "#FFFFFF", "#F0F0F2", "#FAFAFA", "#E8E8EC", "#DFDFE4", "#27272A", "#5F5F68", "#71717B", "#1B4ED8", "#E0E6F7", "#E4E4E7"],
		{
			card: "#F4F4F5",
			input: "#FFFFFF",
			float: "#FFFFFF",
			...LIGHT_INTERACTION_TOKENS,
		},
	),
	preset(
		"dark-t3-code",
		"T3 Code Dark",
		"dark",
		["#0A0A0A", "#050505", "#111111", "#111111", "#18181A", "#222224", "#F5F5F5", "#A3A3A3", "#818181", "#346BF1", "#121B34", "#1E1E20"],
		{
			card: "#111111",
			input: "#141416",
			float: "#1A1A1D",
			"code-bg": "#101012",
			...DARK_INTERACTION_TOKENS,
		},
	),
	// Clawd 深浅主题：浅色会话窗最亮、外圈与侧栏暖灰，深色会话窗最深、外圈与侧栏略亮；另经 tokens 细粒度覆写卡片/输入/浮层分层、半透明悬停与描边、状态色、代码与圆角。
	preset(
		"light-clawd",
		"Clawd Light",
		"light",
		["#F5F4ED", "#FAF9F5", "#F0EEE6", "#F0EEE6", "#E4E4DE", "#E9E8E2", "#141413", "#65645E", "#6B6A64", "#C96442", "#EDEBE3", "#E5E3DA"],
		CLAWD_LIGHT_TOKENS,
	),
	preset(
		"dark-clawd",
		"Clawd Dark",
		"dark",
		["#1F1F1F", "#191919", "#262626", "#262626", "#2C2C2C", "#2E2E2E", "#EFEFF0", "#A3A3A3", "#8E8F8F", "#D97757", "#5B2D1E", "#2E2E2E"],
		CLAWD_DARK_TOKENS,
	),
	preset(
		"light-mint",
		"Mint Morning",
		"light",
		["#E8EEEA", "#F6FBF8", "#EEF7F1", "#FFFFFF", "#DCE9E0", "#D2E6D9", "#173226", "#456253", "#657C6D", "#0E9F6E", "#D9F4E6", "#DCECE2"],
		{
			card: "#EDF6F0",
			input: "#FFFFFF",
			float: "#FFFFFF",
			...LIGHT_INTERACTION_TOKENS,
		},
	),
	preset(
		"light-peach",
		"Peach Cream",
		"light",
		["#F2EAE8", "#FFF8F6", "#FDEEEC", "#FFFFFF", "#F7DFDC", "#F7D2CE", "#3A1F1D", "#7A4E49", "#926E69", "#E0527A", "#FBDCE6", "#F3DDD8"],
		{
			card: "#FCEEEB",
			input: "#FFFFFF",
			float: "#FFFFFF",
			...LIGHT_INTERACTION_TOKENS,
		},
	),
	preset(
		"dark-graphite",
		"Graphite",
		"dark",
		["#191A1F", "#121216", "#222328", "#1F2025", "#28292E", "#313239", "#F2F2F4", "#A7A8B2", "#8B8C98", "#6366F1", "#26264A", "#2B2C31"],
		{
			card: "#1F2025",
			input: "#24252B",
			float: "#2A2B32",
			"code-bg": "#18191E",
			...DARK_INTERACTION_TOKENS,
		},
	),
	preset(
		"dark-berry",
		"Midnight Berry",
		"dark",
		["#130910", "#1D1219", "#140C12", "#25151F", "#2C1A25", "#38212E", "#F6EEF2", "#C39CAE", "#AE8396", "#E02A8B", "#3D1530", "#301C29"],
		{
			card: "#25151F",
			input: "#2A1823",
			float: "#321D2A",
			...DARK_INTERACTION_TOKENS,
		},
	),
	preset(
		"dark-teal",
		"Deep Teal",
		"dark",
		["#0D2023", "#06171A", "#142A2E", "#12272A", "#1A3134", "#20393C", "#EAF5F4", "#9FC0BF", "#7A9E9B", "#0D9488", "#0F3A35", "#1C3335"],
		{
			card: "#12272A",
			input: "#172E32",
			float: "#1D373B",
			"code-bg": "#0C1F22",
			...DARK_INTERACTION_TOKENS,
		},
	),
	// 色调皮肤：只给色相和彩度，整套颜色和渐变外圈都由 OKLCH 推出来。
	toneSkin("light-tone-sky", "Clear Sky", 262, 0.055),
	toneSkin("light-tone-lavender", "Lavender Mist", 296, 0.058),
	toneSkin("light-tone-celadon", "Celadon", 172, 0.048),
];
