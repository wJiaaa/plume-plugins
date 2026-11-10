/**
 * Windows 上跑钩子：不弹控制台窗口，超时时连钩子起的整棵进程树一起收掉。这些只在 Windows 上看得见，测试跑在别的系统上，
 * 所以不起真进程，截下 `spawn`、`execFile` 看它们拿到了什么——问题的全部就在参数里。
 */

import assert from "node:assert/strict";
import childProcess, { ChildProcess, type ExecFileOptions, type SpawnOptions } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import { normalizeHooksConfig } from "../src/config.ts";
import { createHookRunner } from "../src/runner.ts";

// 测试跑在终端里：用继承来的环境，不去问登录 shell。
process.env.TERM_PROGRAM ??= "node-test";

function asWindows(t: TestContext): void {
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	assert.ok(platform);
	Object.defineProperty(process, "platform", { ...platform, value: "win32" });
	t.after(() => Object.defineProperty(process, "platform", platform));
}

test("Windows 上钩子不开控制台、不另开进程组；超时用 taskkill /T 收整棵树", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "plume-hooks-windows-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const spawned: { file: string; args: readonly string[]; options: SpawnOptions }[] = [];
	const killed: { file: string; args: readonly string[]; options: ExecFileOptions }[] = [];
	const spawn = t.mock.method(childProcess, "spawn", (file: string, args: readonly string[], options: SpawnOptions) => {
		spawned.push({ file, args, options });
		// 一个永远不结束的钩子：起来了，不说话，等着超时。
		const child = new ChildProcess();
		Object.assign(child, { pid: 4242, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
		child.kill = () => false;
		return child;
	});
	const exec = t.mock.method(
		childProcess,
		"execFile",
		(file: string, args: readonly string[], options: ExecFileOptions, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
			killed.push({ file, args, options });
			callback(null, "", "");
			return new ChildProcess();
		},
	);
	syncBuiltinESMExports();
	t.after(() => {
		spawn.mock.restore();
		exec.mock.restore();
		syncBuiltinESMExports();
	});
	asWindows(t);

	const runner = createHookRunner({
		user: normalizeHooksConfig({
			timeoutMs: 50,
			events: { SessionStart: [{ hooks: [{ type: "command", command: "sleep 9", shell: "C:\\Git\\bin\\bash.exe" }] }] },
		}),
	});
	await runner.run({ hookEventName: "SessionStart", sessionId: "s", cwd: dir }, {});

	assert.equal(spawned.length, 1);
	assert.equal(spawned[0]?.options.windowsHide, true);
	assert.equal(spawned[0]?.options.detached, false);
	assert.deepEqual(
		killed.map(({ file, args }) => [file, args]),
		[["taskkill", ["/PID", "4242", "/T", "/F"]]],
	);
	assert.equal(killed[0]?.options.windowsHide, true);
});
