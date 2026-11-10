/**
 * 跑钩子。
 *
 * 一次 `run` 对应一个事件：挑出匹配的钩子，按配置顺序一条条跑（`async` 的放到后台），把它们交回来的决定并成一个。
 * 每条钩子的开始和结局各报一次（`report`），逻辑入口记成运行记录，回复底下那个按钮读的就是它们。
 *
 * 约定和 Claude Code 一致：退出码 0 读 stdout 上的 JSON；2 是拦，原因取 stderr；其他非零是这条钩子自己坏了——
 * 记为失败，不替它做拦截的决定。
 */

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { systemShell } from "./shell.ts";
import {
	DEFAULT_HOOK_MAX_OUTPUT_BYTES,
	DEFAULT_HOOK_TIMEOUT_MS,
	type HookEntry,
	type HookEventName,
	type HookScope,
	type HooksConfig,
	hookEntries,
	hookTimeoutMs,
} from "./config.ts";
import {
	type HookJSONOutput,
	HookOutputError,
	type HookRunResult,
	matchesHookMatcher,
	mergeHookRunResult,
	parseHookStdout,
	processHookOutput,
	sanitizeHookDisplayText,
} from "./output.ts";

/** 交给钩子的输入。事件自己的字段（`toolName`、`prompt`……）挂在上面。 */
export interface HookInput {
	hookEventName: HookEventName;
	sessionId: string;
	cwd: string;
	[key: string]: unknown;
}

/** 一条钩子的一次运行：开始时报一次 `running`，收场时同一个 `id` 再报一次结局。命令和原因里的口令已盖住。 */
export interface HookRun {
	id: string;
	event: HookEventName;
	source: HookScope;
	command: string;
	matcher?: string;
	toolName?: string;
	statusMessage?: string;
	status: "running" | "success" | "blocked" | "failed" | "timed_out" | "cancelled";
	/** 被拦下的原因，或者失败的原因。 */
	reason?: string;
	startedAt: number;
	durationMs?: number;
}

export interface HookRegistration {
	entry: HookEntry;
	/** 项目钩子没被信任时为 false：照样出现在记录里，标成被拦下，但不执行。 */
	trusted: boolean;
}

/**
 * Plume 的工具名是小写的（`bash`、`edit`），照 Claude Code 写的 matcher 是 `Bash|Edit`。两种都认，同一份配置搬过来不用改。
 */
const TOOL_ALIASES: Record<string, string[]> = {
	bash: ["Bash"],
	read: ["Read"],
	write: ["Write"],
	edit: ["Edit", "MultiEdit"],
	glob: ["Glob"],
	grep: ["Grep"],
	ls: ["LS"],
	web_fetch: ["WebFetch"],
	web_search: ["WebSearch"],
};

export function hookMatchValues(toolName: string): string[] {
	return [toolName, ...(TOOL_ALIASES[toolName] ?? [])];
}

const PREVIEW_MAX = 4000;

function preview(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return trimmed.length <= PREVIEW_MAX ? trimmed : `${trimmed.slice(0, PREVIEW_MAX)}...`;
}

function hookCommandDisplay(entry: Pick<HookEntry, "definition">): string {
	const { definition } = entry;
	const text =
		definition.type === "process"
			? [definition.command, ...(definition.args ?? [])].map((part) => (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(part) ? part : JSON.stringify(part))).join(" ")
			: definition.command;
	return sanitizeHookDisplayText(text);
}

class HookFailure extends Error {
	readonly status: "failed" | "timed_out" | "cancelled";
	constructor(status: "failed" | "timed_out" | "cancelled", message: string) {
		super(message);
		this.status = status;
	}
}

interface ProcessResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

/** 钩子命令里 `${名字}` 能展开的变量，同一份也放进子进程的环境。Claude Code 的名字照搬，另加 Plume 自己的。 */
function hookVariables(input: HookInput): Record<string, string> {
	return {
		CLAUDE_PROJECT_DIR: input.cwd,
		PLUME_PROJECT_DIR: input.cwd,
		CLAUDE_SESSION_ID: input.sessionId,
		CLAUDE_CODE_SESSION_ID: input.sessionId,
		PLUME_SESSION_ID: input.sessionId,
	};
}

function expandVariables(value: string, input: HookInput): string {
	const variables = hookVariables(input);
	return value.replace(/\$\{([A-Z_]+)\}/gu, (match, key: string) => variables[key] ?? match);
}

