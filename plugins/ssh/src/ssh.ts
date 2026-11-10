/**
 * SSH 连接：一条连接一个交互 shell（面板里的终端），另外按需开独立的 exec 通道（Agent 的命令、批量命令、资源占用）
 * 和 SFTP 通道（文件面板、传输）。
 *
 * exec 通道在同一条连接上排队，一次一条：不继承终端的目录和环境，也就不会和人正在打的命令抢同一个 shell。SFTP 浏览
 * 用一条长期的通道，不进这个队列，Agent 跑着长命令时文件面板照样能翻；每个传输各开一条，随时能取消。
 */

import { createReadStream, createWriteStream } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import type { Client as ClientType, ClientChannel, SFTPWrapper } from "ssh2";
import type { DirectoryListing, RemoteEntry } from "./api.ts";
import type { Errors } from "./messages.ts";

const MAX_EXEC_BYTES = 512 * 1024;
const TERMINAL_CHUNK_CHARACTERS = 16 * 1024;
const CONNECT_TIMEOUT_MS = 65_000;
const MAX_LISTING = 2000;

export interface SshHooks {
	/** 握手时核对主机指纹；`signal` 在连接放弃时中止。 */
	verifyHost(id: string, host: string, port: number, fingerprint: string, signal: AbortSignal): Promise<boolean>;
	onTerminal(id: string, data: string): void;
	onClosed(id: string, reason: string): void;
}

export interface SshConfig {
	host: string;
	port: number;
	username: string;
	password: string;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number | null;
	/** 输出超过上限被截断；截断时不等结束就收场，退出码不可信。 */
	truncated: boolean;
}

export interface ExclusivePort {
	exec(command: string, timeoutMs: number, signal?: AbortSignal): Promise<ExecResult>;
}

interface Session {
	id: string;
	client: ClientType;
	shell?: ClientChannel;
	ready: boolean;
	closed: boolean;
	lifetime: AbortController;
	queue: Promise<void>;
	browseSftp?: SFTPWrapper;
	browseSftpOpening?: Promise<SFTPWrapper>;
	connectTimer?: ReturnType<typeof setTimeout>;
	rejectConnect(error: Error): void;
}

function formatHostFingerprint(hash: string): string {
	if (!/^[a-f\d]{64}$/i.test(hash)) throw new Error("invalid SHA256 host key hash");
	return `SHA256:${Buffer.from(hash, "hex").toString("base64").replace(/=+$/, "")}`;
}

/** 按字节截断，不切开半个字符。 */
export function truncateUtf8(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return text;
	return new StringDecoder("utf8").write(bytes.subarray(0, maxBytes));
}

function normalizeTimeout(timeoutMs: number): number {
	if (!Number.isFinite(timeoutMs)) return 30_000;
	return Math.min(120_000, Math.max(1_000, Math.trunc(timeoutMs)));
}

function abortError(): Error {
	const error = new Error("aborted");
	error.name = "AbortError";
	return error;
}

function checkAbort(signal: AbortSignal): void {
	if (signal.aborted) throw abortError();
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			reject(abortError());
		};
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
}

function closeChannel(channel: ClientChannel): void {
	try {
		channel.close();
	} catch {}
	try {
		channel.destroy();
	} catch {}
}

function endSftp(sftp: SFTPWrapper): void {
	try {
		sftp.end();
	} catch {}
}

function kindOf(mode: number): RemoteEntry["kind"] {
	const type = mode & 0o170000;
	return type === 0o040000 ? "directory" : type === 0o120000 ? "link" : type === 0o100000 ? "file" : "other";
}

export class SshService {
	private readonly sessions = new Map<string, Session>();

	constructor(
		private readonly hooks: SshHooks,
		private readonly t: () => Errors,
		/** ssh2 在第一次连接时才加载（见 index.ts）。 */
		private readonly createClient: () => ClientType,
	) {}

