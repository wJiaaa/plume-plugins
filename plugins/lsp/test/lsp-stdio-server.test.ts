/**
 * 标准 LSP 后端对着一台假服务器从头走到尾：握手、打开文件、改了文件之后再问、诊断、重命名、回收。
 *
 * 假服务器是一个几十行的 Node 脚本，经 PATH 上的一个启动脚本被找到——和真服务器同一条路：
 * 按名字在 PATH 上找、spawn、Content-Length 分帧。真服务器（clangd 等）本机未必有，
 * 这里要定下来的是协议这一侧，不是哪台服务器的分析能力。
 */

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, test } from "node:test";
import { CodeIntelManager } from "../src/manager.ts";
import { StdioLspBackend } from "../src/stdio.ts";

/**
 * 只认 `BAD` 这个词的服务器：每次打开或修改文件都推送一次诊断（文件里每个 `BAD` 一条），
 * references 把被问的位置原样回给它——这样能看出 1 基到 0 基的换算有没有对。
 */
const FAKE_SERVER = String.raw`
let buffer = Buffer.alloc(0);
let configured = false;
const docs = new Map();
const send = (message) => {
	const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
	process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\r\n\r\n"), body]));
};
const publish = (uri) => {
	const diagnostics = [];
	docs.get(uri).split("\n").forEach((line, i) => {
		const at = line.indexOf("BAD");
		if (at >= 0) diagnostics.push({ range: { start: { line: i, character: at }, end: { line: i, character: at + 3 } }, severity: 1, message: "bad word", code: "B1" });
	});
	send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics } });
};
process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const end = buffer.indexOf("\r\n\r\n");
		if (end < 0) return;
		const length = Number(/Content-Length: (\d+)/i.exec(buffer.toString("ascii", 0, end))[1]);
		if (buffer.length < end + 4 + length) return;
		const message = JSON.parse(buffer.toString("utf8", end + 4, end + 4 + length));
		buffer = buffer.subarray(end + 4 + length);
		handle(message);
	}
});
function handle({ id, method, params, result }) {
	if (method === "initialize") {
		send({ id, result: { capabilities: { textDocumentSync: 1, definitionProvider: true, referencesProvider: true, renameProvider: true } } });
		// 反过来问一次配置：客户端得回答——pyright 不拿到回答就一直等着。没答上，definition 就报错。
		send({ id: "cfg", method: "workspace/configuration", params: { items: [{ section: "fake" }] } });
	} else if (id === "cfg") {
		configured = Array.isArray(result) && result.length === 1;
	} else if (method === "textDocument/didOpen") {
		docs.set(params.textDocument.uri, params.textDocument.text);
		publish(params.textDocument.uri);
	} else if (method === "textDocument/didChange") {
		docs.set(params.textDocument.uri, params.contentChanges[0].text);
		publish(params.textDocument.uri);
	} else if (method === "textDocument/references") {
		const at = params.position;
		send({ id, result: [{ uri: params.textDocument.uri, range: { start: at, end: at } }] });
	} else if (method === "textDocument/definition") {
		if (!configured) return send({ id, error: { code: -32002, message: "still waiting for workspace/configuration" } });
		const range = { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } };
		send({ id, result: [{ targetUri: params.textDocument.uri, targetRange: range, targetSelectionRange: range }] });
	} else if (method === "textDocument/rename") {
		const at = params.position;
		send({ id, result: { changes: { [params.textDocument.uri]: [{ range: { start: at, end: { line: at.line, character: at.character + 5 } }, newText: params.newName }] } } });
	} else if (id !== undefined && method) {
		send({ id, error: { code: -32601, message: "unsupported " + method } });
	}
}
`;

let root: string;
let savedPath: string | undefined;

