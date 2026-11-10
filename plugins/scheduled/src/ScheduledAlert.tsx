/**
 * 定时任务失败了：在输入框上方说一句，直到有人看见。
 *
 * 放在对话里而不是窗口角落的提示条：任务跑在一个没人看着的会话里，提示条在有人抬头之前就没了。只占一行——最新的那次失败，
 * 另外还有几个。「查看」打开定时任务页、把那张卡片滚进视野，原因留在卡片上；叉号是「知道了」。两个都清掉侧栏上的数目，
 * 数的是同一些失败。
 */

import { Button, Collapse, IconButton, Text, useI18n } from "@plume/ui";
import { Clock, X } from "@plume/ui/icons";
import { useState, useSyncExternalStore } from "react";
import type { UnseenFailure } from "./api.ts";
import type { ScheduledClient } from "./client.ts";
import { MESSAGES } from "./messages.ts";

const NONE: UnseenFailure[] = [];

export function ScheduledAlert({ client, onLook, onDismiss }: { client: ScheduledClient; onLook: (taskId: string) => void; onDismiss: () => void }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const unseen = useSyncExternalStore(client.subscribe, () => client.get()?.unseen ?? NONE);
	const latest = unseen.at(-1);
	// 收起的那一下还留着这句话，字跟着这一行一起走，不在开始收的时候先变空。
	const [shown, setShown] = useState(latest);
	if (latest && latest !== shown) setShown(latest);
	const others = unseen.length - 1;

	return (
		<Collapse open={latest !== undefined}>
			{shown && (
				<div className="scheduled-alert" data-scheduled-alert={shown.taskId}>
					<Clock size={13} strokeWidth={1.8} className="scheduled-alert-icon" />
					<Text size="detail" tone="muted" className="scheduled-alert-message" data-plume-tip={shown.message}>
						{shown.message}
					</Text>
					{others > 0 && (
						<Text size="caption" tone="faint" numeric className="scheduled-alert-others" data-scheduled-alert-others="">
							{text.otherFailures(others)}
						</Text>
					)}
					<Button variant="subtle" size="sm" onClick={() => onLook(shown.taskId)} data-scheduled-alert-look="">
						{text.look}
					</Button>
					<IconButton size="sm" label={text.dismissFailures} onClick={onDismiss} data-scheduled-alert-dismiss="" icon={<X size={12} strokeWidth={2} />} />
				</div>
			)}
		</Collapse>
	);
}
