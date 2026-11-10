/**
 * 标准 LSP 的语言服务器，经 stdio 说话——除 TypeScript 之外的每种语言都走这里。
 *
 * 资源纪律和 tsserver 一样，由 `manager.ts` 管：第一次被问才起、起得慢就先给文本答案、空闲十分钟
 * 回收。这个文件只管一台服务器从起到死的那一段。
 *
 * 和 tsserver 那个后端最大的不同在文档同步。tsserver 认一次 `open` 之后自己盯着磁盘；标准 LSP
 * 里一个文件只要 `didOpen` 过，服务器就只信客户端给的内容。agent 会在两次提问之间改文件，所以
 * 每次提问前都从磁盘重读一遍，变了就 `didChange` 整篇推过去——不推，服务器回答的是它记得的
 * 旧版本，行号会整段错开。
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { commandEnv } from "./login-env.ts";
import { within } from "./paths.ts";
import { PublishedDiagnostics } from "./published.ts";
import { LspConnection } from "./rpc.ts";
import { findExecutable, spawnPlan, type LanguageServerSpec } from "./servers.ts";
import { toDiagnostics, toLocations, toTextEdits, withLineText } from "./translate.ts";
import type { CodeIntelBackend, CodeLocation, Diagnostic, TextEdit } from "./types.ts";
import { pathToUri, uriToPath } from "./uri.ts";

/** 和 tsserver 后端同一个数，理由也一样：一次工具调用最多卡这么久，再久不如给降级答案。 */
const REQUEST_TIMEOUT_MS = 8000;
/** `initialize` 放宽：管理器只等三秒就先给文本答案，握手在后台接着走，下一次调用就能用上。 */
const INITIALIZE_TIMEOUT_MS = 30_000;

interface OpenDocument {
	version: number;
	text: string;
}

export class StdioLspBackend implements CodeIntelBackend {
	readonly name: string;
	readonly extensions: string[];
	readonly install: string;
	private readonly spec: LanguageServerSpec;

	private child: ChildProcess | null = null;
	private connection: LspConnection | null = null;
	private capabilities: Record<string, unknown> = {};
	private initialized = false;
	private root = "";
	/**
	 * 项目根的真实路径。clangd 的索引按解析过符号链接的路径记文件，发给它 `/var/...`、它的索引里
	 * 是 `/private/var/...`，同一个文件就成了两个：引用只找到一半，还重复列出。所以发出去的 URI
	 * 一律换成真实路径，收回来的再换回人用的那个根。
	 */
	private realRoot = "";
	private readonly documents = new Map<string, OpenDocument>();
	private readonly published = new PublishedDiagnostics();

	constructor(spec: LanguageServerSpec) {
		this.spec = spec;
		this.name = spec.name;
		this.extensions = Object.keys(spec.languages);
		this.install = spec.install;
	}

	get pid(): number | null {
		return this.child?.pid ?? null;
	}

	/** 每次都重新找：会话开着的时候装上的服务器，下一次提问就该用上，不用重开会话。 */
	private async resolveCommand(): Promise<{ file: string; args: string[] } | null> {
		const env = await commandEnv();
		for (const candidate of this.spec.commands) {
			const file = findExecutable(candidate.command, env);
			if (file) return { file, args: candidate.args };
		}
		return null;
	}

	async available(): Promise<boolean> {
		return (await this.resolveCommand()) !== null;
	}

	ready(): boolean {
		return this.initialized && this.connection !== null && !this.connection.closed;
	}

