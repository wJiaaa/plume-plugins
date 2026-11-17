/**
 * plume.magpie 的逻辑入口，跑在 agent 进程：把 Magpie（usemagpie.ai）交给 Plume 的东西交给 Plume。
 *
 * Magpie 的 Agent 插件写进这个插件的数据目录：
 * - `credentials.json`：网关和默认模型（见 `gateway.ts`）。网关经 `ctx.providers` 成为设置页里的「Magpie」供应商，
 *   设置页的改和删写回这份文件；Magpie 选了模型就设成 Plume 的默认模型，断开时把 Plume 原来的默认模型换回来（见 `default-model.ts`）。
 * - `AGENTS.md`、`mcp.json`：全局指令和 MCP 服务（见 `library.ts`）。全局指令每次调模型前现读，经 `model.context` 放成单独一段；
 *   MCP 服务经服务 `mcp.servers` 登记给 MCP 插件。
 * 盯着数据目录，Magpie 改了当场重读。都不抄进 Plume 自己的设置：在 Magpie 里撤回、或停用这个插件，就都没了。
 */

import { watch } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin, PluginProvider } from "@plume/contract";
import { syncDefaultModel } from "./default-model.ts";
import { CREDENTIALS_FILE, type Credentials, magpieGateway, magpieProvider, readCredentials, writeCredentials } from "./gateway.ts";
import { MCP_FILE, readInstructions, readMcpServers, withInstructions } from "./library.ts";
import { MESSAGES } from "./messages.ts";

/** 连接器页上「由 … 管理」的那个名字。 */
const LABEL = "Magpie";
/** Magpie 写文件常是先删后建、或换名落盘，一次改动会来好几个事件：攒一下再读。 */
const SETTLE_MS = 200;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default {
	name: "plume.magpie",
	inject: ["mcp.servers"],
	async apply(ctx) {
		const servers = ctx.use("mcp.servers");

		ctx.hook("model.context", async (input, next) => {
			// 在返回的路上插：不管系统提示词插件在外层还是里层，这时它的段都已经在了，才找得到项目约定从哪开始。
			const [instructions, output] = await Promise.all([readInstructions(ctx.dataDir, ctx.log), next(input)]);
			return { ...output, sections: withInstructions(output.sections, instructions) };
		});

		/** 一次读一份，读的时候又改了就接着再读一次：后读的总是更新的那份。 */
		const queue = (run: () => Promise<void>, failed: (error: unknown) => void) => {
			let chain: Promise<void> = Promise.resolve();
			return () => (chain = chain.then(run).catch(failed));
		};

		const offer = queue(
			async () => servers.offer(ctx.name, LABEL, await readMcpServers(ctx.dataDir, ctx.log)),
			(error) => ctx.log.warn(`登记 Magpie 的 MCP 服务失败：${messageOf(error)}`),
		);

		let provider: PluginProvider | undefined;
		const loadGateway = queue(
			async () => {
				const credentials = await readCredentials(ctx.dataDir, ctx.log);
				if (!credentials) return;
				const next = magpieProvider(credentials);
				// 真变了才让界面重取：设置页改了写回文件，这里会再读到同一份。
				if (JSON.stringify(next) !== JSON.stringify(provider)) {
					provider = next;
					ctx.providers.changed();
				}
				// 先换好供应商再设默认模型：设的时候本体按现在的供应商校验。
				await syncDefaultModel(ctx, credentials);
			},
			(error) => ctx.log.warn(`读 Magpie 的网关失败：${messageOf(error)}`),
		);
		/** 设置页改、删时现读现写，不拿缓存的那份盖掉 Magpie 刚写的默认模型。 */
		const changeGateway = async (change: (credentials: Credentials) => Credentials) => {
			const credentials = await readCredentials(ctx.dataDir, ctx.log);
			if (!credentials) throw new Error(MESSAGES[ctx.locale()].unreadable(join(ctx.dataDir, CREDENTIALS_FILE)));
			const next = change(credentials);
			await writeCredentials(ctx.dataDir, next);
			provider = magpieProvider(next);
		};

		ctx.providers.provide({
			list: () => (provider ? [provider] : []),
			save: (next) => changeGateway((credentials) => ({ ...credentials, magpie: magpieGateway(next) })),
			remove: () => changeGateway(({ magpie: _, ...rest }) => rest),
		});

		// 先建好 0600 的空文件：Magpie 写一份不存在的文件时按 0644 建，网关 key 就人人可读了；已有的文件原样保留它的权限。
		await writeFile(join(ctx.dataDir, CREDENTIALS_FILE), "{}\n", { flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "EEXIST") throw error;
		});
		// 等第一次读完再算启用好：开机就有 Magpie 的供应商，不会先落到别的默认模型上。
		await loadGateway();
		void offer();

		// 盯目录而不是文件：Magpie 撤回时删掉文件、再分发时新建，盯文件会在删掉后失效。
		const timers = new Map<string, ReturnType<typeof setTimeout>>();
		const later = (name: string, run: () => unknown) => {
			clearTimeout(timers.get(name));
			timers.set(name, setTimeout(run, SETTLE_MS));
		};
		const watcher = watch(ctx.dataDir, (_event, name) => {
			if (name === null || name === MCP_FILE) later(MCP_FILE, offer);
			if (name === null || name === CREDENTIALS_FILE) later(CREDENTIALS_FILE, loadGateway);
		});
		watcher.on("error", (error) => ctx.log.warn(`盯不住 ${ctx.dataDir}，Magpie 改了网关或 MCP 服务要重启 Plume 才生效：${error.message}`));
		ctx.effect(() => {
			for (const timer of timers.values()) clearTimeout(timer);
			watcher.close();
		});
	},
} satisfies Plugin;