	connect(id: string, config: SshConfig): Promise<void> {
		if (this.sessions.has(id)) throw new Error(this.t().invalidRequest);
		const t = this.t();
		const client = this.createClient();
		let resolveConnect!: () => void;
		let rejectConnect!: (error: Error) => void;
		const connected = new Promise<void>((resolve, reject) => {
			resolveConnect = resolve;
			rejectConnect = reject;
		});
		const session: Session = { id, client, ready: false, closed: false, lifetime: new AbortController(), queue: Promise.resolve(), rejectConnect };
		this.sessions.set(id, session);
		let hostVerified = false;
		let rejectedKey = false;
		session.connectTimer = setTimeout(() => this.closeSession(session, t.connectTimeout), CONNECT_TIMEOUT_MS);

		client.on("error", (error: Error & { level?: string }) =>
			this.closeSession(session, rejectedKey ? t.hostKeyRejected : error.level === "client-authentication" ? t.authFailed : t.connectFailed),
		);
		client.on("end", () => this.closeSession(session, t.connectionEnded));
		client.on("close", () => this.closeSession(session, t.connectionEnded));
		client.on("ready", () => {
			if (!this.isCurrent(session)) return;
			if (!hostVerified) {
				this.closeSession(session, t.hostKeyRejected);
				return;
			}
			try {
				client.shell({ term: "xterm-256color", cols: 100, rows: 30 }, (error, shell) => {
					if (!this.isCurrent(session)) {
						if (shell) {
							shell.on("error", () => undefined);
							closeChannel(shell);
						}
						return;
					}
					if (error || !shell) {
						this.closeSession(session, t.shellFailed);
						return;
					}
					session.shell = shell;
					shell.on("error", () => this.closeSession(session, t.connectionEnded));
					shell.on("close", () => this.closeSession(session, t.connectionEnded));
					this.pipeTerminal(session, shell);
					this.pipeTerminal(session, shell.stderr);
					session.ready = true;
					clearTimeout(session.connectTimer);
					resolveConnect();
				});
			} catch {
				this.closeSession(session, t.shellFailed);
			}
		});

		try {
			client.connect({
				host: config.host,
				port: config.port,
				username: config.username,
				password: config.password,
				readyTimeout: 60_000,
				keepaliveInterval: 15_000,
				keepaliveCountMax: 3,
				hostHash: "sha256",
				hostVerifier: (key: string | Buffer, verify: (valid: boolean) => void): void => {
					let fingerprint: string;
					try {
						if (typeof key !== "string") throw new Error("expected a hashed host key");
						fingerprint = formatHostFingerprint(key);
					} catch {
						try {
							verify(false);
						} catch {}
						this.closeSession(session, t.hostKeyRejected);
						return;
					}
					const signal = session.lifetime.signal;
					void withAbort(this.hooks.verifyHost(id, config.host, config.port, fingerprint, signal), signal).then(
						(accepted) => {
							const valid = accepted === true && this.isCurrent(session);
							hostVerified = valid;
							rejectedKey = !valid;
							try {
								verify(valid);
							} catch {
								this.closeSession(session, t.hostKeyRejected);
							}
						},
						() => {
							rejectedKey = true;
							try {
								verify(false);
							} catch {}
							this.closeSession(session, t.hostKeyRejected);
						},
					);
				},
			});
		} catch {
			this.closeSession(session, t.connectFailed);
		}
		return connected;
	}

	disconnect(id: string): void {
		const session = this.sessions.get(id);
		if (session) this.closeSession(session, this.t().disconnected);
	}

	disconnectAll(): void {
		for (const session of [...this.sessions.values()]) this.closeSession(session, this.t().disconnected);
	}

	isConnected(id: string): boolean {
		const session = this.sessions.get(id);
		return !!session && session.ready && !session.closed;
	}

	input(id: string, data: string): void {
		const session = this.requireConnected(id);
		session.shell?.write(data);
	}

