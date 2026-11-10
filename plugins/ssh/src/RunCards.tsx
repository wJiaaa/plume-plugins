/**
 * `ssh_run` 的审批卡和工具卡片。
 *
 * 审批卡写明在哪台机器（名字、账号地址、指纹）、为什么、超时多久，命令放在能改的框里：人改过再点「运行修改后的命令」，
 * 改过的那条先经 `editRun` 交给逻辑入口，再 `respond("once")`；逻辑入口照实告诉模型命令被改过。只有「拒绝」和「运行」，
 * 没有「以后不再问」：在别人的服务器上跑什么，一条一条由人决定。
 */

import type { ApprovalCardProps, Remote, ToolCardProps } from "@plume/contract/ui";
import { ApprovalFrame, Button, Card, CodeBlock, Text, TextArea, useI18n } from "@plume/ui";
import { Play, Server, X } from "@plume/ui/icons";
import { useEffect, useRef, useState } from "react";
import type { RunDetails, RunRequest, SshApi } from "./api.ts";
import { errorText } from "./client.ts";
import { MESSAGES } from "./messages.ts";

function readRequest(detail: string): RunRequest | null {
	try {
		const value = JSON.parse(detail) as Partial<RunRequest> | null;
		if (!value || typeof value !== "object") return null;
		const strings = [value.connection, value.label, value.target, value.fingerprint, value.reason, value.command];
		if (strings.some((field) => typeof field !== "string") || typeof value.timeoutSeconds !== "number") return null;
		return value as RunRequest;
	} catch {
		return null;
	}
}

function readDetails(value: unknown): RunDetails | null {
	if (!value || typeof value !== "object") return null;
	const details = value as Partial<RunDetails>;
	if (details.kind !== "ssh_run") return null;
	const strings = [details.label, details.target, details.command, details.reason, details.stdout, details.stderr];
	if (strings.some((field) => typeof field !== "string")) return null;
	if (!["rejected", "succeeded", "failed", "unknown", "blocked"].includes(details.status as string)) return null;
	return details as RunDetails;
}

export function runApproval(api: Remote<SshApi>) {
	return function RunApproval({ request, queued, from, respond, fallback }: ApprovalCardProps) {
		const text = MESSAGES[useI18n().resolvedLocale];
		const run = readRequest(request.detail);
		if (!run) return <>{fallback}</>;
		return (
			<ApprovalFrame
				requestId={request.toolCallId}
				icon={<Server size={15} strokeWidth={1.8} />}
				title={request.title}
				kind={text.runKind}
				expiresAt={request.expiresAt}
				queued={queued}
			>
				<RunForm key={request.toolCallId} run={run} from={from} toolCallId={request.toolCallId} api={api} respond={respond} />
			</ApprovalFrame>
		);
	};
}

function RunForm({
	run,
	from,
	toolCallId,
	api,
	respond,
}: {
	run: RunRequest;
	from: string | undefined;
	toolCallId: string;
	api: Remote<SshApi>;
	respond: ApprovalCardProps["respond"];
}) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const [command, setCommand] = useState(run.command);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const form = useRef<HTMLFormElement>(null);
	const edited = command !== run.command;
	const empty = !command.trim();

	// 卡片一出来把焦点给它：键盘能直接答（Tab 到按钮），也不会误把字敲进输入框。
	useEffect(() => form.current?.focus(), []);

	const answer = async (decision: "once" | "reject") => {
		setPending(true);
		setError("");
		try {
			if (decision === "once" && edited) await api.editRun(toolCallId, command);
			await respond(decision);
		} catch (cause) {
			setError(errorText(cause));
			setPending(false);
		}
	};

	return (
		<form
			ref={form}
			tabIndex={-1}
			className="ssh-run"
			data-ssh-run=""
			onSubmit={(event) => {
				event.preventDefault();
				if (!pending && !empty) void answer("once");
			}}
		>
			{from !== undefined && (
				<Text as="p" size="caption" tone="faint">
					{text.runFrom(from || text.untitled)}
				</Text>
			)}
			<div className="ssh-run-facts">
				<Text as="div" size="detail" tone="faint">
					{text.runTarget}
				</Text>
				<Text as="div" size="detail" className="ssh-break">
					{run.label} · <Text mono>{run.target}</Text>
				</Text>
				<Text as="div" size="detail" tone="faint">
					{text.hostKeyFingerprint}
				</Text>
				<Text as="div" size="detail" mono tone="muted" className="ssh-break">
					{run.fingerprint}
				</Text>
				<Text as="div" size="detail" tone="faint">
					{text.runTimeout}
				</Text>
				<Text as="div" size="detail" numeric>
					{text.seconds(run.timeoutSeconds)}
				</Text>
			</div>
			{run.reason && (
				<Text as="p" size="body" className="ssh-break">
					{run.reason}
				</Text>
			)}
			<TextArea
				value={command}
				onChange={setCommand}
				aria-label={text.runCommand}
				spellCheck={false}
				disabled={pending}
				shell="ssh-run-command"
				className="ssh-mono"
				resizable
				data-ssh-run-command=""
				onKeyDown={(event) => {
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
						event.preventDefault();
						form.current?.requestSubmit();
					}
				}}
			/>
			<Text as="p" size="caption" tone="faint">
				{edited ? text.runEditedNote : text.runNote}
			</Text>
			{error && (
				<Text as="p" size="detail" tone="danger" role="alert">
					{error}
				</Text>
			)}
			<div className="ssh-actions">
				<Button variant="subtle" icon={<X size={14} />} disabled={pending} onClick={() => void answer("reject")} data-ssh-run-reject="">
					{text.reject}
				</Button>
				<Button type="submit" variant="primary" icon={<Play size={14} />} disabled={pending || empty} data-ssh-run-accept="">
					{edited ? text.runEdited : text.run}
				</Button>
			</div>
		</form>
	);
}

export function RunCard({ status, result, fallback }: ToolCardProps) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const details = readDetails(result?.details);
	if (!details) return <>{fallback}</>;
	const label = {
		rejected: text.runRejected,
		succeeded: text.runSucceeded(details.exitCode ?? 0),
		failed: details.exitCode === null ? text.runFailed : text.runExit(details.exitCode),
		unknown: text.runUnknown,
		blocked: text.runBlocked,
	}[details.status];
	return (
		<Card
			title={details.label}
			subtitle={details.edited ? `${details.target} · ${text.runEditedMark}` : details.target}
			status={label}
			tone={details.status === "succeeded" || details.status === "rejected" ? "default" : details.status === "unknown" ? "warning" : "error"}
		>
			<div className="ssh-run-result" data-ssh-run-status={details.status}>
				<CodeBlock>{details.command}</CodeBlock>
				{details.stdout && <CodeBlock>{details.stdout}</CodeBlock>}
				{details.stderr && (
					<>
						<Text as="p" size="caption" tone="faint">
							{text.stderr}
						</Text>
						<CodeBlock>{details.stderr}</CodeBlock>
					</>
				)}
				{details.truncated && (
					<Text as="p" size="caption" tone="faint">
						{text.truncated}
					</Text>
				)}
				{status === "done" && !details.stdout && !details.stderr && details.status === "succeeded" && (
					<Text as="p" size="caption" tone="faint">
						{text.noOutput}
					</Text>
				)}
			</div>
		</Card>
	);
}
