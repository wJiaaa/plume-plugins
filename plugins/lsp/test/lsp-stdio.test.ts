/**
 * 标准 LSP 后端里不需要真服务器就能定下来的部分：按扩展名找谁、找不到时说什么、URI 怎么换、
 * 分帧怎么切、回答怎么换成工具的形状。
 *
 * Windows 那一半在这里按参数测，而不是等 Windows 机器：路径和 `.cmd` 是那边会以别的方式坏掉
 * 的地方，单测大多跑在 macOS 上。
 */

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ToolOutput, ToolRun } from "@plume/contract";
import { lspTool } from "../src/lsp-tool.ts";
import { CodeIntelManager } from "../src/manager.ts";
import { decodeMessages, encodeMessage } from "../src/rpc.ts";
import { findExecutable, LANGUAGE_SERVERS, spawnPlan } from "../src/servers.ts";
import { StdioLspBackend } from "../src/stdio.ts";
import { toDiagnostics, toLocations, toTextEdits } from "../src/translate.ts";
import { pathToUri, uriToPath } from "../src/uri.ts";

let root: string;
before(async () => {
	root = await mkdtemp(join(tmpdir(), "plume-lsp-stdio-"));
});
after(async () => {
	await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
});

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

test("默认的服务器表按扩展名分给对的那一台", () => {
	const manager = new CodeIntelManager();
	const owner = (file: string) => manager.backendFor(join(root, file))?.name ?? null;
	assert.equal(owner("a.ts"), "tsserver", "TypeScript 仍走 tsserver");
	assert.equal(owner("a.py"), "pyright");
	assert.equal(owner("a.pyi"), "pyright");
	assert.equal(owner("main.go"), "gopls");
	assert.equal(owner("lib.rs"), "rust-analyzer");
	assert.equal(owner("x.c"), "clangd");
	assert.equal(owner("x.H"), "clangd", "扩展名不分大小写");
	assert.equal(owner("x.cpp"), "clangd");
	assert.equal(owner("Main.java"), null, "表里没有的语言就没有后端");
});

test("同一种语言有两个候选时，按表里的顺序用第一个找得到的", () => {
	const python = LANGUAGE_SERVERS.find((spec) => spec.name === "pyright");
	assert.deepEqual(
		python?.commands.map((c) => c.command),
		["basedpyright-langserver", "pyright-langserver"],
	);
	for (const spec of LANGUAGE_SERVERS) assert.ok(spec.install.length > 0, `${spec.name} 要写清楚装什么`);
});

// ---------------------------------------------------------------------------
// 找不到服务器
// ---------------------------------------------------------------------------

/** 只有一台装不上的 gopls；不在 git 仓库里，文本搜索自己走目录。 */
function askMissingGo(args: Record<string, unknown>): Promise<ToolOutput> {
	const ghost = new StdioLspBackend({
		name: "gopls",
		languages: { ".go": "go" },
		commands: [{ command: "plume-no-such-language-server", args: [] }],
		install: "gopls（`go install golang.org/x/tools/gopls@latest`）",
	});
	const manager = new CodeIntelManager([ghost]);
	const tool = lspTool({
		managerFor: () => manager,
		listFiles: async () => null,
	});
	const files = { read: async (target: string) => ({ ok: true as const, path: target }) } as ToolRun["files"];
	return tool.execute(args, { cwd: root, sessionId: "s", signal: new AbortController().signal, files } as ToolRun);
}

