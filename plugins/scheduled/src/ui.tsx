/**
 * plume.scheduled 的界面入口：往侧栏的去处里加「定时任务」页面，任务经 ui.remote() 在逻辑入口那边读写；
 * 没人看见的失败挂在侧栏那一行的数目上，并在输入框上方说一句。
 */

import type { PageProps, UiPlugin } from "@plume/contract/ui";
import { Clock } from "@plume/ui/icons";
import type { ScheduledApi } from "./api.ts";
import { connectScheduled } from "./client.ts";
import { MESSAGES } from "./messages.ts";
import scheduledCss from "./scheduled.css";
import { ScheduledAlert } from "./ScheduledAlert.tsx";
import { ScheduledView } from "./ScheduledView.tsx";

const PAGE = "scheduled";

/**
 * 宿主不加载插件的样式表，这里自己挂一份。按插件名认那个元素：更新后重新加载时换掉内容，不叠一份。
 * 停用后留着也无妨：没有这个页面时这些类名没人用。
 */
function mountStyles(): void {
	const id = "plume.scheduled";
	let style = document.querySelector<HTMLStyleElement>(`style[data-plugin-style="${id}"]`);
	if (!style) {
		style = document.createElement("style");
		style.dataset.pluginStyle = id;
		document.head.append(style);
	}
	style.textContent = scheduledCss;
}

export default {
	name: "plume.scheduled",
	apply(ui) {
		mountStyles();
		const api = ui.remote<ScheduledApi>();
		const seen = () => void api.markSeen().catch((error: unknown) => console.error("[plume.scheduled] 没标上已看：", error));
		const client = connectScheduled(api, (state) => {
			const count = state.unseen.length;
			ui.pageBadge(PAGE, count > 0 ? { count, attention: true, label: (locale) => MESSAGES[locale].unseenFailures(count) } : null);
		});

		function ScheduledPage({ workspace }: PageProps) {
			const projects = ui.useProjects();
			// 新任务放在当前工作区：打开着的会话的，没打开会话时是空白页选着的项目。用项目的目录，不是某段对话被换到的
			// 那个目录（工作树）：那份拷贝会被收走。
			const project = workspace?.project ? projects.find((entry) => entry.id === workspace.project) : undefined;
			return <ScheduledView api={api} client={client} host={ui} cwd={project?.path ?? workspace?.cwd ?? ""} project={project?.id} />;
		}
		ui.page(PAGE, ScheduledPage, { title: (locale) => MESSAGES[locale].title, icon: Clock });

		function FailureLine() {
			return (
				<ScheduledAlert
					client={client}
					onLook={(taskId) => {
						client.focus = taskId;
						seen();
						ui.openPage(PAGE);
					}}
					onDismiss={seen}
				/>
			);
		}
		ui.composerAbove("failures", FailureLine);
	},
} satisfies UiPlugin;
