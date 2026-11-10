/**
 * 交出去之前的几道关：远端输出交给模型前遮住密钥、去掉控制序列；主机库加密落盘、已存密码从文字里换掉；
 * 批量命令和 Agent 发命令前核对的连接身份。
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SecretsService } from "@plume/contract";
import { sameTarget, validateBatchInput } from "../src/batch.ts";
import { MESSAGES } from "../src/messages.ts";
import { cleanTerminalText, maskSecrets } from "../src/secrets.ts";
import { Vault } from "../src/vault.ts";

const errors = MESSAGES.en.errors;
const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "plume-ssh-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("maskSecrets", () => {
	it("遮住赋值、令牌、Bearer 和私钥，留下结构定义和变量引用", () => {
		const input = [
			"DB_PASSWORD=hunter2",
			'"api_key": "abc123"',
			"token ghp_abcdefghijklmnopqrstuvwxyz0123",
			"Authorization: Bearer abcdef.ghijkl.mnop",
			"-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
			'"password": { "type": "string" }',
			"password=$DB_PASS",
		].join("\n");
		const masked = maskSecrets(input);
		for (const secret of ["hunter2", "abc123", "ghp_abcdefghijklmnopqrstuvwxyz0123", "abcdef.ghijkl.mnop", "AAAA"]) expect(masked).not.toContain(secret);
		expect(masked).toContain('"password": { "type": "string" }');
		expect(masked).toContain("password=$DB_PASS");
	});

	it("去掉颜色、OSC 标题和双向文字覆盖符", () => {
		expect(cleanTerminalText("\x1b]0;title\x07\x1b[31mred\x1b[0m\r\nok‮!")).toBe("red\nok!");
	});
});

describe("Vault", () => {
	const host = { name: "web", host: "10.0.0.1", port: 22, username: "root", password: "s3cret-pass" };
	/** 服务 `secrets` 的替身：前缀和真的一样，内容只做 base64；`lost` 时什么都解不开。 */
	const SEALED = "plume-sealed:v1:";
	const fake = (lost = false): SecretsService => ({
		seal: async (value) => SEALED + Buffer.from(value).toString("base64"),
		unseal: async (sealed) => (!lost && sealed.startsWith(SEALED) ? Buffer.from(sealed.slice(SEALED.length), "base64").toString() : null),
		isSealed: (value) => value.startsWith(SEALED),
	});
	const open = (dir = tempDir(), secrets = fake()) =>
		Vault.open(
			dir,
			secrets,
			() => errors,
			() => {},
		);

	it("加密落盘，重新打开读得回来；密码不出现在给界面的视图和文件里", async () => {
		const dir = tempDir();
		await (await open(dir)).saveHost(host);
		const disk = readFileSync(join(dir, "hosts.enc"), "utf8");
		expect(disk.startsWith(SEALED)).toBe(true);
		expect(disk.includes("10.0.0.1")).toBe(false);
		const reopened = await open(dir);
		const [profile] = reopened.hosts();
		expect(profile).toMatchObject({ name: "web", hasPassword: true });
		expect(JSON.stringify(profile)).not.toContain("s3cret-pass");
		expect(reopened.host(profile!.id).password).toBe("s3cret-pass");
	});

	it("解不开的主机库挪到旁边，从空的开始，原文件不被盖掉", async () => {
		const dir = tempDir();
		await (await open(dir)).saveHost(host);
		const before = readFileSync(join(dir, "hosts.enc"), "utf8");
		const vault = await open(dir, fake(true));
		expect(vault.hosts()).toEqual([]);
		const aside = readdirSync(dir).find((name) => name.startsWith("hosts.enc.unreadable-"));
		expect(aside && readFileSync(join(dir, aside), "utf8")).toBe(before);
	});

	it("同时来的几次改动按顺序落盘，谁也不丢", async () => {
		const dir = tempDir();
		const vault = await open(dir);
		await Promise.all([vault.saveHost(host), vault.saveHost({ ...host, host: "10.0.0.2" }), vault.saveGroup({ name: "prod" })]);
		const reopened = await open(dir);
		expect(reopened.hosts().map((entry) => entry.host)).toEqual(["10.0.0.1", "10.0.0.2"]);
		expect(reopened.groups().map((group) => group.name)).toEqual(["prod"]);
	});

	it("编辑时不给密码就留着原来的", async () => {
		const vault = await open();
		await vault.saveHost(host);
		const id = vault.hosts()[0]!.id;
		await vault.saveHost({ id, name: "web-2", host: host.host, port: 22, username: "root" });
		expect(vault.host(id)).toMatchObject({ name: "web-2", password: "s3cret-pass" });
	});

	it("redact 先换长的密码", async () => {
		const vault = await open();
		await vault.saveHost({ ...host, password: "abc" });
		await vault.saveHost({ ...host, host: "10.0.0.2", password: "abcdef" });
		expect(vault.redact("x abcdef y abc")).toBe("x [credential hidden] y [credential hidden]");
	});

	it("指纹按地址和端口记，地址不分大小写", async () => {
		const vault = await open();
		await vault.trustHost("Example.COM", 22, "SHA256:abc");
		expect(vault.fingerprint("example.com", 22)).toBe("SHA256:abc");
		expect(vault.fingerprint("example.com", 2222)).toBeUndefined();
	});

	it("拒绝不合规的主机", async () => {
		const vault = await open();
		await expect(vault.saveHost({ ...host, port: 70000 })).rejects.toThrow(errors.invalidPort);
		await expect(vault.saveHost({ ...host, host: "http://x/y" })).rejects.toThrow(errors.invalidHost);
		await expect(vault.saveHost({ ...host, password: "" })).rejects.toThrow(errors.invalidPassword);
		expect(vault.hosts()).toEqual([]);
	});
});

describe("批量命令", () => {
	const target = { connection: "c1", serverId: "s1", label: "web", host: "10.0.0.1", port: 22, username: "root", fingerprint: "SHA256:a" };

	it("身份的任何一项变了都不算同一个目标，名字变了不算", () => {
		expect(sameTarget(target, { ...target, label: "renamed" })).toBe(true);
		for (const change of [{ connection: "c2" }, { host: "10.0.0.2" }, { port: 2222 }, { username: "admin" }, { fingerprint: "SHA256:b" }])
			expect(sameTarget(target, { ...target, ...change })).toBe(false);
	});

	it("校验目标数、命令、并发和超时", () => {
		const input = { connections: ["c1"], command: "uptime", concurrency: 4, timeoutSeconds: 30 };
		expect(validateBatchInput(input, errors)).toEqual(input);
		expect(() => validateBatchInput({ ...input, connections: ["c1", "c1"] }, errors)).toThrow(errors.batchTargets);
		expect(() => validateBatchInput({ ...input, command: "  " }, errors)).toThrow(errors.invalidCommand);
		expect(() => validateBatchInput({ ...input, concurrency: 9 }, errors)).toThrow(errors.batchConcurrency);
		expect(() => validateBatchInput({ ...input, timeoutSeconds: 0 }, errors)).toThrow(errors.batchTimeout);
	});
});