	async start(root: string): Promise<void> {
		if (this.child) return;
		const resolved = await this.resolveCommand();
		// i18n-exempt：交给模型的错误。
		if (!resolved) throw new Error(`找不到 ${this.spec.name}。`);
		this.root = root;
		try {
			this.realRoot = realpathSync(root);
		} catch {
			this.realRoot = root;
		}

		const plan = spawnPlan(resolved.file, resolved.args);
		// `windowsHide`：宿主（agent 进程）没有控制台，不带它 Windows 会给每台服务器弹一个黑窗口。
		const child = spawn(plan.command, plan.args, {
			cwd: root,
			stdio: ["pipe", "pipe", "pipe"],
			env: await commandEnv(),
			shell: plan.shell,
			windowsHide: true,
		});
		this.child = child;
		let connection: LspConnection | null = null;
		const gone = (error: Error) => {
			connection?.close(error);
			// 只收拾自己这一台：回收之后又起了新的，旧进程迟到的 exit 不能把新的状态清掉。
			if (this.child === child) this.reset();
		};
		// 先挂上：spawn 失败（ENOENT、权限）是一个异步的 error 事件，没人接就是宿主进程的未捕获异常。
		// i18n-exempt：交给模型的话（工具结果、错误）。
		child.on("exit", () => gone(new Error(`${this.spec.name} 退出了。`)));
		child.on("error", (error) => gone(error));
		/*
		 * 不替宿主投「能不能退出」的票，和 tsserver 一样：测试问完一次 references 就该退，而不是
		 * 挂到语言服务器自己超时。管道也要 unref，否则它们照样把事件循环撑住。`dispose` 照旧杀它。
		 */
		child.unref();
		for (const stream of [child.stdin, child.stdout, child.stderr]) (stream as { unref?: () => void } | null)?.unref?.();
		// stderr 是服务器的日志（索引进度、加载了哪些包），和被问的问题无关，丢掉。
		child.stderr?.resume();

		if (!child.stdin || !child.stdout) {
			await this.dispose();
			// i18n-exempt：交给模型的错误。
			throw new Error(`${this.spec.name} 没有标准输入输出。`);
		}
		connection = new LspConnection(child.stdin, child.stdout, {
			request: (method, params) => this.answer(method, params),
			notification: (method, params) => this.notice(method, params),
		});
		this.connection = connection;

		try {
			const result = (await connection.request("initialize", this.initializeParams(), INITIALIZE_TIMEOUT_MS)) as {
				capabilities?: Record<string, unknown>;
			} | null;
			this.capabilities = result?.capabilities ?? {};
			connection.notify("initialized", {});
			this.initialized = true;
		} catch (error) {
			await this.dispose();
			throw error;
		}
	}

	private initializeParams(): unknown {
		const rootUri = pathToUri(this.root);
		return {
			// 服务器会盯着这个 pid，宿主死了它自己退出——宿主崩溃时不留下几百兆的孤儿进程。
			processId: process.pid,
			clientInfo: { name: "plume" },
			rootUri,
			rootPath: this.root,
			workspaceFolders: [{ uri: rootUri, name: basename(this.root) }],
			capabilities: {
				general: { positionEncodings: ["utf-16"] },
				workspace: { workspaceFolders: true, configuration: true, workspaceEdit: { documentChanges: true } },
				textDocument: {
					synchronization: { dynamicRegistration: false },
					definition: { linkSupport: true },
					references: {},
					rename: {},
					publishDiagnostics: {},
					diagnostic: { dynamicRegistration: false },
				},
			},
		};
	}

	/** 服务器反过来问的。只答它启动和分析必需的那几样，其余一律「不支持」。 */
	private answer(method: string, params: unknown): unknown {
		switch (method) {
			case "workspace/configuration":
				// 每一项都回 null，等于「用你的默认值」——项目自己的配置文件（pyrightconfig.json 等）照常生效。
				return ((params as { items?: unknown[] } | null)?.items ?? []).map(() => null);
			case "workspace/workspaceFolders":
				return [{ uri: pathToUri(this.root), name: basename(this.root) }];
			case "window/workDoneProgress/create":
			case "client/registerCapability":
			case "client/unregisterCapability":
				return null;
			case "workspace/applyEdit":
				// 改文件只经 edit/write 工具，那里有读过才能改的校验和撤销快照；服务器不能绕过去自己写。
				// i18n-exempt：交给模型的话（工具结果、错误）。
				return { applied: false, failureReason: "这个客户端不接受服务器直接改文件。" };
			default:
				throw new Error(`不支持 ${method}`);
		}
	}

	private notice(method: string, params: unknown): void {
		if (method !== "textDocument/publishDiagnostics") return;
		const { uri, diagnostics } = params as { uri: string; diagnostics: unknown[] };
		this.published.record(uri, diagnostics);
	}

	private toUri(file: string): string {
		const real = this.realRoot !== this.root && within(this.root, file) ? join(this.realRoot, relative(this.root, file)) : file;
		return pathToUri(real);
	}

	private toPath = (uri: string): string | null => {
		const path = uriToPath(uri);
		if (path === null || this.realRoot === this.root || !within(this.realRoot, path)) return path;
		return join(this.root, relative(this.realRoot, path));
	};

