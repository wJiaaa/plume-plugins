/**
 * `ssh_run` 等人批准的卡（`ui.requestCard`）和工具卡片。
 *
 * 卡上写明在哪台机器（名字、账号地址、指纹）、为什么、超时多久，命令放在能改的框里：点「运行」把框里那条经 `answer`
 * 交回（改过的就是改过的那条），逻辑入口再核一遍、照实告诉模型命令被改过；点「拒绝」是 `decline`。只有这两个，
 * 没有「以后不再问」：在别人的服务器上跑什么，一条一条由人决定。
 */

import type { RequestCardProps, ToolCardProps } from "@plume/contract/ui";
import { ApprovalFrame, Button, Card, CodeBlock, Text, TextArea, useI18n } from "@plume/ui";
import { Play, Server, X } from "@plume/ui/icons";
import { useEffect, useRef, useState } from "react";
import type { RunAnswer, RunDetails, RunRequest } from "./api.ts";
import { errorText } from "./client.ts";
import { MESSAGES } from "./messages.ts";

function readRequest(payload: unknown): RunRequest | null {
	if (!payload || typeof payload !== "object") return null;
	const value = payload as Partial<RunRequest>;
	const strings = [value.connection, value.label, value.target, value.fingerprint, value.reason, value.command];
	if (strings.some((field) => typeof field !== "string") || typeof value.timeoutSeconds !== "number") return null;
	return value as RunRequest;
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

export function RunRequestCard({ request, queued, from, answer, decline, fallback }: RequestCardProps) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const run = readRequest(request.payload);
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
			<RunForm key={request.toolCallId} run={run} from={from} answer={answer} decline={decline} />
		</ApprovalFrame>
	);
}

function RunForm({
	run,
	from,
	answer: give,
	decline,
}: {
	run: RunRequest;
	from: string | undefined;
	answer: RequestCardProps["answer"];
	decline: RequestCardProps["decline"];
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

	const answer = async (decision: "run" | "reject") => {
		setPending(true);
		setError("");
		try {
			if (decision === "run") await give({ command } satisfies RunAnswer);
			else await decline();
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
				if (!pending && !empty) void answer("run");
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
