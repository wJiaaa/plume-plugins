/**
 * After a tool that writes or changes a file (declared `kind: "create"` or `"modify"`, like plume.tools'
 * `write` and `edit`): the errors the language server now reports in that file, appended to the result.
 *
 * Without it a type error just written stays unknown until something runs a check. In session
 * histories `lsp diagnostics` was called 0 times across 417 code edits, and 10 of 29 sessions that
 * edited code ended without running any check after the last edit. Telling the model in the result
 * it is already reading costs nothing when the file is clean — nothing is added.
 *
 * Errors only, this file only. Warnings mid-refactor are noise to chase, and other files broken by a
 * changed signature need a whole-program check, which is `lsp references`' job. The wording reports
 * rather than asks for a fix: the first of three planned edits often leaves an error the third
 * removes, and "please fix" pulls the model into fixing it early.
 *
 * A layer of the `tool.execute` hook rather than part of the tools: the file tools belong to other
 * plugins (the built-in plume.tools), and this plugin only reads their results.
 */

import type { ToolExecution, ToolKind, ToolOutput } from "@plume/contract";
import type { CodeIntelManager } from "./manager.ts";
import { toAbsolute } from "./paths.ts";
import type { Diagnostic } from "./types.ts";

/**
 * How long a successful edit may wait for diagnostics before it returns without them.
 *
 * Measured with tsserver: 13–46ms p50–p95 once warm, about 1s for the first question while it
 * loads the project. Past this the edit returns as it would have.
 */
const WAIT_MS = 2000;
const MAX_SHOWN = 10;

/**
 * 只接声明了写、改文件（`kind` 是 `create`、`modify`，注册它的插件在工具定义上写的）、改成了的那次。`kind` 由调用方从工具表里查，
 * 不认工具名。文件从参数的 `path` 取：没有这个参数的写文件工具不附诊断。
 */
export function editedFile(input: ToolExecution, result: ToolOutput, kind: ToolKind | undefined): string | null {
	if (kind !== "create" && kind !== "modify") return null;
	if (result.isError) return null;
	const path = input.call.args.path;
	return typeof path === "string" && path ? toAbsolute(input.cwd, path) : null;
}

export async function withDiagnostics(manager: CodeIntelManager, cwd: string, file: string, result: ToolOutput): Promise<ToolOutput> {
	const started = Date.now();
	// Caught on the request itself: after a timeout it still settles, and a rejection then would be unhandled.
	const request = manager
		.acquire(file, cwd, { waitMs: 0 })
		.then((ready) => (ready ? ready.diagnostics(file) : null))
		.catch(() => null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), WAIT_MS);
	});
	const found = await Promise.race([request, timeout]);
	clearTimeout(timer);
	const ms = Date.now() - started;
	// Recorded with the result, so a look through sessions can see how long this costs and how often it times out.
	const base = result.details && typeof result.details === "object" ? (result.details as Record<string, unknown>) : {};

	if (found === "timeout") return { ...result, details: { ...base, diagnostics: { timedOut: true, ms } } };
	if (found === null) return result;
	const errors = found.filter((d) => d.severity === "error");
	const details = { ...base, diagnostics: { errors: errors.length, ms } };
	if (errors.length === 0) return { ...result, details };
	return { ...result, output: `${result.output}${render(errors)}`, details };
}

function render(errors: Diagnostic[]): string {
	const lines = errors
		.slice(0, MAX_SHOWN)
		// tsserver chains a message over several lines; one line each keeps the list readable.
		.map((d) => `${d.line}:${d.column} ${d.message.replace(/\s*\n\s*/g, " ")}${d.code === undefined ? "" : ` (${d.code})`}`);
	const more = errors.length > MAX_SHOWN ? `\n… ${errors.length - MAX_SHOWN} more` : "";
	return `\n\nThe language server now reports ${errors.length} error${errors.length === 1 ? "" : "s"} in this file:\n${lines.join("\n")}${more}`;
}
