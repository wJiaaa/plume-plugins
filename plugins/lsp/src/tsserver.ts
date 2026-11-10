/**
 * TypeScript, through the `tsserver` this plugin carries in `dist/node_modules/typescript`.
 *
 * TypeScript 6, pinned in `package.json`'s `dependencies`, rather than the 7 the repository builds with:
 * 7 is a native binary in a per-platform package, which the plugin build (it copies only the packages
 * listed, not their dependencies) cannot carry; 6 is plain JavaScript and still ships `tsserver.js`.
 *
 * Three ways to reach TypeScript's understanding of a program, and the choice between them is
 * about where the cost lands:
 *
 *   `typescript-language-server` speaks standard LSP, and is another dependency to carry.
 *
 *   The `LanguageService` API needs no process and no protocol, and builds the program *inside
 *   this process*. On a large repository that is seconds of blocking work and hundreds of
 *   megabytes, in the agent process that runs every session.
 *
 *   `tsserver` is a subprocess with a private protocol. No new dependency, no risk to the window,
 *   and one adapter layer to write — this file. It is the only non-standard adapter we take on;
 *   every other language goes through standard LSP.
 *
 * The protocol is line-delimited JSON, not LSP's `Content-Length` framing, and its own request
 * names. Both are why this is a file rather than a config entry.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { CodeIntelBackend, CodeLocation, Diagnostic, TextEdit } from "./types.ts";

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * How long to wait for one request.
 *
 * Not a guess at how fast the server is: it is how long a tool call may block before returning a
 * degraded answer is better than returning nothing. A model waiting fifteen seconds for references
 * has already lost more than the precision was worth.
 */
const REQUEST_TIMEOUT_MS = 8000;

export class TsServerBackend implements CodeIntelBackend {
	readonly name = "tsserver";
	readonly extensions = EXTENSIONS;

	private child: ChildProcess | null = null;

	/** 子进程的 pid，没起来是 null。给「空闲之后进程真的没了」那条测试用——它数的是进程，不是标志位。 */
	get pid(): number | null {
		return this.child?.pid ?? null;
	}
	private seq = 1;
	private buffer = "";
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
	/** Files opened with the server, and the text it was last given for each. */
	private readonly open = new Map<string, string>();
	private started = false;
	private root = "";

	async available(): Promise<boolean> {
		return this.locate() !== null;
	}

	/** `tsserver.js` from whichever `typescript` resolves here. Null when there is none. */
	private locate(): string | null {
		try {
			const require = createRequire(import.meta.url);
			return require.resolve("typescript/lib/tsserver.js");
		} catch {
			return null;
		}
	}