test("没装服务器：references 退回文本搜索，并说清楚缺的是哪一台、怎么装", async () => {
	await mkdir(join(root, "go"), { recursive: true });
	await writeFile(join(root, "go", "lib.go"), "package lib\n\nfunc Parse(s string) int {\n\treturn len(s)\n}\n");
	await writeFile(join(root, "go", "use.go"), 'package lib\n\nfunc use() int {\n\treturn Parse("x")\n}\n');
	const result = await askMissingGo({ operation: "references", path: "go/lib.go", symbol: "Parse" });
	const text = result.output;
	assert.equal(result.isError, undefined);
	assert.match(text, /这个语言没有可用的语言服务器（需要安装 gopls/);
	assert.match(text, /文本搜索找到 2 处/, "搜的是 .go 文件，不是写死的那组 TS 扩展名");
	assert.match(text, /use\.go:4:9/);
	assert.match(text, /别名导入/, "原来那句文本搜索的提醒还在");
	assert.equal((result.details as { confidence?: string }).confidence, "textual");
});

test("没装服务器：definition、diagnostics、rename 也都带上那句话", async () => {
	const definition = (await askMissingGo({ operation: "definition", path: "go/use.go", symbol: "Parse" })).output;
	assert.match(definition, /需要安装 gopls/);
	const diagnostics = (await askMissingGo({ operation: "diagnostics", path: "go/lib.go" })).output;
	assert.match(diagnostics, /需要安装 gopls/);
	assert.match(diagnostics, /拿不到类型诊断/);
	const rename = await askMissingGo({ operation: "rename", path: "go/lib.go", symbol: "Parse", newName: "Read" });
	assert.ok(rename.isError, "没有服务器的重命名照旧拒绝");
	assert.match(rename.output, /需要安装 gopls/);
});

