/**
 * 人工批量命令：在选中的几条已有连接上各执行一次同一条命令。不经 Agent，命令和结果不进任何会话、不交给模型。
 *
 * 人先在确认框里核对每条连接的账号、地址、指纹和完整命令；这里拿确认时的那份和现在的比，对不上就不发。每条连接
 * 真正轮到时（排在 exec 队列里）再比一次：不重连、不拿新连上的替换。失败不取消别的目标，不重试、不回滚。只在内存里
 * 留最近一次，退出就没了。
 */

import { randomUUID } from "node:crypto";
import type { BatchInput, BatchResult, BatchRun, BatchTarget } from "./api.ts";
import type { Errors } from "./messages.ts";
import { type SshService, truncateUtf8 } from "./ssh.ts";

const SHOWN_BYTES = 32 * 1024;
const IDENTITY = ["connection", "serverId", "host", "port", "username", "fingerprint"] as const;

export function sameTarget(a: BatchTarget, b: BatchTarget): boolean {
	return IDENTITY.every((key) => a[key] === b[key]);
}

export function validateBatchInput(value: unknown, t: Errors): BatchInput {
	if (!value || typeof value !== "object") throw new Error(t.invalidRequest);
	const input = value as Partial<BatchInput>;
	const connections = input.connections;
	if (!Array.isArray(connections) || connections.length === 0 || connections.length > 32 || new Set(connections).size !== connections.length)
		throw new Error(t.batchTargets);
	if (connections.some((id) => typeof id !== "string" || !id)) throw new Error(t.batchTargets);
	if (typeof input.command !== "string" || !input.command.trim() || input.command.length > 32_000 || input.command.includes("\0"))
		throw new Error(t.invalidCommand);
	const { concurrency, timeoutSeconds } = input;
	if (typeof concurrency !== "number" || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error(t.batchConcurrency);
	if (typeof timeoutSeconds !== "number" || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120) throw new Error(t.batchTimeout);
	return { connections: [...connections], command: input.command, concurrency, timeoutSeconds };
}

export class BatchCommands {
	private last: BatchRun | null = null;
	private active?: { run: BatchRun; controller: AbortController };

	constructor(
		private readonly deps: {
			ssh: Pick<SshService, "withExclusive">;
			/** 连接现在的身份；断了、主机改过就抛错。 */
			target(connection: string): BatchTarget;
			/** 结果里的已存密码换掉、控制序列去掉。 */
			scrub(text: string): string;
			changed(): void;
			t(): Errors;
		},
	) {}

	get running(): boolean {
		return this.active !== undefined;
	}

	snapshot(): BatchRun | null {
		return this.last ? structuredClone(this.last) : null;
	}

	start(value: unknown, confirmed: BatchTarget[]): string {
		const t = this.deps.t();
		if (this.active) throw new Error(t.batchBusy);
		const input = validateBatchInput(value, t);
		const targets = input.connections.map((id) => Object.freeze({ ...this.deps.target(id) }));
		if (!Array.isArray(confirmed) || confirmed.length !== targets.length || targets.some((target, index) => !sameTarget(target, confirmed[index]!)))
			throw new Error(t.batchChanged);
		const run: BatchRun = {
			id: randomUUID(),
			command: input.command,
			concurrency: input.concurrency,
			timeoutSeconds: input.timeoutSeconds,
			status: "running",
			createdAt: new Date().toISOString(),
			targets: targets.map((target) => ({ ...target, status: "queued", stdout: "", stderr: "", code: null, truncated: false })),
		};
		const controller = new AbortController();
		this.last = run;
		this.active = { run, controller };
		this.deps.changed();
		void this.execute(run, controller, targets);
		return run.id;
	}

	stop(id?: string): void {
		const active = this.active;
		if (!active || (id !== undefined && active.run.id !== id)) return;
		active.run.status = "stopping";
		active.controller.abort();
		this.deps.changed();
	}

	private async execute(run: BatchRun, controller: AbortController, targets: readonly BatchTarget[]): Promise<void> {
		try {
			let next = 0;
			const worker = async () => {
				while (!controller.signal.aborted && next < targets.length) {
					const index = next++;
					await this.perform(run, controller, targets[index]!, run.targets[index]!);
				}
			};
			await Promise.all(Array.from({ length: Math.min(run.concurrency, targets.length) }, worker));
		} finally {
			for (const result of run.targets) {
				if (result.status !== "queued") continue;
				result.status = "cancelled";
				result.note = "notDispatched";
				result.finishedAt = new Date().toISOString();
			}
			run.status = controller.signal.aborted ? "cancelled" : "completed";
			run.finishedAt = new Date().toISOString();
			if (this.active?.run === run) this.active = undefined;
			this.deps.changed();
		}
	}

	private async perform(run: BatchRun, controller: AbortController, frozen: BatchTarget, result: BatchResult): Promise<void> {
		let dispatched = false;
		try {
			await this.deps.ssh.withExclusive(frozen.connection, controller.signal, async (port) => {
				if (controller.signal.aborted) return;
				let current: BatchTarget;
				try {
					current = this.deps.target(frozen.connection);
				} catch {
					result.status = "blocked";
					result.note = "disconnected";
					return;
				}
				if (!sameTarget(current, frozen)) {
					result.status = "blocked";
					result.note = "identity";
					return;
				}
				result.status = "running";
				result.startedAt = new Date().toISOString();
				this.deps.changed();
				dispatched = true;
				const executed = await port.exec(run.command, run.timeoutSeconds * 1000, controller.signal);
				const stdout = this.deps.scrub(executed.stdout);
				const stderr = this.deps.scrub(executed.stderr);
				result.stdout = truncateUtf8(stdout, SHOWN_BYTES);
				result.stderr = truncateUtf8(stderr, SHOWN_BYTES);
				result.truncated = executed.truncated || result.stdout !== stdout || result.stderr !== stderr;
				result.code = executed.code;
				if (executed.truncated || executed.code === null) {
					result.status = "unknown";
					result.note = executed.truncated ? "outputLimit" : "unknown";
				} else result.status = executed.code === 0 ? "succeeded" : "failed";
			});
		} catch {
			result.status = dispatched ? "unknown" : controller.signal.aborted ? "cancelled" : "blocked";
			result.note = dispatched ? "unknown" : controller.signal.aborted ? "notDispatched" : "disconnected";
		} finally {
			result.finishedAt = new Date().toISOString();
			this.deps.changed();
		}
	}
}
