/**
 * 回复底下那排操作里的「钩子」：这一轮跑过哪些钩子、各自怎么收场。
 *
 * 放在操作排里、点开才看，而不是画进转录：大多数钩子是静静跑完的格式化和日志，一行一行摆出来只会把回答挤开。
 * 拦下了什么、哪条失败了，才是点开时要一眼看到的。全部顺利跑完的那一轮连按钮都不出——只有出了岔子的那一轮才值得占操作排的位置。
 */

import type { Remote } from "@plume/contract/ui";
import { ActionSpinner, Popover, Text, useI18n, usePopover } from "@plume/ui";
import { Anchor, Ban, Check, CircleSlash, CircleX, Clock } from "@plume/ui/icons";
import { useMemo, useSyncExternalStore } from "react";
import type { HookRunRecord, HooksApi } from "./api.ts";
import { type Messages, MESSAGES } from "./messages.ts";

const TROUBLED: ReadonlySet<HookRunRecord["status"]> = new Set(["blocked", "failed", "timed_out"]);
const NONE: readonly HookRunRecord[] = [];

/**
 * 各会话的运行记录，界面入口这边的一份：有按钮在看的会话才去读，逻辑入口说哪个会话变了就重读它；没人看的那份直接丢掉，下次看时再读。
 */
export class RunsCache {
	private readonly runs = new Map<string, readonly HookRunRecord[]>();
	private readonly listeners = new Map<string, Set<() => void>>();
	/** 每个会话读到第几次：晚到的旧回答不盖住新的。 */
	private readonly loads = new Map<string, number>();
	private readonly api: Remote<HooksApi>;

	constructor(api: Remote<HooksApi>) {
		this.api = api;
	}

	/** 一直连着逻辑入口的 `watch`；返回断开的办法。 */
	connect(): () => void {
		const call = this.api.watch();
		void (async () => {
			try {
				for await (const changed of call) for (const sessionId of changed) this.changed(sessionId);
			} catch {
				// 停用、重载时这条连接跟着断；重新加载的界面入口会再连上。
			}
		})();
		return () => call.cancel();
	}

	get(sessionId: string): readonly HookRunRecord[] {
		return this.runs.get(sessionId) ?? NONE;
	}

	subscribe(sessionId: string, listener: () => void): () => void {
		let set = this.listeners.get(sessionId);
		if (!set) this.listeners.set(sessionId, (set = new Set()));
		set.add(listener);
		if (!this.runs.has(sessionId)) this.load(sessionId);
		return () => {
			set.delete(listener);
			if (set.size === 0) this.listeners.delete(sessionId);
		};
	}

	private changed(sessionId: string): void {
		if (this.listeners.has(sessionId)) this.load(sessionId);
		else this.runs.delete(sessionId);
	}

	private load(sessionId: string): void {
		const load = (this.loads.get(sessionId) ?? 0) + 1;
		this.loads.set(sessionId, load);
		void this.api.runs(sessionId).then(
			(runs) => {
				if (this.loads.get(sessionId) !== load) return;
				this.runs.set(sessionId, runs);
				for (const listener of this.listeners.get(sessionId) ?? []) listener();
			},
			() => {},
		);
	}
}

function StatusIcon({ status }: { status: HookRunRecord["status"] }) {
	if (status === "running") return <ActionSpinner size={13} />;
	if (status === "success") return <Check size={13} className="hook-run-ok" aria-hidden />;
	if (status === "blocked") return <Ban size={13} className="hook-run-blocked" aria-hidden />;
	if (status === "failed") return <CircleX size={13} className="hook-run-bad" aria-hidden />;
	if (status === "timed_out") return <Clock size={13} className="hook-run-bad" aria-hidden />;
	return <CircleSlash size={13} className="hook-run-quiet" aria-hidden />;
}

function statusText(text: Messages, status: Exclude<HookRunRecord["status"], "success">): string {
	if (status === "running") return text.statusRunning;
	if (status === "blocked") return text.statusBlocked;
	if (status === "failed") return text.statusFailed;
	if (status === "timed_out") return text.statusTimedOut;
	return text.statusCancelled;
}

function duration(ms: number | undefined): string {
	if (ms === undefined) return "";
	return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** `from` 是这一轮开口的那条消息，`to` 是收尾那条回复之后的位置；钩子的 `at` 落在两者之间就归这一轮。 */
export function HookRunsAction({ cache, sessionId, from, to }: { cache: RunsCache; sessionId: string; from: number; to: number }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const popover = usePopover();
	const all = useSyncExternalStore(
		(listener) => cache.subscribe(sessionId, listener),
		() => cache.get(sessionId),
	);
	const runs = useMemo(() => all.filter((run) => run.at > from && run.at <= to), [all, from, to]);
	if (!runs.some((run) => TROUBLED.has(run.status))) return null;

	return (
		<>
			<button
				type="button"
				className="hook-runs-button"
				data-plume-tip={text.runs}
				aria-label={text.runs}
				aria-expanded={popover.open}
				onClick={popover.toggle}
				data-hook-runs=""
			>
				<Anchor size={12.5} strokeWidth={1.8} aria-hidden />
				<Text size="caption" tone="accent" numeric>
					{runs.length}
				</Text>
			</button>
			{popover.open && (
				<Popover anchor={popover.anchor} onClose={popover.close} placement="top" align="start" width={360} role="dialog" label={text.runs}>
					<div className="hook-runs-list">
						{runs.map((run) => (
							<div key={run.id} className="hook-run" data-hook-run={run.status}>
								<div className="hook-run-head">
									<StatusIcon status={run.status} />
									<Text size="label" weight="medium">
										{run.event}
									</Text>
									{run.toolName && (
										<Text size="detail" mono tone="faint" className="hook-run-truncate">
											{run.toolName}
										</Text>
									)}
									<Text size="detail" tone="faint" className="hook-run-side">
										{run.source === "project" ? text.sourceProject : text.sourceUser}
										{run.durationMs !== undefined && ` · ${duration(run.durationMs)}`}
									</Text>
								</div>
								<Text as="p" size="detail" mono tone="faint" className="hook-run-line hook-run-truncate">
									{run.statusMessage ?? run.command}
								</Text>
								{run.status !== "success" && (
									<Text as="p" size="detail" tone={run.status === "running" || run.status === "cancelled" ? "muted" : "danger"} className="hook-run-line">
										{statusText(text, run.status)}
									</Text>
								)}
								{run.reason && run.status !== "success" && (
									<Text as="p" size="detail" tone="muted" className="hook-run-reason">
										{run.reason}
									</Text>
								)}
							</div>
						))}
					</div>
				</Popover>
			)}
		</>
	);
}
