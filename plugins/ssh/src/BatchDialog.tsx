/**
 * 人工批量命令：勾选几条现在连着的连接，写一条命令，在每条上各跑一次。不经 Agent，命令和结果不进会话、不交给模型。
 *
 * 点「运行」先向逻辑入口要这几条连接现在的身份（账号、地址、指纹），在确认框里连同完整命令给人核对；人确认的那份交回去，
 * 逻辑入口和现在的比，对不上就不发。结果只留最近一次，在这里看、可以停下还没轮到的。
 */

import type { Remote, UiContext } from "@plume/contract/ui";
import { Button, ChoiceMark, CodeBlock, Confirm, Dialog, Disclosure, NumberField, Text, TextArea, useI18n } from "@plume/ui";
import { CircleStop, Play, SquareTerminal, TriangleAlert } from "@plume/ui/icons";
import { useState } from "react";
import type { BatchResult, BatchRun, BatchTarget, SshApi } from "./api.ts";
import { errorText, type SshClient, useSshState } from "./client.ts";
import { address } from "./format.ts";
import { type Messages, MESSAGES } from "./messages.ts";

const MAX_TARGETS = 32;

function resultText(text: Messages, result: BatchResult): string {
	const base = {
		queued: text.batchQueued,
		running: text.batchRunning,
		succeeded: text.batchSucceeded,
		failed: result.code === null ? text.batchFailed : text.runExit(result.code),
		unknown: text.batchUnknown,
		blocked: text.batchBlocked,
		cancelled: text.batchCancelled,
	}[result.status];
	const note =
		result.note &&
		{
			identity: text.noteIdentity,
			disconnected: text.noteDisconnected,
			notDispatched: text.noteNotDispatched,
			unknown: text.noteUnknown,
			outputLimit: text.noteOutputLimit,
		}[result.note];
	return note ? `${base} · ${note}` : base;
}

export function BatchDialog({ ui, api, client, onClose }: { ui: Pick<UiContext, "notify">; api: Remote<SshApi>; client: SshClient; onClose(): void }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const state = useSshState(client);
	const batch = state?.batch ?? null;
	const [view, setView] = useState<"compose" | "results">(batch && batch.status !== "completed" && batch.status !== "cancelled" ? "results" : "compose");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [command, setCommand] = useState("");
	const [concurrency, setConcurrency] = useState(4);
	const [timeoutSeconds, setTimeoutSeconds] = useState(30);
	const [confirming, setConfirming] = useState<BatchTarget[] | null>(null);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState("");

	const live = (state?.connections ?? []).filter((entry) => entry.state === "connected");
	const chosen = [...selected].filter((id) => live.some((entry) => entry.id === id));
	const running = batch?.status === "running" || batch?.status === "stopping";
	const canRun = chosen.length > 0 && chosen.length <= MAX_TARGETS && command.trim().length > 0 && !running && !busy;

	const review = async () => {
		setBusy(true);
		setFailure("");
		try {
			setConfirming(await api.batchTargets(chosen));
		} catch (cause) {
			setFailure(errorText(cause));
		} finally {
			setBusy(false);
		}
	};
	const start = async (targets: BatchTarget[]) => {
		setBusy(true);
		setFailure("");
		try {
			await api.startBatch({ connections: targets.map((target) => target.connection), command, concurrency, timeoutSeconds }, targets);
			setView("results");
		} catch (cause) {
			setFailure(errorText(cause));
		} finally {
			setBusy(false);
		}
	};
	const toggle = (id: string) =>
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else if (next.size < MAX_TARGETS) next.add(id);
			return next;
		});

	// 同一台机器（地址、端口、账号）开了两个标签都勾上时，命令会在上面跑两次：确认框里说一句。
	const duplicates = confirming ? confirming.length - new Set(confirming.map((target) => address(target).toLowerCase())).size : 0;

	return (
		<Dialog
			onClose={onClose}
			width={680}
			label={text.batchTitle}
			title={text.batchTitle}
			icon={<SquareTerminal size={16} />}
			detail={text.batchDetail}
			status={
				failure ? (
					<Text as="p" size="detail" tone="danger" role="alert">
						{failure}
					</Text>
				) : undefined
			}
			actions={(dismiss) =>
				view === "results" ? (
					<>
						{batch && running && (
							<Button
								variant="danger"
								icon={<CircleStop size={14} />}
								disabled={batch.status === "stopping"}
								onClick={() => void api.stopBatch(batch.id).catch((cause: unknown) => ui.notify(errorText(cause), "error"))}
							>
								{text.stop}
							</Button>
						)}
						<span className="ssh-spacer" />
						<Button disabled={running} onClick={() => setView("compose")}>
							{text.batchAgain}
						</Button>
						<Button variant="primary" onClick={() => dismiss()}>
							{text.done}
						</Button>
					</>
				) : (
					<>
						{batch && (
							<Button variant="subtle" onClick={() => setView("results")}>
								{text.batchLast}
							</Button>
						)}
						<span className="ssh-spacer" />
						<Button onClick={() => dismiss()}>{text.cancel}</Button>
						<Button variant="primary" icon={<Play size={14} />} disabled={!canRun} loading={busy} onClick={() => void review()} data-ssh-batch-run="">
							{text.batchRunOn(chosen.length)}
						</Button>
					</>
				)
			}
		>
			{view === "results" && batch ? (
				<BatchResults batch={batch} text={text} />
			) : (
				<div className="ssh-form">
					<div className={"ssh-batch-targets"} role="group" aria-label={text.batchTargets}>
						<Text as="div" size="detail" tone="muted">
							{text.batchPick(chosen.length, MAX_TARGETS)}
						</Text>
						{live.length === 0 ? (
							<Text as="p" size="detail" tone="faint">
								{text.batchNoConnections}
							</Text>
						) : (
							live.map((entry) => (
								<button
									key={entry.id}
									type="button"
									className="plume-item ssh-batch-target"
									aria-pressed={selected.has(entry.id)}
									onClick={() => toggle(entry.id)}
								>
									<ChoiceMark kind="checkbox" checked={selected.has(entry.id)} />
									<Text className="ssh-ellipsis">{entry.label}</Text>
									<Text size="detail" tone="faint" mono className="ssh-ellipsis">
										{address(entry)}
									</Text>
								</button>
							))
						)}
					</div>
					<TextArea
						value={command}
						onChange={setCommand}
						aria-label={text.runCommand}
						placeholder={text.batchPlaceholder}
						spellCheck={false}
						shell="ssh-batch-command"
						className="ssh-mono"
					/>
					<div className="ssh-form-pair">
						<label className="ssh-monitor">
							<Text size="detail" tone="muted">
								{text.batchConcurrency}
							</Text>
							<NumberField value={concurrency} onChange={setConcurrency} min={1} max={8} label={text.batchConcurrency} />
						</label>
						<label className="ssh-monitor">
							<Text size="detail" tone="muted">
								{text.batchTimeout}
							</Text>
							<NumberField value={timeoutSeconds} onChange={setTimeoutSeconds} min={1} max={120} label={text.batchTimeout} />
						</label>
					</div>
					<Text as="p" size="caption" tone="faint">
						{text.batchNote}
					</Text>
				</div>
			)}
			{confirming && (
				<Confirm
					title={text.batchConfirmTitle(confirming.length)}
					detail={text.batchConfirmDetail}
					confirmLabel={text.batchConfirm}
					tone="normal"
					onCancel={() => setConfirming(null)}
					onConfirm={() => {
						const targets = confirming;
						setConfirming(null);
						void start(targets);
					}}
				>
					<div className="ssh-confirm" data-ssh-batch-confirm="">
						{duplicates > 0 && (
							<Text as="p" size="detail" tone="danger" className="ssh-confirm-warn">
								<TriangleAlert size={13} /> {text.batchDuplicates}
							</Text>
						)}
						<div className="ssh-confirm-targets">
							{confirming.map((target) => (
								<div key={target.connection} className="ssh-confirm-target">
									<Text size="detail" weight="medium" className="ssh-ellipsis">
										{target.label}
									</Text>
									<Text size="detail" mono tone="muted" className="ssh-ellipsis">
										{address(target)}
									</Text>
									<Text size="caption" mono tone="faint" className="ssh-break">
										{target.fingerprint}
									</Text>
								</div>
							))}
						</div>
						<CodeBlock>{command}</CodeBlock>
					</div>
				</Confirm>
			)}
		</Dialog>
	);
}

