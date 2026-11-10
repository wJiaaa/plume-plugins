/**
 * Which backend answers, and what happens while it is still waking up.
 *
 * A language server is heavy: `tsserver` on a mid-sized TypeScript project is several hundred
 * megabytes and takes seconds before it can answer anything. Two consequences shape this file.
 *
 * It starts lazily. Most sessions never ask a symbol question, and warming up on session start
 * would mean every window costs that memory for a feature it does not use.
 *
 * And a call that arrives before it is ready gets the textual answer *now* rather than a wait. The
 * agent asked because it is about to change something; an answer that arrives after it has already
 * moved on is worth less than a caveated one that arrives immediately.
 */

import { extname, resolve } from "node:path";
import { LANGUAGE_SERVERS } from "./servers.ts";
import { StdioLspBackend } from "./stdio.ts";
import { TsServerBackend } from "./tsserver.ts";
import type { CodeIntelBackend } from "./types.ts";

/** TypeScript 走 tsserver，其余按 `servers.ts` 那张表，每种语言一台、各自懒启动。 */
const defaultBackends = (): CodeIntelBackend[] => [new TsServerBackend(), ...LANGUAGE_SERVERS.map((spec) => new StdioLspBackend(spec))];

/**
 * How long a first call may block on a server that is still starting.
 *
 * Short on purpose. This is not "how long until tsserver is ready" — it is how long a tool call may
 * hang before a degraded answer beats an accurate one.
 */
const READY_WAIT_MS = 3000;

/**
 * 空闲多久之后把语言服务器杀掉。
 *
 * 一台 tsserver 几百兆内存，而一个会话开着一整天里真正问它的时间加起来不到十分钟。
 * 十分钟比一次「想一想再问」长，比一顿饭短。下次问它会重新起，代价是那一次多等几秒。
 */
const IDLE_MS = 10 * 60 * 1000;

export class CodeIntelManager {
	private readonly backends: CodeIntelBackend[];
	/** 正在起的，按后端去重；起完（成没成都算）就拿掉，失败的下次再问会重新起。 */
	private readonly starting = new Map<CodeIntelBackend, Promise<void>>();
	private readonly idleMs: number;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(backends: CodeIntelBackend[] = defaultBackends(), options: { idleMs?: number } = {}) {
		this.backends = backends;
		this.idleMs = options.idleMs ?? IDLE_MS;
	}