before(async () => {
	root = await mkdtemp(join(tmpdir(), "plume-lsp-fake-"));
	const bin = join(root, "bin");
	await mkdir(bin);
	await writeFile(join(root, "server.cjs"), FAKE_SERVER);
	// 和真服务器一样经 PATH 被找到：Windows 上是 npm 那种 .cmd，别处是带执行位的脚本。
	if (process.platform === "win32") {
		await writeFile(join(bin, "plume-fake-ls.cmd"), `@"${process.execPath}" "${join(root, "server.cjs")}" %*\r\n`);
	} else {
		await writeFile(join(bin, "plume-fake-ls"), `#!/bin/sh\nexec "${process.execPath}" "${join(root, "server.cjs")}" "$@"\n`);
		await chmod(join(bin, "plume-fake-ls"), 0o755);
	}
	savedPath = process.env.PATH;
	process.env.PATH = `${bin}${delimiter}${savedPath ?? ""}`;
	await writeFile(join(root, "a.fake"), "def hello():\n    BAD\n");
});

after(async () => {
	process.env.PATH = savedPath;
	await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
});

function fakeBackend(): StdioLspBackend {
	return new StdioLspBackend({ name: "fake", languages: { ".fake": "fake" }, commands: [{ command: "plume-fake-ls", args: ["--stdio"] }], install: "fake" });
}

test("经 PATH 找到、起来、握手，然后按工具的 1 基行列来回换算", { timeout: 20_000 }, async () => {
	const backend = fakeBackend();
	assert.equal(await backend.available(), true);
	await backend.start(root);
	assert.equal(backend.ready(), true);
	const file = join(root, "a.fake");

	const refs = await backend.references(file, 2, 5);
	assert.deepEqual(refs, [{ path: file, line: 2, column: 5, text: "BAD" }], "问的是第 2 行第 5 列，回来的也是，并且配上了那一行");

	const defs = await backend.definition(file, 2, 5);
	assert.deepEqual(defs, [{ path: file, line: 1, column: 5 }]);

	const edits = await backend.rename(file, 1, 5, "greet");
	assert.deepEqual(edits, [{ path: file, line: 1, column: 5, endLine: 1, endColumn: 10, newText: "greet" }]);
	await backend.dispose();
});

test("推送式诊断：等到服务器推过来；文件改了就重推内容，答案跟着变", { timeout: 20_000 }, async () => {
	const backend = fakeBackend();
	await backend.start(root);
	const file = join(root, "b.fake");
	await writeFile(file, "ok\nBAD\n");

	const first = await backend.diagnostics(file);
	assert.deepEqual(
		first.map((d) => [d.line, d.column, d.severity, d.message]),
		[[2, 1, "error", "bad word"]],
	);

	/*
	 * agent 在两次提问之间改了文件。不推新内容，服务器回答的是它记得的旧版本——这一条守的
	 * 就是那个：改完之后诊断要跟着磁盘走。
	 */
	await writeFile(file, "fine\nfine\n  BAD\n");
	const second = await backend.diagnostics(file);
	assert.deepEqual(
		second.map((d) => [d.line, d.column]),
		[[3, 3]],
	);

	const unchanged = await backend.diagnostics(file);
	assert.deepEqual(
		unchanged.map((d) => [d.line, d.column]),
		[[3, 3]],
		"没变就用手里那份，不再等",
	);
	await backend.dispose();
});

test("经管理器：空闲回收之后进程真的没了", { timeout: 20_000 }, async () => {
	const backend = fakeBackend();
	const manager = new CodeIntelManager([backend], { idleMs: 300 });
	const got = await manager.acquire(join(root, "a.fake"), root);
	assert.equal(got, backend);
	const pid = backend.pid;
	assert.ok(pid);
	assert.doesNotThrow(() => process.kill(pid, 0), "活着");

	await new Promise((resolve) => setTimeout(resolve, 900));
	assert.equal(backend.ready(), false);
	assert.throws(
		() => process.kill(pid, 0),
		(error: NodeJS.ErrnoException) => error.code === "ESRCH",
		"空闲到期后进程该没了",
	);
	await manager.dispose();
});
