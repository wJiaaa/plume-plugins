import type { UiPlugin } from "@plume/contract/ui";
import { GitPullRequest, Server } from "@plume/ui/icons";
import type { PullRequestsApi } from "./api";
import { MESSAGES } from "./messages";
import css from "./pull-requests.css";
import { ServicesContext } from "./view/context";
import { createStore } from "./view/store";
import { createAvatarStore } from "./view/avatars";
import { PullRequestsPage } from "./view/PullRequestsPage";
import { ForgeSettings } from "./view/ForgeSettings";
import { BranchPullRequest } from "./view/BranchPullRequest";

export default {
	name: "plume.pull-requests",
	apply(ui) {
		let style = document.querySelector<HTMLStyleElement>('style[data-plugin-style="plume.pull-requests"]');
		if (!style) {
			style = document.createElement("style");
			style.dataset.pluginStyle = "plume.pull-requests";
			document.head.append(style);
		}
		style.textContent = css;
		const api = ui.remote<PullRequestsApi>();
		// 只在装上界面入口时建一次，下面两个组件拿到的始终是同一个对象。
		const services = { ui, api, store: createStore(api), avatars: createAvatarStore(api) };
		/* oxlint-disable react/jsx-no-constructed-context-values -- services 不是在渲染里建的 */
		ui.page(
			"pull-requests",
			() => (
				<ServicesContext.Provider value={services}>
					<PullRequestsPage />
				</ServicesContext.Provider>
			),
			{ title: (locale) => MESSAGES[locale].title, icon: GitPullRequest, order: -10, topRow: true },
		);
		ui.settingsSection(
			"forges",
			() => (
				<ServicesContext.Provider value={services}>
					<ForgeSettings />
				</ServicesContext.Provider>
			),
			{ title: (locale) => MESSAGES[locale].forgeTitle, detail: (locale) => MESSAGES[locale].forgeIntro, icon: Server, page: "nav" },
		);
		ui.environmentSection(
			"pull-request",
			({ session }) => (
				<ServicesContext.Provider value={services}>
					<BranchPullRequest session={session} />
				</ServicesContext.Provider>
			),
			// 60：环境卡片里排在定时唤醒之后、侧边聊天之前。
			{ label: (locale) => MESSAGES[locale].title, order: 60 },
		);
		/* oxlint-enable react/jsx-no-constructed-context-values */
	},
} satisfies UiPlugin;
