import { useEffect, useState } from "react";
import { Button, Caret, Collapse, Scroller, ScrollText, SkeletonList, Text, lookFor, useSlowLoad } from "@plume/ui";
import type { WorkspaceDiffFile } from "../api";
import { format } from "../messages";
import { useMessages, useServices } from "./context";
import type { PrRef } from "./model";
import { DiffStat } from "./PullRequestList";

export function PullRequestCode({ target }: { target: PrRef }) {
	const { api } = useServices();
	const text = useMessages();
	const [files, setFiles] = useState<WorkspaceDiffFile[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [reload, setReload] = useState(0);
	const [open, setOpen] = useState<Set<string>>(new Set());
	const slow = useSlowLoad(!files && !error);
	useEffect(() => {
		let cancelled = false;
		setError(null);
		const call = api.pullRequestDiff(target.accountId, target.repo, target.number);
		void (async () => {
			try {
				const result = await call;
				if (!cancelled) {
					setFiles(result.files);
					setError(result.error ?? null);
				}
			} catch (failure) {
				if (!cancelled) setError(String(failure));
			}
		})();
		return () => {
			cancelled = true;
			call.cancel();
		};
	}, [api, target.accountId, target.repo, target.number, reload]);
	const toggle = (path: string) =>
		setOpen((previous) => {
			const next = new Set(previous);
			if (!next.delete(path)) next.add(path);
			return next;
		});
	if (error)
		return (
			<div className="plume-pr-empty">
				<Text tone="danger" role="alert">
					{error}
				</Text>
				<Button onClick={() => setReload((value) => value + 1)}>{text.reload}</Button>
			</div>
		);
	if (!files)
		return slow ? (
			<div className="plume-pr-summary">
				<SkeletonList label={text.reading} />
			</div>
		) : (
			<div className="plume-pr-grow" />
		);
	if (!files.length)
		return (
			<div className="plume-pr-empty">
				<Text tone="faint">{text.noFiles}</Text>
			</div>
		);
	return (
		<div className="plume-pr-column">
			<div className="plume-pr-code-count">
				<Text size="detail" tone="faint">
					{format(text.files, { n: files.length })}
				</Text>
				<DiffStat added={files.reduce((sum, file) => sum + file.added, 0)} removed={files.reduce((sum, file) => sum + file.removed, 0)} />
				<div className="plume-pr-spacer" />
				<Button size="xs" variant="subtle" onClick={() => setOpen(open.size ? new Set() : new Set(files.map((file) => file.path)))}>
					{open.size ? text.collapseAll : text.expandAll}
				</Button>
			</div>
			<Scroller className="plume-pr-grow" contentClassName="plume-pr-code-body plume-pr-fade">
				{files.map((file) => (
					<FileDiff key={file.path} file={file} open={open.has(file.path)} onToggle={() => toggle(file.path)} />
				))}
			</Scroller>
		</div>
	);
}
function FileDiff({ file, open, onToggle }: { file: WorkspaceDiffFile; open: boolean; onToggle: () => void }) {
	const { ui } = useServices();
	const text = useMessages();
	const { Icon } = lookFor(file.path.split("/").pop() ?? file.path, false);
	return (
		<section className="plume-pr-file">
			<div className="plume-pr-file-pin">
				<button type="button" className="plume-pr-file-head plume-scroll" aria-expanded={open} data-plume-tip={file.path} onClick={onToggle}>
					<Caret open={open} from="right" size={11} />
					<Icon size={13} />
					<Text size="detail" tone="muted" className="plume-pr-grow">
						<ScrollText text={file.path} />
					</Text>
					<Text size="caption" tone="faint">
						{file.status === "added" ? "A" : file.status === "deleted" ? "D" : file.status === "renamed" ? "R" : "M"}
					</Text>
					<DiffStat added={file.added} removed={file.removed} />
				</button>
			</div>
			<Collapse open={open} bodyClassName="plume-pr-file-diff">
				{file.binary ? (
					<Text as="p" size="detail" tone="faint" className="plume-pr-empty-message">
						{text.binary}
						{file.bytes === undefined ? "" : ` · ${file.bytes} B`}
					</Text>
				) : !file.hunks.length ? (
					<Text as="p" size="detail" tone="faint" className="plume-pr-empty-message">
						{text.noPatch}
					</Text>
				) : (
					<ui.FileDiff path={file.path} hunks={file.hunks} maxLines={4000} />
				)}
			</Collapse>
		</section>
	);
}
