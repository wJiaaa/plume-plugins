/**
 * Code intelligence, and specifically what happens when there is none.
 *
 * The exact path needs a language server and a built program, so it is measured in
 * `test/tool-eval/lsp-eval.ts` against a real `tsserver`. What belongs here is everything that
 * must hold when the server is absent, slow or broken — which is the common case, and the one
 * where a wrong answer is most expensive:
 *
 *   The tool still answers. A missing server must degrade, not fail.
 *   The answer says it is textual. "Found 6" and "text search found 6" are different claims.
 *   A rename is refused outright, because a textual rename is the exact failure this layer exists
 *   to prevent.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import type { RunFiles, ToolOutput, ToolRun } from "@plume/contract";
import { textualReferences, TEXTUAL_CAVEAT } from "../src/fallback.ts";
import { lspTool } from "../src/lsp-tool.ts";
import { CodeIntelLeases, CodeIntelManager } from "../src/manager.ts";
import { TsServerBackend } from "../src/tsserver.ts";
import type { CodeIntelBackend } from "../src/types.ts";

let root: string;

/** 本体的读边界在这里放行一切，按收到的路径交回；要看工具怎么经它读的测试自己给 `read`。 */
const allowAll: RunFiles["read"] = async (target) => ({ ok: true, path: target });

function runFor(cwd: string, projectRoots: readonly string[] = [], read: RunFiles["read"] = allowAll): ToolRun {
	return {
		sessionId: "s",
		session: { id: "s", kind: "top" },
		toolCallId: "call",
		cwd,
		projectRoots,
		scratchDir: join(cwd, "scratch"),
		signal: new AbortController().signal,
		progress() {},
		ask: async () => assert.fail("读取审批应由共享服务处理"),
		request: async () => assert.fail("lsp 不问人要数据"),
		permissionMode: async () => "auto",
		tools: () => [],
		calls: [],
		shell: async () => assert.fail("lsp 不跑命令"),
		exec: async () => assert.fail("lsp 不跑命令"),
		escalate: async () => assert.fail("lsp 不提权"),
		files: {
			read,
			readCommand: async () => assert.fail("lsp 不跑命令"),
			resolve: () => assert.fail("lsp 不解析要写的路径"),
			change: async () => assert.fail("lsp 不写文件"),
			write: async () => assert.fail("lsp 不写文件"),
			includeChanges: () => assert.fail("lsp 不跑命令"),
		},
		track: () => assert.fail("lsp 不登记后台任务"),
	};
}

/** Ask the tool with these backends — none at all by default, which is what most projects look like. */
function ask(args: Record<string, unknown>, manager = new CodeIntelManager([])): Promise<ToolOutput> {
	const tool = lspTool({
		managerFor: () => manager,
		listFiles: async () => null,
	});
	return tool.execute(args, runFor(root));
}

const textOf = (result: ToolOutput): string => result.output;

before(async () => {
	root = await mkdtemp(join(tmpdir(), "plume-lsp-"));
	await mkdir(join(root, "src"), { recursive: true });
	await writeFile(join(root, "src", "core.ts"), "export function parseConfig(text: string): object {\n\treturn JSON.parse(text);\n}\n", "utf8");
	await writeFile(
		join(root, "src", "aliased.ts"),
		'import { parseConfig as pc } from "./core.ts";\n\nexport function load(t: string) {\n\treturn pc(t);\n}\n',
		"utf8",
	);
	await writeFile(join(root, "src", "commented.ts"), "// parseConfig is mentioned here but not called\nexport const x = 1;\n", "utf8");
});

after(async () => {
	await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
});

// ---------------------------------------------------------------------------
// The fallback
// ---------------------------------------------------------------------------

test("a textual search finds the plain occurrences", async () => {
	const found = await textualReferences([join(root, "src", "core.ts"), join(root, "src", "aliased.ts")], "parseConfig", root);
	assert.equal(found.length, 2, "the declaration and the import");
	assert.ok(
		found.every((f) => !f.path.startsWith("/")),
		"paths come back relative to the workspace",
	);
});

