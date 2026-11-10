/**
 * SFTP 传输：一个文件一个任务，各开一条通道，带进度，随时能取消；断开连接时取消它名下的。只留最近 50 个结束的。
 */

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, posix } from "node:path";
import type { Transfer } from "./api.ts";
import type { Errors } from "./messages.ts";
import type { SshService } from "./ssh.ts";

export class Transfers {
	private readonly items = new Map<string, Transfer>();
	private readonly controllers = new Map<string, AbortController>();

	constructor(
		private readonly deps: {
			ssh: Pick<SshService, "sftpTransfer" | "sftpStat" | "isConnected">;
			changed(): void;
			t(): Errors;
		},
	) {}

	start(connection: string, direction: Transfer["direction"], localPath: string, remotePath: string): string {
		const id = randomUUID();
		const transfer: Transfer = {
			id,
			connection,
			direction,
			name: direction === "upload" ? basename(localPath) : posix.basename(remotePath),
			remotePath,
			localPath,
			bytes: 0,
			total: 0,
			status: "running",
			startedAt: new Date().toISOString(),
		};
		const controller = new AbortController();
		this.items.set(id, transfer);
		this.controllers.set(id, controller);
		this.deps.changed();
		void this.run(transfer, controller);
		return id;
	}

	cancel(id: string): void {
		if (this.items.get(id)?.status === "running") this.controllers.get(id)?.abort();
	}

	cancelConnection(connection: string): void {
		for (const transfer of this.items.values()) if (transfer.connection === connection) this.cancel(transfer.id);
	}

	cancelAll(): void {
		for (const id of this.items.keys()) this.cancel(id);
	}

	list(): Transfer[] {
		return [...this.items.values()].map((item) => ({ ...item })).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
	}

	private async run(transfer: Transfer, controller: AbortController): Promise<void> {
		const t = this.deps.t();
		try {
			if (!this.deps.ssh.isConnected(transfer.connection)) throw new Error(t.notConnected);
			if (transfer.direction === "upload") {
				const info = await stat(transfer.localPath).catch(() => {
					throw new Error(t.localUnreadable);
				});
				if (info.isDirectory()) throw new Error(t.folderTransfer);
				if (!info.isFile()) throw new Error(t.localUnreadable);
				transfer.total = info.size;
			} else {
				const info = await this.deps.ssh.sftpStat(transfer.connection, transfer.remotePath, controller.signal);
				if (info.kind === "directory") throw new Error(t.folderTransfer);
				transfer.total = info.size;
			}
			this.deps.changed();
			await this.deps.ssh.sftpTransfer(transfer.connection, transfer.direction, transfer.localPath, transfer.remotePath, controller.signal, (bytes, total) => {
				transfer.bytes = bytes;
				transfer.total = total;
				this.deps.changed();
			});
			transfer.status = "done";
			transfer.bytes = transfer.total || transfer.bytes;
		} catch (error) {
			transfer.status = controller.signal.aborted || (error instanceof Error && error.name === "AbortError") ? "cancelled" : "failed";
			if (transfer.status === "failed") transfer.error = error instanceof Error ? error.message : String(error);
		} finally {
			transfer.finishedAt = new Date().toISOString();
			this.controllers.delete(transfer.id);
			const finished = [...this.items.values()]
				.filter((item) => item.status !== "running")
				.sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""));
			for (const old of finished.slice(50)) this.items.delete(old.id);
			this.deps.changed();
		}
	}
}
