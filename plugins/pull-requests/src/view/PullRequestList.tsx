import { memo, useRef, useState } from "react";
import {
	ActionSpinner,
	Button,
	Caret,
	Collapse,
	IconButton,
	PageTopRow,
	Scroller,
	ScrollText,
	SearchField,
	Sideways,
	SkeletonList,
	Text,
	relativeTime,
	useSlowLoad,
} from "@plume/ui";
import { Check, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, RefreshCw, Settings2, TriangleAlert, UserPlus } from "@plume/ui/icons";
import type { PullRequestSummary } from "../api";
import { format } from "../messages";
import { readCache, writeCache } from "./cache";
import { Avatar } from "./avatars";
import { useMessages, useServices } from "./context";
import { rowId, sameRef } from "./model";
import type { usePullRequests } from "./usePullRequests";

type PullRequests = ReturnType<typeof usePullRequests>;
export function PullRequestList({ pr }: { pr: PullRequests }) {
	const text = useMessages();
	const { ui } = useServices();
	const [folded, setFolded] = useState<Set<string>>(() => {
		const saved = readCache("folded");
		return new Set(Array.isArray(saved) ? saved.filter((key): key is string => typeof key === "string") : []);
	});
	const strip = useRef<HTMLDivElement>(null);
	const slow = useSlowLoad(pr.loading && !pr.items.length);
	const accounts = pr.accounts.filter((account) => account.enabled);
	const labels = { reviewing: text.forYou, authored: text.authored, reviewed: text.reviewed };
	const toggle = (key: string) =>
		setFolded((previous) => {
			const next = new Set(previous);
			if (!next.delete(key)) next.add(key);
			writeCache("folded", [...next]);
			return next;
		});
	const accountSettings = () => ui.openSettings("forges");
	const signedOut = pr.ready && !pr.accounts.length;
	return (
		<div className="plume-pr-column">
			<PageTopRow start className="plume-pr-head" data-plume-toprow="pr-list">
				{!signedOut &&
					(["all", "reviewing", "authored"] as const).map((filter) => (
						<Button key={filter} variant="subtle" size="sm" pressed={pr.filter === filter} onClick={() => pr.setFilter(filter)}>
							{text[filter]}
						</Button>
					))}
				<div className="plume-pr-spacer" />
				{!signedOut && (
					<>
						<IconButton
							label={text.refresh}
							disabled={pr.loading}
							onClick={() => void pr.refresh()}
							icon={pr.loading ? <ActionSpinner size={13} /> : <RefreshCw size={13} />}
						/>
						<IconButton label={text.settings} onClick={accountSettings} icon={<Settings2 size={13} />} />
					</>
				)}
			</PageTopRow>
			{signedOut ? (
				<div className="plume-pr-empty">
					<Text size="title">{text.noAccount}</Text>
					<Text size="detail" tone="faint">
						{text.hostsSupported}
					</Text>
					<Button icon={<UserPlus size={13} />} onClick={accountSettings}>
						{text.addAccount}
					</Button>
				</div>
			) : (
				<>
					{accounts.length > 1 && (
						<Sideways trackRef={strip} role="group" aria-label={text.accounts} className="plume-pr-account-tabs">
							<Button size="sm" variant="subtle" pressed={pr.account === null} onClick={() => pr.setAccount(null)}>
								{text.all}
							</Button>
							{accounts.map((account) => (
								<Button
									key={account.id}
									size="sm"
									variant="subtle"
									label={pr.errors[account.id] ?? account.label}
									pressed={pr.account === account.id}
									onClick={() => pr.setAccount(account.id)}
									icon={<Avatar accountId={account.id} login={account.login} url={account.avatarUrl} size={14} />}
									className="plume-pr-account-tab"
								>
									<Text className="plume-pr-truncate">{account.label}</Text>
									{(pr.errors[account.id] || account.lastError) && <span className="plume-pr-unseen plume-pr-failure-dot" />}
								</Button>
							))}
						</Sideways>
					)}
					<div className="plume-pr-search">
						<SearchField value={pr.query} onChange={pr.setQuery} placeholder={text.search} size="comfortable" />
					</div>
					<Scroller className="plume-pr-grow" contentClassName="plume-pr-list-body">
						{(pr.error || pr.accountError) && (
							<Text as="p" size="detail" tone="danger" role="alert" className="plume-pr-notice">
								{pr.error ?? pr.accountError}
							</Text>
						)}
						{accounts.length < 2 &&
							!pr.error &&
							accounts.map((account) =>
								pr.errors[account.id] || account.lastError ? (
									<Text key={account.id} as="p" size="detail" tone="danger" role="alert" className="plume-pr-notice">
										{pr.errors[account.id] ?? account.lastError}
									</Text>
								) : null,
							)}
						{slow && <SkeletonList label={text.reading} />}
						{!pr.groups.length && !pr.loading && !pr.error && (
							<Text as="p" tone="faint" className="plume-pr-empty-message">
								{pr.query ? text.noMatch : (pr.errors[pr.account ?? ""] ?? (pr.account ? text.emptyAccount : text.empty))}
							</Text>
						)}
						{pr.groups.map((group) => {
							const open = Boolean(pr.query.trim()) || !folded.has(group.key);
							const unseen = group.items.filter((item) => pr.unseen.has(rowId(item))).length;
							return (
								<section key={group.key} className="plume-pr-group">
									<button type="button" className="plume-pr-group-head" aria-expanded={open} onClick={() => toggle(group.key)}>
										<Text size="detail" tone="faint">
											{labels[group.key]}
										</Text>
										<Caret open={open} from="right" size={11} />
										<div className="plume-pr-spacer" />
										{!open && unseen > 0 && (
											<Text size="caption" tone="accent" data-plume-tip={format(text.unseenFolded, { n: unseen })}>
												{unseen}
											</Text>
										)}
										<Text size="caption" numeric tone="faint">
											{group.items.length}
										</Text>
									</button>
									<Collapse open={open}>
										{group.items.map((item) => (
											<PullRequestRow
												key={rowId(item)}
												pr={item}
												active={sameRef(pr.selected, item)}
												unseen={pr.unseen.has(rowId(item))}
												touched={pr.touched.has(rowId(item))}
												time={relativeTime(item.updatedAt)}
												onSelect={pr.select}
											/>
										))}
									</Collapse>
								</section>
							);
						})}
					</Scroller>
				</>
			)}
		</div>
	);
}