function BatchResults({ batch, text }: { batch: BatchRun; text: Messages }) {
	const done = batch.targets.filter((target) => !["queued", "running"].includes(target.status)).length;
	return (
		<div className="ssh-form" data-ssh-batch-results={batch.status}>
			<CodeBlock>{batch.command}</CodeBlock>
			<Text as="p" size="detail" tone="muted" numeric>
				{text.batchProgress(done, batch.targets.length, batch.status)}
			</Text>
			<div className="ssh-batch-results">
				{batch.targets.map((result) => {
					const hasOutput = Boolean(result.stdout || result.stderr);
					const head = (
						<span className="ssh-batch-result-head">
							<span
								className="ssh-dot"
								data-state={result.status === "succeeded" ? "connected" : result.status === "running" || result.status === "queued" ? "connecting" : "closed"}
							/>
							<Text weight="medium" className="ssh-ellipsis">
								{result.label}
							</Text>
							<Text size="detail" mono tone="faint" className="ssh-ellipsis ssh-grow">
								{address(result)}
							</Text>
							<Text size="caption" tone={result.status === "failed" || result.status === "blocked" ? "danger" : "muted"}>
								{resultText(text, result)}
							</Text>
						</span>
					);
					return (
						<div key={result.connection} className="ssh-batch-result" data-status={result.status}>
							{hasOutput ? (
								<Disclosure title={head} variant="compact">
									<div className="ssh-batch-output">
										{result.stdout && <CodeBlock>{result.stdout}</CodeBlock>}
										{result.stderr && (
											<>
												<Text as="p" size="caption" tone="faint">
													{text.stderr}
												</Text>
												<CodeBlock>{result.stderr}</CodeBlock>
											</>
										)}
										{result.truncated && (
											<Text as="p" size="caption" tone="faint">
												{text.truncated}
											</Text>
										)}
									</div>
								</Disclosure>
							) : (
								head
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}
