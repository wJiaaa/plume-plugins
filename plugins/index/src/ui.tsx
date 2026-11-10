/**
 * plume.index 的界面入口：设置页里「索引库」那一节，和转录里 `symbol` 的说法。`symbol` 没有专用卡片，画法是宿主的通用卡片：
 * 行上说「查找符号 runAgent」，和读文件、搜索归成一类，连着做时并进同一段活。
 * 索引在逻辑入口那边建和搜，经 `ui.remote()` 调。
 */

import type { UiPlugin } from "@plume/contract/ui";
import { Database } from "@plume/ui/icons";
import type { IndexApi } from "./api.ts";
import indexCss from "./index.css";
import { IndexSettings } from "./IndexSettings.tsx";
import { MESSAGES } from "./messages.ts";

/** 宿主不加载插件的样式表，这里自己挂一份。按插件名认那个元素：重新加载时换掉内容，不叠一份。 */
function mountStyles(): void {
	const id = "plume.index";
	let style = document.querySelector<HTMLStyleElement>(`style[data-plugin-style="${id}"]`);
	if (!style) {
		style = document.createElement("style");
		style.dataset.pluginStyle = id;
		document.head.append(style);
	}
	style.textContent = indexCss;
}

export default {
	name: "plume.index",
	apply(ui) {
		mountStyles();
		const api = ui.remote<IndexApi>();
		const notify = ui.notify.bind(ui);
		ui.toolLine("symbol", {
			verb: (locale) => MESSAGES[locale].toolVerb,
			// 模型有时把名字写在别的键上，和逻辑入口认的一样。
			subject: (args) =>
				["name", "query", "symbol", "pattern"].map((key) => args[key]).find((value): value is string => typeof value === "string" && value !== ""),
			like: "read",
		});
		ui.settingsSection("index", () => <IndexSettings api={api} notify={notify} useProjects={() => ui.useProjects()} />, {
			title: (locale) => MESSAGES[locale].title,
			icon: Database,
			// 「数据」组里依次是索引库、使用统计、存储。
			order: 1,
			group: "data",
			page: "nav",
		});
	},
} satisfies UiPlugin;
