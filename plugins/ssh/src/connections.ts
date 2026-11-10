/**
 * 主机页终端标签和 SSH 连接的对应：一个标签一条连接，连接住在逻辑入口里，离开主机页、去设置页都不断；页面再挂上时
 * 按连接 id 接回来，先回放最近的输出。只有关标签、点断开或者连接自己断了才结束。
 *
 * 第一次连一台机器（这个地址和端口还没核对过指纹）时，连接停在 hostkey，等人在终端上方核对指纹；指纹和记下的不一样
 * 直接拒绝，不给「仍然连接」：那正是中间人攻击的样子。
 */

import { randomUUID } from "node:crypto";
import type { BatchTarget, ConnectionView, ResourceStats, TerminalOutput } from "./api.ts";
import type { Errors } from "./messages.ts";
import type { SshService } from "./ssh.ts";
import type { Vault } from "./vault.ts";

/** 回放留多少：够重画一屏和往上翻一段，不无限长。 */
const REPLAY_CHARS = 256 * 1024;

interface Live {
	view: ConnectionView;
	output: string;
	listeners: Set<(event: TerminalOutput) => void>;
	/** 等人核对指纹时，人的回答从这里进来。 */
	answer?: (accept: boolean) => void;
}

export class Connections {
	private readonly byTab = new Map<string, Live>();
	private readonly byId = new Map<string, Live>();

	constructor(
		private readonly deps: {
			vault: Vault;
			ssh: () => SshService;
			changed(): void;
			/** 连上、断开（给资源占用、传输）。 */
			opened(id: string): void;
			closed(id: string): void;
			t(): Errors;
		},
	) {}

	views(): ConnectionView[] {
		return [...this.byTab.values()].map((live) => ({ ...live.view, ...(live.view.stats ? { stats: { ...live.view.stats } } : {}) }));
	}

	view(id: string): ConnectionView | undefined {
		const live = this.byId.get(id);
		return live && { ...live.view };
	}

	/** 现在连着的。运维助手能用的就是这些。 */
	connected(): ConnectionView[] {
		return this.views().filter((view) => view.state === "connected");
	}

	connectedIds(): string[] {
		return [...this.byId.values()].filter((live) => live.view.state === "connected").map((live) => live.view.id);
	}

	connect(tab: string, serverId: string): void {
		const t = this.deps.t();
		const host = this.deps.vault.host(serverId);
		if (!host.password) throw new Error(t.invalidPassword);
		this.drop(tab);
		const id = randomUUID();
		const live: Live = {
			view: {
				tab,
				id,
				serverId,
				label: host.name,
				host: host.host,
				port: host.port,
				username: host.username,
				state: "connecting",
			},
			output: "",
			listeners: new Set(),
		};
		this.byTab.set(tab, live);
		this.byId.set(id, live);
		this.deps.changed();
		// ssh2 加载失败这类同步抛错也落到下面的失败分支里，不让标签停在「连接中」。
		Promise.resolve()
			.then(() => this.deps.ssh().connect(id, host))
			.then(
				() => {
					if (this.byId.get(id) !== live) return;
					const fingerprint = this.deps.vault.fingerprint(host.host, host.port);
					if (!fingerprint) {
						this.deps.ssh().disconnect(id);
						return;
					}
					live.view = { ...live.view, state: "connected", fingerprint };
					delete live.view.error;
					// 只是记个时间，记不下不影响这次连接。
					void this.deps.vault.markConnected(serverId).catch(() => {});
					this.deps.opened(id);
					this.deps.changed();
				},
				(error: unknown) => this.finish(live, error instanceof Error ? error.message : String(error)),
			);
	}

	trust(tab: string, accept: boolean): void {
		this.byTab.get(tab)?.answer?.(accept === true);
	}

	disconnect(tab: string): void {
		const live = this.byTab.get(tab);
		if (live) this.deps.ssh().disconnect(live.view.id);
	}

	/** 关标签：断开，标签和它的输出都不留。 */
	close(tab: string): void {
		this.drop(tab);
		this.deps.changed();
	}

	closeAll(): void {
		for (const tab of [...this.byTab.keys()]) this.drop(tab);
	}

