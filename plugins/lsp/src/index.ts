/**
 * plume.lsp 的逻辑入口：`lsp` 工具，和 plume.tools 的 edit、write 之后附上这个文件现在的错误。
 *
 * 语言服务器按工作目录一套：同一个目录的会话和子会话借同一套，worktree 里的会话目录不同，各用各的。每台服务器第一次
 * 被问才起，空闲十分钟回收（`manager.ts`）；最后一个借它的会话结束时停掉，插件停用时全部停掉。
 */

import type { Plugin } from "@plume/contract";
import { editedFile, withDiagnostics } from "./edit-diagnostics.ts";
import { lspTool } from "./lsp-tool.ts";
import { CodeIntelLeases } from "./manager.ts";

export default {
	name: "plume.lsp",
	inject: ["project.files", "file.read"],
	apply(ctx) {
		const files = ctx.use("project.files");
		const reads = ctx.use("file.read");
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
			void ctx.sessions.list().then((sessions) => {
				if (sessions.find((session) => session.id === observation.sessionId)?.parentId) return leases.release(observation.sessionId);
			});
		});

		ctx.tools.register(lspTool({ managerFor, listFiles: (root) => files.list(root), authorizeRead: (run, path) => reads.authorize(run, path) }));

		ctx.hook("tool.execute", async (input, next) => {
			const result = await next(input);
			const file = editedFile(input, result);
			return file ? withDiagnostics(managerFor(input.cwd, input.sessionId), input.cwd, file, result) : result;
		});
	},
} satisfies Plugin;