	private languageId(file: string): string {
		return this.spec.languages[extname(file).toLowerCase()] ?? "plaintext";
	}

	/** 让服务器手里的这个文件和磁盘一致。返回 URI，以及这次有没有推过新内容。 */
	private async sync(file: string): Promise<{ uri: string; changed: boolean }> {
		const connection = this.requireConnection();
		const uri = this.toUri(file);
		const text = await readFile(file, "utf8");
		const open = this.documents.get(file);
		if (!open) {
			this.documents.set(file, { version: 1, text });
			connection.notify("textDocument/didOpen", { textDocument: { uri, languageId: this.languageId(file), version: 1, text } });
			return { uri, changed: true };
		}
		if (open.text === text) return { uri, changed: false };
		open.version += 1;
		open.text = text;
		// 整篇替换：不带 range 的变更在全量和增量两种同步方式下都合法，省得算差异。
		connection.notify("textDocument/didChange", { textDocument: { uri, version: open.version }, contentChanges: [{ text }] });
		return { uri, changed: true };
	}

	private requireConnection(): LspConnection {
		// i18n-exempt：交给模型的话（工具结果、错误）。
		if (!this.connection || !this.ready()) throw new Error(`${this.spec.name} 没有在运行。`);
		return this.connection;
	}

	private position(uri: string, line: number, column: number) {
		return { textDocument: { uri }, position: { line: line - 1, character: column - 1 } };
	}

	async references(file: string, line: number, column: number): Promise<CodeLocation[]> {
		const { uri } = await this.sync(file);
		const payload = await this.requireConnection().request(
			"textDocument/references",
			{ ...this.position(uri, line, column), context: { includeDeclaration: true } },
			REQUEST_TIMEOUT_MS,
		);
		return withLineText(toLocations(payload, this.toPath));
	}

	async definition(file: string, line: number, column: number): Promise<CodeLocation[]> {
		const { uri } = await this.sync(file);
		const payload = await this.requireConnection().request("textDocument/definition", this.position(uri, line, column), REQUEST_TIMEOUT_MS);
		return toLocations(payload, this.toPath);
	}

	async rename(file: string, line: number, column: number, newName: string): Promise<TextEdit[]> {
		const { uri } = await this.sync(file);
		const payload = await this.requireConnection().request("textDocument/rename", { ...this.position(uri, line, column), newName }, REQUEST_TIMEOUT_MS);
		// i18n-exempt：交给模型的话（工具结果、错误）。
		if (!payload) throw new Error("这个位置不能重命名。");
		return toTextEdits(payload, this.toPath);
	}

	/** 两种诊断模型都接：拉取式（LSP 3.17 的 `textDocument/diagnostic`）问了就答，推送式只能等，见 `published.ts`。 */
	async diagnostics(file: string): Promise<Diagnostic[]> {
		if (this.capabilities.diagnosticProvider) {
			const { uri } = await this.sync(file);
			const report = (await this.requireConnection().request("textDocument/diagnostic", { textDocument: { uri } }, REQUEST_TIMEOUT_MS)) as {
				items?: unknown[];
			} | null;
			return toDiagnostics(report?.items ?? [], file);
		}
		const items = await this.published.collect(this.toUri(file), async () => (await this.sync(file)).changed, this.spec.name);
		return toDiagnostics(items, file);
	}

	private reset(): void {
		this.child = null;
		this.connection = null;
		this.initialized = false;
		this.capabilities = {};
		this.documents.clear();
		this.published.clear();
	}

	/**
	 * 直接杀，不走 `shutdown`/`exit` 握手：那要多等一个来回，而这几台服务器被杀时都会自己收拾
	 * 子进程。Windows 例外——经 `.cmd` 起的服务器，`kill()` 只杀到外面那层 `cmd.exe`，真正的服务器
	 * 成了孤儿，所以按进程树杀。rust-analyzer 的 proc-macro 子进程也在那棵树上。
	 */
	async dispose(): Promise<void> {
		const child = this.child;
		// i18n-exempt：交给模型的话（工具结果、错误）。
		this.connection?.close(new Error("语言服务器停了。"));
		this.reset();
		if (!child) return;
		if (process.platform === "win32" && child.pid !== undefined) {
			await new Promise<void>((resolve) => {
				execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => resolve());
			});
		} else {
			child.kill();
		}
	}
}
