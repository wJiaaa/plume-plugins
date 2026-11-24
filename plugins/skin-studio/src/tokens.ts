import type { SkinToken } from "@plume/contract/ui";

/**
 * 工坊允许皮肤覆写的 Plume SkinToken 白名单。
 * 故意不包含 `root-image`：外圈渐变底纹由 `backdrop: { from, to }` 表达，避免接受任意 CSS 图像或外链 URL。
 */
const COLOR_SKIN_TOKENS = [
	"bg",
	"fg",
	"accent",
	"shell",
	"root",
	"accent-dim",
	"sidebar",
	"card",
	"card-hover",
	"elevated",
	"input",
	"float",
	"knob",
	"shade",
	"window-tint",
	"line",
	"line-soft",
	"line-float",
	"ink",
	"ink-muted",
	"ink-faint",
	"ok",
	"danger",
	"warning",
	"violet",
	"chart-2",
	"chart-3",
	"chart-4",
	"chart-5",
	"chart-6",
	"on-accent",
	"code-bg",
	"code-fg",
	"inline-code-bg",
	"inline-code-fg",
	"inline-code-ring",
	"diff-add",
	"diff-remove",
	"syntax-keyword",
	"syntax-string",
	"syntax-number",
	"syntax-comment",
	"syntax-function",
	"syntax-type",
	"syntax-variable",
	"syntax-operator",
	"syntax-punctuation",
	"syntax-tag",
	"syntax-attribute",
] as const;

const RADIUS_SKIN_TOKENS = ["radius-panel", "radius-field", "radius-item", "radius-menu"] as const;
const FONT_SIZE_SKIN_TOKENS = ["ui-size", "code-size"] as const;
const FONT_FAMILY_SKIN_TOKENS = ["font-sans", "font-mono"] as const;
const OTHER_SKIN_TOKENS = ["contrast", "code-line-height", "code-tracking"] as const;

export const STUDIO_SKIN_TOKENS = [
	...COLOR_SKIN_TOKENS,
	...OTHER_SKIN_TOKENS,
	...RADIUS_SKIN_TOKENS,
	...FONT_SIZE_SKIN_TOKENS,
	...FONT_FAMILY_SKIN_TOKENS,
] as const satisfies readonly Exclude<SkinToken, "root-image">[];

type StudioSkinToken = (typeof STUDIO_SKIN_TOKENS)[number];
export type SkinTokenOverrides = Partial<Record<StudioSkinToken, string>>;

// 编译期守卫：SDK 增减 SkinToken 时强制同步这里的白名单。
type AssertNever<T extends never> = T;
type _AllSkinTokensCovered = AssertNever<Exclude<Exclude<SkinToken, "root-image">, StudioSkinToken>>;

const COLOR_TOKEN_SET: ReadonlySet<string> = new Set(COLOR_SKIN_TOKENS);
const RADIUS_TOKEN_SET: ReadonlySet<string> = new Set(RADIUS_SKIN_TOKENS);
const FONT_SIZE_TOKEN_SET: ReadonlySet<string> = new Set(FONT_SIZE_SKIN_TOKENS);
const FONT_FAMILY_TOKEN_SET: ReadonlySet<string> = new Set(FONT_FAMILY_SKIN_TOKENS);
const STUDIO_TOKEN_SET: ReadonlySet<string> = new Set(STUDIO_SKIN_TOKENS);

const MAX_TOKEN_VALUE_LENGTH = 240;
const FORBIDDEN_CSS = /[\u0000-\u001F\u007F;{}\\]|\/\*|\*\//;
const HEX_COLOR = /^(?:#[\da-f]{3}|#[\da-f]{4}|#[\da-f]{6}|#[\da-f]{8})$/i;
const COLOR_KEYWORDS = new Set(["transparent", "currentcolor"]);
const COLOR_FUNCTIONS = new Set(["rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch"]);
const COLOR_SPACES = new Set(["srgb", "srgb-linear", "display-p3", "a98-rgb", "prophoto-rgb", "rec2020", "xyz", "xyz-d50", "xyz-d65"]);
const COLOR_MIX_METHOD =
	/^in\s+(?:srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020|lab|oklab|xyz|xyz-d50|xyz-d65|(?:hsl|hwb|lch|oklch)(?:\s+(?:shorter|longer|increasing|decreasing)\s+hue)?)$/i;
const COLOR_ARG_PART = /^(?:none|[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:%|deg|rad|grad|turn)?)$/;
const PERCENTAGE = /^(?:\d+(?:\.\d+)?|\.\d+)%$/;
const NUMBER_ONLY = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
const TRACKING_VALUE = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(em|px)$/;
const RADIUS_VALUE = /^((?:\d+(?:\.\d+)?|\.\d+))(px|rem|em)$/;
const FONT_SIZE_VALUE = /^((?:\d+(?:\.\d+)?|\.\d+))px$/;
const FONT_IDENT = /^[A-Za-z0-9_-]+(?:\s+[A-Za-z0-9_-]+)*$/;
const FONT_DOUBLE_QUOTED = /^"[^"\\;{}()\r\n]{1,80}"$/;
const FONT_SINGLE_QUOTED = /^'[^'\\;{}()\r\n]{1,80}'$/;

function splitTopLevel(input: string, separator: "," | " "): string[] | null {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let index = 0; index < input.length; index++) {
		const ch = input[index]!;
		if (ch === "(") {
			depth++;
		} else if (ch === ")") {
			depth--;
			if (depth < 0) return null;
		} else if (depth === 0) {
			if (separator === "," && ch === ",") {
				parts.push(input.slice(start, index).trim());
				start = index + 1;
			} else if (separator === " " && /\s/.test(ch)) {
				const segment = input.slice(start, index).trim();
				if (segment) parts.push(segment);
				start = index + 1;
			}
		}
	}
	if (depth !== 0) return null;
	const tail = input.slice(start).trim();
	if (separator === ",") parts.push(tail);
	else if (tail) parts.push(tail);
	return parts;
}