	private drop(tab: string): void {
		const live = this.byTab.get(tab);
		if (!live) return;
		this.byTab.delete(tab);
		this.byId.delete(live.view.id);
		live.answer?.(false);
		this.deps.ssh().disconnect(live.view.id);
		for (const listener of live.listeners) listener({ type: "end" });
		live.listeners.clear();
		if (live.view.state === "connected") this.deps.closed(live.view.id);
	}

	/** 先回放攒下的输出，再接着推；连接已经断了的回放完就结束。返回断开监听的函数，连接不在时返回 undefined。 */
	attach(id: string, emit: (event: TerminalOutput) => void): (() => void) | undefined {
		const live = this.byId.get(id);
		if (!live) return undefined;
		if (live.output) emit({ type: "data", data: live.output });
		emit({ type: "ready" });
		if (live.view.state === "closed") {
			emit({ type: "end" });
			return () => undefined;
		}
		live.listeners.add(emit);
		return () => live.listeners.delete(emit);
	}

	setStats(id: string, stats: ResourceStats | null): void {
		const live = this.byId.get(id);
		if (!live) return;
		live.view = { ...live.view };
		if (stats) live.view.stats = stats;
		else delete live.view.stats;
		this.deps.changed();
	}

	/** 连接现在的身份。断了、主机的地址或账号改过、指纹对不上记下的，都抛错：Agent 和批量命令据此不发命令。 */
	target(id: string): BatchTarget {
		const t = this.deps.t();
		const live = this.byId.get(id);
		const view = live?.view;
		if (!view || view.state !== "connected" || !this.deps.ssh().isConnected(id) || !view.fingerprint) throw new Error(t.notConnected);
		const fingerprint = view.fingerprint;
		let host;
		try {
			host = this.deps.vault.host(view.serverId);
		} catch {
			throw new Error(t.identityChanged);
		}
		if (
			host.host !== view.host ||
			host.port !== view.port ||
			host.username !== view.username ||
			this.deps.vault.fingerprint(view.host, view.port) !== fingerprint
		)
			throw new Error(t.identityChanged);
		return { connection: id, serverId: view.serverId, label: view.label, host: view.host, port: view.port, username: view.username, fingerprint };
	}

	// —— 以下是 SshService 的回调 ——

	async verifyHost(id: string, host: string, port: number, fingerprint: string, signal: AbortSignal): Promise<boolean> {
		const live = this.byId.get(id);
		if (!live) return false;
		const known = this.deps.vault.fingerprint(host, port);
		if (known === fingerprint) return true;
		if (known) {
			live.view = { ...live.view, error: this.deps.t().hostKeyChanged(known, fingerprint) };
			return false;
		}
		live.view = { ...live.view, state: "hostkey", fingerprint };
		this.deps.changed();
		const accepted = await new Promise<boolean>((resolve) => {
			const finish = (accept: boolean) => {
				signal.removeEventListener("abort", onAbort);
				delete live.answer;
				resolve(accept);
			};
			const onAbort = () => finish(false);
			signal.addEventListener("abort", onAbort, { once: true });
			live.answer = finish;
		});
		if (!accepted || signal.aborted || this.byId.get(id) !== live) return false;
		await this.deps.vault.trustHost(host, port, fingerprint);
		live.view = { ...live.view, state: "connecting" };
		this.deps.changed();
		return true;
	}

	onTerminal(id: string, data: string): void {
		const live = this.byId.get(id);
		if (!live) return;
		live.output = (live.output + data).slice(-REPLAY_CHARS);
		for (const listener of live.listeners) listener({ type: "data", data });
	}

	onClosed(id: string, reason: string): void {
		const live = this.byId.get(id);
		if (live) this.finish(live, reason);
	}

	private finish(live: Live, reason: string): void {
		if (live.view.state === "closed") return;
		const wasConnected = live.view.state === "connected";
		// 指纹对不上时 verifyHost 已经写好了更具体的原因，不拿「连接被拒绝」盖掉。
		live.view = { ...live.view, state: "closed", error: live.view.error ?? reason };
		delete live.view.stats;
		delete live.answer;
		for (const listener of live.listeners) listener({ type: "end" });
		live.listeners.clear();
		if (wasConnected) this.deps.closed(live.view.id);
		this.deps.changed();
	}
}
