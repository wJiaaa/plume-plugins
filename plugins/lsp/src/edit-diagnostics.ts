/**
 * After a call that changed files (whatever the tool: plume.tools' `write` and `edit`, a command run
 * with `recordChanges`): the errors the language server now reports in those files, appended to the
 * result.
 *
 * Without it a type error just written stays unknown until something runs a check. In session
 * histories `lsp diagnostics` was called 0 times across 417 code edits, and 10 of 29 sessions that
 * edited code ended without running any check after the last edit. Telling the model in the result
 * it is already reading costs nothing when the files are clean — nothing is added.
 *
 * Errors only, changed files only. Warnings mid-refactor are noise to chase, and other files broken
 * by a changed signature need a whole-program check, which is `lsp references`' job. The wording
 * reports rather than asks for a fix: the first of three planned edits often leaves an error the
 * third removes, and "please fix" pulls the model into fixing it early.
 *
 * A layer of the `tool.execute` hook rather than part of the tools: the file tools belong to other
 * plugins (the built-in plume.tools), and this plugin only reads their results.
 */

import { stat } from "node:fs/promises";
import { relative } from "node:path";
import type { ToolOutput } from "@plume/contract";
import type { CodeIntelManager } from "./manager.ts";
import { within } from "./paths.ts";
import type { Diagnostic } from "./types.ts";

/**
 * How long a call that changed files may wait for diagnostics before it returns without them — one
 * deadline for all its files; the files answered by then are still shown.
 *
 * Measured with tsserver: 13–46ms p50–p95 once warm, about 1s for the first question while it
 * loads the project. Past this the call returns as it would have.
 */
const WAIT_MS = 2000;
const MAX_SHOWN = 10;
/**
 * 一次调用改了超过这么多个语言服务器认的文件，就一个都不问。改这么多的多半是格式化、生成代码、`git checkout` 这类批量命令：
 * 逐个问要排着队过语言服务器（每个文件同步一次内容、问两次），两秒内问不完，超时以后服务器还在后台算；列出来也是一长串，
 * 这时该做的是整个项目的检查，不是逐个文件看。
 */
const MAX_FILES = 5;

/**
 * 这次调用改了哪些文件，只认本体记在结果上的（`ToolOutput.changes.paths`，已是绝对路径），不认是哪个工具、参数叫什么：
 * 命令改的也在里面；出错的结果上记着的也是真改了，照样问。只问语言服务器认的、改完还在的（删掉的不问）。
 */
async function changedFiles(manager: CodeIntelManager, result: ToolOutput): Promise<string[]> {
	const claimed = [...new Set(result.changes?.paths ?? [])].filter((path) => manager.backendFor(path));
	const present = await Promise.all(
		claimed.map((path) =>
			stat(path).then(
				(info) => info.isFile(),
				() => false,
			),
		),
	);
	return claimed.filter((_, at) => present[at]);
}

export async function withDiagnostics(manager: CodeIntelManager, cwd: string, result: ToolOutput): Promise<ToolOutput> {
	const files = await changedFiles(manager, result);
	if (files.length === 0) return result;
	// Recorded with the result, so a look through sessions can see how long this costs and how often it times out or is skipped.
	const base = result.details && typeof result.details === "object" ? (result.details as Record<string, unknown>) : {};
	if (files.length > MAX_FILES) return { ...result, details: { ...base, diagnostics: { files: files.length, skipped: true } } };

	const started = Date.now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), WAIT_MS);
	});
	const found = await Promise.all(
		files.map((file) => {
			// Caught on the request itself: after a timeout it still settles, and a rejection then would be unhandled.
			const request = manager
				.acquire(file, cwd, { waitMs: 0 })
				.then((ready) => (ready ? ready.diagnostics(file) : null))
				.catch(() => null);
			return Promise.race([request, timeout]);
		}),
	);
	clearTimeout(timer);
	const ms = Date.now() - started;

	const timedOut = found.includes("timeout");
	const answered = files.flatMap((file, at) => {
		const list = found[at];
		return Array.isArray(list) ? [{ file, errors: list.filter((d) => d.severity === "error") }] : [];
	});
	if (answered.length === 0 && !timedOut) return result;
	const count = answered.reduce((sum, entry) => sum + entry.errors.length, 0);
	const details = { ...base, diagnostics: { files: files.length, errors: count, ms, ...(timedOut ? { timedOut: true } : {}) } };
	if (count === 0) return { ...result, details };
	return { ...result, output: `${result.output}${render(cwd, answered, count)}`, details };
}

function render(cwd: string, answered: { file: string; errors: Diagnostic[] }[], count: number): string {
	const line = (d: Diagnostic) =>
		// tsserver chains a message over several lines; one line each keeps the list readable.
		`${d.line}:${d.column} ${d.message.replace(/\s*\n\s*/g, " ")}${d.code === undefined ? "" : ` (${d.code})`}`;
	const shown = (file: string) => (within(cwd, file) ? relative(cwd, file) : file);
	const withErrors = answered.filter((entry) => entry.errors.length > 0);
	const lines: string[] = [];
	let left = MAX_SHOWN;
	for (const { file, errors } of withErrors) {
		if (left === 0) break;
		// One file: its name is in the heading. Several: each gets its own heading line.
		if (withErrors.length > 1) lines.push(`${shown(file)}:`);
		lines.push(...errors.slice(0, left).map(line));
		left -= Math.min(left, errors.length);
	}
	const more = count > MAX_SHOWN ? `\n… ${count - MAX_SHOWN} more` : "";
	const where = withErrors.length === 1 ? shown(withErrors[0]!.file) : `${withErrors.length} files this call changed`;
	return `\n\nThe language server now reports ${count} error${count === 1 ? "" : "s"} in ${where}:\n${lines.join("\n")}${more}`;
}
