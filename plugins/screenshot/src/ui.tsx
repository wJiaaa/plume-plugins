/**
 * plume.screenshot 的界面入口：截图浮层、钉图窗口、输入框里的相机按钮、设置页里的「截图」一节。
 *
 * 拍屏幕、开窗口、剪贴板、全局快捷键是宿主经 `ui.screen` 给的；设置、写文件、窗口列表在逻辑入口那边，经 `ui.remote()` 用。
 * 这个入口在主窗口、浮层窗口、钉图窗口里各跑一份，各有一份设置（都从逻辑入口读）。
 */

import type { ComposerItemProps, PinnedShotProps, ScreenOverlayProps, UiPlugin } from "@plume/contract/ui";
import { acceleratorLabel, IconButton, useI18n } from "@plume/ui";
import { Camera } from "@plume/ui/icons";
import type { ScreenshotApi } from "./api.ts";
import { MESSAGES } from "./messages.ts";
import { PinnedShot } from "./PinnedShot.tsx";
import screenshotCss from "./screenshot.css";
import { ScreenshotOverlay } from "./ScreenshotOverlay.tsx";
import { ScreenshotSettings } from "./ScreenshotSettings.tsx";
import { createSettingsStore, useSettings } from "./settings-store.ts";

/**
 * 宿主不加载插件的样式表，这里自己挂一份。按插件名认那个元素：更新后重新加载时换掉内容，不叠一份。
 */
function mountStyles(): void {
	const id = "plume.screenshot";
	let style = document.querySelector<HTMLStyleElement>(`style[data-plugin-style="${id}"]`);
	if (!style) {
		style = document.createElement("style");
		style.dataset.pluginStyle = id;
		document.head.append(style);
	}
	style.textContent = screenshotCss;
}

export default {
	name: "plume.screenshot",
	apply(ui) {
		mountStyles();
		const api = ui.remote<ScreenshotApi>();
		const store = createSettingsStore(api, ui.screen, (message) => ui.notify(message, "error"));

		function Overlay(props: ScreenOverlayProps) {
			return <ScreenshotOverlay {...props} api={api} screen={ui.screen} store={store} />;
		}
		ui.screenOverlay(Overlay);
		ui.pinnedShot((props: PinnedShotProps) => <PinnedShot {...props} />);

		function ComposerButton(_: ComposerItemProps) {
			const text = MESSAGES[useI18n().resolvedLocale];
			const settings = useSettings(store);
			if (!settings.enabled || !settings.showInComposer) return null;
			// 悬停提示带上快捷键，按 `acceleratorLabel` 写：手拼的替换会把录下的 Win+Shift+S 写成「SuperShift+S」。
			const shortcut = settings.shortcut ? ` (${acceleratorLabel(settings.shortcut).replace(/ /g, "")})` : "";
			return (
				<IconButton
					size="composer"
					emphasis
					label={`${text.composerScreenshot}${shortcut}`}
					ariaLabel={text.composerScreenshot}
					onClick={() => void ui.screen.start()}
					icon={<Camera size={15} strokeWidth={1.9} />}
				/>
			);
		}
		ui.composerItem("capture", ComposerButton);

		ui.settingsSection("screenshot", () => <ScreenshotSettings store={store} screen={ui.screen} />, {
			title: (locale) => MESSAGES[locale].title,
			icon: Camera,
			page: "nav",
		});
	},
} satisfies UiPlugin;