test("Windows 上按 PATHEXT 找到 npm 装的 .cmd，跳过同名的 sh 脚本", async () => {
	const bin = join(root, "winbin");
	await mkdir(bin, { recursive: true });
	await writeFile(join(bin, "pyright-langserver"), "#!/bin/sh\n");
	await writeFile(join(bin, "pyright-langserver.cmd"), "@echo off\n");
	// Windows 的变量名拼作 `Path`；展开成普通对象之后大小写就要自己处理。
	const env = { Path: `C:\\nowhere;"${bin}"`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
	assert.equal(findExecutable("pyright-langserver", env, true), join(bin, "pyright-langserver.cmd"));
	assert.equal(findExecutable("gopls", env, true), null);
});

test("POSIX 上只认有执行位的文件", { skip: process.platform === "win32" && "Windows 没有执行位" }, async () => {
	const bin = join(root, "posixbin");
	await mkdir(bin, { recursive: true });
	await writeFile(join(bin, "gopls"), "#!/bin/sh\n");
	assert.equal(findExecutable("gopls", { PATH: bin }, false), null, "没有执行位的不算");
	await chmod(join(bin, "gopls"), 0o755);
	assert.equal(findExecutable("gopls", { PATH: `/nowhere:${bin}` }, false), join(bin, "gopls"));
});

test(".cmd 经 cmd.exe 起，命令行里路径加引号、不另传参数数组", () => {
	const plan = spawnPlan("C:\\Program Files\\nodejs\\pyright-langserver.cmd", ["--stdio"], true);
	assert.deepEqual(plan, { command: '"C:\\Program Files\\nodejs\\pyright-langserver.cmd" --stdio', args: [], shell: true });
	assert.deepEqual(spawnPlan("C:\\LLVM\\bin\\clangd.exe", [], true), { command: "C:\\LLVM\\bin\\clangd.exe", args: [], shell: false });
	assert.deepEqual(spawnPlan("/usr/bin/clangd", [], false), { command: "/usr/bin/clangd", args: [], shell: false });
});

// ---------------------------------------------------------------------------
// URI
// ---------------------------------------------------------------------------

test("POSIX 路径与 URI 来回换，空格、#、中文都要转义", () => {
	const path = "/Users/me/my project/#1/模块.py";
	const uri = pathToUri(path, false);
	assert.equal(uri, "file:///Users/me/my%20project/%231/%E6%A8%A1%E5%9D%97.py");
	assert.equal(uriToPath(uri, false), path);
});

test("Windows 盘符路径换成 URI，冒号原样、反斜杠变正斜杠", () => {
	assert.equal(pathToUri("C:\\Users\\a b\\x.py", true), "file:///C:/Users/a%20b/x.py");
	assert.equal(uriToPath("file:///C:/Users/a%20b/x.py", true), "C:\\Users\\a b\\x.py");
});

test("pyright 那种 `c%3A` 的小写编码盘符也认，换回来统一大写", () => {
	assert.equal(uriToPath("file:///c%3A/Users/me/x.py", true), "C:\\Users\\me\\x.py");
	assert.equal(uriToPath("file:///d:", true), "D:\\");
});

test("UNC 路径把主机名放进 authority，换回来还是两个反斜杠开头", () => {
	assert.equal(pathToUri("\\\\server\\share\\src\\a.go", true), "file://server/share/src/a.go");
	assert.equal(uriToPath("file://server/share/src/a.go", true), "\\\\server\\share\\src\\a.go");
});

test("不是 file: 的 URI 换不出路径，调用方会跳过它", () => {
	assert.equal(uriToPath("untitled:Untitled-1", false), null);
	assert.equal(uriToPath("file:///bad%E0%A4%A", false), null, "坏掉的转义不抛错");
});

// ---------------------------------------------------------------------------
// 分帧与换算
// ---------------------------------------------------------------------------

test("Content-Length 数的是 UTF-8 字节，半截消息留到下一块", () => {
	const one = encodeMessage({ id: 1, result: "中文" });
	const two = encodeMessage({ id: 2, result: null });
	const whole = Buffer.concat([one, two]);
	const cut = one.length + 5;
	const first = decodeMessages(whole.subarray(0, cut));
	assert.deepEqual(first.messages, [{ id: 1, result: "中文" }]);
	const second = decodeMessages(Buffer.concat([first.rest, whole.subarray(cut)]));
	assert.deepEqual(second.messages, [{ id: 2, result: null }]);
	assert.equal(second.rest.length, 0);
});

test("位置从 0 基换成 1 基；LocationLink 取名字那一段；同一处只列一次", () => {
	const toPath = (uri: string) => uriToPath(uri, false);
	const found = toLocations(
		[
			{
				targetUri: "file:///p/a.py",
				targetRange: { start: { line: 0, character: 0 }, end: { line: 3, character: 0 } },
				targetSelectionRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } },
			},
			{ uri: "file:///p/a.py", range: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } } },
			{ uri: "untitled:x", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
		],
		toPath,
	);
	assert.deepEqual(found, [{ path: "/p/a.py", line: 1, column: 5 }]);
	assert.deepEqual(toLocations(null, toPath), []);
});

test("WorkspaceEdit 两种写法都展平成逐条编辑，用服务器给的新文本", () => {
	const toPath = (uri: string) => uriToPath(uri, false);
	const range = { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } };
	const expected = [{ path: "/p/a.go", line: 3, column: 5, endLine: 3, endColumn: 10, newText: "Read" }];
	assert.deepEqual(toTextEdits({ changes: { "file:///p/a.go": [{ range, newText: "Read" }] } }, toPath), expected);
	assert.deepEqual(
		toTextEdits(
			{
				documentChanges: [
					{ textDocument: { uri: "file:///p/a.go", version: 1 }, edits: [{ range, newText: "Read" }] },
					{ kind: "create", uri: "file:///p/new.go" },
				],
			},
			toPath,
		),
		expected,
		"建文件那一项不是文本编辑，跳过",
	);
});

test("诊断的严重程度：1 错误、2 警告、3 和 4 都算 info", () => {
	const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
	const found = toDiagnostics(
		[1, 2, 3, 4].map((severity) => ({ range, severity, message: `s${severity}`, code: "X" })),
		"/p/a.rs",
	);
	assert.deepEqual(
		found.map((d) => d.severity),
		["error", "warning", "info", "info"],
	);
	assert.equal(found[0]?.path, "/p/a.rs");
});
