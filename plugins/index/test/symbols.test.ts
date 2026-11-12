import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ToolRun } from "@plume/contract";
import { symbolTool } from "../src/symbol-tool.ts";
import { buildIndex, INDEX_VERSION, loadIndex, pruneIndexes, saveIndex, searchIndex, type SymbolIndex } from "../src/symbols.ts";

const notInGit = async () => null;

async function workspace(t: TestContext): Promise<{ dir: string; root: string }> {
	const base = await mkdtemp(join(tmpdir(), "plume-index-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const dir = join(base, "project");
	await mkdir(dir);
	return { dir, root: join(base, "data", "index") };
}

function lookup(root: string, dir: string, args: Record<string, unknown>) {
	const tool = symbolTool({ root, listFiles: notInGit, cache: new Map<string, SymbolIndex>() });
	return tool.execute(args, { sessionId: "s", cwd: dir, signal: new AbortController().signal } as ToolRun);
}

test("函数体里的局部变量不进索引；顶层常量、嵌套的函数照收", async (t) => {
	const { dir } = await workspace(t);
	await writeFile(
		join(dir, "a.ts"),
		[
			"export const MENU_WIDTH = { compact: 190 };",
			"function resolvedWidth(width) {",
			"\tconst fixed = widthOf(width);",
			"\tfunction inner() {}",
			"\treturn fixed;",
			"}",
		].join("\n"),
	);

	const names = (await buildIndex(dir, notInGit)).symbols.map((entry) => entry.name);

	assert.deepEqual(names, ["MENU_WIDTH", "resolvedWidth", "inner"]);
});

test("在 git 仓库里只收清单上的文件，清单上的 dist 之类照样跳过", async (t) => {
	const { dir } = await workspace(t);
	await mkdir(join(dir, "dist"));
	await writeFile(join(dir, "kept.ts"), "export function kept() {}\n");
	await writeFile(join(dir, "ignored.ts"), "export function ignored() {}\n");
	await writeFile(join(dir, "dist", "bundle.ts"), "export function bundled() {}\n");

	const index = await buildIndex(dir, async () => [join(dir, "kept.ts"), join(dir, "dist", "bundle.ts")]);

	assert.deepEqual(
		index.symbols.map((entry) => entry.name),
		["kept"],
	);
});

test("名字完全一样的排最前，导出的排在局部的前面", () => {
	const entry = (name: string, text: string) => ({ name, kind: "function", file: "a.ts", line: 1, text });
	const index = {
		cwd: "/",
		builtAt: 0,
		fileCount: 1,
		skipped: 0,
		symbols: [
			entry("runAgentLoop", "export function runAgentLoop()"),
			entry("runAgent", "function runAgent()"),
			entry("runAgent", "export function runAgent()"),
		],
	};

	assert.deepEqual(
		searchIndex(index, "runagent").map((hit) => hit.text),
		["export function runAgent()", "function runAgent()", "export function runAgentLoop()"],
	);
});

test("磁盘上旧规则建的索引不再沿用，按现在的规则重建", async (t) => {
	const { dir, root } = await workspace(t);
	await writeFile(join(dir, "a.ts"), "export function fresh() {}\n");
	// 没有 version：上一版规则建的，里面也没有 `fresh`。
	await saveIndex(root, { cwd: dir, builtAt: Date.now(), fileCount: 0, symbols: [], skipped: 0 });

	const found = await lookup(root, dir, { name: "fresh" });

	assert.match(found.output, /a\.ts:1/);
	assert.equal((await loadIndex(root, dir))?.version, INDEX_VERSION);
});

test("名字写在 query 上也认", async (t) => {
	const { dir, root } = await workspace(t);
	await writeFile(join(dir, "a.ts"), "export class Widget {}\n");

	const found = await lookup(root, dir, { query: "Widget" });

	assert.equal(found.isError, undefined);
	assert.match(found.output, /a\.ts:1 {2}\[class\]/);
});

test("导出 Markdown 时写成「Find definition of」加符号名，名字写在别的键上也认", () => {
	const describe = symbolTool({ root: "/unused", listFiles: notInGit, cache: new Map<string, SymbolIndex>() }).describe!;
	assert.equal(describe({ name: " parseConfig " }), "Find definition of parseConfig");
	assert.equal(describe({ query: "Widget" }), "Find definition of Widget");
	assert.equal(describe({ name: "", pattern: "render" }), "Find definition of render");
	assert.equal(describe({ name: 42 }), "Find definition");
	assert.equal(describe({}), "Find definition");
});

test("索引没建完时，找不到要说清楚是没建到，不是不存在", async (t) => {
	const { dir, root } = await workspace(t);
	await saveIndex(root, { cwd: dir, builtAt: Date.now(), fileCount: 1, symbols: [], skipped: 0, version: INDEX_VERSION, truncated: true });

	const found = await lookup(root, dir, { name: "missing" });

	assert.match(found.output, /never indexed/);
});

test("目录不在了的索引删掉，还在用的留着", async (t) => {
	const { dir, root } = await workspace(t);
	// 路径里带引号：目录是从 JSON 里读回来的，不是按原文匹配。
	const kept = join(dir, 'project "a"');
	const gone = join(dir, "worktree-b");
	await mkdir(kept);
	await saveIndex(root, { cwd: kept, builtAt: 1, fileCount: 0, symbols: [], skipped: 0 });
	await saveIndex(root, { cwd: gone, builtAt: 1, fileCount: 0, symbols: [], skipped: 0 });

	assert.equal(await pruneIndexes(root), 1);
	assert.equal((await readdir(root)).length, 1);
	assert.ok(await loadIndex(root, kept));
});