test("a textual search cannot see the aliased callsite — which is the whole problem", async () => {
	/*
	 * `return pc(t)` contains no occurrence of `parseConfig`. This assertion is not testing our
	 * code so much as pinning the limitation the caveat has to describe: if this ever starts
	 * passing, the caveat is lying and should be rewritten.
	 */
	const found = await textualReferences([join(root, "src", "aliased.ts")], "parseConfig", root);
	assert.ok(!found.some((f) => f.line === 4), "line 4 is `return pc(t)` and text search cannot reach it");
});

test("comment-only lines are skipped, so a rename driven by this does not edit prose", async () => {
	const found = await textualReferences([join(root, "src", "commented.ts")], "parseConfig", root);
	assert.equal(found.length, 0);
});

// ---------------------------------------------------------------------------
// Degrading
// ---------------------------------------------------------------------------

test("with no backend, references still answers", async () => {
	const result = await ask({ operation: "references", path: "src/core.ts", symbol: "parseConfig" });
	assert.equal(result.isError, undefined);
	assert.match(textOf(result), /文本搜索找到/);
});

test("and the answer names what a text search cannot see", async () => {
	/*
	 * The dangerous outcome is not a missing answer, it is a partial one presented as complete. The
	 * caveat is the difference between the model checking and the model proceeding.
	 */
	const result = await ask({ operation: "references", path: "src/core.ts", symbol: "parseConfig" });
	assert.match(textOf(result), /别名导入/);
	assert.match(textOf(result), /重导出/);
	assert.equal((result.details as { confidence?: string }).confidence, "textual");
});

test("the caveat is one string, so it cannot drift between call sites", () => {
	assert.match(TEXTUAL_CAVEAT, /别名导入/);
	assert.match(TEXTUAL_CAVEAT, /重导出/);
});

test("rename with no backend is refused rather than approximated", async () => {
	/*
	 * A textual rename is precisely the operation this layer exists to prevent: it edits every line
	 * it found, looks complete, and leaves the aliased callsite pointing at a name that no longer
	 * exists. Doing it "best effort" would be doing the bug on purpose.
	 */
	const result = await ask({ operation: "rename", path: "src/core.ts", symbol: "parseConfig", newName: "parseSettings" });
	assert.ok(result.isError);
	assert.match(textOf(result), /漏掉别名导入/);
	assert.match(textOf(result), /lsp references/, "and it says what to do instead");
});

test("diagnostics with no backend says so instead of inventing something", async () => {
	const result = await ask({ operation: "diagnostics", path: "src/core.ts" });
	assert.equal(result.isError, undefined);
	assert.match(textOf(result), /没有可用的语言服务器/);
});

// ---------------------------------------------------------------------------
// Routing and lifecycle
// ---------------------------------------------------------------------------

test("a file type nobody handles gets no backend", async () => {
	const manager = new CodeIntelManager([]);
	assert.equal(manager.backendFor("a.rs"), null);
	assert.equal(await manager.acquire(join(root, "a.rs"), root), null);
});

test("a backend whose binary is missing is not an error, just an absence", async () => {
	/*
	 * The default server table will eventually list rust-analyzer, gopls and friends. A user who
	 * has none of them installed must get a working degraded tool, not a warning per language.
	 */
	const missing: CodeIntelBackend = {
		name: "ghost",
		extensions: [".ts"],
		available: async () => false,
		start: async () => {
			throw new Error("must not be started");
		},
		ready: () => false,
		references: async () => [],
		definition: async () => [],
		diagnostics: async () => [],
		rename: async () => [],
		dispose: async () => {},
	};
	const manager = new CodeIntelManager([missing]);
	assert.equal(await manager.acquire(join(root, "src", "core.ts"), root), null);
});

test("a backend that throws on start degrades rather than propagating", async () => {
	const broken: CodeIntelBackend = {
		name: "broken",
		extensions: [".ts"],
		available: async () => true,
		start: async () => {
			throw new Error("boom");
		},
		ready: () => false,
		references: async () => [],
		definition: async () => [],
		diagnostics: async () => [],
		rename: async () => [],
		dispose: async () => {},
	};
	const manager = new CodeIntelManager([broken]);
	assert.equal(await manager.acquire(join(root, "src", "core.ts"), root), null, "a broken server is the same as no server");
});

