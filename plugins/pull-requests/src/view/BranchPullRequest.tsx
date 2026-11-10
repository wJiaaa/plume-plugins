/**
 * 环境卡片里那一节：会话工作目录当前分支的拉取请求，有才显示，带检查状态，点了去拉取请求页选中它。
 *
 * 没有「按分支查 PR」这条现成的路，于是用「我的 PR」那份列表按分支名过滤，再问逻辑入口这个 PR 的仓库是不是这个目录的 `origin`
 * （`findLocalCheckout`，和「询问 Agent」找本地检出是同一个判断）。这份列表只有你提的、你在审的、你审过的——别人提、和你无关的 PR
 * 不在里面，这一节就不出现。
 *
 * 列表先读页面留下的缓存，不够新再问一次平台；一个窗口里五分钟最多问一次，切会话、开关卡片都不会多问。
 */

import type { EnvironmentSectionProps } from "@plume/contract/ui";
import { Text } from "@plume/ui";
import { CircleCheck, CircleDashed, GitPullRequest, GitPullRequestDraft, XCircle } from "@plume/ui/icons";
import { useEffect, useState } from "react";
import type { PullRequestSummary } from "../api";
import { useMessages, useServices } from "./context";
import type { Api } from "./store";

const REFRESH_MS = 5 * 60_000;

let fetched: { at: number; list: PullRequestSummary[] } | null = null;
let fetching: Promise<PullRequestSummary[]> | null = null;
const checkouts = new Map<string, Promise<boolean>>();
const branches = new Map<string, { at: number; branch: Promise<string | null> }>();

function freshList(api: Api): Promise<PullRequestSummary[]> {
	if (fetched && Date.now() - fetched.at < REFRESH_MS) return Promise.resolve(fetched.list);
	fetching ??= api
		.myPullRequests()
		.then((result) => {
			fetched = { at: Date.now(), list: result.pullRequests };
			return result.pullRequests;
		})
		.catch(() => fetched?.list ?? [])
		.finally(() => {
			fetching = null;
		});
	return fetching;
}

/** 分支会被人切走，比列表变得勤：一会儿就重新问。 */
function branchOf(api: Api, cwd: string): Promise<string | null> {
	const known = branches.get(cwd);
	if (known && Date.now() - known.at < 30_000) return known.branch;
	const branch = api.currentBranch(cwd).catch(() => null);
	branches.set(cwd, { at: Date.now(), branch });
	return branch;
}

function isCheckout(api: Api, pr: PullRequestSummary, path: string): Promise<boolean> {
	const key = `${pr.accountId}\n${pr.repo}\n${path}`;
	let answer = checkouts.get(key);
	if (!answer) {
		answer = api.findLocalCheckout(pr.accountId, pr.repo, [path]).then(
			(found) => found !== null,
			() => false,
		);
		checkouts.set(key, answer);
	}
	return answer;
}

async function pullRequestFor(api: Api, list: PullRequestSummary[], branch: string, path: string): Promise<PullRequestSummary | null> {
	const open = list.filter((pr) => pr.headRefName === branch && pr.state !== "MERGED" && pr.state !== "CLOSED");
	for (const pr of open) if (await isCheckout(api, pr, path)) return pr;
	return null;
}

function usePullRequest(cwd: string): PullRequestSummary | null {
	const { api, store } = useServices();
	const [found, setFound] = useState<{ cwd: string; pr: PullRequestSummary | null } | null>(null);
	useEffect(() => {
		let live = true;
		const settle = (pr: PullRequestSummary | null) => {
			if (live) setFound({ cwd, pr });
		};
		void branchOf(api, cwd).then(async (branch) => {
			if (!branch) return settle(null);
			// 页面留下的缓存只在第一次画时垫底，之后以平台的答复为准。
			settle(await pullRequestFor(api, fetched?.list ?? store.getSnapshot().items, branch, cwd));
			settle(await pullRequestFor(api, await freshList(api), branch, cwd));
		});
		return () => {
			live = false;
		};
	}, [api, store, cwd]);
	return found?.cwd === cwd ? found.pr : null;
}

function CheckMark({ state }: { state: PullRequestSummary["checkState"] }) {
	const text = useMessages();
	if (state === "pass") return <CircleCheck size={13} className="plume-pr-branch-check" data-state="pass" aria-label={text.branchChecksPassed} />;
	if (state === "fail") return <XCircle size={13} className="plume-pr-branch-check" data-state="fail" aria-label={text.branchChecksFailed} />;
	if (state === "pending") return <CircleDashed size={13} className="plume-pr-branch-check" data-state="pending" aria-label={text.branchChecksPending} />;
	return null;
}

export function BranchPullRequest({ session }: EnvironmentSectionProps) {
	const { ui, store } = useServices();
	const pr = usePullRequest(session.summary.cwd);
	if (!pr) return null;
	const Icon = pr.isDraft ? GitPullRequestDraft : GitPullRequest;
	return (
		<button
			type="button"
			className="plume-pr-branch-row"
			data-environment-pull-request={pr.number}
			data-plume-tip={`${pr.repo}#${pr.number}\n${pr.title}`}
			onClick={() => {
				store.focus({ accountId: pr.accountId, repo: pr.repo, number: pr.number });
				ui.openPage("pull-requests");
			}}
		>
			<Icon size={14} className="plume-pr-branch-icon" data-draft={pr.isDraft} />
			<Text size="label" className="plume-pr-branch-title">
				<Text tone="faint" numeric>
					#{pr.number}
				</Text>{" "}
				{pr.title}
			</Text>
			<CheckMark state={pr.checkState} />
		</button>
	);
}
