import { useEffect, useRef, useState } from "react";
import { useNarrow } from "@plume/ui";
import type { PullRequestDetail } from "../api";
import { format } from "../messages";
import { useMessages, useServices } from "./context";
import { PullRequestList } from "./PullRequestList";
import { PullRequestDetailView } from "./PullRequestDetail";
import { ReviewBar } from "./ReviewBar";
import { usePullRequests } from "./usePullRequests";

export function PullRequestsPage() {
	const { ui, api } = useServices();
	const text = useMessages();
	const projects = ui.useProjects();
	const [narrow, measure] = useNarrow(760);
	const [expanded, setExpanded] = useState(false);
	const [tab, setTab] = useState<"summary" | "code">("summary");
	const [chatBusy, setChatBusy] = useState(false);
	const alive = useRef(true);
	const opening = useRef<{ cancel(): void } | null>(null);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
			opening.current?.cancel();
		};
	}, []);
	const pr = usePullRequests(!narrow);
	const openChat = async (detail: PullRequestDetail, intent: "ask" | "review") => {
		if (opening.current) return;
		setChatBusy(true);
		try {
			const paths = [...new Set(projects.map((project) => project.path))];
			const lookup = api.findLocalCheckout(detail.accountId, detail.repo, paths);
			opening.current = lookup;
			const local = await lookup;
			if (!alive.current) return;
			const where = local ? format(text.localRepo, { head: detail.headRefName, base: detail.baseRefName }) : "";
			const prompt = format(intent === "review" ? text.reviewPrompt : text.explainPrompt, {
				number: detail.number,
				title: detail.title,
				url: detail.url,
				where: where ? (intent === "ask" ? `\n\n${where}` : `${where}\n\n`) : "",
			});
			const draft = `${prompt}\n\n${text.readWithTool}\n${JSON.stringify({ accountId: detail.accountId, repo: detail.repo, number: detail.number })}`;
			if (local) {
				const project = projects.find((entry) => entry.path === local);
				await ui.openConversationDraft({ ...(project ? { project: project.id } : { cwd: local }), text: draft });
			} else {
				const scratch = api.scratchForPullRequest(detail.accountId, detail.repo, detail.number);
				opening.current = scratch;
				const cwd = await scratch;
				if (alive.current) await ui.openConversationDraft({ cwd, text: draft });
			}
		} catch (error) {
			if (alive.current) ui.notify(String(error), "error");
		} finally {
			opening.current = null;
			if (alive.current) setChatBusy(false);
		}
	};
	return (
		<div ref={measure} className="plume-pr-page" data-narrow={narrow} data-expanded={expanded} data-selected={Boolean(pr.selected)}>
			<aside className="plume-pr-list" inert={(!narrow && expanded) || (narrow && Boolean(pr.selected))}>
				<PullRequestList pr={pr} />
			</aside>
			<main className="plume-pr-detail" inert={narrow && !pr.selected}>
				<PullRequestDetailView
					selected={pr.selected}
					detail={pr.detail}
					loading={pr.detailLoading}
					error={pr.detailError}
					onRefresh={pr.refreshDetail}
					expanded={expanded}
					onToggleExpanded={() => setExpanded((value) => !value)}
					tab={tab}
					onTab={setTab}
					narrow={narrow}
					onBack={pr.clearSelection}
					onOpenChat={(detail, intent) => void openChat(detail, intent)}
					chatBusy={chatBusy}
				/>
				<ReviewBar target={pr.detail} onSubmitted={pr.refreshDetail} />
			</main>
		</div>
	);
}
