export const DEFAULT_MODES = ["system", "light", "dark"] as const;

/** 默认配色不复制 token，运行时由产品主题决定；其选择与普通皮肤使用同一个 activeId。 */
export function defaultMode(id: string | null): (typeof DEFAULT_MODES)[number] | undefined {
	return DEFAULT_MODES.find((mode) => id === `default-${mode}`);
}

/** 皮肤是配色数据，不接受 CSS、路径或脚本。 */
export const COLOR_KEYS = [
	"bgRoot",
	"bgMain",
	"bgSidebar",
	"bgElevated",
	"bgHover",
	"bgActive",
	"textPrimary",
	"textSecondary",
	"textTertiary",
	"accent",
	"accentDim",
	"border",
] as const;
type ColorKey = (typeof COLOR_KEYS)[number];
export type SkinColors = Record<ColorKey, string>;
/** 窗口外圈的底纹：from 到 to 的斜向渐变。侧栏的字压在上面，两端都要过文字对比度。磨砂颗粒是宿主的用户开关，不归皮肤。 */
interface SkinBackdrop {
	from: string;
	to: string;
}
export interface ColorSkin {
	name: string;
	base: "light" | "dark";
	colors: SkinColors;
	backdrop?: SkinBackdrop;
}
export interface StudioSkin extends ColorSkin {
	id: string;
	builtin: boolean;
}
export interface StudioView {
	skins: StudioSkin[];
	activeId: string | null;
}

function luminance(hex: string): number {
	const channels = [1, 3, 5].map((offset) => {
		const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
		return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	});
	return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

export function contrast(first: string, second: string): number {
	const a = luminance(first);
	const b = luminance(second);
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** 返回错误代码，模型调用和界面按各自语言解释，不把坏数据悄悄当成默认皮肤。 */
export function parseSkin(value: unknown): ColorSkin {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalidSkin");
	const raw = value as Record<string, unknown>;
	if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.trim().length > 80) throw new Error("invalidName");
	if (raw.base !== "light" && raw.base !== "dark") throw new Error("invalidBase");
	if (!raw.colors || typeof raw.colors !== "object" || Array.isArray(raw.colors)) throw new Error("invalidColors");
	const source = raw.colors as Record<string, unknown>;
	const colors = {} as SkinColors;
	for (const key of COLOR_KEYS) {
		const value = source[key];
		if (!isHex(value)) throw new Error("invalidColors");
		colors[key] = value.toUpperCase();
	}
	let backdrop: SkinBackdrop | undefined;
	if (raw.backdrop !== undefined) {
		const value = raw.backdrop as Record<string, unknown> | null;
		if (!value || typeof value !== "object" || Array.isArray(value) || !isHex(value.from) || !isHex(value.to)) throw new Error("invalidBackdrop");
		backdrop = { from: value.from.toUpperCase(), to: value.to.toUpperCase() };
	}
	const backgrounds = [colors.bgRoot, colors.bgMain, colors.bgSidebar, colors.bgElevated, colors.bgHover, colors.bgActive];
	if (backdrop) backgrounds.push(backdrop.from, backdrop.to);
	for (const background of backgrounds) {
		if (contrast(colors.textPrimary, background) < 4.5 || contrast(colors.textSecondary, background) < 4.5 || contrast(colors.textTertiary, background) < 3) {
			throw new Error("lowContrast");
		}
	}
	return { name: raw.name.trim(), base: raw.base, colors, ...(backdrop && { backdrop }) };
}

function isHex(value: unknown): value is string {
	return typeof value === "string" && /^#[\da-f]{6}$/i.test(value);
}
