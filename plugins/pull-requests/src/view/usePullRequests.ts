import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PullRequestDetail, PullRequestSummary } from "../api";
import { cacheDetail } from "./cache";
import { acknowledge, groupFor, rowId, sameDetail, sameRef, unseenOf, type Filter, type PrRef } from "./model";
import { useServices, useStore } from "./context";

export function usePullRequests(autoSelect: boolean) {
	const { api, store, avatars } = useServices();
	const state = useStore();
	const [account, setAccount] = useState<string | null>(null);
	const [filter, setFilter] = useState<Filter>("all");
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<PrRef | null>(null);
	const current = useRef(selected);
	current.current = selected;
	const [detail, setDetail] = useState<PullRequestDetail | null>(null);
	const [detailError, setDetailError] = useState<string | null>(null);
	const [detailLoading, setDetailLoading] = useState(false);
	const [fetchKey, setFetchKey] = useState<string | null>(null);
	const [reload, setReload] = useState(0);
	const showing = useRef(detail);
	showing.current = detail;
	const refresh = useCallback((stale = false) => store.refresh(() => current.current, stale), [store]);
	useEffect(() => {
		void store.reloadAccounts();
		let timer: ReturnType<typeof setInterval> | undefined;
		const visible = () => document.visibilityState === "visible";
		const start = () => {
			if (!timer && visible()) timer = setInterval(() => void refresh(), 45_000);
		};
		const stop = () => {
			clearInterval(timer);
			timer = undefined;
			store.stop();
		};
		const wake = () => {
			if (!visible()) {
				stop();
				return;
			}
			start();
			void refresh(true);
		};
		wake();
		document.addEventListener("visibilitychange", wake);
		window.addEventListener("online", wake);
		return () => {
			stop();
			document.removeEventListener("visibilitychange", wake);
			window.removeEventListener("online", wake);
		};
	}, [store, refresh]);
	useEffect(() => {
		for (const pr of state.items) avatars.want({ accountId: pr.accountId, login: pr.author, url: pr.avatarUrl });
	}, [avatars, state.items, state.revision]);
	useEffect(() => {
		if (!state.ready) return;
		const available = (id: string) => state.accounts.some((entry) => entry.id === id && entry.enabled);
		if (account && !available(account)) setAccount(null);
		if (selected && !available(selected.accountId)) setSelected(null);
	}, [state.accounts, state.ready, account, selected]);
	useEffect(() => {
		if (!state.focus) return;
		// 从环境卡片点过来的：筛选清空，免得要看的那条被筛掉。
		setAccount(null);
		setFilter("all");
		setQuery("");
		setSelected({ accountId: state.focus.accountId, repo: state.focus.repo, number: state.focus.number });
		store.focus(null);
	}, [state.focus, store]);
	const groups = useMemo(() => groupFor(state.items, filter, query, account), [state.items, filter, query, account]);
	useEffect(() => {
		if (autoSelect && !selected && !state.focus && groups[0]?.items[0]) {
			const first = groups[0].items[0];
			setSelected({ accountId: first.accountId, repo: first.repo, number: first.number });
		}
	}, [autoSelect, selected, groups, state.focus]);
	useEffect(() => {
		if (!selected) {
			setDetail(null);
			setDetailError(null);
			setDetailLoading(false);
			return;
		}
		const key = rowId(selected);
		setFetchKey(key);
		const old = showing.current;
		const start = old && rowId(old) === key ? old : (store.details.get(key) ?? null);
		setDetail(start);
		setDetailError(null);
		setDetailLoading(true);
		let cancelled = false;
		const call = api.pullRequest(selected.accountId, selected.repo, selected.number);
		void (async () => {
			try {
				const result = await call;
				if (cancelled) return;
				if (result.detail) {
					cacheDetail(store.details, result.detail);
					setDetail((previous) => (previous && sameDetail(previous, result.detail!) ? previous : result.detail!));
				} else setDetailError(result.error ?? null);
			} catch (error) {
				if (!cancelled) setDetailError(String(error));
			} finally {
				if (!cancelled) setDetailLoading(false);
			}
		})();
		return () => {
			cancelled = true;
			call.cancel();
		};
	}, [api, store, selected, reload, state.revision]);
	const select = useCallback(
		(pr: PullRequestSummary) => {
			setSelected((old) => (sameRef(old, pr) ? old : { accountId: pr.accountId, repo: pr.repo, number: pr.number }));
			store.markSeen(acknowledge(store.getSnapshot().seen, pr));
		},
		[store],
	);
	// 在 effect 接上前也不能把前一条的详情画在新选中项下面。
	const visibleDetail = selected ? (detail && sameRef(detail, selected) ? detail : (store.details.get(rowId(selected)) ?? null)) : null;
	return {
		...state,
		account,
		setAccount,
		filter,
		setFilter,
		query,
		setQuery,
		selected,
		select,
		clearSelection: () => setSelected(null),
		groups,
		unseen: unseenOf(state.items, state.seen),
		detail: visibleDetail,
		detailError: selected && fetchKey === rowId(selected) ? detailError : null,
		detailLoading: Boolean(selected) && (fetchKey !== rowId(selected!) || detailLoading),
		refresh,
		refreshDetail: () => setReload((value) => value + 1),
	};
}
