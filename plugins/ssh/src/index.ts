/**
 * plume.ssh 的逻辑入口：主机库、SSH 连接、SFTP 传输、资源占用、批量命令和 Excel 导入都在 agent 进程里，经
 * ctx.serve 开给界面；主机页右边的运维助手见 assistant.ts，它用的 `ssh_sessions`、`ssh_run` 见 tools.ts。
 *
 * 密码只在这里用：界面拿到的主机只知道存没存密码，交给模型和画进卡片的远端输出都先换掉已存的密码。
 */

import { createRequire } from "node:module";
import { isAbsolute, join, posix } from "node:path";
import type { Plugin } from "@plume/contract";
import type { SshApi, SshState, TerminalOutput } from "./api.ts";
import { Assistant } from "./assistant.ts";
import { BatchCommands } from "./batch.ts";
import { Connections } from "./connections.ts";
import { HostImports, writeTemplate } from "./import.ts";
import { listen } from "./listen.ts";
import { MESSAGES } from "./messages.ts";
import { ResourceMonitor } from "./monitor.ts";
import { availablePath, downloadsDir } from "./paths.ts";
import { cleanTerminalText, maskSecrets } from "./secrets.ts";
import { SshService } from "./ssh.ts";
import { registerTools } from "./tools.ts";
import { Transfers } from "./transfers.ts";
import { Vault } from "./vault.ts";

/** 浏览、改名这类一下就该回来的 SFTP 操作，等这么久还没回来就算失败。 */
const SFTP_TIMEOUT_MS = 30_000;
const MAX_SCRUB = 256 * 1024;

