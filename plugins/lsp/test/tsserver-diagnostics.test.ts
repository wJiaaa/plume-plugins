/**
 * Diagnostics from a real `tsserver`, after the file has changed under it.
 *
 * Both cases below once answered "no diagnostics" for a file with an error in it: an open file was
 * never re-read after an edit, and only semantic diagnostics were asked for, which leave out syntax.
 */

import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TsServerBackend } from "../src/tsserver.ts";

async function project(t: { after: (fn: () => Promise<void>) => void }) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "plume-tsserver-")));
	const backend = new TsServerBackend();
	t.after(async () => {
		await backend.dispose();
		await rm(root, { recursive: true, force: true });
	});
	return { root, backend, file: join(root, "a.ts") };
}

test("an error written after the file was first asked about is reported", async (t) => {
	const { root, backend, file } = await project(t);
	assert.ok(await backend.available(), "the plugin carries typescript 6 in its dependencies");
	await writeFile(file, "export const a: number = 1;\n");
	await backend.start(root);
	assert.deepEqual(await backend.diagnostics(file), []);

	await writeFile(file, 'export const a: number = "x";\n');
	const found = await backend.diagnostics(file);
	assert.equal(found.length, 1);
	assert.equal(found[0]?.code, 2322);
	assert.equal(found[0]?.severity, "error");
});

test("a syntax error is reported, not only type errors", async (t) => {
	const { root, backend, file } = await project(t);
	assert.ok(await backend.available(), "the plugin carries typescript 6 in its dependencies");
	await writeFile(file, "export function f() {\n\treturn 1;\n");
	await backend.start(root);
	const found = await backend.diagnostics(file);
	assert.ok(found.length > 0, "a missing brace is an error");
	assert.equal(found[0]?.severity, "error");
	assert.match(found[0]?.message, /'\}' expected/);
});