function isSafeColorArgs(raw: string): boolean {
	const trimmed = raw.trim();
	if (!trimmed) return false;
	const slashParts = trimmed.split("/");
	if (slashParts.length > 2) return false;
	const before = slashParts[0]!.trim();
	const alpha = slashParts[1]?.trim();
	if (!before || (slashParts.length === 2 && (!alpha || !COLOR_ARG_PART.test(alpha)))) return false;
	const tokens = before.includes(",") ? before.split(",").map((part) => part.trim()) : before.split(/\s+/);
	return tokens.length >= 3 && tokens.length <= 4 && tokens.every((token) => COLOR_ARG_PART.test(token));
}

function isSafeColorMixStop(stop: string, depth: number): boolean {
	if (!stop) return false;
	if (isSafeColorValue(stop, depth)) return true;
	const parts = splitTopLevel(stop, " ");
	if (!parts || parts.length !== 2) return false;
	const [first, second] = parts as [string, string];
	if (PERCENTAGE.test(second)) {
		const percent = Number.parseFloat(second);
		return percent >= 0 && percent <= 100 && isSafeColorValue(first, depth);
	}
	if (PERCENTAGE.test(first)) {
		const percent = Number.parseFloat(first);
		return percent >= 0 && percent <= 100 && isSafeColorValue(second, depth);
	}
	return false;
}

function isSafeColorValue(raw: string, depth = 0): boolean {
	if (depth > 3) return false;
	const value = raw.trim();
	if (!value) return false;
	if (HEX_COLOR.test(value) || COLOR_KEYWORDS.has(value.toLowerCase())) return true;
	const varMatch = /^var\(\s*--plume-([a-z0-9-]+)\s*\)$/.exec(value);
	if (varMatch) return COLOR_TOKEN_SET.has(varMatch[1]!);
	if (value.toLowerCase().startsWith("color-mix(") && value.endsWith(")")) {
		const inner = value.slice("color-mix(".length, -1).trim();
		const args = splitTopLevel(inner, ",");
		if (!args || args.length !== 3) return false;
		const [method, first, second] = args as [string, string, string];
		return COLOR_MIX_METHOD.test(method) && isSafeColorMixStop(first, depth + 1) && isSafeColorMixStop(second, depth + 1);
	}
	const fnMatch = /^([a-z]+)\(([^()]+)\)$/i.exec(value);
	if (!fnMatch) return false;
	const name = fnMatch[1]!.toLowerCase();
	const body = fnMatch[2]!.trim();
	if (name === "color") {
		const spaceMatch = /^([a-z0-9-]+)\s+(.+)$/i.exec(body);
		if (!spaceMatch || !COLOR_SPACES.has(spaceMatch[1]!.toLowerCase())) return false;
		return isSafeColorArgs(spaceMatch[2]!);
	}
	return COLOR_FUNCTIONS.has(name) && isSafeColorArgs(body);
}

function isSafeFontFamily(value: string): boolean {
	const items = value.split(",");
	if (items.length === 0 || items.length > 20) return false;
	return items.every((item) => {
		const trimmed = item.trim();
		return FONT_DOUBLE_QUOTED.test(trimmed) || FONT_SINGLE_QUOTED.test(trimmed) || FONT_IDENT.test(trimmed);
	});
}

function isValidTokenValue(token: StudioSkinToken, value: string): boolean {
	if (!value || value.length > MAX_TOKEN_VALUE_LENGTH || FORBIDDEN_CSS.test(value)) return false;
	if (COLOR_TOKEN_SET.has(token)) return isSafeColorValue(value);
	if (token === "contrast") {
		if (!NUMBER_ONLY.test(value)) return false;
		const number = Number.parseFloat(value);
		return number >= 0 && number <= 1;
	}
	if (token === "code-line-height") {
		if (!NUMBER_ONLY.test(value)) return false;
		const number = Number.parseFloat(value);
		return number >= 1 && number <= 3;
	}
	if (token === "code-tracking") {
		if (value === "0") return true;
		const match = TRACKING_VALUE.exec(value);
		if (!match) return false;
		const number = Number.parseFloat(match[1]!);
		return match[2] === "em" ? number >= -0.2 && number <= 0.5 : number >= -4 && number <= 8;
	}
	if (RADIUS_TOKEN_SET.has(token)) {
		if (value === "0") return true;
		const match = RADIUS_VALUE.exec(value);
		if (!match) return false;
		const number = Number.parseFloat(match[1]!);
		return match[2] === "px" ? number >= 0 && number <= 64 : number >= 0 && number <= 4;
	}
	if (FONT_SIZE_TOKEN_SET.has(token)) {
		const match = FONT_SIZE_VALUE.exec(value);
		if (!match) return false;
		const number = Number.parseFloat(match[1]!);
		return number >= 10 && number <= 24;
	}
	if (FONT_FAMILY_TOKEN_SET.has(token)) return isSafeFontFamily(value);
	return false;
}

export function parseTokenOverrides(value: unknown): SkinTokenOverrides | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalidTokens");
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length === 0) return undefined;
	const tokens: SkinTokenOverrides = {};
	for (const [key, rawValue] of entries) {
		if (!STUDIO_TOKEN_SET.has(key) || typeof rawValue !== "string") throw new Error("invalidTokens");
		const trimmed = rawValue.trim();
		if (!isValidTokenValue(key as StudioSkinToken, trimmed)) throw new Error("invalidTokens");
		tokens[key as StudioSkinToken] = trimmed;
	}
	return tokens;
}
