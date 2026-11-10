import { useEffect, useState, type ReactNode } from "react";
import { ActionSpinner, Button, Disclosure, IconButton, PageTopRow, Scroller, ScrollText, SkeletonList, Text, relativeTime, useSlowLoad } from "@plume/ui";
import {
	ArrowLeft,
	Bot,
	Check,
	Circle,
	CircleDashed,
	ExternalLink,
	GitBranch,
	GitCommitHorizontal,
	GitPullRequest,
	Maximize2,
	MessageSquare,
	Minimize2,
	RefreshCw,
	Users,
	X,
} from "@plume/ui/icons";
import type { PullRequestDetail } from "../api";
import type { Messages } from "../messages";
import { format } from "../messages";
import { Avatar } from "./avatars";
import { useMessages, useServices } from "./context";
import { activityOf, firstLine, rowId, type ActivityEntry, type PrRef } from "./model";
import { PullRequestCode } from "./PullRequestCode";

export function PullRequestDetailView({
	selected,
	detail,
	loading,
	error,
	onRefresh,
	expanded,
	onToggleExpanded,
	tab,
	onTab,
	narrow,
	onBack,
	onOpenChat,
	chatBusy,
}: {
	selected: PrRef | null;
	detail: PullRequestDetail | null;
	loading: boolean;
	error: string | null;
	onRefresh: () => void;
	expanded: boolean;
	onToggleExpanded: () => void;
	tab: "summary" | "code";
	onTab: (value: "summary" | "code") => void;
	narrow: boolean;
	onBack: () => void;
	onOpenChat: (detail: PullRequestDetail, intent: "ask" | "review") => void;
	chatBusy: boolean;
}) {
	const text = useMessages();
	const { ui } = useServices();
	const slow = useSlowLoad(loading && !detail);
	return (
		<div className="plume-pr-column">
			<PageTopRow start={narrow || expanded} className="plume-pr-head" data-plume-toprow="pr-detail">
				{narrow && <IconButton label={text.back} onClick={onBack} icon={<ArrowLeft size={14} />} />}
				{expanded && detail && (
					<Text className="plume-pr-header-title">
						<ScrollText text={detail.title} />
					</Text>
				)}
				<div className="plume-pr-controls">
					{(["summary", "code"] as const).map((key) => (
						<Button key={key} size="sm" variant="subtle" pressed={tab === key} onClick={() => onTab(key)}>
							{text[key]}
						</Button>
					))}
				</div>
				<div className="plume-pr-spacer" />
				<IconButton
					label={text.reload}
					disabled={!selected || loading}
					onClick={onRefresh}
					icon={loading ? <ActionSpinner size={13} /> : <RefreshCw size={13} />}
				/>
				<IconButton
					label={text.browser}
					disabled={!detail}
					onClick={() => {
						if (detail) void ui.openExternal(detail.url).catch((failure) => ui.notify(String(failure), "error"));
					}}
					icon={<ExternalLink size={13} />}
				/>
				<IconButton
					label={text.reviewAgent}
					disabled={!detail || chatBusy}
					onClick={() => {
						if (detail) onOpenChat(detail, "review");
					}}
					icon={chatBusy ? <ActionSpinner size={13} /> : <Bot size={13} />}
				/>
				{!narrow && (
					<IconButton
						label={expanded ? text.showList : text.fillWidth}
						onClick={onToggleExpanded}
						icon={expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
					/>
				)}
			</PageTopRow>
			{error && (
				<Text size="detail" tone="danger" as="p" role="alert" className="plume-pr-notice">
					{error}
				</Text>
			)}
			{!detail ? (
				slow ? (
					<div className="plume-pr-summary">
						<SkeletonList count={6} label={text.reading} />
					</div>
				) : (
					<div className="plume-pr-empty">
						<Text tone="faint">{loading ? "" : selected && error ? "" : text.pickOne}</Text>
					</div>
				)
			) : tab === "code" ? (
				<PullRequestCode key={rowId(detail)} target={detail} />
			) : (
				<Summary key={rowId(detail)} detail={detail} onAsk={() => onOpenChat(detail, "ask")} chatBusy={chatBusy} />
			)}
		</div>
	);
}

function Summary({ detail, onAsk, chatBusy }: { detail: PullRequestDetail; onAsk: () => void; chatBusy: boolean }) {
	const text = useMessages();
	const { ui } = useServices();
	const [open, setOpen] = useState({ body: true, checks: false, activity: false });
	const toggle = (key: keyof typeof open) => setOpen((previous) => ({ ...previous, [key]: !previous[key] }));
	const entries = activityOf(detail);
	useEffect(() => {
		if (detail.checks && detail.checks.failed > 0) setOpen((previous) => ({ ...previous, checks: true }));
	}, [detail.checks]);
	return (
		<Scroller className="plume-pr-grow" contentClassName="plume-pr-summary plume-pr-fade">
			<Text as="h1" size="heading" weight="semibold" className="plume-pr-summary-title">
				{detail.title}
			</Text>
			<div className="plume-pr-byline">
				<Avatar accountId={detail.accountId} login={detail.author} url={detail.avatarUrl} size={17} />
				<Text size="detail" tone="muted">
					{detail.author}
				</Text>
				<Text size="detail" tone="faint">
					·
				</Text>
				<Text size="detail" tone="faint">
					{relativeTime(detail.createdAt)}
				</Text>
				<Text size="detail" tone="faint" className="plume-pr-truncate">
					{detail.repo} #{detail.number}
				</Text>
			</div>
			<Meta detail={detail} />
			<div className="plume-pr-summary-sections">
				<Disclosure title={text.description} open={open.body} onToggle={() => toggle("body")}>
					{detail.body.trim() ? (
						<ui.Markdown text={detail.body} />
					) : (
						<Text as="p" tone="faint">
							{text.noDescription}
						</Text>
					)}
				</Disclosure>
				{detail.checks && (
					<Disclosure title={text.checks} count={detail.checks.total} open={open.checks} onToggle={() => toggle("checks")}>
						<Checks detail={detail} />
					</Disclosure>
				)}
				{entries.length > 0 && (
					<Disclosure
						title={text.activity}
						count={entries.length}
						open={open.activity}
						onToggle={() => toggle("activity")}
						trailing={
							<IconButton
								size="sm"
								label={text.allInBrowser}
								onClick={() => void ui.openExternal(detail.url).catch((error) => ui.notify(String(error), "error"))}
								icon={<ExternalLink size={12} />}
							/>
						}
					>
						<Activity accountId={detail.accountId} entries={entries} />
					</Disclosure>
				)}
			</div>
			<Button size="sm" variant="subtle" disabled={chatBusy} onClick={onAsk} icon={<MessageSquare size={13} />}>
				{text.askAgent}
			</Button>
		</Scroller>
	);
}

function verdictLabel(state: string, text: Messages): string {
	if (state === "APPROVED") return text.approved;
	if (state === "CHANGES_REQUESTED") return text.requestChanges;
	if (state === "REQUESTED") return text.requested;
	if (state === "DISMISSED") return text.dismissed;
	return text.commented;
}
function verdictClass(state: string) {
	return state === "APPROVED" ? "plume-pr-ok" : state === "CHANGES_REQUESTED" ? "plume-pr-danger" : "plume-pr-muted";
}
function Meta({ detail }: { detail: PullRequestDetail }) {
	const text = useMessages();
	const checks = detail.checks;
	const status =
		detail.state === "MERGED"
			? text.merged
			: detail.state === "CLOSED"
				? text.closed
				: detail.isDraft
					? text.draft
					: detail.mergeable === "CONFLICTING"
						? text.conflicted
						: text.reviewable;
	return (
		<dl className="plume-pr-meta">
			<MetaRow icon={<GitBranch size={13} />} label={text.branch}>
				<Text size="detail" mono>
					{detail.headRefName}
				</Text>
				<Text tone="faint">›</Text>
				<Text size="detail" mono tone="muted">
					{detail.baseRefName}
				</Text>
				{detail.additions !== null && detail.deletions !== null && (
					<Text size="detail" mono numeric>
						<span className="plume-pr-ok">+{detail.additions}</span> <span className="plume-pr-danger">−{detail.deletions}</span>
					</Text>
				)}
				{detail.changedFiles !== null && (
					<Text size="detail" tone="faint">
						{format(text.files, { n: detail.changedFiles })}
					</Text>
				)}
			</MetaRow>
			<MetaRow icon={<Users size={13} />} label={text.reviewers}>
				{!detail.reviewers.length ? (
					<Text size="detail" tone="faint">
						{text.noReviewers}
					</Text>
				) : (
					detail.reviewers.map((reviewer, index) => (
						<Text size="detail" key={`${reviewer.login}-${index}`} className="plume-pr-badge">
							{reviewer.login} <span className={verdictClass(reviewer.state)}>{verdictLabel(reviewer.state, text)}</span>
						</Text>
					))
				)}
			</MetaRow>
			<MetaRow icon={<MessageSquare size={13} />} label={text.comments}>
				<Text size="detail">{format(text.commentCount, { n: detail.comments })}</Text>
			</MetaRow>
			<MetaRow icon={<Circle size={13} />} label={text.checks}>
				<Text size="detail" className={checks?.failed ? "plume-pr-danger" : checks && !checks.pending ? "plume-pr-ok" : "plume-pr-muted"}>
					{!checks
						? text.noChecks
						: checks.failed
							? format(text.checksFailed, { failed: checks.failed, total: checks.total })
							: checks.pending
								? format(text.checksRunning, { running: checks.pending, total: checks.total })
								: format(text.checksPassed, { n: checks.total })}
				</Text>
			</MetaRow>
			<MetaRow icon={<GitPullRequest size={13} />} label={text.status}>
				<Text size="detail">{status}</Text>
				{detail.labels.map((label) => (
					<Text size="caption" tone="muted" key={label} className="plume-pr-badge">
						{label}
					</Text>
				))}
			</MetaRow>
		</dl>
	);
}
function MetaRow({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
	return (
		<div className="plume-pr-meta-row">
			<dt>
				<Text size="detail" tone="faint" className="plume-pr-meta-label">
					{icon}
					{label}
				</Text>
			</dt>
			<dd>{children}</dd>
		</div>
	);
}
function Checks({ detail }: { detail: PullRequestDetail }) {
	const text = useMessages();
	const { ui } = useServices();
	const rank = { fail: 0, pending: 1, pass: 2 };
	const checks = [...(detail.checks?.items ?? [])].sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
	if (!checks.length)
		return (
			<Text as="p" size="detail" tone="faint">
				{text.noCheckDetail}
			</Text>
		);
	return (
		<div>
			{checks.map((check, index) => {
				const Icon = check.state === "pass" ? Check : check.state === "fail" ? X : CircleDashed;
				return (
					<div className="plume-pr-check" key={`${check.name}-${index}`}>
						<Icon size={13} className={`plume-pr-check-${check.state}`} />
						<Text className="plume-pr-grow plume-pr-truncate">{check.name}</Text>
						{check.url && (
							<IconButton
								size="sm"
								className="plume-pr-check-link"
								label={format(text.viewCheck, { name: check.name })}
								onClick={() => void ui.openExternal(check.url!).catch((error) => ui.notify(String(error), "error"))}
								icon={<ExternalLink size={12} />}
							/>
						)}
						<Text size="detail" className={`plume-pr-check-${check.state}`}>
							{text[check.state === "pass" ? "passed" : check.state === "fail" ? "failed" : "pending"]}
						</Text>
					</div>
				);
			})}
		</div>
	);
}
function Activity({ accountId, entries }: { accountId: string; entries: ActivityEntry[] }) {
	const text = useMessages();
	const { ui } = useServices();
	const [open, setOpen] = useState<Record<string, boolean>>(() => {
		const prose = entries.filter((entry) => entry.kind === "review" || entry.kind === "comment");
		return prose.length === 1 ? { [prose[0]!.key]: true } : {};
	});
	return (
		<div className="plume-pr-activity">
			{entries.map((entry) => {
				if (entry.kind === "opened" || entry.kind === "commit") {
					const Icon = entry.kind === "opened" ? GitPullRequest : GitCommitHorizontal;
					return (
						<div className="plume-pr-event" key={entry.key}>
							<Icon size={13} className={entry.kind === "opened" ? "plume-pr-ok" : "plume-pr-muted"} />
							<Text tone="muted" className="plume-pr-grow plume-pr-truncate">
								{entry.kind === "opened" ? format(text.opened, { author: entry.author }) : entry.body}
							</Text>
							{entry.kind === "commit" && (
								<Text size="detail" tone="faint">
									{entry.author}
								</Text>
							)}
							{entry.sha && (
								<Text size="detail" mono tone="faint">
									{entry.sha}
								</Text>
							)}
							<Text size="detail" tone="faint" className="plume-pr-nowrap">
								{relativeTime(entry.at)}
							</Text>
						</div>
					);
				}
				return (
					<Disclosure
						key={entry.key}
						variant="framed"
						open={Boolean(open[entry.key]) && Boolean(entry.body.trim())}
						onToggle={() => {
							if (entry.body.trim()) setOpen((previous) => ({ ...previous, [entry.key]: !previous[entry.key] }));
						}}
						title={
							<span className="plume-pr-prose-heading">
								<Avatar accountId={accountId} login={entry.author} />
								<Text>{entry.author}</Text>
								{entry.state && (
									<Text size="detail" tone="faint">
										{verdictLabel(entry.state, text)}
									</Text>
								)}
								{!open[entry.key] && (
									<Text size="detail" tone="faint" className="plume-pr-grow plume-pr-truncate">
										{entry.body.trim() ? firstLine(entry.body) : text.noText}
									</Text>
								)}
								<Text size="detail" tone="faint" className="plume-pr-nowrap">
									{relativeTime(entry.at)}
								</Text>
							</span>
						}
					>
						<ui.Markdown text={entry.body} />
					</Disclosure>
				);
			})}
		</div>
	);
}
