/**
 * edit、write 之后附上的错误，对着一台假的语言服务器。
 *
 * 要守住的：文件干净时一个字不加，只列错误、最多列那么多；要握手的服务器起起来但不等；慢的服务器拖不住这次编辑；
 * 只接声明了写、改文件（kind 是 create、modify）的工具改成了的那次。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ToolExecution, ToolKind, ToolOutput } from "@plume/contract";
import { editedFile, withDiagnostics } from "../src/edit-diagnostics.ts";
import { CodeIntelManager } from "../src/manager.ts";
import type { CodeIntelBackend, Diagnostic } from "../src/types.ts";

function fakeServer(options: { ready?: boolean; handshake?: boolean; diagnostics?: () => Promise<Diagnostic[]> } = {}) {
	let ready = options.ready ?? true;
	const calls = { start: 0, diagnostics: 0 };
	const backend: CodeIntelBackend = {
		name: "fake",
		extensions: [".ts"],
		available: async () => true,
		start: async () => {
			calls.start++;
			if (options.handshake) await new Promise((resolve) => setTimeout(resolve, 50));
			ready = true;
		},
		ready: () => ready,
		references: async () => [],
		definition: async () => [],
		diagnostics: async () => {
			calls.diagnostics++;
			return (await options.diagnostics?.()) ?? [];
		},
		rename: async () => [],
		dispose: async () => {},
	};
	return { backend, calls };
}

const EDITED: ToolOutput = { output: "Edited a.ts: 1 replacement, +1 -1.", details: { kind: "edit", path: "a.ts" } };

/** 走一遍插件那一层：里层（声明了 `kind` 的工具）给出 `inner`，再看附没附诊断。 */
async function run(t: TestContext, backend: CodeIntelBackend, options: { name?: string; tool?: string; kind?: ToolKind; inner?: ToolOutput } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "plume-edit-diag-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = options.name ?? "a.ts";
	await writeFile(join(dir, path), "export const a = 1;\n");
	const tool = options.tool ?? "edit";
	const input = {
		sessionId: "s",
		cwd: dir,
		call: { id: "c", name: tool, args: { path } },
		tool: { name: tool, mutating: true, plugin: "plume.tools" },
	} as unknown as ToolExecution;
	const inner = options.inner ?? EDITED;
	const manager = new CodeIntelManager([backend]);
	t.after(() => manager.dispose());
	const file = editedFile(input, inner, "kind" in options ? options.kind : "modify");
	return file ? withDiagnostics(manager, dir, file, inner) : inner;
}

const error = (line: number, message: string): Diagnostic => ({ path: "", line, column: 1, severity: "error", message, code: 2322 });
const diagnosticsOf = (res: ToolOutput) => (res.details as { diagnostics?: Record<string, unknown> } | undefined)?.diagnostics;

test("这个文件里的错误附在后面，警告不附", async (t) => {
	const { backend } = fakeServer({
		diagnostics: async () => [error(1, "Type 'string' is not assignable to type 'number'."), { ...error(2, "unused"), severity: "warning" }],
	});
	const res = await run(t, backend);
	assert.match(res.output, /^Edited a\.ts: 1 replacement, \+1 -1\./, "编辑自己的话在前");
	assert.match(res.output, /The language server now reports 1 error in this file:\n1:1 Type 'string' is not assignable to type 'number'\. \(2322\)$/);
	assert.doesNotMatch(res.output, /unused/);
	assert.equal(diagnosticsOf(res)?.errors, 1);
	assert.equal((res.details as { kind?: string }).kind, "edit", "原来的 details 留着");
});

test("文件干净时一个字不加", async (t) => {
	const { backend, calls } = fakeServer();
	const res = await run(t, backend);
	assert.equal(calls.diagnostics, 1);
	assert.equal(res.output, EDITED.output);
	assert.equal(diagnosticsOf(res)?.errors, 0);
});

test("最多列十条，剩下的报个数；跨行的消息并成一行", async (t) => {
	const { backend } = fakeServer({ diagnostics: async () => Array.from({ length: 12 }, (_, i) => error(i + 1, `multi\n  line ${i}`)) });
	const res = await run(t, backend);
	assert.match(res.output, /reports 12 errors/);
	assert.match(res.output, /10:1 multi line 9 \(2322\)\n… 2 more$/);
	assert.doesNotMatch(res.output, /11:1/);
});

test("一起来就能答的服务器，第一次编辑就问", async (t) => {
	const { backend, calls } = fakeServer({ ready: false, diagnostics: async () => [error(1, "x")] });
	const res = await run(t, backend);
	assert.equal(calls.start, 1);
	assert.equal(diagnosticsOf(res)?.errors, 1);
});

test("要握手的服务器起起来，但这次不等", async (t) => {
	const { backend, calls } = fakeServer({ ready: false, handshake: true, diagnostics: async () => [error(1, "x")] });
	const res = await run(t, backend);
	assert.equal(calls.start, 1);
	assert.equal(calls.diagnostics, 0);
	assert.equal(diagnosticsOf(res), undefined);
});

test("不回话的服务器拖不过上限", async (t) => {
	const { backend } = fakeServer({ diagnostics: () => new Promise(() => {}) });
	const started = Date.now();
	const res = await run(t, backend);
	assert.ok(Date.now() - started < 3000);
	assert.equal(res.isError, undefined);
	assert.equal(diagnosticsOf(res)?.timedOut, true);
});

test("没有服务器认领的文件不问", async (t) => {
	const { backend, calls } = fakeServer();
	const res = await run(t, backend, { name: "notes.md" });
	assert.equal(calls.diagnostics + calls.start, 0);
	assert.equal(diagnosticsOf(res), undefined);
});

test("write 同样附上", async (t) => {
	const { backend } = fakeServer({ diagnostics: async () => [error(1, "'}' expected.")] });
	const res = await run(t, backend, { tool: "write", kind: "create", inner: { output: "Created a.ts.", details: { kind: "write" } } });
	assert.match(res.output, /^Created a\.ts\.\n\nThe language server now reports 1 error in this file:\n1:1 '\}' expected\. \(2322\)$/);
});

test("被拒绝、出错的编辑不问", async (t) => {
	const { backend, calls } = fakeServer();
	const res = await run(t, backend, { inner: { output: "The user rejected this edit.", isError: true } });
	assert.equal(res.isError, true);
	assert.equal(calls.diagnostics, 0);
});

test("没声明写、改文件的工具不接，叫什么都一样", async (t) => {
	for (const kind of [undefined, "view"] as const) {
		const { backend, calls } = fakeServer({ diagnostics: async () => [error(1, "x")] });
		const res = await run(t, backend, { kind });
		assert.equal(calls.diagnostics, 0);
		assert.equal(res, EDITED);
	}
});