	async start(root: string): Promise<void> {
		if (this.started) return;
		const entry = this.locate();
		// i18n-exempt：交给模型的话（工具结果、错误）。
		if (!entry) throw new Error("找不到 typescript/lib/tsserver.js。");

		this.root = root;
		/*
		 * `ELECTRON_RUN_AS_NODE`, because in the agent process `process.execPath` is Plume, not Node.
		 *
		 * Without it every code-intelligence question would start a second copy of the app with
		 * `tsserver.js` for an argument: the single-instance lock sends it away, the server never
		 * answers, and the tool waits out its timeout into a textual fallback — in the app only,
		 * since the tests run under Node where the variable does nothing. `windowsHide` because the
		 * agent process has no console, and a program started from it without the flag opens one.
		 */
		const child = spawn(process.execPath, [entry, "--disableAutomaticTypingAcquisition"], {
			cwd: root,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, NODE_OPTIONS: "", ELECTRON_RUN_AS_NODE: "1" },
			windowsHide: true,
		});
		this.child = child;
		this.started = true;
		/*
		 * Detached from the parent's exit accounting.
		 *
		 * Without this the language server keeps the host process alive: a test that asked one
		 * `references` question finishes its work in 300ms and then sits there until tsserver's own
		 * idle timeout, looking hung. `dispose` still kills it — this only stops it voting on when
		 * the parent may exit. The pipes too, as in `stdio.ts`: unref on the process alone left them
		 * holding the loop, and once edits started the server in the background a test file that
		 * edited a `.ts` never exited.
		 */
		this.child.unref();
		for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) (stream as { unref?: () => void } | null)?.unref?.();

		this.child.stdout?.setEncoding("utf8");
		this.child.stdout?.on("data", (chunk: string) => this.consume(chunk));
		/*
		 * The server's own stderr is discarded rather than surfaced.
		 *
		 * It reports on projects it decided to load, files it could not resolve and its own
		 * telemetry — none of which is about the question that was asked, and all of which would
		 * turn a working lookup into a wall of noise attached to a tool result.
		 */
		this.child.stderr?.resume();
		// i18n-exempt：交给模型的话（工具结果、错误）。
		this.child.on("exit", () => this.gone(child, new Error("tsserver 退出了。")));
		this.child.on("error", (error) => this.gone(child, error));
	}

	/**
	 * The process is gone, and with it every file it had been told to open.
	 *
	 * `open` records what *this* process has opened; a new process has opened nothing. Resetting
	 * only `started` left `sync` believing the restarted server already had the file, so it sent a
	 * `reload` or nothing at all, and every answer after a crash was "No Project" until the session
	 * ended. Only for its own process, as in `stdio.ts`: after a recycle and a restart, the old
	 * process's late `exit` must not wipe the new one's state.
	 */
	private gone(child: ChildProcess, error: Error): void {
		if (this.child !== child) return;
		this.failAll(error);
		this.open.clear();
		this.buffer = "";
		this.child = null;
	}

	ready(): boolean {
		return this.started && this.child !== null && !this.child.killed;
	}

	private consume(chunk: string): void {
		this.buffer += chunk;
		/*
		 * Line-delimited JSON, and the lines that matter are the ones starting with `{`.
		 *
		 * tsserver interleaves `Content-Length` headers and blank lines with its payloads depending
		 * on version and flags. Filtering on the first character rather than parsing the framing is
		 * what makes this robust across both shapes.
		 */
		let newline = this.buffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			newline = this.buffer.indexOf("\n");
			if (!line.startsWith("{")) continue;
			try {
				const message = JSON.parse(line) as { type?: string; request_seq?: number; success?: boolean; body?: unknown; message?: string };
				if (message.type === "response" && typeof message.request_seq === "number") {
					const waiter = this.pending.get(message.request_seq);
					if (!waiter) continue;
					this.pending.delete(message.request_seq);
					clearTimeout(waiter.timer);
					// i18n-exempt：交给模型的话（工具结果、错误）。
					if (message.success === false) waiter.reject(new Error(message.message ?? "tsserver 拒绝了这个请求。"));
					else waiter.resolve(message.body);
				}
			} catch {
				// A line that is not JSON is not a response; ignoring it is the whole handling.
			}
		}
	}

	private failAll(error: Error): void {
		for (const waiter of this.pending.values()) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		this.pending.clear();
		this.started = false;
	}

	private send(command: string, args: unknown, expectResponse: boolean): Promise<unknown> {
		// i18n-exempt：交给模型的话（工具结果、错误）。
		if (!this.child?.stdin) return Promise.reject(new Error("tsserver 没有在运行。"));
		const seq = this.seq++;
		this.child.stdin.write(`${JSON.stringify({ seq, type: "request", command, arguments: args })}\n`);
		if (!expectResponse) return Promise.resolve(undefined);

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(seq);
				// i18n-exempt：交给模型的话（工具结果、错误）。
				reject(new Error(`tsserver 在 ${REQUEST_TIMEOUT_MS}ms 内没有回应 ${command}。`));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(seq, { resolve, reject, timer });
		});
	}

	/**
	 * Make the server's copy of `file` match the disk before asking about it.
	 *
	 * The server answers nothing about a file it has not been told to open, and once a file is open
	 * it stops reading it from disk: the client owns it. Opening once and never again left every
	 * answer after an edit about the text as first opened — diagnostics said "none" for a type error
	 * just written. So the text is compared each time and `reload` sent only when it changed; `open`
	 * again would make the server rebuild its view, which on a large project costs more than the call.
	 */
	private async sync(file: string): Promise<void> {
		const text = await readFile(file, "utf8").catch(() => null);
		const known = this.open.get(file);
		if (known === undefined) {
			await this.send("open", { file }, false);
		} else if (text !== null && text !== known) {
			await this.send("reload", { file, tmpfile: file }, true);
		}
		if (text !== null) this.open.set(file, text);
	}

	async references(file: string, line: number, column: number): Promise<CodeLocation[]> {
		await this.sync(file);
		const body = (await this.send("references", { file, line, offset: column }, true)) as
			| { refs?: { file: string; start: { line: number; offset: number }; lineText?: string }[] }
			| undefined;
		return (body?.refs ?? []).map((ref) => ({
			path: ref.file,
			line: ref.start.line,
			column: ref.start.offset,
			text: ref.lineText?.trim(),
		}));
	}

	async definition(file: string, line: number, column: number): Promise<CodeLocation[]> {
		await this.sync(file);
		const body = (await this.send("definition", { file, line, offset: column }, true)) as
			| { file: string; start: { line: number; offset: number } }[]
			| undefined;
		return (body ?? []).map((entry) => ({ path: entry.file, line: entry.start.line, column: entry.start.offset }));
	}

	async diagnostics(file: string): Promise<Diagnostic[]> {
		await this.sync(file);
		type Entry = { start: { line: number; offset: number }; text: string; code?: number; category?: string };
		// Semantic diagnostics leave out syntax errors — a missing brace came back as "none" — so both are asked, syntax first.
		const syntactic = ((await this.send("syntacticDiagnosticsSync", { file }, true)) as Entry[] | undefined) ?? [];
		const semantic = ((await this.send("semanticDiagnosticsSync", { file }, true)) as Entry[] | undefined) ?? [];
		return [...syntactic, ...semantic].map((entry) => ({
			path: file,
			line: entry.start.line,
			column: entry.start.offset,
			severity: entry.category === "warning" ? "warning" : entry.category === "suggestion" ? "info" : "error",
			message: entry.text,
			code: entry.code,
		}));
	}

	async rename(file: string, line: number, column: number, newName: string): Promise<TextEdit[]> {
		await this.sync(file);
		const body = (await this.send("rename", { file, line, offset: column, findInStrings: false, findInComments: false }, true)) as
			| {
					info?: { canRename?: boolean; localizedErrorMessage?: string };
					locs?: { file: string; locs: { start: { line: number; offset: number }; end: { line: number; offset: number } }[] }[];
			  }
			| undefined;

		if (body?.info?.canRename === false) {
			// i18n-exempt：交给模型的话（工具结果、错误）。
			throw new Error(body.info.localizedErrorMessage ?? "这个位置不能重命名。");
		}
		const edits: TextEdit[] = [];
		for (const group of body?.locs ?? []) {
			for (const loc of group.locs) {
				edits.push({
					path: group.file,
					line: loc.start.line,
					column: loc.start.offset,
					endLine: loc.end.line,
					endColumn: loc.end.offset,
					newText: newName,
				});
			}
		}
		return edits;
	}

	async dispose(): Promise<void> {
		// i18n-exempt：交给模型的话（工具结果、错误）。
		this.failAll(new Error("语言服务器停了。"));
		this.open.clear();
		this.child?.kill();
		this.child = null;
		this.started = false;
	}
}
