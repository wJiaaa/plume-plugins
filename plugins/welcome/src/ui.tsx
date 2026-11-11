/**
 * plume.welcome 的界面入口：把今天的那一句交给欢迎页（`ui.welcomeLine`）。句子由逻辑入口写好、存好，这里只经 `remote()` 取。
 */

import type { Locale } from "@plume/contract";
import type { UiPlugin } from "@plume/contract/ui";
import type { WelcomeApi } from "./api.ts";

export default {
	name: "plume.welcome",
	apply(context) {
		const api = context.remote<WelcomeApi>();
		context.welcomeLine((locale: Locale) => api.today(locale));
	},
} satisfies UiPlugin;
