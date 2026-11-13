/**
 * plume.review 的界面入口：一次 `review_session` 在对话里画成一行「审阅会话 · 审什么」。不经卡片——人敲 `/review` 就是同意，
 * 调用答完时审阅会话已经开出来了。行首是审阅的图标，它在跑时摘要上扫光，没跑完时行尾说一声，点了过去。
 * 报告交回来时本体另画一行「来自新会话」。调用被退回（交接单不全、开不出来）时交回通用的工具行。
 * 审阅会话里问原会话修哪几条的 `ask_implementer` 画成一行「问原会话修哪几条」。
 */

import type { ToolCardProps, UiContext, UiPlugin } from "@plume/contract/ui";
import { FlowRow, Text, useI18n } from "@plume/ui";
import { ChevronRight, FileSearch, MessageCircleQuestion } from "@plume/ui/icons";
import reviewCss from "./review.css";
import { MESSAGES } from "./messages.ts";
import { ASK_IMPLEMENTER, isReviewSession, REVIEW_SESSION } from "./types.ts";

const NAME = "plume.review";

let ui: UiContext;

function ReviewRow({ call, status, result, fallback }: ToolCardProps) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const details = status === "done" ? result?.details : undefined;
	const sessionId = isReviewSession(details) ? details.sessionId : undefined;
	const running = ui.useSession(sessionId)?.summary.running === true;
	const failed = ui.useSessionActivity(sessionId ?? "") === "failed";
	if (!isReviewSession(details) || !sessionId) return <>{fallback}</>;
	return (
		<div data-review-session={sessionId} data-review-call={call.id}>
			<FlowRow
				icon={<FileSearch size={13} strokeWidth={1.8} />}
				title={<span className="plume-review-plain">{text.reviewSession}</span>}
				summary={details.subject}
				running={running}
				trailing={
					<>
						{failed && (
							<Text size="caption" tone="danger">
								{text.failedMark}
							</Text>
						)}
						{/* 点了是去那个会话，不是就地展开：箭头自己画，和交回那一行一样。 */}
						<ChevronRight size={12} strokeWidth={2} aria-hidden />
					</>
				}
				onToggle={() => void ui.openSession(sessionId)}
				label={details.subject}
			/>
		</div>
	);
}

function mountStyles(): void {
	let style = document.querySelector<HTMLStyleElement>(`style[data-plugin-style="${NAME}"]`);
	if (!style) {
		style = document.createElement("style");
		style.dataset.pluginStyle = NAME;
		document.head.append(style);
	}
	style.textContent = reviewCss;
}

export default {
	name: NAME,
	apply(context) {
		ui = context;
		mountStyles();
		context.toolCard(REVIEW_SESSION, ReviewRow);
		context.toolLine(REVIEW_SESSION, {
			verb: (locale) => MESSAGES[locale].handingOff,
			subject: (args) => (typeof args.target === "string" && args.target.trim() ? args.target.trim() : undefined),
			icon: FileSearch,
		});
		context.toolLine(ASK_IMPLEMENTER, { verb: (locale) => MESSAGES[locale].askingImplementer, icon: MessageCircleQuestion });
	},
} satisfies UiPlugin;
