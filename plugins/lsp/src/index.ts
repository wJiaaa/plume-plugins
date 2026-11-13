/**
 * plume.lsp 的逻辑入口：`lsp` 工具，和改了文件的调用（plume.tools 的 edit、write，改了文件的命令）之后附上这些文件现在的错误。
 *
 * 语言服务器按工作目录一套：同一个目录的会话和子会话借同一套，worktree 里的会话目录不同，各用各的。每台服务器第一次
 * 被问才起，空闲十分钟回收（`manager.ts`）；最后一个借它的会话结束时停掉，插件停用时全部停掉。
 */

import type { Plugin } from "@plume/contract";
import { withDiagnostics } from "./edit-diagnostics.ts";
import { lspTool } from "./lsp-tool.ts";
import { CodeIntelLeases } from "./manager.ts";

export default {
	name: "plume.lsp",
	// 哪个会话的子会话都可能借过语言服务器，要在它一轮跑完时还：看全部会话。
	observe: "all",
	apply(ctx) {
		const leases = new CodeIntelLeases();
		const managerFor = (cwd: string, sessionId: string) => leases.borrow(sessionId, cwd);
		ctx.effect(() => leases.dispose());
		/*
		 * 什么时候还：会话删掉、归档、换了项目、退出应用（`onEnded`）；子会话（子 Agent、侧边聊天）跑完一段就还——
		 * 它们多半跑一段就交差，续跑时再借，同一个目录里父会话还借着的话服务器不停。
		 */
		ctx.sessions.onEnded((sessionId) => leases.release(sessionId));
		ctx.sessions.observe((observation) => {
			if (observation.event.type !== "turnEnd") return;
			void ctx.sessions.get(observation.sessionId).then((session) => {
				if (session?.kind === "child") leases.release(observation.sessionId);
			});
		});

		ctx.tools.register(lspTool({ managerFor, listFiles: (root) => ctx.workspace.files(root) }));

		ctx.hook("tool.execute", async (input, next) => {
			const result = await next(input);
			// 没改文件的调用不借语言服务器：改了哪些文件看本体记在结果上的 `changes`。
			return result.changes?.paths.length ? withDiagnostics(managerFor(input.cwd, input.sessionId), input.cwd, result) : result;
		});
	},
} satisfies Plugin;