	/**
	 * 有人问了：重新计时。
	 *
	 * `unref`，跟子进程本身一样：一个还没到期的计时器不该成为进程活着的理由——测试跑完、agent 进程要退时，
	 * 不该因为十分钟后要杀一个服务器而挂着不退。
	 */
	private touch(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => void this.recycle(), this.idleMs);
		this.idleTimer.unref();
	}

	/**
	 * 到期了：杀掉在跑的，忘掉在起的。
	 *
	 * 管理器自己留着——下次 `acquire` 会重新起。跟 `dispose` 的区别就在这儿：那个是插件停用，
	 * 这个只是没人问了一阵。
	 */
	private async recycle(): Promise<void> {
		this.idleTimer = null;
		await Promise.all(this.backends.filter((b) => b.ready()).map((b) => b.dispose().catch(() => {})));
		this.starting.clear();
	}

	backendFor(file: string): CodeIntelBackend | null {
		const ext = extname(file).toLowerCase();
		return this.backends.find((backend) => backend.extensions.includes(ext)) ?? null;
	}

	/**
	 * Get a backend that can answer about `file`, or null to use the fallback.
	 *
	 * Null covers three different situations on purpose — no backend for this language, the binary
	 * is not installed, and it is still starting — because the caller does the same thing in all
	 * three, and distinguishing them would only move the branching one level up.
	 *
	 * `waitMs` is how long this call may wait on a startup. Edits pass 0: tsserver is up the moment
	 * it is spawned and still answers, while a server that needs a handshake is started and left to
	 * the next edit instead of holding this one.
	 */
	async acquire(file: string, root: string, { waitMs = READY_WAIT_MS }: { waitMs?: number } = {}): Promise<CodeIntelBackend | null> {
		const backend = this.backendFor(file);
		if (!backend) return null;
		if (!(await backend.available())) return null;

		if (backend.ready()) {
			this.touch();
			return backend;
		}

		let pending = this.starting.get(backend);
		if (!pending) {
			/*
			 * 起来的那一刻开始计时（起不来的不计，它没占着什么），不等下一次 `acquire`。只在等待窗口里看一眼的话，冷启动超过
			 * `waitMs` 的那台（大项目上的 tsserver 常常如此）就永远没有计时器，一直活到会话结束。
			 */
			pending = backend
				.start(root)
				.then(() => {
					if (backend.ready()) this.touch();
				})
				.catch(() => {})
				.finally(() => this.starting.delete(backend));
			this.starting.set(backend, pending);
		}

		/*
		 * Race the startup against the deadline rather than awaiting it.
		 *
		 * Losing the race is not a failure — the startup keeps going, and the next call finds it
		 * ready. What must not happen is the first call blocking for the fifteen seconds a cold
		 * `tsserver` can take on a large project.
		 */
		const won = await Promise.race([pending.then(() => true), delay(waitMs).then(() => false)]);
		return won && backend.ready() ? backend : null;
	}

	/**
	 * `acquire` 给了 null 之后，为什么——写进工具结果里的那句话。
	 *
	 * `acquire` 把几种情况并成一个 null，是因为调用方在每种情况下做的事一样：退回文本搜索。
	 * 说的话却不一样，而说清楚正是降级可以被接受的前提：「没装 gopls」是人能去解决的，
	 * 「还在启动」是等一下就好的。没有为这种文件配置任何服务器时返回 null，工具照旧只说文本搜索。
	 */
	async unavailable(file: string): Promise<string | null> {
		const backend = this.backendFor(file);
		if (!backend) return null;
		// i18n-exempt：交给模型的结果里的话。
		if (!(await backend.available())) return `这个语言没有可用的语言服务器（需要安装 ${backend.install ?? backend.name}）。`;
		if (!backend.ready()) return `语言服务器 ${backend.name} 还没有就绪（正在启动或启动失败），这次先用文本搜索。`;
		return null;
	}

	async dispose(): Promise<void> {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = null;
		await Promise.all(this.backends.map((backend) => backend.dispose().catch(() => {})));
		this.starting.clear();
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 每个目录一套，谁在用按会话记着：同一个目录的会话和子会话借同一套，最后一个还的把语言服务器停掉。
 *
 * 一台 tsserver 几百兆：同一个项目开三个会话起三台不值得，它们看的是同一批文件；工作树里的会话目录不同，照旧各用各的
 * ——那确实是另一批文件。不还的话只能等空闲回收，子会话在另一个目录里跑完一段，那台服务器还要白占十分钟。
 */
export class CodeIntelLeases {
	private readonly shared = new Map<string, { manager: CodeIntelManager; users: Set<string> }>();
	/** 会话借着哪个目录的那一套。 */
	private readonly leases = new Map<string, string>();
	private readonly create: () => CodeIntelManager;

	constructor(create: () => CodeIntelManager = () => new CodeIntelManager()) {
		this.create = create;
	}

	/** 这个会话在 `root` 下用的那一套：`lsp` 工具和编辑后的诊断共用。会话换了目录（换了项目），先还旧的那一套。 */
	borrow(sessionId: string, root: string): CodeIntelManager {
		const key = resolve(root);
		const held = this.leases.get(sessionId);
		if (held !== undefined && held !== key) void this.release(sessionId);
		let entry = this.shared.get(key);
		if (!entry) {
			entry = { manager: this.create(), users: new Set() };
			this.shared.set(key, entry);
		}
		entry.users.add(sessionId);
		this.leases.set(sessionId, key);
		return entry.manager;
	}

	/** 会话不再用了：还回它借的那一套，最后一个还的停掉语言服务器。下次再问时重新借、重新起。 */
	async release(sessionId: string): Promise<void> {
		const key = this.leases.get(sessionId);
		this.leases.delete(sessionId);
		if (key === undefined) return;
		const entry = this.shared.get(key);
		if (!entry) return;
		entry.users.delete(sessionId);
		if (entry.users.size > 0) return;
		this.shared.delete(key);
		await entry.manager.dispose().catch(() => {});
	}

	/** 插件停用：全部停掉。 */
	async dispose(): Promise<void> {
		const all = [...this.shared.values()];
		this.shared.clear();
		this.leases.clear();
		await Promise.all(all.map((entry) => entry.manager.dispose().catch(() => {})));
	}
}
