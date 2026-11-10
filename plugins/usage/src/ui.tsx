/**
 * plume.usage 的界面入口：设置 › 数据 里「存储」上面那一页。页头的标题和介绍由宿主按 `title`、`detail` 画，
 * 页面从工具条画起（UsagePage.tsx），读数经 `ui.remote()` 向逻辑入口要。
 */

import type { UiPlugin } from "@plume/contract/ui";
import { BarChart3 } from "@plume/ui/icons";
import type { UsageApi } from "./api.ts";
import { MESSAGES } from "./messages.ts";
import css from "./usage.css";
import { UsagePage } from "./UsagePage.tsx";

/** 宿主不加载插件的样式表，这里自己挂一份。按插件名认那个元素：更新后重新加载时换掉内容，不叠一份。 */
function mountStyles(): void {
	const id = "plume.usage";
	let style = document.querySelector<HTMLStyleElement>(`style[data-plugin-style="${id}"]`);
	if (!style) {
		style = document.createElement("style");
		style.dataset.pluginStyle = id;
		document.head.append(style);
	}
	style.textContent = css;
}

export default {
	name: "plume.usage",
	apply(ui) {
		mountStyles();
		const api = ui.remote<UsageApi>();
		const scan = () => api.scan();
		ui.settingsSection("usage", () => <UsagePage scan={scan} />, {
			title: (locale) => MESSAGES[locale].title,
			detail: (locale) => MESSAGES[locale].intro,
			icon: BarChart3,
			order: 2,
			group: "data",
			page: "nav",
		});
	},
} satisfies UiPlugin;
