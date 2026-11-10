/**
 * plume.summary 的界面入口：环境卡片里「摘要」那一节，和设置 › 智能体 › 会话里选模型的那一行。
 *
 * 这一节不决定什么时候生成，只读存着的那份、跟着逻辑入口推来的变化走。还没有摘要时整节不占位，只在后台真在生成的那几秒画骨架；
 * 失败了留一个「重试」。
 */

import type { EnvironmentSectionProps, Remote, UiContext, UiPlugin } from "@plume/contract/ui";
import { relativeTime, SkeletonBar, Text, useI18n, useNow } from "@plume/ui";
import { useEffect, useMemo, useState } from "react";
import type { SummaryApi, SummaryState } from "./api.ts";
import { MESSAGES } from "./messages.ts";
import { lastSpoken } from "./summary.ts";
import css from "./summary.css";

let ui: UiContext;
let api: Remote<SummaryApi>;

const EMPTY: SummaryState = { summary: null, pending: false };

function useSummary(sessionId: string): SummaryState {
	const [held, setHeld] = useState<{ sessionId: string; state: SummaryState }>({ sessionId, state: EMPTY });
	useEffect(() => {
		const call = api.watch(sessionId);
		void (async () => {
			try {
				for await (const state of call) setHeld({ sessionId, state });
			} catch {
				// 换会话、卸下、插件停用时这条连接跟着断。
			}
		})();
		return () => call.cancel();
	}, [sessionId]);
	return held.sessionId === sessionId ? held.state : EMPTY;
}

/** 「2 分钟前更新」。刚生成的那一刻说「刚刚更新」：「刚刚前」不成话。 */
function UpdatedAt({ at }: { at: number }) {
	const { resolvedLocale } = useI18n();
	const text = MESSAGES[resolvedLocale];
	const now = useNow(true, 30_000);
	const tip = new Intl.DateTimeFormat(resolvedLocale, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(at);
	return (
		<Text size="caption" tone="faint" numeric data-plume-tip={tip}>
			{now - at < 60_000 ? text.justNow : text.updated(relativeTime(new Date(at).toISOString(), now))}
		</Text>
	);
}

function SummarySection({ session }: EnvironmentSectionProps) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const id = session.summary.id;
	const state = useSummary(id);
	const latest = useMemo(() => lastSpoken(session.messages), [session.messages]);
	const [retrying, setRetrying] = useState(false);
	const pending = state.pending || retrying;
	if (!state.summary && !pending && !state.error) return null;
	const stale = latest !== null && state.summary !== null && latest > state.summary.upto;
	const retry = () => {
		setRetrying(true);
		void api
			.summarize(id)
			.catch((error: unknown) => ui.notify(error instanceof Error ? error.message : String(error), "error"))
			.finally(() => setRetrying(false));
	};
	return (
		<div className="plume-summary">
			<div className="plume-summary-label">
				<Text size="caption" tone="faint">
					{text.section}
				</Text>
			</div>
			<div className="plume-summary-body">
				{state.summary ? (
					<Text as="p" size="detail" tone="muted" data-environment-summary>
						{state.summary.text}
					</Text>
				) : state.error && !pending ? null : (
					<div className="plume-summary-skeleton" aria-hidden>
						<SkeletonBar width="100%" />
						<SkeletonBar width="92%" />
						<SkeletonBar width="60%" />
					</div>
				)}
				<div className="plume-summary-foot">
					{state.error && !pending ? (
						<>
							<Text size="caption" tone="faint" className="plume-summary-truncate" data-plume-tip={state.error}>
								{text.failed}
							</Text>
							<button type="button" className="plume-summary-link" onClick={retry}>
								<Text size="caption" tone="accent">
									{text.retry}
								</Text>
							</button>
						</>
					) : state.summary && stale && (session.summary.running || pending) ? (
						<>
							<span className="plume-summary-dot" aria-hidden />
							<Text size="caption" tone="faint" className="plume-summary-truncate">
								{session.summary.running ? text.afterTurn : text.updating}
							</Text>
						</>
					) : state.summary ? (
						<UpdatedAt at={state.summary.updatedAt} />
					) : null}
				</div>
			</div>
		</div>
	);
}

function ModelSetting() {
	const text = MESSAGES[useI18n().resolvedLocale];
	const defaults = ui.useModelDefaults();
	const [model, setModel] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState(true);
	useEffect(() => {
		let alive = true;
		void api
			.model()
			.then(
				(value: string | undefined) => {
					if (alive) setModel(value);
				},
				(error: unknown) => ui.notify(error instanceof Error ? error.message : String(error), "error"),
			)
			.finally(() => {
				if (alive) setBusy(false);
			});
		return () => {
			alive = false;
		};
	}, []);
	const inherited = defaults.sessionModel ?? defaults.defaultModel;
	return (
		<ui.ModelSelect
			ariaLabel={text.modelTitle}
			value={model ?? ""}
			disabled={busy}
			inheritLabel={text.followMain}
			{...(inherited ? { inheritedModelId: inherited } : {})}
			inheritedSource={text.followMainShort}
			inheritDetail={text.modelDetail}
			onChange={(next) => {
				const previous = model;
				setModel(next || undefined);
				void api.setModel(next || undefined).catch((error: unknown) => {
					setModel(previous);
					ui.notify(error instanceof Error ? error.message : String(error), "error");
				});
			}}
		/>
	);
}

/** 宿主不加载插件的样式表：自己挂一份，按插件名认那个元素，重新加载时换内容不叠加。 */
function mountStyles(): void {
	let style = document.querySelector<HTMLStyleElement>('style[data-plugin-style="plume.summary"]');
	if (!style) {
		style = document.createElement("style");
		style.dataset.pluginStyle = "plume.summary";
		document.head.append(style);
	}
	style.textContent = css;
}

export default {
	name: "plume.summary",
	apply(context) {
		ui = context;
		api = context.remote<SummaryApi>();
		mountStyles();
		// 80：环境卡片里排在侧边聊天之后、压缩记录之前。
		context.environmentSection("summary", SummarySection, { label: (locale) => MESSAGES[locale].section, order: 80 });
		context.settingsSection("model", ModelSetting, {
			title: (locale) => MESSAGES[locale].modelTitle,
			detail: (locale) => MESSAGES[locale].modelDetail,
			page: "session-models",
		});
	},
} satisfies UiPlugin;
