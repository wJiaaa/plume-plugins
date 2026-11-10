import { afterEach, expect, it, vi } from "vitest";

import {
	openInTerminal,
	registerTerminalOpener,
	registerTerminalRunner,
	runInTerminal,
} from "../../../../plume/apps/desktop/src/renderer/files/open-terminal.ts";
import { currentNotices, dismissNotice } from "../../../../plume/apps/desktop/src/renderer/toast/store.ts";

const cleanups = [];
afterEach(() => {
	for (const dispose of cleanups.splice(0).reverse()) dispose();
	for (const notice of currentNotices()) dismissNotice(notice.id);
});

it("最近注册的终端接请求，同插件更新后旧清理不撤掉新入口，停用恢复前一个", async () => {
	const first = vi.fn(),
		second = vi.fn(),
		updated = vi.fn();
	const old = registerTerminalOpener("first", first);
	cleanups.push(old, registerTerminalOpener("second", second));
	const newest = registerTerminalOpener("first", updated);
	cleanups.push(newest);
	old();
	await openInTerminal("session-a", "/work/a");
	expect(updated).toHaveBeenCalledWith("/work/a", "session-a");
	expect(first).not.toHaveBeenCalled();
	expect(second).not.toHaveBeenCalled();
	newest();
	await openInTerminal("session-b", "/work/b");
	expect(second).toHaveBeenCalledWith("/work/b", "session-b");
});

it("没有终端或打开失败都给出提示", async () => {
	await openInTerminal("session", "/work");
	expect(currentNotices().at(-1)).toMatchObject({ level: "warn", message: "请先安装并启用终端插件。" });
	cleanups.push(
		registerTerminalOpener("failed", async () => {
			throw new Error("terminal unavailable");
		}),
	);
	await openInTerminal("session", "/work");
	expect(currentNotices().at(-1)).toMatchObject({ level: "error", message: "terminal unavailable" });
});

it("同一个回调重新登记时，旧清理也不能撤掉最新登记", async () => {
	const open = vi.fn();
	const old = registerTerminalOpener("same", open);
	cleanups.push(old, registerTerminalOpener("same", open));
	old();
	await openInTerminal("session", "/work");
	expect(open).toHaveBeenCalledWith("/work", "session");
});

it("「在终端运行」交给最近登记的终端，带着命令和会话；没有终端时提示", async () => {
	await runInTerminal("session", "ls");
	expect(currentNotices().at(-1)).toMatchObject({ level: "warn", message: "请先安装并启用终端插件。" });
	const first = vi.fn(),
		second = vi.fn();
	cleanups.push(registerTerminalRunner("first", first));
	const latest = registerTerminalRunner("second", second);
	cleanups.push(latest);
	await runInTerminal("session-a", "pnpm dev");
	expect(second).toHaveBeenCalledWith("pnpm dev", "session-a");
	latest();
	await runInTerminal("session-b", "ls");
	expect(first).toHaveBeenCalledWith("ls", "session-b");
	cleanups.push(
		registerTerminalRunner("failed", async () => {
			throw new Error("terminal unavailable");
		}),
	);
	await runInTerminal("session", "ls");
	expect(currentNotices().at(-1)).toMatchObject({ level: "error", message: "terminal unavailable" });
});
