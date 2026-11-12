/**
 * 主机库：主机（连同密码）、分组和核对过的主机指纹，整份经 `ctx.secrets` 加密存在插件数据目录的 `hosts.enc`。
 *
 * 挡的是备份、同步盘、搜文件时顺手带出去明文密码，不挡这台机器上同一个用户。密码只在逻辑入口里用，
 * 交给界面的视图只说存没存。
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginSecrets } from "@plume/contract";
import type { HostGroup, HostInput, HostProfile } from "./api.ts";
import type { Errors } from "./messages.ts";

export interface StoredHost {
	id: string;
	name: string;
	host: string;
	port: number;
	username: string;
	password: string;
	groupId: string | null;
	tags: string[];
	favorite: boolean;
	lastConnectedAt: string | null;
}

/** 导入、编辑都要过的那几项：名称、地址、端口、账号、密码。 */
export interface HostFields {
	name: string;
	host: string;
	port: number;
	username: string;
	password: string;
}

interface VaultData {
	version: 1;
	hosts: StoredHost[];
	groups: HostGroup[];
	/** `[host 小写, port]` 的 JSON → `SHA256:…`。 */
	fingerprints: Record<string, string>;
}

const MAX_TAGS = 12;

export function hostIdentity(host: Pick<HostFields, "host" | "port" | "username">): string {
	return JSON.stringify([host.host.toLowerCase(), host.port, host.username]);
}

function required(value: unknown, error: string, max: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new Error(error);
	return value.trim();
}

export function validateHostFields(input: { name: unknown; host: unknown; port: unknown; username: unknown; password: unknown }, t: Errors): HostFields {
	const name = required(input.name, t.invalidName, 80);
	const host = required(input.host, t.invalidHost, 253);
	if (/\s|[/\\]/.test(host)) throw new Error(t.invalidHost);
	const username = required(input.username, t.invalidUsername, 256);
	if (typeof input.port !== "number" || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error(t.invalidPort);
	if (typeof input.password !== "string" || !input.password || input.password.length > 8192 || input.password.includes("\0"))
		throw new Error(t.invalidPassword);
	return { name, host, port: input.port, username, password: input.password };
}

/** 标签是筛选用的短词：去掉大小写不同的重复，保留顺序。 */
function normalizeTags(value: unknown, t: Errors): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(t.invalidTags);
	const result: string[] = [];
	for (const item of value) {
		const tag = required(item, t.invalidTags, 32).replace(/\s+/g, " ");
		// i18n-exempt：标签里不许有半角、全角逗号（它们是输入时的分隔符），不是界面文字。
		if (/[,，\0]/.test(tag)) throw new Error(t.invalidTags);
		if (!result.some((existing) => existing.toLowerCase() === tag.toLowerCase())) result.push(tag);
	}
	if (result.length > MAX_TAGS) throw new Error(t.invalidTags);
	return result;
}

const EMPTY: VaultData = { version: 1, hosts: [], groups: [], fingerprints: {} };

export class Vault {
	/** 读都从这一份同步拿；改动排队落盘，写成功了才换上新的。 */
	private data: VaultData;
	private writing: Promise<unknown> = Promise.resolve();

	private constructor(
		private readonly file: string,
		private readonly secrets: PluginSecrets,
		private readonly t: () => Errors,
		data: VaultData,
	) {
		this.data = data;
	}