const PullRequestRow = memo(function PullRequestRow({
	pr,
	active,
	unseen,
	touched,
	time,
	onSelect,
}: {
	pr: PullRequestSummary;
	active: boolean;
	unseen: boolean;
	touched: boolean;
	time: string;
	onSelect: (pr: PullRequestSummary) => void;
}) {
	const text = useMessages();
	const Icon = pr.state === "MERGED" ? GitMerge : pr.state === "CLOSED" ? GitPullRequestClosed : pr.isDraft ? GitPullRequestDraft : GitPullRequest;
	const state = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open";
	return (
		<button
			type="button"
			className="plume-pr-row plume-scroll"
			data-active={active}
			data-touched={touched}
			aria-current={active ? "true" : undefined}
			onClick={() => onSelect(pr)}
		>
			<span className="plume-pr-row-mark" data-plume-tip={text[state]}>
				<Icon size={14} strokeWidth={1.9} className={`plume-pr-state-${state}`} />
				{pr.checkState && <span className="plume-pr-check-dot" data-state={pr.checkState} />}
			</span>
			<span className="plume-pr-row-copy">
				<span className="plume-pr-row-line">
					<Text className="plume-pr-grow">
						<ScrollText text={pr.title} />
					</Text>
					{unseen && <span className="plume-pr-unseen" data-plume-tip={text.unseen} />}
					<Text size="caption" tone="faint" numeric className="plume-pr-nowrap">
						{time}
					</Text>
				</span>
				<span className="plume-pr-row-line">
					<Avatar accountId={pr.accountId} login={pr.author} url={pr.avatarUrl} size={13} />
					<Text size="detail" tone="faint" className="plume-pr-repo">
						{pr.repo}
					</Text>
					<Text size="caption" mono tone="faint" className="plume-pr-truncate plume-pr-grow">
						{pr.headRefName}
					</Text>
					{pr.reviewDecision === "APPROVED" && <Check size={11} className="plume-pr-ok" data-plume-tip={text.approved} />}
					{pr.reviewDecision === "CHANGES_REQUESTED" && <TriangleAlert size={11} className="plume-pr-danger" data-plume-tip={text.changesRequested} />}
					<DiffStat added={pr.additions} removed={pr.deletions} />
				</span>
			</span>
		</button>
	);
});
export function DiffStat({ added, removed }: { added: number | null; removed: number | null }) {
	const text = useMessages();
	return added === null && removed === null ? null : (
		<Text size="caption" numeric mono className="plume-pr-nowrap" data-plume-tip={text.lineCount}>
			<span className="plume-pr-ok">+{added ?? 0}</span> <span className="plume-pr-danger">−{removed ?? 0}</span>
		</Text>
	);
}
