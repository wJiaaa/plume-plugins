/**
 * 界面这边对逻辑入口状态的一份订阅：主机页、面板、批量命令共用，界面入口 apply 时连上，停用时断开。
 */

import type { Remote } from "@plume/contract/ui";
import { useSyncExternalStore } from "react";
import type { SshApi, SshState } from "./api.ts";

export interface SshClient {
	get(): SshState | null;
	subscribe(listener: () => void): () => void;
	/** 停用时调。 */
	cancel(): void;
}

export function connectSsh(api: Remote<SshApi>): SshClient {
	let state: SshState | null = null;
	const listeners = new Set<() => void>();
	let stopped = false;
	const call = api.watch();
	void (async () => {
		try {
			for await (const next of call) {
				state = next;
				for (const listener of listeners) listener();
			}
		} catch (error) {
			if (!stopped) console.error("[plume.ssh] 状态订阅断了：", error);
		}
	})();
	return {
		get: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		cancel() {
			stopped = true;
			call.cancel();
		},
	};
}

export function useSshState(client: SshClient): SshState | null {
	return useSyncExternalStore(client.subscribe, client.get);
}

/** 远端调用的错误给人看的那句话：去掉 RPC 包的前缀。 */
export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
