/**
 * 「N 个项目钩子待审核」：输入框上方的一行，提示这个会话的目录里有没信任的项目钩子。
 *
 * 项目钩子可能是别人提交进来的，没信任之前会话里跑到它们只记一笔「已阻止」。不在这里说一声，人只会觉得自己写的钩子怎么不灵。
 * 点「去审核」落到设置页的钩子，并把那一页切到这个项目。
 */

import type { ComposerAboveProps, Remote } from "@plume/contract/ui";
import { Button, Collapse, IconButton, Text, useI18n } from "@plume/ui";
import { Anchor, X } from "@plume/ui/icons";
import { useCallback, useEffect, useState } from "react";
import type { HooksApi } from "./api.ts";
import { MESSAGES } from "./messages.ts";
import { hooksChanged } from "./scope.ts";

/**
 * 忽略过的，按「目录 + 待审的那几条」记，活在这次运行里。换一批待审的钩子（有人又改了一条），签名跟着变，提示会再出来——
 * 忽略的是看过的那一批，不是以后所有的。
 */
const dismissed = new Set<string>();

export function HookTrustBanner({ api, session, onReview }: ComposerAboveProps & { api: Remote<HooksApi>; onReview: (cwd: string) => void }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const cwd = session.summary.cwd;
	const [pending, setPending] = useState<{ key: string; count: number } | null>(null);
	// 收起的那一下还留着这句话，字跟着这一行一起走，不在开始收的时候先变空。
	const [shown, setShown] = useState(pending);
	if (pending && pending !== shown) setShown(pending);

	const refresh = useCallback(() => {
		if (!cwd) {
			setPending(null);
			return;
		}
		void api
			.list(cwd)
			.then((view) => {
				const waiting = (view.project ?? []).filter((hook) => hook.trusted === false && hook.enabled);
				const key = `${cwd}\n${waiting.map((hook) => `${hook.id}:${hook.command}`).join("\n")}`;
				setPending(waiting.length > 0 && !dismissed.has(key) ? { key, count: waiting.length } : null);
			})
			.catch(() => setPending(null));
	}, [api, cwd]);
	useEffect(refresh, [refresh]);
	// 设置页信任、开关过以后重读：对话那一屏一直挂着，不会因为回来而重新读一次。
	useEffect(() => hooksChanged.subscribe(refresh), [refresh]);
	// 项目钩子写在项目目录的文件里，拉一次代码就可能变了。回到窗口时重读。
	useEffect(() => {
		window.addEventListener("focus", refresh);
		return () => window.removeEventListener("focus", refresh);
	}, [refresh]);

	return (
		<Collapse open={pending !== null}>
			{shown && (
				<div className="hook-banner" data-hook-trust-banner="">
					<Anchor size={13} strokeWidth={1.8} className="hook-banner-icon" aria-hidden />
					<Text size="detail" tone="muted" className="hook-banner-message">
						{text.pending(shown.count)}
					</Text>
					<Button variant="subtle" size="sm" onClick={() => onReview(cwd)} data-hook-review="">
						{text.review}
					</Button>
					<IconButton
						size="sm"
						label={text.dismiss}
						onClick={() => {
							dismissed.add(shown.key);
							setPending(null);
						}}
						icon={<X size={12} strokeWidth={2} />}
					/>
				</div>
			)}
		</Collapse>
	);
}