test("a backend that failed to start is tried again on the next call", async () => {
	let starts = 0;
	let ready = false;
	const flaky: CodeIntelBackend = {
		name: "flaky",
		extensions: [".ts"],
		available: async () => true,
		start: async () => {
			starts += 1;
			if (starts === 1) throw new Error("boom");
			ready = true;
		},
		ready: () => ready,
		references: async () => [],
		definition: async () => [],
		diagnostics: async () => [],
		rename: async () => [],
		dispose: async () => {},
	};
	const manager = new CodeIntelManager([flaky]);
	const file = join(root, "src", "core.ts");
	assert.equal(await manager.acquire(file, root), null);
	assert.equal(await manager.acquire(file, root), flaky, "one failed start must not switch the server off for good");
	assert.equal(starts, 2);
	await manager.dispose();
});

test("dispose reaches every backend", async () => {
	let disposed = 0;
	const backend = (ext: string): CodeIntelBackend => ({
		name: ext,
		extensions: [ext],
		available: async () => true,
		start: async () => {},
		ready: () => true,
		references: async () => [],
		definition: async () => [],
		diagnostics: async () => [],
		rename: async () => [],
		dispose: async () => {
			disposed += 1;
		},
	});
	await new CodeIntelManager([backend(".ts"), backend(".go")]).dispose();
	assert.equal(disposed, 2, "a language server left running is hundreds of megabytes");
});

test("an unknown symbol is refused with advice rather than an empty list", async () => {
	const result = await ask({ operation: "references", path: "src/core.ts", symbol: "notAThing" });
	assert.ok(result.isError);
	assert.match(textOf(result), /找不到符号/);
});

test("四种查询都先经本体的读边界，拒绝时不启动服务器或读取文件", async () => {
	const asked: string[] = [];
	const run = runFor(root, ["/other-project"], async (target) => {
		asked.push(target);
		return { ok: false, message: "用户拒绝了这次读取" };
	});
	const tool = lspTool({
		managerFor: () => assert.fail("拒绝读取后不能启动语言服务器"),
		listFiles: async () => assert.fail("拒绝读取后不能列文件"),
	});
	for (const operation of ["references", "definition", "diagnostics", "rename"]) {
		const path = `../other-project/${operation}.ts`;
		const result = await tool.execute({ operation, path, symbol: "parse", newName: "read" }, run);
		assert.deepEqual(result, { isError: true, output: "用户拒绝了这次读取" });
		assert.equal(asked.at(-1), resolve(root, path), "只换成绝对路径，不替本体解析符号链接");
	}
	assert.equal(asked.length, 4);
});

test("本体交回的是资源内容而不是磁盘上的文件时拒掉，不启动服务器", async () => {
	const run = runFor(root, [], async () => ({ ok: true, resource: { url: "skill://x", content: "", contentType: "text/plain" } }));
	const tool = lspTool({
		managerFor: () => assert.fail("不是文件时不能启动语言服务器"),
		listFiles: async () => assert.fail("不是文件时不能列文件"),
	});
	const result = await tool.execute({ operation: "references", path: "skill://x", symbol: "parse" }, run);
	assert.ok(result.isError);
	assert.match(result.output, /不是磁盘上的文件/);
});

