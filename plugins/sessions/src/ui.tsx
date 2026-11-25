/**
 * plume.sessions 的界面入口：三件工具在转录里的说法，和 `send_message` 那一行上的回执。
 *
 * 和别的会话往来只是这段活里交代一句，归成一类（`group`），和读文件、跑命令接成一段，不单独一行把活切成好几截；
 * `send_message` 的卡片只是补上回执（`inline`），那一行照样并进去。
 *
 * 回执从对方的记录里认：里面有这封信（`peer` 上的 id）是已送达；读到它以后，对方又给这边发了消息（它记录里一次成功的 `send_message`）
 * 是已回复——两边的信擦肩而过、它读到这封之前寄出的那封不算。对方每轮交回这边的（这边开出它、要了交回），答案随交回送到、不回寄：
 * 它读到这封并结束一轮以后，这边的记录里收到它交回的那一行（`delivery` 上的 `sessionId`），也是已回复。逻辑入口记着它没送到（钩子拦下、对方删掉）是未送达；寄出时就知道叫不醒对方
 * （`held`）的是等对方开口；别的都是排队中——对方在忙、还没读到，或者应用重启前寄出、没了下落。
 */

import type { ToolCardProps, UiContext, UiPlugin, Remote } from "@plume/contract/ui";
import { Collapse, FlowRow, IconButton, Text, useI18n } from "@plume/ui";
import { ArrowUpRight, MessagesSquare, ScrollText, Send } from "@plume/ui/icons";
import { useEffect, useMemo, useState } from "react";
import type { SessionsApi } from "./api.ts";
import { MESSAGES } from "./messages.ts";
import { hasReportedReply } from "./peers.ts";
import css from "./ui.css";

let ui: UiContext;
let api: Remote<SessionsApi>;

function mountStyles(): () => void {
	const id = "plume.sessions";
	let style = document.querySelector<HTMLStyleElement>(`style[data-plugin-style="${id}"]`);
	if (!style) {
		style = document.createElement("style");
		style.dataset.pluginStyle = id;
		document.head.append(style);
	}
	style.textContent = css;
	return () => style?.remove();
}

/** 地址里的名字：`修登录 [a1b2c3]` 说成「修登录」，ref 是给模型认人的；只写了 ref 或 id 就说它。 */
function peerName(to: unknown): string | undefined {
	if (typeof to !== "string" || to.trim() === "") return undefined;
	const address = to.trim();
	return address.replace(/\s*\[[0-9a-f]{6,12}\]$/i, "") || address;
}

interface SentDetails {
	kind: "session_message";
	to: string;
	sessionId: string;
	letterId: string;
	held?: boolean;
}

function isSent(value: unknown): value is SentDetails {
	const one = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
	return one?.kind === "session_message" && typeof one.sessionId === "string" && typeof one.letterId === "string" && typeof one.to === "string";
}

type Receipt = "queued" | "held" | "delivered" | "replied" | "dropped" | "closed";

function useReceipt(sessionId: string, sent: SentDetails): Receipt {
	const target = ui.useSession(sent.sessionId)?.messages;
	/** 这封信在对方记录里的位置；还没读到是 -1。 */
	const at = useMemo(
		() => target?.findIndex((message) => message.role === "user" && message.peer?.some((letter) => letter.id === sent.letterId)) ?? -1,
		[target, sent.letterId],
	);
	const delivered = at >= 0;
	const replied = useMemo(
		() =>
			delivered &&
			target!
				.slice(at + 1)
				.some((message) => message.role === "toolResult" && !message.isError && isSent(message.details) && message.details.sessionId === sessionId),
		[target, at, delivered, sessionId],
	);
	const own = ui.useSession(sessionId)?.messages;
	const reported = useMemo(() => {
		if (!delivered || !own) return false;
		const mine = own.findIndex((message) => message.role === "toolResult" && isSent(message.details) && message.details.letterId === sent.letterId);
		return hasReportedReply(own, target, at, mine, sent.sessionId);
	}, [own, target, at, delivered, sent.letterId, sent.sessionId]);
	const [fate, setFate] = useState<string>();
	// 对方的记录变了（读到了、被拦下了）再问一次下落；已经认出送达就不用问。
	const seen = target?.length ?? 0;
	useEffect(() => {
		if (delivered) return;
		let live = true;
		void api.fates([sent.letterId]).then(
			(found) => live && setFate(found[sent.letterId]),
			() => {},
		);
		return () => {
			live = false;
		};
	}, [delivered, seen, sent.letterId]);
	if (replied || reported) return "replied";
	if (delivered || fate === "read") return "delivered";
	if (fate === "dropped" || fate === "closed") return fate;
	return sent.held ? "held" : "queued";
}

function SentRow({ sessionId, call, sent }: { sessionId: string; call: ToolCardProps["call"]; sent: SentDetails }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const [open, setOpen] = useState(false);
	const receipt = useReceipt(sessionId, sent);
	const label = receipt === "dropped" || receipt === "closed" ? text.undelivered : text[receipt];
	const why = receipt === "dropped" ? text.undeliveredDropped : receipt === "closed" ? text.undeliveredClosed : undefined;
	const hint = why ?? (receipt === "held" ? text.heldHint : undefined);
	const message = typeof call.args.message === "string" ? call.args.message.trim() : "";
	const jump = () => void ui.openSession(sent.sessionId).catch(() => ui.notify(text.sessionGone, "warn"));
	return (
		<div data-peer-message={sent.letterId} data-peer-receipt={receipt}>
			<div className="plume-sessions-head">
				<FlowRow
					icon={<Send size={13} strokeWidth={1.8} />}
					title={text.sendMessage}
					summary={peerName(sent.to)}
					trailing={
						<Text size="caption" tone={why ? "danger" : "faint"} title={hint}>
							{label}
						</Text>
					}
					open={message ? open : undefined}
					onToggle={message ? () => setOpen((value) => !value) : undefined}
					label={text.sentMessage}
				/>
				<IconButton size="xs" icon={<ArrowUpRight size={12} strokeWidth={1.8} />} label={text.openSession} onClick={jump} data-peer-open="" />
			</div>
			{message && (
				<Collapse open={open} bodyClassName="plume-sessions-body">
					<Text as="div" size="label" tone="muted">
						<ui.Markdown text={message} sessionId={sessionId} className="plume-sessions-text" />
					</Text>
				</Collapse>
			)}
		</div>
	);
}

/** 寄出去了才有回执；还在写、被退回的照通用的那一行画。 */
function SendCard({ sessionId, call, status, result, fallback }: ToolCardProps) {
	const details = status === "done" && !result?.isError ? result?.details : undefined;
	return isSent(details) ? <SentRow sessionId={sessionId} call={call} sent={details} /> : <>{fallback}</>;
}

export default {
	name: "plume.sessions",
	apply(context) {
		ui = context;
		api = context.remote<SessionsApi>();
		context.effect(mountStyles());
		context.toolLine("list_sessions", { verb: (locale) => MESSAGES[locale].listSessions, group: "peer", icon: MessagesSquare });
		context.toolLine("read_session", {
			verb: (locale) => MESSAGES[locale].readSession,
			subject: (args) => peerName(args.to),
			group: "peer",
			icon: ScrollText,
		});
		context.toolLine("send_message", { verb: (locale) => MESSAGES[locale].sendMessage, subject: (args) => peerName(args.to), group: "peer", icon: Send });
		context.toolCard("send_message", SendCard, { inline: true });
	},
} satisfies UiPlugin;
