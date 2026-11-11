// color-exempt：按皮肤的强调色选择黑或白的字，确保强调色实底上的文字可读
import type { Skin, SkinToken } from "@plume/contract/ui";
import type { ColorSkin } from "./types.ts";
import { contrast } from "./types.ts";

/** 外圈底纹的 CSS 图像。 */
function rootImage(backdrop: NonNullable<ColorSkin["backdrop"]>): string {
	return `linear-gradient(160deg, ${backdrop.from}, ${backdrop.to})`;
}

/** 一套数据皮肤决定应用模式；两种媒体查询给相同颜色，切换系统模式时也不闪回旧皮肤。 */
export function toSkin(skin: ColorSkin): Skin {
	const c = skin.colors;
	const tokens: Partial<Record<SkinToken, string>> = {
		root: c.bgRoot,
		// 没有底纹的皮肤不写这一项：每次 ui.skin 整套替换，缺省就是宿主的 none。
		...(skin.backdrop && { "root-image": rootImage(skin.backdrop) }),
		"window-tint": c.bgRoot,
		bg: c.bgMain,
		shell: c.bgMain,
		"code-bg": c.bgMain,
		sidebar: c.bgSidebar,
		card: c.bgElevated,
		input: c.bgElevated,
		float: c.bgElevated,
		"card-hover": c.bgHover,
		elevated: c.bgActive,
		fg: c.textPrimary,
		ink: c.textPrimary,
		"code-fg": c.textPrimary,
		"ink-muted": c.textSecondary,
		"ink-faint": c.textTertiary,
		accent: c.accent,
		"accent-dim": c.accentDim,
		"on-accent": contrast(c.accent, "#FFFFFF") >= contrast(c.accent, "#000000") ? "#FFFFFF" : "#000000",
		line: c.border,
		"line-soft": c.border,
		"line-float": c.border,
	};
	return { name: skin.name, mode: skin.base, light: tokens, dark: tokens };
}
