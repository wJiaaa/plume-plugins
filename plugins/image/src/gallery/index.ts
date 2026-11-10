/**
 * 画廊页，给界面入口注册成 `ui.page`；样式表按文字交出去，由界面入口和别的样式一起挂。
 */

import css from "./gallery.css";

export { GalleryPage } from "./GalleryPage.tsx";
export const GALLERY_CSS: string = css;
