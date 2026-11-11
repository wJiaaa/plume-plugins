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
		// line-float 不写，交回宿主的半透明前景色：它要压在外圈底纹上也深一档（侧栏空闲会话的空心圈），
		// 不透明的 border 是按正文区挑的，落在外圈上和底色几乎一样，圈就看不见了。
	};
	return { name: skin.name, mode: skin.base, light: tokens, dark: tokens };
}