	/**
	 * 打开主机库。解不开的（加密用的钥匙丢了、换过）挪到旁边、从空的开始，不在原处被新内容盖掉；
	 * 钥匙文件读不出来时 `unseal` 抛错，插件加载失败，文件原样留着。
	 */
	static async open(dir: string, secrets: PluginSecrets, t: () => Errors, movedAside: (path: string) => void): Promise<Vault> {
		const file = join(dir, "hosts.enc");
		const sealed = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : Promise.reject(error)));
		if (sealed === null) return new Vault(file, secrets, t, structuredClone(EMPTY));
		const raw = await secrets.unseal(sealed.trim());
		if (raw === null) {
			const aside = `${file}.unreadable-${Date.now()}`;
			await rename(file, aside);
			movedAside(aside);
			return new Vault(file, secrets, t, structuredClone(EMPTY));
		}
		const loaded = JSON.parse(raw) as VaultData;
		if (loaded.version !== 1 || !Array.isArray(loaded.hosts) || !Array.isArray(loaded.groups) || typeof loaded.fingerprints !== "object")
			throw new Error("hosts.enc has an unknown format");
		return new Vault(file, secrets, t, loaded);
	}

	/** 一次改动：在队里按当时最新的数据算出下一份（算的时候抛错就是这次改动不成立），加密写盘后换上。 */
	private commit(change: (data: VaultData) => VaultData): Promise<void> {
		const run = this.writing.then(async () => {
			const next = change(this.data);
			const temp = `${this.file}.${randomUUID()}.tmp`;
			try {
				await mkdir(join(this.file, ".."), { recursive: true });
				await writeFile(temp, await this.secrets.seal(JSON.stringify(next)), { mode: 0o600 });
				await rename(temp, this.file);
				this.data = next;
			} finally {
				await rm(temp, { force: true });
			}
		});
		this.writing = run.catch(() => {});
		return run;
	}

	host(id: string): StoredHost {
		return Vault.find(this.data, id, this.t);
	}

	private static find(data: VaultData, id: string, t: () => Errors): StoredHost {
		const host = data.hosts.find((entry) => entry.id === id);
		if (!host) throw new Error(t().hostMissing);
		return { ...host, tags: [...host.tags] };
	}

	hosts(): HostProfile[] {
		return this.data.hosts.map(({ password, tags, ...host }) => ({ ...host, tags: [...tags], hasPassword: Boolean(password) }));
	}

	groups(): HostGroup[] {
		return this.data.groups.map((group) => ({ ...group }));
	}

	saveHost(input: HostInput): Promise<void> {
		return this.commit((data) => {
			const t = this.t();
			const previous = input.id ? Vault.find(data, input.id, this.t) : undefined;
			const fields = validateHostFields({ ...input, password: input.password || previous?.password || "" }, t);
			const groupId = this.checkedGroup(data, input.groupId === undefined ? (previous?.groupId ?? null) : input.groupId);
			const tags = input.tags === undefined ? (previous?.tags ?? []) : normalizeTags(input.tags, t);
			const favorite = input.favorite ?? previous?.favorite ?? false;
			if (typeof favorite !== "boolean") throw new Error(t.invalidRequest);
			const host: StoredHost = { id: previous?.id ?? randomUUID(), ...fields, groupId, tags, favorite, lastConnectedAt: previous?.lastConnectedAt ?? null };
			// 编辑不挪位置。
			const hosts = previous ? data.hosts.map((entry) => (entry.id === host.id ? host : entry)) : [...data.hosts, host];
			return { ...data, hosts };
		});
	}

	private patchHost(id: string, patch: Partial<StoredHost>): Promise<void> {
		return this.commit((data) => {
			Vault.find(data, id, this.t);
			return { ...data, hosts: data.hosts.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)) };
		});
	}

	setFavorite(id: string, favorite: boolean): Promise<void> {
		if (typeof favorite !== "boolean") return Promise.reject(new Error(this.t().invalidRequest));
		return this.patchHost(id, { favorite });
	}

	markConnected(id: string): Promise<void> {
		return this.patchHost(id, { lastConnectedAt: new Date().toISOString() });
	}

	deleteHost(id: string): Promise<void> {
		return this.commit((data) => ({ ...data, hosts: data.hosts.filter((entry) => entry.id !== id) }));
	}

	private checkedGroup(data: VaultData, value: unknown): string | null {
		if (value === undefined || value === null) return null;
		if (typeof value !== "string" || !data.groups.some((group) => group.id === value)) throw new Error(this.t().groupMissing);
		return value;
	}

	saveGroup(input: { id?: string; name: string }): Promise<void> {
		return this.commit((data) => {
			const t = this.t();
			const previous = input.id === undefined ? undefined : data.groups.find((group) => group.id === input.id);
			if (input.id !== undefined && !previous) throw new Error(t.groupMissing);
			const name = required(input.name, t.invalidGroupName, 80);
			if (data.groups.some((group) => group.id !== previous?.id && group.name.toLowerCase() === name.toLowerCase())) throw new Error(t.groupExists);
			const group = { id: previous?.id ?? randomUUID(), name };
			const groups = previous ? data.groups.map((entry) => (entry.id === group.id ? group : entry)) : [...data.groups, group];
			return { ...data, groups };
		});
	}

	deleteGroup(id: string): Promise<void> {
		return this.commit((data) => {
			this.checkedGroup(data, id);
			return {
				...data,
				groups: data.groups.filter((group) => group.id !== id),
				hosts: data.hosts.map((host) => (host.groupId === id ? { ...host, groupId: null } : host)),
			};
		});
	}

	moveHosts(ids: string[], groupId: string | null): Promise<void> {
		return this.commit((data) => {
			const group = this.checkedGroup(data, groupId);
			if (!Array.isArray(ids) || ids.length === 0 || ids.length > 1000) throw new Error(this.t().invalidRequest);
			const selected = new Set(ids);
			for (const id of selected) Vault.find(data, id, this.t);
			return { ...data, hosts: data.hosts.map((host) => (selected.has(host.id) ? { ...host, groupId: group } : host)) };
		});
	}

	hasHost(fields: Pick<HostFields, "host" | "port" | "username">): boolean {
		const identity = hostIdentity(fields);
		return this.data.hosts.some((host) => hostIdentity(host) === identity);
	}

	/** 导入的主机和新建的分组一起写进去，不会只进了一半。已有的（地址、端口、账号都一样）跳过，不覆盖。 */
	async importHosts(
		candidates: { fields: HostFields; groupName: string }[],
		options: { groupId: string | null; useSheetGroups: boolean },
	): Promise<{ imported: number; skipped: number }> {
		const counts = { imported: 0, skipped: 0 };
		await this.commit((data) => {
			const fallback = this.checkedGroup(data, options.groupId);
			const hosts = [...data.hosts];
			const groups = [...data.groups];
			const seen = new Set(hosts.map(hostIdentity));
			for (const candidate of candidates) {
				const fields = validateHostFields(candidate.fields, this.t());
				const identity = hostIdentity(fields);
				if (seen.has(identity)) {
					counts.skipped++;
					continue;
				}
				let groupId = fallback;
				const name = candidate.groupName.trim();
				if (options.useSheetGroups && name) {
					let group = groups.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
					if (!group) {
						group = { id: randomUUID(), name };
						groups.push(group);
					}
					groupId = group.id;
				}
				hosts.push({ id: randomUUID(), ...fields, groupId, tags: [], favorite: false, lastConnectedAt: null });
				seen.add(identity);
				counts.imported++;
			}
			return { ...data, hosts, groups };
		});
		return counts;
	}

	fingerprint(host: string, port: number): string | undefined {
		return this.data.fingerprints[JSON.stringify([host.toLowerCase(), port])];
	}

	trustHost(host: string, port: number, fingerprint: string): Promise<void> {
		return this.commit((data) => ({ ...data, fingerprints: { ...data.fingerprints, [JSON.stringify([host.toLowerCase(), port])]: fingerprint } }));
	}

	/** 把已存的密码从一段要交出去的文字里换掉；长的先换，免得一个密码是另一个的一截时只换掉一半。 */
	redact(value: string): string {
		const secrets = this.data.hosts
			.map((host) => host.password)
			.filter(Boolean)
			.sort((a, b) => b.length - a.length);
		let result = value;
		for (const secret of secrets) result = result.split(secret).join("[credential hidden]");
		return result;
	}
}