test("其他源目录和符号链接能经 tsserver 查询，服务器根仍是 cwd，重命名只列建议", { timeout: 20_000 }, async () => {
	const project = await mkdtemp(join(tmpdir(), "plume-lsp-multi-root-"));
	const cwd = join(project, "app");
	const shared = join(project, "shared");
	const manager = new CodeIntelManager([new TsServerBackend()]);
	try {
		await mkdir(cwd);
		await mkdir(shared);
		await writeFile(
			join(project, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { noEmit: true, allowImportingTsExtensions: true }, include: ["app", "shared"] }),
		);
		const core = join(shared, "core.ts");
		const source = "export function parseConfig(text: string): object {\n\treturn JSON.parse(text);\n}\n";
		await writeFile(core, source);
		await writeFile(join(shared, "index.ts"), 'export { parseConfig } from "./core.ts";\n');
		await writeFile(join(cwd, "use.ts"), 'import { parseConfig as pc } from "../shared/index.ts";\nexport const value = pc("{}");\n');
		await writeFile(join(shared, "broken.ts"), 'export const count: number = "bad";\n');
		await symlink(shared, join(cwd, "linked"), process.platform === "win32" ? "junction" : "dir");
		const run = runFor(cwd, [cwd, shared], async (target) => ({ ok: true, path: await realpath(target) }));
		const tool = lspTool({
			managerFor: (root) => {
				assert.equal(root, cwd, "附加源目录不切换服务器工作目录");
				return manager;
			},
			listFiles: async () => null,
		});
		const refs = await tool.execute({ operation: "references", path: "../shared/core.ts", symbol: "parseConfig" }, run);
		assert.equal((refs.details as { confidence: string }).confidence, "exact");
		assert.match(refs.output, /shared[/\\]index\.ts:1:/, "找得到另一个源目录里的重导出");
		assert.match(refs.output, /use\.ts:1:/, "找得到当前目录里的别名导入");
		const definition = await tool.execute({ operation: "definition", path: "use.ts", line: 2, column: 22 }, run);
		assert.match(definition.output, /shared[/\\]core\.ts:1:17/, "从别名穿过重导出回到另一个源目录里的定义");
		const diagnostics = await tool.execute({ operation: "diagnostics", path: "linked/broken.ts" }, run);
		assert.equal((diagnostics.details as { count: number }).count, 1);
		assert.match(diagnostics.output, /shared[/\\]broken\.ts:1:/, "用本体读边界交回的目标路径");
		const rename = await tool.execute({ operation: "rename", path: core, symbol: "parseConfig", newName: "parseSettings" }, run);
		const edits = (rename.details as { edits: { path: string; newText: string }[] }).edits;
		const realCore = await realpath(core);
		const realUse = await realpath(join(cwd, "use.ts"));
		assert.ok(edits.some((edit) => resolve(edit.path) === realCore));
		assert.ok(edits.some((edit) => resolve(edit.path) === realUse));
		assert.ok(edits.every((edit) => edit.newText === "parseSettings"));
		assert.equal(await readFile(core, "utf8"), source, "重命名查询没有写文件");
	} finally {
		await manager.dispose();
		await rm(project, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	}
});

test("with tsserver, references reach the aliased callsite that text search misses", { timeout: 20_000 }, async () => {
	// Without a tsconfig, tsserver's project is only the files it was told to open; a real project has one.
	await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { allowImportingTsExtensions: true, noEmit: true }, include: ["src"] }));
	const manager = new CodeIntelManager([new TsServerBackend()]);
	try {
		const result = await ask({ operation: "references", path: "src/core.ts", symbol: "parseConfig" }, manager);
		assert.equal(result.isError, undefined);
		assert.equal((result.details as { confidence?: string }).confidence, "exact");
		assert.match(textOf(result), /语言服务器，含别名导入与重导出/);
		assert.match(textOf(result), /src\/aliased\.ts:1:/, "the aliased import");
		const definition = await ask({ operation: "definition", path: "src/aliased.ts", line: 4, column: 9 }, manager);
		assert.match(textOf(definition), /src\/core\.ts:1:17/, "`pc` goes back to where `parseConfig` is declared");
	} finally {
		await manager.dispose();
	}
});

test("同一个目录的会话借同一套，最后一个还的停掉；换了目录先还旧的", async () => {
	const stopped: string[] = [];
	let made = 0;
	const leases = new CodeIntelLeases(() => {
		const name = `m${++made}`;
		return { dispose: async () => void stopped.push(name) } as unknown as CodeIntelManager;
	});
	const first = leases.borrow("a", "/w/app");
	assert.equal(leases.borrow("b", "/w/app/"), first);
	assert.equal(leases.borrow("a", "/w/app"), first);
	await leases.release("a");
	assert.deepEqual(stopped, []);
	// b 换了目录：旧的那一套没人借了，停掉。
	const moved = leases.borrow("b", "/w/tree");
	assert.notEqual(moved, first);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(stopped, ["m1"]);
	await leases.release("没借过的");
	await leases.release("b");
	assert.deepEqual(stopped, ["m1", "m2"]);
	// 还完再借是新的一套。
	assert.notEqual(leases.borrow("b", "/w/tree"), moved);
	await leases.dispose();
	assert.deepEqual(stopped, ["m1", "m2", "m3"]);
});