export default {
	name: "plume.ssh",
	inject: ["secrets"],
	async apply(ctx) {
		const text = () => MESSAGES[ctx.locale()];
		const errors = () => text().errors;
		const vault = await Vault.open(ctx.dataDir, ctx.use("secrets"), errors, (aside) => ctx.log.warn(`主机库解不开，已挪到 ${aside}，从空的主机库开始`));

		/*
		 * ssh2 在第一次连接时才加载，不在 apply 里：它带着可选的原生模块，万一加载出错，坏的只是连接这一件事，
		 * 主机库、导入照样能用。
		 */
		const require = createRequire(import.meta.url);
		let ssh2: typeof import("ssh2") | undefined;
		const createClient = () => {
			if (!ssh2) {
				try {
					ssh2 = require("ssh2") as typeof import("ssh2");
				} catch (error) {
					ctx.log.error(`ssh2 加载失败：${error instanceof Error ? error.message : String(error)}`);
					throw new Error(errors().unavailable, { cause: error });
				}
			}
			return new ssh2.Client();
		};

		const listeners = new Set<() => void>();
		const changed = () => {
			for (const listener of listeners) listener();
		};
		let monitor: ResourceMonitor | undefined;
		let transfers: Transfers | undefined;
		const connections: Connections = new Connections({
			vault,
			ssh: () => ssh,
			changed,
			opened: () => monitor?.setConnections(connections.connectedIds()),
			closed: (id) => {
				transfers?.cancelConnection(id);
				monitor?.setConnections(connections.connectedIds());
			},
			t: errors,
		});
		const ssh: SshService = new SshService(
			{
				verifyHost: (id, host, port, fingerprint, signal) => connections.verifyHost(id, host, port, fingerprint, signal),
				onTerminal: (id, data) => connections.onTerminal(id, data),
				onClosed: (id, reason) => connections.onClosed(id, reason),
			},
			errors,
			createClient,
		);
		monitor = new ResourceMonitor({
			exec: (id, command, timeoutMs, signal) => ssh.exec(id, command, timeoutMs, signal),
			emit: (id, stats) => connections.setStats(id, stats),
		});
		transfers = new Transfers({ ssh, changed, t: errors });
		const scrub = (value: string) => maskSecrets(cleanTerminalText(vault.redact(value)));
		const batch = new BatchCommands({ ssh, target: (id) => connections.target(id), scrub, changed, t: errors });
		const imports = new HostImports({ exists: (fields) => vault.hasHost(fields), t: text });

		ctx.effect(() => {
			batch.stop();
			monitor?.stop();
			transfers?.cancelAll();
			imports.clear();
			connections.closeAll();
			ssh.disconnectAll();
		});

		const assistant = new Assistant(ctx, changed);
		registerTools(ctx, { connections, ssh: () => ssh, vault, scrub, isAssistant: (sessionId) => assistant.has(sessionId), t: text });

		const state = (): SshState => ({
			hosts: vault.hosts(),
			groups: vault.groups(),
			connections: connections.views(),
			monitoring: monitor?.enabled ?? false,
			batch: batch.snapshot(),
			transfers: transfers?.list() ?? [],
			assistant: assistant.id,
			asking: assistant.asking,
		});
		const signal = () => AbortSignal.timeout(SFTP_TIMEOUT_MS);
		const remotePath = (value: unknown) => {
			if (typeof value !== "string" || !value.startsWith("/") || value.length > 4096 || value.includes("\0")) throw new Error(errors().invalidPath);
			return value;
		};
		const entryName = (value: unknown) => {
			if (typeof value !== "string") throw new Error(errors().invalidEntryName);
			const name = value.trim();
			if (!name || name === "." || name === ".." || name.length > 255 || /[/\0]/.test(name)) throw new Error(errors().invalidEntryName);
			return name;
		};

		const api: SshApi = {
			async *watch(call) {
				const updates = listen<null>(call.signal, (emit) => {
					emit(null);
					const listener = () => emit(null);
					listeners.add(listener);
					return () => listeners.delete(listener);
				});
				// 每次都是完整的一份，攒下好几次变化时只推一份最新的。
				for await (const _batch of updates) yield state();
			},

			saveHost: async (input) => {
				await vault.saveHost(input);
				changed();
			},
			setFavorite: async (id, favorite) => {
				await vault.setFavorite(id, favorite);
				changed();
			},
			deleteHost: async (id) => {
				if (connections.views().some((view) => view.serverId === id && view.state !== "closed")) throw new Error(errors().hostInUse);
				await vault.deleteHost(id);
				changed();
			},
			saveGroup: async (group) => {
				await vault.saveGroup(group);
				changed();
			},
			deleteGroup: async (id) => {
				await vault.deleteGroup(id);
				changed();
			},
			moveHosts: async (ids, groupId) => {
				await vault.moveHosts(ids, groupId);
				changed();
			},

			connect: (tab, serverId) => connections.connect(tab, serverId),
			trust: (tab, accept) => connections.trust(tab, accept),
			disconnect: (tab) => connections.disconnect(tab),
			close: (tab) => connections.close(tab),
			async *attach(id, call) {
				const output = listen<TerminalOutput>(call.signal, (emit, end) => {
					const detach = connections.attach(id, (event) => {
						emit(event);
						if (event.type === "end") end();
					});
					if (!detach) {
						emit({ type: "end" });
						end();
					}
					return detach ?? (() => undefined);
				});
				for await (const events of output) {
					// 一批里连着的输出合成一条推过去。
					let pending = "";
					for (const event of events) {
						if (event.type === "data") pending += event.data;
						else {
							if (pending) yield { type: "data", data: pending };
							pending = "";
							yield event;
						}
					}
					if (pending) yield { type: "data", data: pending };
				}
			},
			write: (id, data) => {
				if (typeof data === "string" && data.length <= 65_536) ssh.input(id, data);
			},
			resize: (id, cols, rows) => ssh.resize(id, cols, rows),
			setMonitoring: (enabled) => {
				monitor?.setEnabled(enabled === true);
				changed();
			},
			scrub: (value) => scrub(typeof value === "string" ? value.slice(-MAX_SCRUB) : ""),

			sftpHome: (id) => ssh.sftpRealpath(id, ".", signal()),
			sftpList: (id, path) => ssh.sftpReaddir(id, remotePath(path), signal()),
			sftpMkdir: (id, directory, name) => ssh.sftpMkdir(id, posix.join(remotePath(directory), entryName(name)), signal()),
			sftpRename: async (id, path, name) => {
				const from = remotePath(path);
				await ssh.sftpRename(id, from, posix.join(posix.dirname(from), entryName(name)), signal());
			},
			// 只删文件和空文件夹，不递归：在远端一口气删掉一棵树的事交给人自己在终端里做。
			sftpRemove: async (id, path, kind) => {
				const target = remotePath(path);
				if (target === "/") throw new Error(errors().invalidPath);
				if (kind === "directory") await ssh.sftpRmdir(id, target, signal());
				else await ssh.sftpUnlink(id, target, signal());
			},
			upload: async (id, directory, localPaths) => {
				const target = remotePath(directory);
				if (!Array.isArray(localPaths) || localPaths.length === 0 || localPaths.length > 100) throw new Error(errors().invalidRequest);
				if (localPaths.some((file) => typeof file !== "string" || !isAbsolute(file))) throw new Error(errors().invalidRequest);
				for (const file of localPaths) transfers?.start(id, "upload", file, posix.join(target, file.split(/[\\/]/).pop()!));
			},
			download: async (id, path) => {
				const source = remotePath(path);
				const local = await availablePath(join(downloadsDir(), posix.basename(source) || "download"));
				transfers?.start(id, "download", local, source);
				return local;
			},
			cancelTransfer: (id) => transfers?.cancel(id),

			batchTargets: (ids) => {
				if (!Array.isArray(ids)) throw new Error(errors().invalidRequest);
				return ids.map((id) => connections.target(id));
			},
			startBatch: (input, confirmed) => batch.start(input, confirmed),
			stopBatch: (id) => batch.stop(id),

			previewImport: (fileName, data) => imports.preview(fileName, data),
			commitImport: async (input) => {
				const selected = imports.selected(input);
				const result = await vault.importHosts(selected, { groupId: input.groupId, useSheetGroups: input.useSheetGroups === true });
				imports.discard(input.previewId);
				changed();
				return result;
			},
			discardImport: (id) => imports.discard(id),
			writeTemplate: () => writeTemplate(downloadsDir(), text()),

			ask: (message, choice) => assistant.ask(message, choice),
			stopAssistant: () => assistant.stop(),
			newAssistant: () => assistant.fresh(),
			history: () => assistant.history(),
			openAssistant: (id) => assistant.open(String(id)),
			deleteAssistant: (id) => assistant.remove(String(id)),
		};
		ctx.serve(api);
	},
} satisfies Plugin;
