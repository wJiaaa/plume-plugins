/**
 * plume.sessions 的界面入口：三件工具在转录里的说法，和 `send_message` 那一行上的回执。
 *
 * 和别的会话往来只是这段活里交代一句，归成一类（`group`），和读文件、跑命令接成一段，不单独一行把活切成好几截；
 * `send_message` 的卡片只是补上回执（`inline`），那一行照样并进去。
 *
 * 回执从记录里认：对方的记录里有这封信（`peer` 上的 id）是已送达；之后对方给这边发了消息是已回复；逻辑入口记着它没送到
 * （钩子拦下、对方删掉）是未送达；别的都是排队中——对方在忙、还没读到，或者应用重启前寄出、没了下落。
 */

import type { ToolCardProps, UiContext, UiPlugin, Remote } from "@plume/contract/ui";
import { FlowRow, Text, useI18n } from "@plume/ui";
import { ChevronRight, MessagesSquare, ScrollText, Send } from "@plume/ui/icons";
import { useEffect, useMemo, useState } from "react";
import type { SessionsApi } from "./api.ts";
import { MESSAGES } from "./messages.ts";

let ui: UiContext;
let api: Remote<SessionsApi>;

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
}

function isSent(value: unknown): value is SentDetails {
	const one = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
	return one?.kind === "session_message" && typeof one.sessionId === "string" && typeof one.letterId === "string" && typeof one.to === "string";
}

type Receipt = "queued" | "delivered" | "replied" | "dropped" | "closed";

function useReceipt(sessionId: string, callId: string, sent: SentDetails): Receipt {
	const own = ui.useSession(sessionId)?.messages;
	const target = ui.useSession(sent.sessionId)?.messages;
	const delivered = useMemo(
		() => target?.some((message) => message.role === "user" && message.peer?.some((letter) => letter.id === sent.letterId)) ?? false,
		[target, sent.letterId],
	);
	const replied = useMemo(() => {
		if (!own) return false;
		const at = own.findIndex((message) => message.role === "toolResult" && message.toolCallId === callId);
		return at >= 0 && own.slice(at + 1).some((message) => message.role === "user" && message.peer?.some((letter) => letter.sessionId === sent.sessionId));
	}, [own, callId, sent.sessionId]);
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
	if (replied) return "replied";
	if (delivered || fate === "read") return "delivered";
	if (fate === "dropped" || fate === "closed") return fate;
	return "queued";
}

function SentRow({ sessionId, call, sent }: { sessionId: string; call: ToolCardProps["call"]; sent: SentDetails }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const receipt = useReceipt(sessionId, call.id, sent);
	const label = receipt === "dropped" || receipt === "closed" ? text.undelivered : text[receipt];
	const why = receipt === "dropped" ? text.undeliveredDropped : receipt === "closed" ? text.undeliveredClosed : undefined;
	const message = typeof call.args.message === "string" ? call.args.message : "";
	return (
		<div data-peer-message={sent.letterId} data-peer-receipt={receipt}>
			<FlowRow
				icon={<Send size={13} strokeWidth={1.8} />}
				title={text.sendMessage}
				summary={peerName(sent.to)}
				trailing={
					<>
						<Text size="caption" tone={why ? "danger" : "faint"} title={why}>
							{label}
						</Text>
						<ChevronRight size={12} strokeWidth={2} aria-hidden />
					</>
				}
				onToggle={() => void ui.openSession(sent.sessionId)}
				label={message ? `${text.openSession} · ${message}` : text.openSession}
			/>
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