/**
 * stdin：Plume 自己的 camelCase 字段，加上 Claude Code 脚本认的 snake_case 别名。`transcript_path` 指向一份临时文件，
 * 只装着这次事件涉及的那条消息——只有 Stop（最后一条回复）和 UserPromptSubmit（刚发的那句）有这条消息；
 * 其余事件指向空设备，读到的和一份空文件一样，不必每次工具调用都建一个目录。
 */
async function compatibleStdin(input: HookInput): Promise<{ value: string; cleanup: () => Promise<void> }> {
	const compatible: Record<string, unknown> = { ...input, hook_event_name: input.hookEventName, session_id: input.sessionId };
	if (typeof input.toolName === "string") {
		compatible.tool_name = input.toolName;
		compatible.tool_input = input.toolInput;
		compatible.tool_use_id = input.toolCallId;
	}
	if (input.hookEventName === "PostToolUse") compatible.tool_response = input.toolResponse;
	if (input.hookEventName === "PostToolUseFailure") {
		compatible.error = (input.error as { message?: string } | undefined)?.message;
		compatible.error_details = input.error;
	}
	if (input.hookEventName === "Stop") {
		compatible.last_assistant_message = input.responseText;
		compatible.stop_hook_active = input.stopHookActive;
	}
	if (input.hookEventName === "StopFailure" && input.responseText !== undefined) compatible.last_assistant_message = input.responseText;
	const line = (role: "user" | "assistant", text: unknown) =>
		`${JSON.stringify({ message: { role, content: [{ type: "text", text: String(text ?? "") }] } })}\n`;
	const content =
		input.hookEventName === "Stop" ? line("assistant", input.responseText) : input.hookEventName === "UserPromptSubmit" ? line("user", input.prompt) : null;
	let transcriptPath = devNull;
	let cleanup = async () => {};
	if (content !== null) {
		const dir = await mkdtemp(join(tmpdir(), "plume-hook-"));
		transcriptPath = join(dir, "transcript.jsonl");
		await writeFile(transcriptPath, content, "utf8");
		cleanup = () => rm(dir, { recursive: true, force: true });
	}
	compatible.transcript_path = transcriptPath;
	compatible.transcriptPath = transcriptPath;
	return { value: `${JSON.stringify(compatible)}\n`, cleanup };
}

const ENV_MARK = "__PLUME_HOOK_ENV__";
const ENV_TIMEOUT_MS = 5000;
let loginEnv: Promise<Record<string, string>> | undefined;

/**
 * 跑钩子用的环境。从图标启动的应用只从 launchd 拿到 `/usr/bin:/bin:/usr/sbin:/sbin`，钩子里的 `jq`、`node` 找不到；
 * 所以第一次用时问一遍用户的登录 shell（`-l -i`，登录文件和 `~/.zshrc` 都读）它会给终端什么环境，之后一直用这一份。
 * 本进程是从终端启动的，或者问不到时，用继承来的环境。Windows 上也用继承来的：那边没有登录 shell，PATH 由注册表给全。
 */
function commandEnv(): Promise<Record<string, string>> {
	return (loginEnv ??= (async () => {
		const inherited = Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => typeof pair[1] === "string"));
		const term = process.env.TERM;
		const shell = process.env.SHELL;
		if (process.platform === "win32" || (term && term !== "dumb") || process.env.TERM_PROGRAM || !shell || !existsSync(shell)) return inherited;
		const stdout = await new Promise<string>((resolve) => {
			execFile(
				shell,
				["-l", "-i", "-c", `printf ${ENV_MARK}; /usr/bin/env -0; printf ${ENV_MARK}`],
				{ timeout: ENV_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: inherited },
				(_error, out) => resolve(String(out ?? "")),
			);
		});
		const answer = stdout.split(ENV_MARK)[1];
		if (!answer) return inherited;
		const env: Record<string, string> = {};
		for (const pair of answer.split("\0")) {
			const at = pair.indexOf("=");
			if (at > 0) env[pair.slice(0, at)] = pair.slice(at + 1);
		}
		// 描述 shell 自己的那几个不要：它们是那次询问的，不是用户的。
		for (const key of ["SHLVL", "PWD", "OLDPWD", "_"]) delete env[key];
		return env.PATH ? { ...inherited, ...env } : inherited;
	})());
}

