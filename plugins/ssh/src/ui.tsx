/**
 * plume.ssh 的界面入口：侧栏「SSH 主机」页（主机库、终端标签、AI 运维助手）、`ssh_run` 的审批卡和工具卡片。
 * 连接、凭据、运维助手的会话都在逻辑入口那边，界面经 ui.remote() 连过去，一直订阅着它的状态。
 */

import type { UiPlugin } from "@plume/contract/ui";
import { Server } from "@plume/ui/icons";
import xtermCss from "@xterm/xterm/css/xterm.css";
import type { SshApi } from "./api.ts";
import { connectSsh } from "./client.ts";
import { hostsPage } from "./HostsPage.tsx";
import { MESSAGES } from "./messages.ts";
import { RunCard, RunRequestCard } from "./RunCards.tsx";
import sshCss from "./ssh.css";

const PAGE = "hosts";

/** 宿主不加载插件的样式表，自己挂一份；xterm 是自己打包的，样式表也带自己那一版。重新加载时换内容不叠加。 */
function mountStyles(): void {
	const id = "plume.ssh";
	let style = document.querySelector<HTMLStyleElement>(`style[data-plugin-style="${id}"]`);
	if (!style) {
		style = document.createElement("style");
		style.dataset.pluginStyle = id;
		document.head.append(style);
	}
	style.textContent = `${xtermCss}\n${sshCss}`;
}

export default {
	name: "plume.ssh",
	apply(ui) {
		mountStyles();
		const api = ui.remote<SshApi>();
		const client = connectSsh(api);
		ui.effect(client.cancel);

		ui.page(PAGE, hostsPage(ui, api, client), { title: (locale) => MESSAGES[locale].hostsTitle, icon: Server, topRow: true });
		// 运维助手等人批准时，人可能不在主机页上：侧栏那一行挂个提醒，也列进通知菜单。人在这一页上时宿主不画。
		let asking = false;
		ui.effect(
			client.subscribe(() => {
				const next = client.get()?.asking ?? false;
				if (next === asking) return;
				asking = next;
				ui.pageBadge(PAGE, next ? { count: 1, label: (locale) => MESSAGES[locale].assistantAsking, attention: true } : null);
			}),
		);
		ui.requestCard("ssh_run", RunRequestCard);
		ui.toolCard("ssh_run", RunCard);
		// 列的是主机页上连着的远程连接，不碰本机文件和命令，工具定义上不标 `kind`：转录里自成一类。图标和主机页的一样。
		ui.toolLine("ssh_sessions", { verb: (locale) => MESSAGES[locale].sessionsVerb, icon: Server });
	},
} satisfies UiPlugin;
