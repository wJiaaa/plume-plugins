/**
 * `ssh_run` 问人的那一步：经 `run.request` 弹卡（不经审批），卡交回要跑的那条命令，逻辑入口再核一遍；
 * 改过的照实告诉模型，拒绝、过期、交回的不成样子都一条不跑，停下这一轮照停下算。
 */

import type { HumanAnswer, HumanRequestInput, PluginContext, ToolDefinition, ToolRun } from "@plume/contract";
import { describe, expect, it } from "vitest";
import type { BatchTarget, RunDetails, RunRequest } from "../src/api.ts";
import type { Connections } from "../src/connections.ts";
import { MESSAGES } from "../src/messages.ts";
import type { SshService } from "../src/ssh.ts";
import { registerTools } from "../src/tools.ts";
import type { Vault } from "../src/vault.ts";

const TARGET: BatchTarget = { connection: "c1", serverId: "s1", label: "web", host: "10.0.0.1", port: 22, username: "root", fingerprint: "SHA256:abc" };

function setup(answer: HumanAnswer | ((input: HumanRequestInput) => HumanAnswer)) {
	const tools = new Map<string, ToolDefinition>();
	const ctx = { tools: { register: (tool: ToolDefinition) => tools.set(tool.name, tool) }, hook: () => {} } as unknown as PluginContext;
	const executed: string[] = [];
	const connections = {
		view: (id: string) => (id === TARGET.connection ? { id, label: TARGET.label } : undefined),
		connected: () => [],
		target: () => TARGET,
	} as unknown as Connections;
	const ssh = {
		withExclusive: (_id: string, _signal: AbortSignal, callback: (port: { exec(command: string): Promise<unknown> }) => Promise<unknown>) =>
			callback({
				exec: async (command: string) => {
					executed.push(command);
					return { stdout: "done", stderr: "", code: 0, truncated: false };
				},
			}),
	} as unknown as SshService;
	registerTools(ctx, {
		connections,
		ssh: () => ssh,
		vault: { redact: (value: string) => value.replaceAll("hunter2", "***") } as unknown as Vault,
		scrub: (value) => value,
		isAssistant: async () => true,
		t: () => MESSAGES.en,
	});
	const requests: HumanRequestInput[] = [];
	let asked = 0;
	const controller = new AbortController();
	const run = {
		sessionId: "s",
		toolCallId: "call-1",
		signal: controller.signal,
		ask: async () => {
			asked++;
			return "once";
		},
		request: async (input: HumanRequestInput) => {
			requests.push(input);
			return typeof answer === "function" ? answer(input) : answer;
		},
		permissionMode: async () => "full-access",
	} as unknown as ToolRun;
	const call = (command = "df -h") => tools.get("ssh_run")!.execute({ connection: "c1", command, reason: "看看磁盘" }, run);
	return { call, executed, requests, asked: () => asked };
}

describe("ssh_run", () => {
	it("完全访问下也经 run.request 问人，不经审批；卡上收到的是结构化的请求", async () => {
		const f = setup({ answered: true, value: { command: "df -h" } });
		const result = await f.call();
		expect(f.asked()).toBe(0);
		expect(f.requests).toHaveLength(1);
		expect(f.requests[0]!.kind).toBe("ssh_run");
		expect(f.requests[0]!.payload).toMatchObject({
			connection: "c1",
			label: "web",
			target: "root@10.0.0.1:22",
			fingerprint: "SHA256:abc",
			command: "df -h",
		} satisfies Partial<RunRequest>);
		expect(f.executed).toEqual(["df -h"]);
		expect(result.output).not.toContain("editedByUser");
		expect((result.details as RunDetails).edited).toBe(false);
	});

	it("卡上改过的命令随答案回来，跑改过的那条并照实告诉模型", async () => {
		const f = setup({ answered: true, value: { command: "df -h /var" } });
		const result = await f.call();
		expect(f.executed).toEqual(["df -h /var"]);
		expect(JSON.parse(result.output)).toMatchObject({ executedCommand: "df -h /var" });
		expect(result.details).toMatchObject({ command: "df -h /var", edited: true, status: "succeeded" });
	});

	it("拒绝、过期和交回的不成样子都不跑，记成被拒绝", async () => {
		for (const answer of [
			{ answered: false, reason: "declined" },
			{ answered: false, reason: "expired" },
			{ answered: true, value: { command: 42 } },
			{ answered: true, value: { command: "   " } },
			{ answered: true, value: "df -h" },
		] as HumanAnswer[]) {
			const f = setup(answer);
			const result = await f.call();
			expect(f.executed).toEqual([]);
			expect(result.details).toMatchObject({ status: "rejected", command: "df -h", edited: false });
		}
	});

	it("这一轮停了就照停下收场，不跑", async () => {
		const f = setup({ answered: false, reason: "stopped" });
		const result = await f.call();
		expect(f.executed).toEqual([]);
		expect(result).toMatchObject({ isError: true, output: "Stopped by the user before the command ran." });
	});

	it("改过的命令里带已存的密码就拦下", async () => {
		const f = setup({ answered: true, value: { command: "echo hunter2" } });
		const result = await f.call();
		expect(f.executed).toEqual([]);
		expect((result.details as RunDetails).status).toBe("blocked");
	});
});