function spawnArgs(entry: HookEntry, input: HookInput): { file: string; args: string[] } {
	const { definition } = entry;
	if (definition.type === "process")
		return { file: expandVariables(definition.command, input), args: (definition.args ?? []).map((arg) => expandVariables(arg, input)) };
	const command = expandVariables(definition.command, input);
	if (typeof definition.shell === "string") return { file: definition.shell, args: ["-c", command] };
	// 和智能体自己的命令同一个 shell：Windows 上是 Git Bash，没有时是 PowerShell。
	const shell = systemShell();
	return { file: shell.file, args: shell.args(command) };
}

async function execute(entry: HookEntry, input: HookInput, stdin: string, timeoutMs: number, maxBytes: number, signal?: AbortSignal): Promise<ProcessResult> {
	if (!existsSync(input.cwd)) throw new HookFailure("failed", `working directory does not exist: ${input.cwd}`);
	if (signal?.aborted) throw new HookFailure("cancelled", "cancelled");
	const env = { ...(await commandEnv()), ...hookVariables(input) };
	return new Promise((resolve, reject) => {
		const { file, args } = spawnArgs(entry, input);
		const child = spawn(file, args, {
			cwd: input.cwd,
			// 自己一个进程组，超时时能把钩子派生出来的进程一起收掉。Windows 没有进程组，detached 在那边是另开一个控制台。
			detached: process.platform !== "win32",
			// agent 进程没有控制台：Windows 上不带它，每跑一次钩子就闪一个黑窗口。
			windowsHide: true,
			env,
		});
		const killTree = () => {
			if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
			if (process.platform === "win32") {
				// 只杀 child 杀不到 shell 底下起的进程；taskkill /T 连整棵树一起收。
				execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
				return;
			}
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};

		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			fn();
		};
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (stdout.length < maxBytes) stdout += chunk.slice(0, maxBytes - stdout.length);
		});
		child.stderr.on("data", (chunk: string) => {
			if (stderr.length < maxBytes) stderr += chunk.slice(0, maxBytes - stderr.length);
		});

		const timer = setTimeout(() => {
			killTree();
			finish(() => reject(new HookFailure("timed_out", `timed out after ${Math.round(timeoutMs / 1000)}s`)));
		}, timeoutMs);
		const onAbort = () => {
			killTree();
			finish(() => reject(new HookFailure("cancelled", "cancelled")));
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		child.on("error", (error) => finish(() => reject(new HookFailure("failed", error.message))));
		child.on("close", (code) => finish(() => resolve({ exitCode: code, stdout, stderr })));

		// 钩子不一定读 stdin；读者早早退出时写入会 EPIPE，那不是错误——它不读，是它的事。
		child.stdin.on("error", () => {});
		child.stdin.end(stdin);
	});
}

/** 退出码 2 换成等价的「拦」的输出，原因取 stderr。 */
function exitCodeBlock(event: HookEventName, result: ProcessResult): HookJSONOutput {
	const reason = preview(result.stderr) ?? preview(result.stdout) ?? "Hook blocked execution";
	if (event === "PreToolUse")
		return { continue: false, reason, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
	if (event === "PermissionRequest")
		return { continue: false, reason, hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: reason } } };
	if (event === "Stop") return { decision: "block", reason };
	return { continue: false, reason };
}

async function runOne(entry: HookEntry, input: HookInput, timeoutMs: number, maxBytes: number, signal?: AbortSignal): Promise<HookJSONOutput | undefined> {
	const stdin = await compatibleStdin(input);
	try {
		const result = await execute(entry, input, stdin.value, timeoutMs, maxBytes, signal);
		if (result.exitCode === 0) {
			try {
				return parseHookStdout(result.stdout);
			} catch (error) {
				throw new HookFailure("failed", `invalid hook output: ${(error as Error).message}`);
			}
		}
		if (result.exitCode === 2) return exitCodeBlock(input.hookEventName, result);
		throw new HookFailure("failed", preview(result.stderr) ?? `exited with status ${result.exitCode}`);
	} finally {
		await stdin.cleanup().catch(() => {});
	}
}

export interface HookRunnerOptions {
	hooks: HookRegistration[];
	timeoutMs?: number;
	maxOutputBytes?: number;
	report?: (run: HookRun) => void;
	/** 没信任的项目钩子被拦下时记的原因，按界面语言。 */
	untrustedReason?: string;
}

export class HookRunner {
	private readonly hooks: HookRegistration[];
	private readonly timeoutMs: number;
	private readonly maxOutputBytes: number;
	private readonly report: (run: HookRun) => void;
	private readonly untrustedReason: string;

	constructor(options: HookRunnerOptions) {
		this.hooks = options.hooks;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
		this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_HOOK_MAX_OUTPUT_BYTES;
		this.report = options.report ?? (() => {});
		this.untrustedReason = options.untrustedReason ?? "Project hook not trusted yet; it did not run.";
	}

