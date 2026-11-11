/**
 * 主机页右边的「AI 运维助手」：插件的独立会话（`ctx.sessions.create` 不给 `parentId`），不进侧栏，只画在主机页上。
 * 一段一段的：人点「新开一段」以后，下一句话开一个新的会话，旧的留在「历史」里。现在是哪一段记在数据目录，重启接着用。
 *
 * 只有这些会话里能用 `ssh_sessions`、`ssh_run`（见 tools.ts），用的是主机页上全部连着的连接。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginContext, SessionMessage } from "@plume/contract";
import type { SessionChoice } from "@plume/contract/ui";
import type { AssistantMessage, AssistantSegment } from "./api.ts";

export class Assistant {
	private current: string | null = null;
	/** 这个插件建的独立会话：运维助手说过的各段。 */
	private readonly mine = new Set<string>();
	/** 有操作在等人批准的那几段。 */
	private readonly waiting = new Set<string>();
	private readonly ready: Promise<void>;
	private creating: Promise<string> | undefined;

	constructor(
		private readonly ctx: Pick<PluginContext, "name" | "dataDir" | "sessions" | "log">,
		private readonly changed: () => void,
	) {
		this.ready = this.load();
		ctx.sessions.onDeleted((sessionId) => {
			if (!this.mine.delete(sessionId)) return;
			this.waiting.delete(sessionId);
			if (this.current === sessionId) this.choose(null);
			else this.changed();
		});
		ctx.sessions.observe(({ sessionId, event }) => {
			if (!this.mine.has(sessionId)) return;
			const before = this.waiting.size;
			if (event.type === "approval" && event.approval) this.waiting.add(sessionId);
			else if (event.type === "approval" || event.type === "turnEnd") this.waiting.delete(sessionId);
			if (this.waiting.size !== before) this.changed();
		});
	}

	get id(): string | null {
		return this.current;
	}

	get asking(): boolean {
		return this.waiting.size > 0;
	}

	/** 这个会话是不是运维助手的一段。 */
	async has(sessionId: string): Promise<boolean> {
		await this.ready;
		return this.mine.has(sessionId);
	}

	/**
	 * 对现在这一段说一句；还没有这一段就照 `choice`（人在第一句之前选的模型和档位，只取这两样，不对时 `create` 抛错）开一段。
	 * 主机页上「问 AI」交来的没有 `choice`，用默认模型。
	 */
	async ask(message: string | AssistantMessage, choice?: SessionChoice): Promise<void> {
		await this.ready;
		// 两处同时发第一句（输入框、终端上的「问 AI」）只开一段。
		const id =
			this.current ??
			(await (this.creating ??= this.ctx.sessions
				.create({ ...(choice?.model ? { model: choice.model } : {}), ...(choice?.thinking ? { thinking: choice.thinking } : {}) })
				.then((created) => {
					this.mine.add(created.id);
					this.choose(created.id);
					return created.id;
				})
				.finally(() => (this.creating = undefined))));
		await this.ctx.sessions.send(id, typeof message === "string" ? message : body(message));
	}

	stop(): void {
		if (this.current) this.ctx.sessions.stop(this.current);
	}

	/** 「新开一段」：这一段留在历史里，下一句话开新的一段。 */
	async fresh(): Promise<void> {
		await this.ready;
		this.choose(null);
	}

	async history(): Promise<AssistantSegment[]> {
		await this.ready;
		return (await this.ctx.sessions.list())
			.filter((session) => this.mine.has(session.id) && (session.messageCount ?? 0) > 0)
			.map((session) => ({ id: session.id, title: session.title, updatedAt: session.updatedAt }));
	}

	async open(id: string): Promise<void> {
		if (!this.mine.has(id)) throw new Error("unknown assistant session"); // i18n-exempt：界面只交历史里有的
		this.choose(id);
	}

	async remove(id: string): Promise<void> {
		if (!this.mine.has(id)) return;
		await this.ctx.sessions.delete(id);
	}

	private choose(id: string | null): void {
		if (this.current === id) return;
		this.current = id;
		this.changed();
		void mkdir(this.ctx.dataDir, { recursive: true })
			.then(() => writeFile(this.file, JSON.stringify({ current: id })))
			.catch((error: unknown) => this.ctx.log.warn(`运维助手的当前段没存上：${error instanceof Error ? error.message : String(error)}`));
	}

	private get file(): string {
		return join(this.ctx.dataDir, "assistant.json");
	}

	private async load(): Promise<void> {
		for (const session of await this.ctx.sessions.list()) if (session.owner === this.ctx.name && !session.parentId) this.mine.add(session.id);
		try {
			const saved = JSON.parse(await readFile(this.file, "utf8")) as { current?: unknown };
			if (typeof saved.current === "string" && this.mine.has(saved.current)) this.current = saved.current;
		} catch {}
		this.changed();
	}
}

/** 界面交来的只取正文、气泡上的字和附件：不能借这条路冒充派发方（`origin`）。 */
function body(message: AssistantMessage): SessionMessage {
	return {
		content: message.content,
		...(message.displayText !== undefined ? { displayText: message.displayText } : {}),
		...(message.attachments ? { attachments: message.attachments } : {}),
	};
}
