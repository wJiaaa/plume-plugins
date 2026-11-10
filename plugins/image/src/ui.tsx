/**
 * plume.image 的界面入口，跑在渲染进程：对话里 `image_generate` 的卡片，侧栏的「画廊」页。
 *
 * 画廊的数据在逻辑入口那边（扫会话），经 `ui.remote()` 取；图本身经 `ui.mediaUrl` 直接读媒体目录。
 */

import type { UiPlugin } from "@plume/contract/ui";
import { Image as ImageIcon, Images } from "@plume/ui/icons";
import type { ImageApi } from "./api.ts";
import { GALLERY_CSS, GalleryPage } from "./gallery/index.ts";
import imageCss from "./image.css";
import { imageCard, promptSubject } from "./ImageCard.tsx";
import { GALLERY_MESSAGES, MESSAGES } from "./messages.ts";
import { IMAGE_TOOL } from "./types.ts";

/** 宿主不加载插件的样式表，这里自己挂一份。按插件名认那个元素：重新加载时换掉内容，不叠一份。 */
function mountStyles(): void {
	const id = "plume.image";
	let style = document.querySelector<HTMLStyleElement>(`style[data-plugin-style="${id}"]`);
	if (!style) {
		style = document.createElement("style");
		style.dataset.pluginStyle = id;
		document.head.append(style);
	}
	style.textContent = `${imageCss}\n${GALLERY_CSS}`;
}

export default {
	name: "plume.image",
	apply(ui) {
		mountStyles();
		const api = ui.remote<ImageApi>();
		ui.toolLine(IMAGE_TOOL, { verb: (locale) => MESSAGES[locale].generateImage, subject: promptSubject, icon: ImageIcon });
		ui.toolCard(IMAGE_TOOL, imageCard(ui));
		ui.page("gallery", () => <GalleryPage ui={ui} api={api} />, { title: (locale) => GALLERY_MESSAGES[locale].title, icon: Images, topRow: true });
	},
} satisfies UiPlugin;
