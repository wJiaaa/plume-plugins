/**
 * plume.memory 的界面入口：把记忆那一节画进设置的「个性化」页（全局指令和语气之间），记忆经 ui.remote() 在逻辑入口那边读写；
 * 设置 › 智能体 › 会话里再画一行，后台总结用哪个模型；转录里 `learn` 那一行怎么说。
 */

import type { UiPlugin } from "@plume/contract/ui";
import type { MemoryApi } from "./api.ts";
import { MemoryModel } from "./MemoryModel.tsx";
import memoryCss from "./memory.css";
import { MemorySettings } from "./MemorySettings.tsx";
import { MESSAGES } from "./messages.ts";

/** 宿主不加载插件的样式表，这里自己挂一份。按插件名认那个元素：更新后重新加载时换掉内容，不叠一份。 */
function mountStyles(): void {
	const id = "plume.memory";
	let style = document.querySelector<HTMLStyleElement>(`style[data-plugin-style="${id}"]`);
	if (!style) {
		style = document.createElement("style");
		style.dataset.pluginStyle = id;
		document.head.append(style);
	}
	style.textContent = memoryCss;
}

/** `learn` 记的那一条，取开头 40 个字；参数是模型给的、没校验过。 */
function learnSubject(args: Record<string, unknown>): string | undefined {
	const lesson = typeof args.lesson === "string" ? args.lesson.trim() : "";
	return lesson ? lesson.slice(0, 40) : undefined;
}

export default {
	name: "plume.memory",
	apply(ui) {
		mountStyles();
		const api = ui.remote<MemoryApi>();
		function MemorySection() {
			return <MemorySettings api={api} />;
		}
		// 转录里 `learn` 那一行说记下的是哪一条（开头 40 个字）：只说「学习」，几次 learn 并在一起时分不出各记了什么。
		ui.toolLine("learn", { verb: (locale) => MESSAGES[locale].learn, subject: learnSubject });
		ui.settingsSection("memory", MemorySection, { title: (locale) => MESSAGES[locale].title, page: "personalization" });
		function ModelSection() {
			return <MemoryModel ui={ui} api={api} />;
		}
		ui.settingsSection("model", ModelSection, {
			title: (locale) => MESSAGES[locale].modelTitle,
			detail: (locale) => MESSAGES[locale].modelDetail,
			page: "session-models",
		});
	},
} satisfies UiPlugin;