	resize(id: string, cols: number, rows: number): void {
		const session = this.requireConnected(id);
		if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 1000 || rows > 1000) return;
		session.shell?.setWindow(rows, cols, 0, 0);
	}

	/** 在这条连接的 exec 队列里跑一条命令（资源占用用它）。 */
	exec(id: string, command: string, timeoutMs: number, signal: AbortSignal): Promise<ExecResult> {
		return this.enqueue(id, signal, (session, operation) => this.directExec(session, command, normalizeTimeout(timeoutMs), operation));
	}

	/**
	 * 占住这条连接的 exec 队列，回调里核对完身份再执行：Agent 的命令和批量命令先确认连接还是批准时那一条，
	 * 再发出去。排队时取消就直接退出；开始以后要等回调自己收尾，好把「已经发出去、结果不知道」说清楚。
	 */
	withExclusive<T>(id: string, signal: AbortSignal, callback: (port: ExclusivePort) => Promise<T>): Promise<T> {
		return this.enqueue(
			id,
			signal,
			async (session, operation) => {
				let active = true;
				const port: ExclusivePort = {
					exec: (command, timeoutMs, extra) => {
						const combined = extra ? AbortSignal.any([operation, extra]) : operation;
						checkAbort(combined);
						if (!active || !this.isCurrent(session) || !session.ready) throw new Error(this.t().notConnected);
						return this.directExec(session, command, normalizeTimeout(timeoutMs), combined);
					},
				};
				try {
					return await callback(port);
				} finally {
					active = false;
				}
			},
			true,
		);
	}

	private directExec(session: Session, command: string, timeout: number, signal: AbortSignal): Promise<ExecResult> {
		const t = this.t();
		return new Promise<ExecResult>((resolve, reject) => {
			let channel: ClientChannel | undefined;
			let settled = false;
			let code: number | null = null;
			let bytes = 0;
			let truncated = false;
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				if (channel) closeChannel(channel);
				if (error) {
					reject(error);
					return;
				}
				resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), code, truncated });
			};
			const onAbort = () => finish(abortError());
			const timer = setTimeout(() => finish(new Error(t.commandTimeout)), timeout);
			const capture = (chunks: Buffer[], data: Buffer | string) => {
				if (settled) return;
				const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
				const allowed = Math.min(buffer.length, MAX_EXEC_BYTES - bytes);
				if (allowed > 0) {
					chunks.push(Buffer.from(buffer.subarray(0, allowed)));
					bytes += allowed;
				}
				if (allowed < buffer.length) {
					truncated = true;
					finish();
				}
			};
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) {
				onAbort();
				return;
			}
			try {
				session.client.exec(command, (error, stream) => {
					if (settled) {
						if (stream) {
							stream.on("error", () => undefined);
							closeChannel(stream);
						}
						return;
					}
					if (error || !stream) {
						finish(new Error(t.execFailed));
						return;
					}
					channel = stream;
					stream.on("error", () => finish(new Error(t.execFailed)));
					stream.on("exit", (exitCode: number | null) => {
						if (Number.isInteger(exitCode)) code = exitCode;
					});
					// 通道关了不说明远端进程退出了；退出码以 exit 事件为准，没有就是不知道。
					stream.on("close", () => finish());
					stream.on("data", (data: Buffer | string) => capture(stdout, data));
					stream.stderr.on("data", (data: Buffer | string) => capture(stderr, data));
				});
			} catch {
				finish(new Error(t.execFailed));
			}
		});
	}

	async sftpRealpath(id: string, path: string, signal: AbortSignal): Promise<string> {
		return this.browse(id, signal, (sftp, operation) => this.sftpCall<string>(operation, this.t().sftpFailed, (callback) => sftp.realpath(path, callback)));
	}

	async sftpReaddir(id: string, path: string, signal: AbortSignal): Promise<DirectoryListing> {
		const items = await this.browse(id, signal, (sftp, operation) =>
			this.sftpCall<{ filename: string; attrs: { mode?: number; size?: number; mtime?: number } }[]>(operation, this.t().sftpFailed, (callback) =>
				sftp.readdir(path, callback),
			),
		);
		const entries: RemoteEntry[] = items.map((item) => {
			const mode = Number(item.attrs?.mode) || 0;
			const kind = kindOf(mode);
			const bits = mode & 0o777;
			const permissions = `${kind === "directory" ? "d" : kind === "link" ? "l" : "-"}${[6, 3, 0]
				.map((offset) => `${bits & (4 << offset) ? "r" : "-"}${bits & (2 << offset) ? "w" : "-"}${bits & (1 << offset) ? "x" : "-"}`)
				.join("")}`;
			const mtime = Number(item.attrs?.mtime);
			return {
				name: item.filename,
				path: posix.join(path, item.filename),
				kind,
				size: Number(item.attrs?.size) || 0,
				modifiedAt: Number.isFinite(mtime) && mtime > 0 ? new Date(mtime * 1000).toISOString() : null,
				permissions,
			};
		});
		entries.sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name));
		return { path, entries: entries.slice(0, MAX_LISTING), truncated: entries.length > MAX_LISTING };
	}

	async sftpMkdir(id: string, path: string, signal: AbortSignal): Promise<void> {
		await this.browse(id, signal, (sftp, operation) => this.sftpCall<void>(operation, this.t().sftpFailed, (callback) => sftp.mkdir(path, callback)));
	}

	async sftpRename(id: string, from: string, to: string, signal: AbortSignal): Promise<void> {
		await this.browse(id, signal, (sftp, operation) => this.sftpCall<void>(operation, this.t().sftpFailed, (callback) => sftp.rename(from, to, callback)));
	}

	async sftpUnlink(id: string, path: string, signal: AbortSignal): Promise<void> {
		await this.browse(id, signal, (sftp, operation) => this.sftpCall<void>(operation, this.t().sftpFailed, (callback) => sftp.unlink(path, callback)));
	}

	async sftpRmdir(id: string, path: string, signal: AbortSignal): Promise<void> {
		await this.browse(id, signal, (sftp, operation) => this.sftpCall<void>(operation, this.t().directoryNotEmpty, (callback) => sftp.rmdir(path, callback)));
	}

	async sftpStat(id: string, path: string, signal: AbortSignal): Promise<{ size: number; kind: RemoteEntry["kind"] }> {
		const attrs = await this.browse(id, signal, (sftp, operation) =>
			this.sftpCall<{ mode?: number; size?: number }>(operation, this.t().sftpFailed, (callback) => sftp.lstat(path, callback)),
		);
		return { size: Number(attrs.size) || 0, kind: kindOf(Number(attrs.mode) || 0) };
	}

	/**
	 * 一次传输，自己开一条 SFTP 通道。下载先写 `.part`，传完才改名，取消或失败删掉它，不留半个文件冒充下好的。
	 */
	async sftpTransfer(
		id: string,
		direction: "upload" | "download",
		localPath: string,
		remotePath: string,
		signal: AbortSignal,
		onProgress: (bytes: number, total: number) => void,
	): Promise<void> {
		const t = this.t();
		const session = this.requireConnected(id);
		const operation = AbortSignal.any([signal, session.lifetime.signal]);
		checkAbort(operation);
		let sftp: SFTPWrapper | undefined;
		let source: (NodeJS.ReadableStream & { destroy(error?: Error): void }) | undefined;
		let destination: (NodeJS.WritableStream & { destroy(error?: Error): void }) | undefined;
		const partPath = `${localPath}.part`;
		let bytes = 0;
		let total = 0;
		let last = 0;
		let transfer: Promise<void> | undefined;
		const report = (final = false) => {
			const now = Date.now();
			if (!final && now - last < 200) return;
			last = now;
			try {
				onProgress(bytes, total);
			} catch {}
		};
		try {
			sftp = await this.openSftp(session, operation);
			if (direction === "upload") {
				const file = await open(localPath, "r");
				try {
					total = (await file.stat()).size;
				} finally {
					await file.close();
				}
				source = createReadStream(localPath);
				destination = sftp.createWriteStream(remotePath, { flags: "w", mode: 0o644 });
			} else {
				const remote = sftp;
				const attrs = await this.sftpCall<{ mode?: number; size?: number }>(operation, t.sftpFailed, (callback) => remote.lstat(remotePath, callback));
				if (kindOf(Number(attrs.mode) || 0) === "directory") throw new Error(t.folderTransfer);
				total = Number(attrs.size) || 0;
				source = sftp.createReadStream(remotePath);
				destination = createWriteStream(partPath, { flags: "wx" });
			}
			source.on("data", (chunk: Buffer | string) => {
				bytes += Buffer.byteLength(chunk);
				report();
			});
			transfer = pipeline(source, destination, { signal: operation });
			await withAbort(transfer, operation);
			if (direction === "download") await rename(partPath, localPath);
			report(true);
		} catch (error) {
			if (operation.aborted) {
				source?.destroy(abortError());
				destination?.destroy(abortError());
				await transfer?.catch(() => undefined);
			}
			if (direction === "download") await rm(partPath, { force: true }).catch(() => undefined);
			if (operation.aborted) throw abortError();
			throw this.sftpError(error, direction === "upload" ? t.uploadFailed : t.downloadFailed);
		} finally {
			source?.destroy();
			destination?.destroy();
			if (sftp) endSftp(sftp);
		}
	}

	private async browse<T>(id: string, signal: AbortSignal, operation: (sftp: SFTPWrapper, signal: AbortSignal) => Promise<T>): Promise<T> {
		const session = this.requireConnected(id);
		const combined = AbortSignal.any([signal, session.lifetime.signal]);
		checkAbort(combined);
		return operation(await this.browseSftp(session, combined), combined);
	}

	private browseSftp(session: Session, signal: AbortSignal): Promise<SFTPWrapper> {
		if (session.browseSftp) return Promise.resolve(session.browseSftp);
		if (!session.browseSftpOpening) {
			session.browseSftpOpening = this.openSftp(session, session.lifetime.signal)
				.then((sftp) => {
					if (!this.isCurrent(session)) {
						endSftp(sftp);
						throw new Error(this.t().notConnected);
					}
					session.browseSftp = sftp;
					const drop = () => {
						if (session.browseSftp === sftp) session.browseSftp = undefined;
					};
					sftp.on("close", drop);
					sftp.on("end", drop);
					sftp.on("error", drop);
					return sftp;
				})
				.finally(() => {
					session.browseSftpOpening = undefined;
				});
		}
		return withAbort(session.browseSftpOpening, signal);
	}

	private sftpCall<T>(signal: AbortSignal, fallback: string, start: (callback: (error?: Error | null, value?: T) => void) => void): Promise<T> {
		checkAbort(signal);
		return withAbort(
			new Promise<T>((resolve, reject) => {
				try {
					start((error, value) => (error ? reject(this.sftpError(error, fallback)) : resolve(value as T)));
				} catch (error) {
					reject(this.sftpError(error, fallback));
				}
			}),
			signal,
		);
	}

	private sftpError(error: unknown, fallback: string): Error {
		const t = this.t();
		const code = (error as { code?: number | string } | null)?.code;
		if (code === 2 || code === "2" || code === "ENOENT") return new Error(t.pathMissing);
		if (code === 3 || code === "3" || code === "EACCES" || code === "EPERM") return new Error(t.permissionDenied);
		if (code === 4 || code === "EEXIST") return new Error(t.pathExists);
		if (error instanceof Error && error.name === "AbortError") return abortError();
		// 已经是给人看的话（本地文件读不到、文件夹不能传）就原样交出去。
		return error instanceof Error && Object.values(t).includes(error.message) ? error : new Error(fallback);
	}

	private isCurrent(session: Session): boolean {
		return !session.closed && this.sessions.get(session.id) === session;
	}

	private requireConnected(id: string): Session {
		const session = this.sessions.get(id);
		if (!session || !session.ready || session.closed) throw new Error(this.t().notConnected);
		return session;
	}

	private closeSession(session: Session, reason: string): void {
		if (session.closed) return;
		session.closed = true;
		session.ready = false;
		clearTimeout(session.connectTimer);
		const current = this.sessions.get(session.id) === session;
		if (current) this.sessions.delete(session.id);
		session.rejectConnect(new Error(reason));
		session.lifetime.abort();
		if (session.shell) closeChannel(session.shell);
		if (session.browseSftp) endSftp(session.browseSftp);
		try {
			session.client.destroy();
		} catch {}
		if (current) {
			try {
				this.hooks.onClosed(session.id, reason);
			} catch {}
		}
	}

	private pipeTerminal(session: Session, stream: NodeJS.ReadableStream): void {
		const decoder = new StringDecoder("utf8");
		const emit = (text: string) => {
			for (let offset = 0; offset < text.length && this.isCurrent(session);) {
				let end = Math.min(offset + TERMINAL_CHUNK_CHARACTERS, text.length);
				const last = text.charCodeAt(end - 1);
				if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
				try {
					this.hooks.onTerminal(session.id, text.slice(offset, end));
				} catch {}
				offset = end;
			}
		};
		stream.on("data", (data: Buffer | string) => {
			if (this.isCurrent(session)) emit(typeof data === "string" ? data : decoder.write(data));
		});
		stream.on("end", () => emit(decoder.end()));
	}

	private enqueue<T>(id: string, signal: AbortSignal, operation: (session: Session, signal: AbortSignal) => Promise<T>, waitForActive = false): Promise<T> {
		const session = this.requireConnected(id);
		const combined = AbortSignal.any([signal, session.lifetime.signal]);
		checkAbort(combined);
		let started = false;
		const result = session.queue.then(() => {
			checkAbort(combined);
			if (!this.isCurrent(session) || !session.ready) throw new Error(this.t().notConnected);
			started = true;
			return operation(session, combined);
		});
		session.queue = result.then(
			() => undefined,
			() => undefined,
		);
		if (!waitForActive) return withAbort(result, combined);
		return new Promise<T>((resolve, reject) => {
			const onAbort = () => {
				if (started) return;
				combined.removeEventListener("abort", onAbort);
				reject(abortError());
			};
			result.then(
				(value) => {
					combined.removeEventListener("abort", onAbort);
					resolve(value);
				},
				(error: unknown) => {
					combined.removeEventListener("abort", onAbort);
					reject(error);
				},
			);
			combined.addEventListener("abort", onAbort, { once: true });
			if (combined.aborted) onAbort();
		});
	}

	private openSftp(session: Session, signal: AbortSignal): Promise<SFTPWrapper> {
		const t = this.t();
		return new Promise<SFTPWrapper>((resolve, reject) => {
			let settled = false;
			const onAbort = () => {
				if (settled) return;
				settled = true;
				reject(abortError());
			};
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) {
				onAbort();
				return;
			}
			try {
				session.client.sftp((error, sftp) => {
					if (sftp) sftp.on("error", () => undefined);
					if (settled) {
						if (sftp) endSftp(sftp);
						return;
					}
					settled = true;
					signal.removeEventListener("abort", onAbort);
					if (error || !sftp) reject(new Error(t.sftpOpenFailed));
					else resolve(sftp);
				});
			} catch {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				reject(new Error(t.sftpOpenFailed));
			}
		});
	}
}
