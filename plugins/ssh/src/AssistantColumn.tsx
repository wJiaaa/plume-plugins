/**
 * 主机页右边固定的一列「AI 运维助手」：产品的对话视图（`ui.Conversation`）画运维助手现在这一段，输入框、审批卡都在这一列里。
 * 头上「新开一段」「历史」：说过的各段不进侧栏，只能在这里找回来。会话本身在逻辑入口（assistant.ts）。
 */

import type { OutgoingMessage } from "@plume/contract";
import type { Remote, SessionChoice, UiContext } from "@plume/contract/ui";
import {
	IconButton,
	MENU_MAX_HEIGHT,
	MenuBody,
	MenuItem,
	MenuLabel,
	MenuSeparator,
	PageTopRow,
	PanelEmpty,
	Popover,
	Text,
	TimeAgo,
	useConfirmer,
	usePopover,
} from "@plume/ui";
import { Check, History, Sparkles, SquarePen, Trash2 } from "@plume/ui/icons";
import { type MouseEvent, useState } from "react";
import type { AssistantSegment, SshApi } from "./api.ts";
import { errorText } from "./client.ts";
import { type Messages, MESSAGES } from "./messages.ts";

/** 输入框里没发的字按这个名字存：离开主机页再回来还在。 */
const DRAFT_KEY = "plume.ssh.assistant";

type Host = Pick<UiContext, "Conversation" | "notify" | "useSession">;

export function AssistantColumn({ ui, api, sessionId, text }: { ui: Host; api: Remote<SshApi>; sessionId: string | null; text: Messages }) {
	const history = usePopover();
	const view = ui.useSession(sessionId ?? undefined);
	const [segments, setSegments] = useState<AssistantSegment[] | null>(null);
	const confirmer = useConfirmer();
	const report = (cause: unknown) => ui.notify(errorText(cause), "error");
	const send = async (message: string | OutgoingMessage, choice?: SessionChoice) => {
		await api.ask(
			typeof message === "string"
				? message
				: {
						content: message.content,
						...(message.displayText !== undefined ? { displayText: message.displayText } : {}),
						...(message.attachments ? { attachments: message.attachments } : {}),
					},
			choice,
		);
	};
	const openHistory = (event: MouseEvent<HTMLButtonElement>) => {
		if (history.open) {
			history.close();
			return;
		}
		setSegments(null);
		history.toggle(event);
		void api.history().then(setSegments, (cause: unknown) => {
			history.close();
			report(cause);
		});
	};
	const pick = (run: () => PromiseLike<unknown>) => () => {
		history.close();
		void Promise.resolve(run()).catch(report);
	};

	return (
		<section className="ssh-assistant" aria-label={text.assistantTitle} data-ssh-assistant="">
			<PageTopRow className="ssh-row">
				<Sparkles size={15} className="ssh-accent" />
				<Text size="label" weight="medium" className="ssh-ellipsis">
					{text.assistantTitle}
				</Text>
				<span className="ssh-spacer" />
				<IconButton
					size="sm"
					label={text.assistantNew}
					icon={<SquarePen size={14} />}
					disabled={!view || view.messages.length === 0}
					onClick={() => void api.newAssistant().catch(report)}
					data-ssh-assistant-new=""
				/>
				<IconButton size="sm" label={text.assistantHistory} icon={<History size={14} />} menu={history.open} onClick={openHistory} />
				{history.open && (
					<Popover anchor={history.anchor} onClose={history.close} placement="bottom" align="end" width="default" maxHeight={MENU_MAX_HEIGHT}>
						<MenuBody>
							<MenuLabel>{text.assistantHistory}</MenuLabel>
							{segments === null ? null : segments.length === 0 ? (
								<MenuItem disabled>{text.assistantNoHistory}</MenuItem>
							) : (
								segments.map((segment) => (
									<MenuItem
										key={segment.id}
										selected={segment.id === sessionId}
										trailing={segment.id === sessionId ? <Check size={13} /> : <TimeAgo iso={new Date(segment.updatedAt).toISOString()} />}
										onClick={pick(() => api.openAssistant(segment.id))}
									>
										{segment.title || text.untitled}
									</MenuItem>
								))
							)}
							{sessionId && (
								<>
									<MenuSeparator />
									<MenuItem
										icon={<Trash2 size={14} />}
										danger
										onClick={() => {
											history.close();
											confirmer.ask({
												title: text.assistantDeleteTitle,
												detail: text.assistantDeleteDetail,
												confirmLabel: text.delete,
												onConfirm: () => void api.deleteAssistant(sessionId).catch(report),
											});
										}}
									>
										{text.assistantDelete}
									</MenuItem>
								</>
							)}
						</MenuBody>
					</Popover>
				)}
			</PageTopRow>
			<div className="ssh-assistant-body">
				<ui.Conversation
					{...(sessionId ? { sessionId } : {})}
					reask
					empty={
						<PanelEmpty icon={Sparkles} title={text.assistantTitle}>
							{text.assistantEmpty}
						</PanelEmpty>
					}
					composer={{
						draftKey: DRAFT_KEY,
						model: "choose",
						// 还没有这一段（刚装上、刚新开、刚删掉）时也能先选模型和档位，第一句照选的开这一段。
						blank: {},
						placeholder: (locale) => MESSAGES[locale].assistantPlaceholder,
						send,
						sendMessage: send,
						stop: () => void api.stopAssistant().catch(report),
					}}
				/>
			</div>
			{confirmer.element}
		</section>
	);
}