	/** 这个事件上有没有任何会被考虑的钩子——没有就连输入都不必拼。 */
	has(event: HookEventName): boolean {
		return this.hooks.some(({ entry }) => entry.event === event && entry.definition.enabled !== false);
	}

	/** 一条会被考虑的钩子都没有。 */
	get empty(): boolean {
		return !this.hooks.some(({ entry }) => entry.definition.enabled !== false);
	}

	async run(input: HookInput, options: { matchValues?: readonly string[]; signal?: AbortSignal } = {}): Promise<HookRunResult> {
		const result: HookRunResult = { additionalContexts: [] };
		const values = options.matchValues ?? [];
		const matching = this.hooks.filter(
			({ entry }) =>
				entry.event === input.hookEventName &&
				entry.definition.enabled !== false &&
				(values.length === 0 ? matchesHookMatcher(undefined, entry.matcher) : values.some((value) => matchesHookMatcher(value, entry.matcher))),
		);
		for (const { entry, trusted } of matching) {
			const base: HookRun = {
				id: crypto.randomUUID(),
				event: input.hookEventName,
				source: entry.scope,
				command: hookCommandDisplay(entry),
				...(entry.matcher ? { matcher: entry.matcher } : {}),
				...(typeof input.toolName === "string" ? { toolName: input.toolName } : {}),
				...(entry.definition.statusMessage ? { statusMessage: sanitizeHookDisplayText(entry.definition.statusMessage) } : {}),
				status: "running",
				startedAt: Date.now(),
			};
			if (!trusted) {
				this.report({ ...base, status: "blocked", reason: this.untrustedReason, durationMs: 0 });
				continue;
			}
			this.report(base);
			const timeoutMs = hookTimeoutMs(entry.definition, this.timeoutMs);
			const took = () => Date.now() - base.startedAt;

			if (entry.definition.type === "command" && entry.definition.async) {
				// 后台钩子的结局不能回头改变已经继续往下走的动作，所以它的输出只进记录。
				void runOne(entry, input, timeoutMs, this.maxOutputBytes, options.signal).then(
					() => this.report({ ...base, status: "success", durationMs: took() }),
					(error: unknown) => this.report(failed(base, error, took())),
				);
				continue;
			}

			try {
				const output = await runOne(entry, input, timeoutMs, this.maxOutputBytes, options.signal);
				const processed = processHookOutput(input.hookEventName, output);
				mergeHookRunResult(result, processed);
				// Stop 的 block 是「接着干」，不在 `decision` 里，记成成功。
				const blocked = processed.decision === "deny";
				const reason = blocked ? (processed.reason ?? "Hook blocked execution") : undefined;
				this.report({
					...base,
					status: blocked ? "blocked" : "success",
					durationMs: took(),
					...(reason ? { reason: sanitizeHookDisplayText(reason).slice(0, PREVIEW_MAX) } : {}),
				});
			} catch (error) {
				this.report(failed(base, error, took()));
			}
		}
		return result;
	}
}

function failed(base: HookRun, error: unknown, durationMs: number): HookRun {
	const status = error instanceof HookFailure ? error.status : "failed";
	const message = error instanceof HookOutputError || error instanceof Error ? error.message : String(error);
	return { ...base, status, durationMs, reason: sanitizeHookDisplayText(message).slice(0, PREVIEW_MAX) };
}

/** 用户钩子全部上场；项目钩子带着信任状态上场，没信任的只会被记成「被拦下」。项目层的默认值覆盖用户层。 */
export function createHookRunner(input: {
	user: HooksConfig;
	project?: { config: HooksConfig; trusted: ReadonlySet<string> };
	report?: (run: HookRun) => void;
	untrustedReason?: string;
}): HookRunner {
	const hooks: HookRegistration[] = [
		...hookEntries(input.user, "user").map((entry) => ({ entry, trusted: true })),
		...(input.project ? hookEntries(input.project.config, "project").map((entry) => ({ entry, trusted: input.project!.trusted.has(entry.digest) })) : []),
	];
	const timeoutMs = input.project?.config.timeoutMs ?? input.user.timeoutMs;
	const maxOutputBytes = input.project?.config.maxOutputBytes ?? input.user.maxOutputBytes;
	return new HookRunner({
		hooks,
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
		...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
		...(input.report ? { report: input.report } : {}),
		...(input.untrustedReason ? { untrustedReason: input.untrustedReason } : {}),
	});
}
