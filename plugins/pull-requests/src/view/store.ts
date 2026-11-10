import type { Remote } from "@plume/contract/ui";
import type { ForgeAccount, PullRequestsApi } from "../api";
import { readDetails, readList, readSeen, writeCache } from "./cache.ts";
import { mergeLists, reconcileSeen, type PrRef } from "./model.ts";

export type Api = Remote<PullRequestsApi>;
export function createStore(api: Api) {
	let state = {
		accounts: [] as ForgeAccount[],
		ready: false,
		accountError: null as string | null,
		items: readList(),
		seen: readSeen(),
		errors: {} as Record<string, string>,
		error: null as string | null,
		loading: false,
		touched: new Set<string>(),
		revision: 0,
		drafts: {} as Record<string, string>,
		reviewErrors: {} as Record<string, string>,
		reviewBusy: false,
		/** 别处（环境卡片）要页面选中的那一条；页面选上以后清掉，只用一次。 */
		focus: null as PrRef | null,
	};
	const details = readDetails();
	const listeners = new Set<() => void>();
	let lastFetch = 0;
	let epoch = 0;
	let listCall: ReturnType<Api["myPullRequests"]> | null = null;
	let accountCall: Promise<void> | null = null;
	let flashTimer: ReturnType<typeof setTimeout> | undefined;
	const publish = (patch: Partial<typeof state>) => {
		state = { ...state, ...patch };
		for (const listener of listeners) listener();
	};
	const reloadAccounts = (): Promise<void> => {
		if (accountCall) return accountCall;
		const generation = epoch;
		accountCall = (async () => {
			try {
				const accounts = await api.accounts();
				if (generation !== epoch) return;
				const enabled = new Set(accounts.filter((account) => account.enabled).map((account) => account.id));
				const items = state.items.filter((pr) => enabled.has(pr.accountId));
				for (const [key, detail] of details) if (!enabled.has(detail.accountId)) details.delete(key);
				writeCache("list", items);
				writeCache("details", [...details.values()]);
				publish({ accounts, ready: true, accountError: null, items: items.length === state.items.length ? state.items : items });
			} catch (error) {
				if (generation === epoch) publish({ accountError: String(error) });
			} finally {
				accountCall = null;
			}
		})();
		return accountCall;
	};
	const invalidateAccounts = async () => {
		epoch++;
		lastFetch = 0;
		listCall?.cancel();
		listCall = null;
		// 先让旧读取退出，避免旧账号快照盖回刚保存的结果。
		await accountCall;
		await reloadAccounts();
		publish({ revision: state.revision + 1, loading: false });
	};
	const refresh = async (selected: () => PrRef | null, stale = false): Promise<void> => {
		if (listCall || (stale && Date.now() - lastFetch < 20_000)) return;
		const generation = epoch;
		const call = api.myPullRequests();
		listCall = call;
		publish({ loading: true });
		try {
			const answer = await call;
			if (generation !== epoch || listCall !== call) return;
			void reloadAccounts();
			publish({ errors: answer.errors });
			if (answer.error && !answer.pullRequests.length) {
				publish({ error: answer.error });
				return;
			}
			const incoming = state.ready
				? answer.pullRequests.filter((pr) => state.accounts.some((account) => account.id === pr.accountId && account.enabled))
				: answer.pullRequests;
			const merged = mergeLists(state.items, incoming);
			const seen = reconcileSeen(state.seen, merged.items, selected());
			lastFetch = Date.now();
			writeCache("list", merged.items);
			writeCache("seen", seen);
			publish({ items: merged.items, seen, touched: merged.touched, error: answer.error ?? null, revision: state.revision + 1 });
			if (merged.touched.size) {
				clearTimeout(flashTimer);
				flashTimer = setTimeout(() => publish({ touched: new Set() }), 1400);
			}
		} catch (error) {
			if (generation === epoch && listCall === call) publish({ error: String(error) });
		} finally {
			if (listCall === call) {
				listCall = null;
				publish({ loading: false });
			}
		}
	};
	return {
		getSnapshot: () => state,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		details,
		reloadAccounts,
		invalidateAccounts,
		refresh,
		setDraft: (id: string, body: string) => publish({ drafts: { ...state.drafts, [id]: body }, reviewErrors: { ...state.reviewErrors, [id]: "" } }),
		startReview: (id: string) => {
			if (state.reviewBusy) return false;
			publish({ reviewBusy: true, reviewErrors: { ...state.reviewErrors, [id]: "" } });
			return true;
		},
		finishReview: (id: string, submitted: string, error: string | null) =>
			publish({
				reviewBusy: false,
				reviewErrors: { ...state.reviewErrors, [id]: error ?? "" },
				drafts: !error && state.drafts[id] === submitted ? { ...state.drafts, [id]: "" } : state.drafts,
			}),
		focus: (ref: PrRef | null) => publish({ focus: ref }),
		markSeen: (seen: Record<string, string>) => {
			writeCache("seen", seen);
			publish({ seen });
		},
		stop: () => {
			listCall?.cancel();
			listCall = null;
			clearTimeout(flashTimer);
			publish({ loading: false, touched: new Set() });
		},
	};
}
export type Store = ReturnType<typeof createStore>;
