/**
 * plume.magpie 的逻辑入口，跑在 agent 进程：把 Magpie（usemagpie.ai）资源库分发给 Plume 的东西交给 Plume。
 *
 * Magpie 的 Agent 插件把全局指令和 MCP 服务写进这个插件的数据目录（见 `library.ts`）。全局指令每次调模型前现读，
 * 经 `model.context` 放成单独一段；MCP 服务经服务 `mcp.servers` 登记给 MCP 插件，盯着数据目录，Magpie 改了当场重登记。
 * 都不抄进别处：在 Magpie 里撤回、或停用这个插件，就都没了。
 */

import { watch } from "node:fs";
import type { Plugin } from "@plume/contract";
import { MCP_FILE, readInstructions, readMcpServers, withInstructions } from "./library.ts";

/** 连接器页上「由 … 管理」的那个名字。 */
const LABEL = "Magpie";
/** Magpie 写文件常是先删后建、或换名落盘，一次改动会来好几个事件：攒一下再读。 */
const SETTLE_MS = 200;

export default {
	name: "plume.magpie",
	inject: ["mcp.servers"],
	apply(ctx) {
		const servers = ctx.use("mcp.servers");

		ctx.hook("model.context", async (input, next) => {
			// 在返回的路上插：不管系统提示词插件在外层还是里层，这时它的段都已经在了，才找得到项目约定从哪开始。
			const [instructions, output] = await Promise.all([readInstructions(ctx.dataDir, ctx.log), next(input)]);
			return { ...output, sections: withInstructions(output.sections, instructions) };
		});

		// 一次读一份，读的时候又改了就接着再读一次：后登记的总是更新的那份。
		let reading: Promise<void> = Promise.resolve();
		const offer = () => {
			reading = reading
				.then(async () => servers.offer(ctx.name, LABEL, await readMcpServers(ctx.dataDir, ctx.log)))
				.catch((error: unknown) => {
					ctx.log.warn(`登记 Magpie 的 MCP 服务失败：${error instanceof Error ? error.message : String(error)}`);
				});
		};
		offer();

		// 盯目录而不是文件：Magpie 撤回时删掉文件、再分发时新建，盯文件会在删掉后失效。
		let timer: ReturnType<typeof setTimeout> | undefined;
		const watcher = watch(ctx.dataDir, (_event, name) => {
			if (name !== null && name !== MCP_FILE) return;
			clearTimeout(timer);
			timer = setTimeout(offer, SETTLE_MS);
		});
		watcher.on("error", (error) => ctx.log.warn(`盯不住 ${ctx.dataDir}，Magpie 改了 MCP 服务要重启 Plume 才生效：${error.message}`));
		ctx.effect(() => {
			clearTimeout(timer);
			watcher.close();
		});
	},
} satisfies Plugin;
