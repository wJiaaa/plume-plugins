import { useState } from "react";
import { Button, Confirm, Text, TextArea } from "@plume/ui";
import { Check, Send, X } from "@plume/ui/icons";
import type { PullRequestDetail, ReviewVerdict } from "../api";
import { format } from "../messages";
import { useMessages, useServices, useStore } from "./context";
import { canSubmit, rowId } from "./model";

type Submission = { target: PullRequestDetail; verdict: ReviewVerdict; body: string; account: string };
export function ReviewBar({ target, onSubmitted }: { target: PullRequestDetail | null; onSubmitted: () => void }) {
	const text = useMessages();
	const { api, ui, store } = useServices();
	const { accounts, drafts, reviewErrors, reviewBusy: busy } = useStore();
	const [pending, setPending] = useState<Submission | null>(null);
	const id = target ? rowId(target) : "";
	const body = drafts[id] ?? "";
	const active = target && accounts.some((account) => account.id === target.accountId && account.enabled);
	const action = (verdict: ReviewVerdict) => (verdict === "approve" ? text.approve : verdict === "request-changes" ? text.requestChanges : text.comment);
	const prepare = (verdict: ReviewVerdict) => {
		if (!target || !active || store.getSnapshot().reviewBusy || !canSubmit(verdict, body)) return;
		setPending({ target, verdict, body, account: accounts.find((account) => account.id === target.accountId)?.label ?? target.accountId });
	};
	const submit = async (submission: Submission) => {
		const { target: frozen, verdict, body: frozenBody } = submission;
		const key = rowId(frozen);
		if (!store.startReview(key)) return;
		setPending(null);
		try {
			const result =
				verdict === "comment"
					? await api.commentOnPullRequest(frozen.accountId, frozen.repo, frozen.number, frozenBody)
					: await api.reviewPullRequest(frozen.accountId, frozen.repo, frozen.number, verdict, frozenBody);
			store.finishReview(key, frozenBody, result.error ?? null);
			if (result.error) return;
			ui.notify(text.submitted);
			onSubmitted();
		} catch (error) {
			store.finishReview(key, frozenBody, String(error));
		}
	};
	return (
		<div className="plume-pr-review">
			{reviewErrors[id] && (
				<Text as="p" size="detail" tone="danger" role="alert">
					{reviewErrors[id]}
				</Text>
			)}
			<TextArea
				value={body}
				onChange={(value) => store.setDraft(id, value)}
				disabled={!active || busy}
				placeholder={target ? text.placeholder : text.pickOne}
				aria-label={text.placeholder}
				shell="plume-pr-review-field"
				onKeyDown={(event) => {
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
						event.preventDefault();
						prepare("comment");
					}
				}}
			/>
			<div className="plume-pr-review-actions">
				<Button size="sm" variant="subtle" icon={<Check size={13} />} disabled={!active || busy} onClick={() => prepare("approve")}>
					{text.approve}
				</Button>
				<Button
					size="sm"
					variant="subtle"
					icon={<X size={13} />}
					label={text.requestTip}
					disabled={!active || busy || !body.trim()}
					onClick={() => prepare("request-changes")}
				>
					{text.requestChanges}
				</Button>
				<div className="plume-pr-spacer" />
				<Button size="sm" icon={<Send size={13} />} loading={busy} disabled={!active || !body.trim()} onClick={() => prepare("comment")}>
					{text.comment}
				</Button>
			</div>
			{pending && (
				<Confirm
					title={format(text.confirmReview, { action: action(pending.verdict), repo: pending.target.repo, number: pending.target.number })}
					detail={
						<div className="plume-pr-confirm-detail">
							<Text as="p" size="detail">
								{format(text.confirmDetail, { account: pending.account })}
							</Text>
							{pending.body && (
								<Text as="p" size="detail" className="plume-pr-confirm-body">
									{pending.body}
								</Text>
							)}
						</div>
					}
					confirmLabel={action(pending.verdict)}
					cancelLabel={text.cancel}
					tone={pending.verdict === "request-changes" ? "danger" : "normal"}
					onCancel={() => setPending(null)}
					onConfirm={() => void submit(pending)}
				/>
			)}
		</div>
	);
}
