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
export type SkinBackgroundEffect = "none" | "dither" | "ascii" | "halftone" | "scanlines" | "grid" | "haze";
export interface SkinImageBackground {
	image: string;
	fit: "cover" | "tile";
	effect: SkinBackgroundEffect;
	opacity: number;
	onNewChat: boolean;
	inChat: boolean;
}
export interface ColorSkin {
	name: string;
	base: "light" | "dark";
	colors: SkinColors;
	backdrop?: SkinBackdrop;
	/** 皮肤独立背景；应用时覆盖显示，撤下后恢复人的全局背景。 */
	background?: SkinImageBackground;
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

const MAX_BACKGROUND_BYTES = 5 * 1024 * 1024;
const BACKGROUND_EFFECTS = new Set<SkinBackgroundEffect>(["none", "dither", "ascii", "halftone", "scanlines", "grid", "haze"]);

function imageSignature(mime: string, bytes: Uint8Array): boolean {
	if (mime === "png") return bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
	if (mime === "jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	if (mime === "gif") return bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(new TextDecoder().decode(bytes.subarray(0, 6)));
	return (
		mime === "webp" &&
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	);
}

function parseBackground(value: unknown): SkinImageBackground | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalidBackground");
	const raw = value as Record<string, unknown>;
	if (typeof raw.image !== "string") throw new Error("invalidBackground");
	const match = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw.image);
	if (!match || match[2]!.length % 4 !== 0 || match[2]!.length > Math.ceil((MAX_BACKGROUND_BYTES * 4) / 3) + 4) throw new Error("invalidBackground");
	let decoded: string;
	try {
		decoded = atob(match[2]!);
	} catch {
		throw new Error("invalidBackground");
	}
	if (decoded.length > MAX_BACKGROUND_BYTES) throw new Error("backgroundTooLarge");
	if (
		!imageSignature(
			match[1]!,
			Uint8Array.from(decoded, (character) => character.charCodeAt(0)),
		)
	)
		throw new Error("invalidBackground");
	const fit = raw.fit ?? "cover";
	const effect = raw.effect ?? "none";
	const opacity = raw.opacity ?? 0.24;
	if (fit !== "cover" && fit !== "tile") throw new Error("invalidBackground");
	if (typeof effect !== "string" || !BACKGROUND_EFFECTS.has(effect as SkinBackgroundEffect)) throw new Error("invalidBackground");
	if (typeof opacity !== "number" || !Number.isFinite(opacity) || opacity < 0.05 || opacity > 0.65) throw new Error("invalidBackground");
	if (raw.onNewChat !== undefined && typeof raw.onNewChat !== "boolean") throw new Error("invalidBackground");
	if (raw.inChat !== undefined && typeof raw.inChat !== "boolean") throw new Error("invalidBackground");
	return {
		image: raw.image,
		fit,
		effect: effect as SkinBackgroundEffect,
		opacity,
		onNewChat: raw.onNewChat ?? true,
		inChat: raw.inChat ?? true,
	};
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
	const background = parseBackground(raw.background);
	const backgrounds = [colors.bgRoot, colors.bgMain, colors.bgSidebar, colors.bgElevated, colors.bgHover, colors.bgActive];
	if (backdrop) backgrounds.push(backdrop.from, backdrop.to);
	for (const background of backgrounds) {
		if (contrast(colors.textPrimary, background) < 4.5 || contrast(colors.textSecondary, background) < 4.5 || contrast(colors.textTertiary, background) < 3) {
			throw new Error("lowContrast");
		}
	}
	return { name: raw.name.trim(), base: raw.base, colors, ...(backdrop && { backdrop }), ...(background && { background }) };
}

function isHex(value: unknown): value is string {
	return typeof value === "string" && /^#[\da-f]{6}$/i.test(value);
}
