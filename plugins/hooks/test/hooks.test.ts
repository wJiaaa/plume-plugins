import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
	HookLayer,
	HookName,
	Hooks,
	Message,
	ModelContext,
	PluginContext,
	SessionEndReason,
	SessionObservation,
	StepEnd,
	ToolApproval,
	ToolExecution,
} from "@plume/contract";
import type { HooksApi } from "../src/api.ts";
import { addHook, hookEntries, normalizeHooksConfig, removeHook, setHookEnabled, updateHook } from "../src/config.ts";
import plugin from "../src/index.ts";
import { matchesHookMatcher } from "../src/output.ts";
import { createHookRunner } from "../src/runner.ts";

// 测试跑在终端里：用继承来的环境，不去问登录 shell。
process.env.TERM_PROGRAM ??= "node-test";

interface Harness {
	/** 会话的工作目录，项目钩子写在它的 `.plume/config.json` 里。 */
	dir: string;
	/** 插件数据目录：用户钩子、信任记录、运行记录。 */
	data: string;
	api: HooksApi;
	notices: string[];
	/** 会话里的消息，`ctx.sessions.messages` 读它。 */
	messages: Map<string, Message[]>;
	run<N extends HookName>(name: N, input: Hooks[N][0], inner: (input: Hooks[N][0]) => Promise<Hooks[N][1]>): Promise<Hooks[N][1]>;
	observe(sessionId: string, event: SessionObservation["event"]): void;
	end(sessionId: string, reason: SessionEndReason): Promise<void>;
	deleted(sessionId: string): void;
	dispose(): Promise<void>;
}

async function harness(events: Record<string, unknown>): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), "plume-hooks-test-"));
	const dir = join(root, "workspace");
	const data = join(root, "data");
	await mkdir(dir);
	await mkdir(data);
	await writeFile(join(data, "hooks.json"), JSON.stringify({ events }));
	const layers = new Map<string, HookLayer<HookName>>();
	const notices: string[] = [];
	const messages = new Map<string, Message[]>();
	const observers: Array<(observation: SessionObservation) => void> = [];
	const ended: Array<(sessionId: string, reason: SessionEndReason) => void | Promise<void>> = [];
	const deleted: Array<(sessionId: string) => void> = [];
	let api: HooksApi | undefined;
	const ctx = {
		name: "plume.hooks",
		dataDir: data,
		hook: (name: HookName, layer: HookLayer<HookName>) => void layers.set(name, layer),
		serve: (served: object) => void (api = served as HooksApi),
		log: { info() {}, warn() {}, error() {} },
		locale: () => "en",
		notice: (_session: string, text: string) => void notices.push(text),
		sessions: {
			messages: async (sessionId: string) => messages.get(sessionId) ?? [],
			get: async (id: string) => (id === "s1" ? { id: "s1", cwd: dir } : undefined),
			observe: (listener: (observation: SessionObservation) => void) => void observers.push(listener),
			onEnded: (listener: (sessionId: string, reason: SessionEndReason) => void | Promise<void>) => void ended.push(listener),
			onDeleted: (listener: (sessionId: string) => void) => void deleted.push(listener),
		},
	} as unknown as PluginContext;
	await plugin.apply(ctx);
	return {
		dir,
		data,
		api: api!,
		notices,
		messages,
		run: (name, input, inner) => (layers.get(name) as unknown as HookLayer<typeof name>)(input, inner),
		observe: (sessionId, event) => {
			for (const observer of observers) observer({ sessionId, at: 0, timestamp: Date.now(), event });
		},
		end: async (sessionId, reason) => {
			await Promise.all(ended.map((listener) => listener(sessionId, reason)));
		},
		deleted: (sessionId) => {
			for (const listener of deleted) listener(sessionId);
		},
		dispose: () => rm(root, { recursive: true, force: true }),
	};
}

/** 等到条件成立：运行记录是在后台写的。 */
async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
	const deadline = Date.now() + 5000;
	for (;;) {
		const value = await read();
		if (ok(value) || Date.now() > deadline) return value;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

const command = (script: string) => ({ type: "command", command: script });

function submit(h: Harness, text: string, overrides: { synthetic?: boolean } = {}) {
	return h.run(
		"prompt.submit",
		{
			sessionId: "s1",
			session: { id: "s1", kind: "top" },
			cwd: h.dir,
			text,
			attachments: [],
			synthetic: overrides.synthetic ?? false,
			fresh: true,
			launched: false,
			signal: new AbortController().signal,
		},
		async () => ({ block: false }),
	);
}

function approval(dir: string, overrides: Partial<ToolApproval> = {}): ToolApproval {
	return {
		sessionId: "s1",
		session: { id: "s1", kind: "top" },
		cwd: dir,
		call: { id: "c1", name: "bash", args: { command: "ls" } },
		tool: { name: "bash", mutating: true, plugin: "plume.tools" },
		request: { kind: "bash", title: "Run ls", detail: "ls" },
		permissionMode: "ask",
		signal: new AbortController().signal,
		...overrides,
	} as ToolApproval;
}

function execution(dir: string, overrides: Partial<ToolExecution> = {}): ToolExecution {
	return {
		sessionId: "s1",
		session: { id: "s1", kind: "top" },
		cwd: dir,
		call: { id: "c1", name: "bash", args: { command: "ls" } },
		tool: { name: "bash", mutating: true, plugin: "plume.tools" },
		signal: new AbortController().signal,
		ask: async () => true,
		progress() {},
		...overrides,
	};
}

test("配置：认不出的事件和缺命令的条目丢掉，增删改开关按 id 找到同一条", () => {
	const config = normalizeHooksConfig({
		events: {
			PreToolUse: [{ matcher: "Bash", hooks: [command("a"), { type: "command" }, { type: "weird", command: "x" }] }],
			Bogus: [{ hooks: [command("b")] }],
		},
	});
	assert.deepEqual(Object.keys(config.events), ["PreToolUse"]);
	const [entry] = hookEntries(config, "user");
	assert.ok(entry);
	assert.ok(entry.id.startsWith("user:PreToolUse:0:0:"));
	const off = setHookEnabled(config, entry.id, false);
	// 开关不改 id，也不改指纹：关掉再打开的项目钩子不用再信任一次。
	assert.equal(hookEntries(off, "user")[0]?.id, entry.id);
	assert.equal(hookEntries(off, "user")[0]?.digest, entry.digest);
	assert.equal(hookEntries(off, "user")[0]?.definition.enabled, false);
	const added = addHook(config, { event: "PreToolUse", matcher: "Bash", type: "process", command: "b", args: ["1"] });
	assert.equal(added.events.PreToolUse?.[0]?.hooks.length, 2);
	const moved = updateHook(added, entry.id, { event: "Stop", type: "command", command: "c" });
	assert.equal(moved.events.PreToolUse?.[0]?.hooks.length, 1);
	assert.equal(moved.events.Stop?.[0]?.hooks[0]?.command, "c");
	// 内容变了的旧 id 对不上，什么也不删。
	assert.equal(removeHook(moved, entry.id), moved);
});

test("matcher：只有字母、数字、_、-、空格、逗号和 | 的按名字精确比，| 和逗号都分隔；StopFailure 只认字母、数字、_ 和 |；其余当正则", () => {
	assert.equal(matchesHookMatcher("Write", "Edit, Write"), true);
	assert.equal(matchesHookMatcher("Edit", "Edit,Write"), true);
	assert.equal(matchesHookMatcher("Write", "Edit | Write"), true);
	assert.equal(matchesHookMatcher("NotebookEdit", "Edit, Write"), false);
	assert.equal(matchesHookMatcher("code-reviewer", "code-reviewer"), true);
	assert.equal(matchesHookMatcher("code-reviewer-2", "code-reviewer"), false);
	assert.equal(matchesHookMatcher("NotebookEdit", "Edit.*"), true);
	assert.equal(matchesHookMatcher("mcp__memory__x", "mcp__memory"), false);
	// StopFailure：逗号、连字符走正则，只有 | 分隔。
	assert.equal(matchesHookMatcher("error", "error, aborted", "StopFailure"), false);
	assert.equal(matchesHookMatcher("max_turns", "max_turns|error", "StopFailure"), true);
});

test("matcher：不按 matcher 分的事件（UserPromptSubmit、Stop）上写了 matcher 也照跑", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-hooks-matcher-"));
	try {
		const runner = createHookRunner({
			user: normalizeHooksConfig({ events: { Stop: [{ matcher: "Bash", hooks: [command(`echo '{"decision":"block","reason":"again"}'`)] }] } }),
		});
		const result = await runner.run({ hookEventName: "Stop", sessionId: "s", cwd: dir });
		assert.equal(result.continueStop, true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("输出：Claude Code 的 terminalSequence 认得、不用，同一份输出里的决定照算", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-hooks-terminal-"));
	try {
		const runner = createHookRunner({
			user: normalizeHooksConfig({
				events: {
					PreToolUse: [
						{
							hooks: [
								command(
									`printf '%s' '{"terminalSequence":"\\u0007","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"no"}}'`,
								),
							],
						},
					],
				},
			}),
		});
		const result = await runner.run({ hookEventName: "PreToolUse", sessionId: "s", cwd: dir, toolName: "bash" }, { matchValues: ["bash"] });
		assert.equal(result.decision, "deny");
		assert.equal(result.reason, "no");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("执行：退出码 2 是拦，原因取 stderr；JSON 里的决定取最严；坏了的钩子报失败不替它拦", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-hooks-run-"));
	try {
		const runs: string[] = [];
		const runner = createHookRunner({
			user: normalizeHooksConfig({
				events: {
					PreToolUse: [
						{
							matcher: "Bash",
							hooks: [command(`echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'`), command("echo no >&2; exit 2")],
						},
						{ matcher: "Read", hooks: [command("exit 7"), command('echo "{\\"additionalContext\\":\\"$CLAUDE_PROJECT_DIR\\"}"')] },
					],
				},
			}),
			report: (run) => void (run.status !== "running" && runs.push(run.status)),
		});
		const base = { hookEventName: "PreToolUse" as const, sessionId: "s", cwd: dir };
		const bash = await runner.run({ ...base, toolName: "bash" }, { matchValues: ["bash", "Bash"] });
		assert.equal(bash.decision, "deny");
		assert.equal(bash.reason, "no");
		const read = await runner.run({ ...base, toolName: "read" }, { matchValues: ["read", "Read"] });
		assert.equal(read.decision, undefined);
		assert.deepEqual(read.additionalContexts, [dir]);
		assert.deepEqual(runs, ["success", "blocked", "failed", "success"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("工具前后：拦下不执行；改参数、要确认；之后的上下文接在结果后面", async () => {
	const h = await harness({
		PreToolUse: [
			{ matcher: "Write", hooks: [command("echo 'not here' >&2; exit 2")] },
			{
				matcher: "Bash",
				hooks: [
					command(
						`echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"sure?","updatedInput":{"command":"pwd"}}}'`,
					),
				],
			},
		],
		PostToolUse: [{ matcher: "Bash", hooks: [command(`echo '{"additionalContext":"checked"}'`)] }],
	});
	try {
		let ran = 0;
		const blocked = await h.run("tool.execute", execution(h.dir, { call: { id: "c", name: "write", args: {} } }), async () => {
			ran += 1;
			return { output: "ok" };
		});
		assert.equal(ran, 0);
		assert.deepEqual(blocked, { output: "not here", isError: true });

		const asked: string[] = [];
		let seen: ToolExecution | undefined;
		const result = await h.run(
			"tool.execute",
			execution(h.dir, {
				ask: async (reason) => {
					asked.push(reason);
					return true;
				},
			}),
			async (input) => {
				seen = input;
				return { output: "done" };
			},
		);
		assert.deepEqual(asked, ["sure?"]);
		assert.deepEqual(seen?.call.args, { command: "pwd" });
		assert.equal(seen?.approved, "PreToolUse");
		assert.equal(result.output, "done\n[Hook additional context]\n#1\nchecked");

		const declined = await h.run("tool.execute", execution(h.dir, { ask: async () => false }), async () => ({ output: "never" }));
		assert.deepEqual(declined, { output: 'The user declined "bash".', isError: true });
	} finally {
		await h.dispose();
	}
});

test("工具之后：decision block 的 reason、退出码 2 的 stderr 接在结果后面交给 agent，结果本身不变", async () => {
	const h = await harness({
		PostToolUse: [{ hooks: [command(`echo '{"decision":"block","reason":"lint failed"}'`)] }],
		PostToolUseFailure: [{ hooks: [command("echo 'see the logs' >&2; exit 2")] }],
	});
	try {
		const ok = await h.run("tool.execute", execution(h.dir), async () => ({ output: "done" }));
		assert.equal(ok.output, "done\n[Hook additional context]\n#1\nlint failed");
		assert.equal(ok.isError, undefined);
		const failed = await h.run("tool.execute", execution(h.dir), async () => ({ output: "boom", isError: true }));
		assert.equal(failed.output, "boom\n[Hook additional context]\n#1\nsee the logs");
		assert.equal(failed.isError, true);
	} finally {
		await h.dispose();
	}
});

test("PreToolUse 的 defer：Plume 没有 -p 模式，照 Claude Code 交互模式忽略它，连同它的 updatedInput、additionalContext；不算钩子失败", async () => {
	const h = await harness({
		PreToolUse: [
			{
				matcher: "Bash",
				hooks: [
					command(
						`echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"defer","updatedInput":{"command":"pwd"},"additionalContext":"later"}}'`,
					),
				],
			},
		],
	});
	try {
		await submit(h, "hello");
		let seen: ToolExecution | undefined;
		const result = await h.run("tool.execute", execution(h.dir), async (input) => {
			seen = input;
			return { output: "ran" };
		});
		assert.deepEqual(result, { output: "ran" });
		assert.deepEqual(seen?.call.args, { command: "ls" });
		assert.equal(seen?.approved, undefined);
		const runs = await until(
			() => h.api.runs("s1"),
			(list) => list.length === 1 && list[0]?.status !== "running",
		);
		assert.equal(runs[0]?.status, "success");
	} finally {
		await h.dispose();
	}
});

test("照 Claude Code 写的脚本：比 tool_name、读 tool_input.file_path、tool_input.command 的守卫拦得住；改 file_path 的 updatedInput 翻回 path", async () => {
	const scripts = await mkdtemp(join(tmpdir(), "plume-hooks-cc-"));
	const guard = join(scripts, "guard.mjs");
	const move = join(scripts, "move.mjs");
	const shout = join(scripts, "shout.mjs");
	const stdin = 'let raw = ""; process.stdin.on("data", (c) => (raw += c)).on("end", () => main(JSON.parse(raw)));\n';
	await writeFile(
		guard,
		`import { join } from "node:path";\n${stdin}function main({ cwd, tool_name, toolName, tool_input: input }) {
	if (tool_name === "Edit" && input.old_string === "secret") { process.stderr.write("no secret from " + toolName); process.exit(2); }
	if (tool_name === "ls") { process.stderr.write("ls stays ls"); process.exit(2); }
	if (input.file_path === join(cwd, ".env")) { process.stderr.write("no .env"); process.exit(2); }
	if (String(input.command ?? "").includes("rm -rf")) { process.stderr.write("no rm"); process.exit(2); }
}\n`,
	);
	// jq '.tool_input | .file_path = …' 那种写法：整份交回，只改 Claude Code 的名字。
	await writeFile(
		move,
		`import { join } from "node:path";\n${stdin}function main({ cwd, tool_input: input }) {
	const updatedInput = { ...input, file_path: join(cwd, "moved.txt") };
	process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput } }));
}\n`,
	);
	// 同样整份交回，但只改了别的字段：file_path 没动，Plume 的 path 原样留着（还是相对路径）。
	await writeFile(
		shout,
		`${stdin}function main({ tool_input: input }) {
	const updatedInput = { ...input, new_string: input.new_string.toUpperCase() };
	process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput } }));
}\n`,
	);
	const node = (file: string) => command(`"${process.execPath}" "${file}"`);
	const h = await harness({
		PreToolUse: [
			{ matcher: "Write|Edit|Bash|ls", hooks: [node(guard)] },
			{ matcher: "Read", hooks: [node(move)] },
			{ matcher: "Edit", hooks: [node(shout)] },
		],
	});
	try {
		const call = async (name: string, args: Record<string, unknown>) => {
			let seen: Record<string, unknown> | undefined;
			const result = await h.run("tool.execute", execution(h.dir, { call: { id: "c", name, args } }), async (input) => {
				seen = input.call.args;
				return { output: "ran" };
			});
			return { result, seen };
		};
		assert.deepEqual((await call("write", { path: ".env", content: "x" })).result, { output: "no .env", isError: true });
		assert.deepEqual((await call("edit", { path: join(h.dir, ".env"), old_string: "a", new_string: "b" })).result, { output: "no .env", isError: true });
		assert.deepEqual((await call("bash", { command: "rm -rf build" })).result, { output: "no rm", isError: true });
		// tool_name 是 Claude Code 的名字，Plume 的名字在 toolName；没有对照的工具两边都是 Plume 的名字。
		assert.deepEqual((await call("edit", { path: "a.ts", old_string: "secret", new_string: "b" })).result, { output: "no secret from edit", isError: true });
		assert.deepEqual((await call("ls", {})).result, { output: "ls stays ls", isError: true });
		assert.deepEqual((await call("write", { path: "notes.txt", content: "x" })).seen, { path: "notes.txt", content: "x" });
		// 交回的参数里 Claude Code 的名字翻回 Plume 的，不混进工具拿到的参数。
		assert.deepEqual((await call("read", { path: "a.txt", offset: 3 })).seen, { path: join(h.dir, "moved.txt"), offset: 3 });
		assert.deepEqual((await call("edit", { path: "a.ts", old_string: "a", new_string: "b" })).seen, { path: "a.ts", old_string: "a", new_string: "B" });
	} finally {
		await h.dispose();
		await rm(scripts, { recursive: true, force: true });
	}
});

/** 一次模型请求：权限模式、计划模式和 shell 只在这里给，钩子插件从这里记下。 */
function request(h: Harness, overrides: Partial<ModelContext> = {}) {
	const input = { sessionId: "s1", cwd: h.dir, permissionMode: "auto", shell: { kind: "posix", label: "zsh", sandbox: "workspace-write" }, ...overrides };
	return h.run("model.context", input as unknown as ModelContext, async (context) => context);
}

test("stdin 照 Claude Code 补上 permission_mode、duration_ms、is_interrupt；拿不到的 effort、prompt_id 不给", async () => {
	const log = `cat >> "$CLAUDE_PROJECT_DIR/events.log"; echo >> "$CLAUDE_PROJECT_DIR/events.log"`;
	const h = await harness({
		UserPromptSubmit: [{ hooks: [command(log)] }],
		PreToolUse: [{ hooks: [command(log)] }],
		PermissionRequest: [{ hooks: [command(log)] }],
		PostToolUse: [{ hooks: [command(log)] }],
		PostToolUseFailure: [{ hooks: [command(log)] }],
		Stop: [{ hooks: [command(log)] }],
	});
	try {
		const events = async () =>
			(await readFile(join(h.dir, "events.log"), "utf8"))
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>);
		await submit(h, "hello");
		await request(h);
		// 工具里等人审批的那 300 毫秒不算进 duration_ms。
		await h.run("tool.execute", execution(h.dir), async () => {
			await h.run("tool.approve", approval(h.dir, { permissionMode: "auto" }), async () => {
				await new Promise((resolve) => setTimeout(resolve, 300));
				return "once";
			});
			return { output: "ok" };
		});
		await request(h, { permissionMode: "full" });
		await h.run("tool.execute", execution(h.dir), async () => ({ output: "boom", isError: true }));
		await request(h, { permissionMode: "ask", readOnly: true });
		await h.run("tool.execute", execution(h.dir, { readOnly: { refusal: "plan" } }), async () => ({ output: "ok" }));
		const end = {
			sessionId: "s1",
			cwd: h.dir,
			step: 1,
			stepsLeft: 10,
			reply: { role: "assistant", content: [{ type: "text", text: "done" }] },
			toolResults: [],
			signal: new AbortController().signal,
		} as unknown as StepEnd;
		await h.run("step.end", end, async () => ({ continue: false }));

		const seen = await events();
		assert.deepEqual(
			seen.map((event) => [event.hook_event_name, event.permission_mode]),
			[
				// 一轮开始时还没有这一轮的请求，权限模式拿不到。
				["UserPromptSubmit", undefined],
				["PreToolUse", "auto"],
				["PermissionRequest", "auto"],
				["PostToolUse", "auto"],
				["PreToolUse", "bypassPermissions"],
				["PostToolUseFailure", "bypassPermissions"],
				["PreToolUse", "plan"],
				["PostToolUse", "plan"],
				["Stop", "plan"],
			],
		);
		const [post, failure] = seen.filter((event) => event.hook_event_name === "PostToolUse" || event.hook_event_name === "PostToolUseFailure");
		assert.equal(typeof post?.duration_ms, "number");
		assert.ok((post?.duration_ms as number) < 250, `duration_ms ${String(post?.duration_ms)}`);
		assert.equal(typeof failure?.duration_ms, "number");
		assert.equal(failure?.is_interrupt, false);
		assert.equal(failure?.error, "boom");
		for (const event of seen) {
			assert.equal("effort" in event, false);
			assert.equal("prompt_id" in event, false);
		}
	} finally {
		await h.dispose();
	}
});

test("命令跑在 PowerShell 里时（Windows 上受约束的档），bash 对的是 Claude Code 的 PowerShell 工具：tool_name 是 PowerShell，只写 Bash 的 matcher 不中", async () => {
	const log = (tag: string) =>
		`printf '${tag} ' >> "$CLAUDE_PROJECT_DIR/events.log"; cat >> "$CLAUDE_PROJECT_DIR/events.log"; echo >> "$CLAUDE_PROJECT_DIR/events.log"`;
	const h = await harness({
		PreToolUse: [
			{ matcher: "Bash", hooks: [command(log("bash-only"))] },
			{ matcher: "Bash|PowerShell", hooks: [command(log("both"))] },
		],
		PermissionRequest: [{ matcher: "PowerShell", hooks: [command(log("permission"))] }],
	});
	try {
		const events = async () =>
			(await readFile(join(h.dir, "events.log"), "utf8"))
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const at = line.indexOf(" ");
					return [line.slice(0, at), (JSON.parse(line.slice(at + 1)) as { tool_name: string }).tool_name];
				});
		await request(h, { shell: { kind: "powershell", label: "Windows PowerShell 5.1", sandbox: "workspace-write" } });
		await h.run("tool.execute", execution(h.dir), async () => ({ output: "ok" }));
		await h.run("tool.approve", approval(h.dir), async () => "once");
		await request(h, { shell: { kind: "posix", label: "Git Bash", sandbox: "danger-full-access" } });
		await h.run("tool.execute", execution(h.dir), async () => ({ output: "ok" }));
		assert.deepEqual(await events(), [
			["both", "PowerShell"],
			["permission", "PowerShell"],
			["bash-only", "Bash"],
			["both", "Bash"],
		]);
	} finally {
		await h.dispose();
	}
});

test("一轮开始：SessionStart 只跑一次；UserPromptSubmit 拦下时下一轮重跑 SessionStart", async () => {
	const h = await harness({
		SessionStart: [{ hooks: [command(`echo '{"additionalContext":"start"}'`)] }],
		UserPromptSubmit: [{ hooks: [command(`read line; case "$line" in *secret*) echo leak >&2; exit 2;; esac; echo '{"additionalContext":"seen"}'`)] }],
	});
	try {
		assert.deepEqual(await submit(h, "my secret"), { block: true, reason: "A UserPromptSubmit hook blocked this message: leak" });
		const first = await submit(h, "hello");
		assert.equal(first.block, false);
		assert.ok(!first.block && first.context?.includes("SessionStart hook additional context:\n#1\nstart"));
		assert.ok(!first.block && first.context?.includes("UserPromptSubmit hook additional context:\n#1\nseen"));
		const second = await submit(h, "again");
		assert.ok(!second.block && second.context && !second.context.includes("SessionStart"));
	} finally {
		await h.dispose();
	}
});

test("Stop：说了还差什么才接着干，一轮最多三次", async () => {
	const h = await harness({ Stop: [{ hooks: [command(`echo '{"decision":"block","reason":"run the tests"}'`)] }] });
	try {
		const end = {
			sessionId: "s1",
			cwd: h.dir,
			step: 1,
			stepsLeft: 10,
			reply: { role: "assistant", content: [{ type: "text", text: "done" }] },
			toolResults: [],
			signal: new AbortController().signal,
		} as unknown as StepEnd;
		const verdicts = [];
		for (let i = 0; i < 4; i++) verdicts.push(await h.run("step.end", end, async () => ({ continue: false })));
		assert.deepEqual(
			verdicts.map((verdict) => verdict.continue),
			[true, true, true, false],
		);
		assert.ok(verdicts[0]?.continue && verdicts[0].say?.includes("Stop hook additional context:\n#1\nrun the tests"));
		// 还有工具结果要交给模型时不问 Stop。
		assert.deepEqual(await h.run("step.end", end, async () => ({ continue: true })), { continue: true });
	} finally {
		await h.dispose();
	}
});

test("设置页：新建、开关、删除写回 hooks.json；写坏了的文件不被冲掉", async () => {
	const h = await harness({});
	try {
		const created = await h.api.save("user", null, null, { event: "PostToolUse", matcher: "Edit", type: "process", command: "fmt", args: ["--check"] });
		assert.equal(created.user.length, 1);
		assert.equal(created.project, null);
		const [hook] = created.user;
		assert.ok(hook);
		assert.equal((await h.api.setEnabled("user", null, hook.id, false)).user[0]?.enabled, false);
		assert.equal((await h.api.remove("user", null, hook.id)).user.length, 0);
		await assert.rejects(h.api.remove("user", null, hook.id));
		// 没选项目时写不了项目钩子；目录也得是绝对路径。
		await assert.rejects(h.api.save("project", null, null, { event: "Stop", type: "command", command: "x" }));
		await assert.rejects(h.api.list("relative/dir"));
		await writeFile(join(h.data, "hooks.json"), "{ broken");
		assert.ok((await h.api.list(null)).error);
		await assert.rejects(h.api.save("user", null, null, { event: "Stop", type: "command", command: "x" }));
		assert.equal(await readFile(join(h.data, "hooks.json"), "utf8"), "{ broken");
	} finally {
		await h.dispose();
	}
});

test("PermissionRequest：要弹卡时先问钩子；拒绝算数，放行只放一次，退出码 2 不改审批，提权和只能人答的不归它", async () => {
	const h = await harness({
		PermissionRequest: [
			{ matcher: "Bash", hooks: [command(`echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'`)] },
			{
				matcher: "Write",
				hooks: [command(`echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"nope"}}}'`)],
			},
			// 照 Claude Code：退出码 2 不算拒绝，审批照常弹给人。
			{ matcher: "Edit", hooks: [command("echo nope >&2; exit 2")] },
		],
	});
	try {
		let asked = 0;
		const human = async () => {
			asked += 1;
			return "always" as const;
		};
		assert.equal(await h.run("tool.approve", approval(h.dir), human), "once");
		assert.equal(await h.run("tool.approve", approval(h.dir, { call: { id: "c2", name: "write", args: {} } }), human), "reject");
		assert.equal(asked, 0);
		// 提权的放行由本体不认、照样弹卡（见 core/agent 的测试）；这里只看拒绝照样算。
		const escalation = { kind: "bash", title: "Run ls", detail: "ls", escalation: "danger-full-access" as const };
		assert.equal(await h.run("tool.approve", approval(h.dir, { call: { id: "c3", name: "write", args: {} }, request: escalation }), human), "reject");
		// 层自己要问的，钩子不碰；没配钩子的工具照常问人。
		assert.equal(await h.run("tool.approve", approval(h.dir, { byLayer: true }), human), "always");
		assert.equal(await h.run("tool.approve", approval(h.dir, { call: { id: "c4", name: "read", args: {} } }), human), "always");
		assert.equal(asked, 2);
		assert.equal(await h.run("tool.approve", approval(h.dir, { call: { id: "c5", name: "edit", args: {} } }), human), "always");
		assert.equal(asked, 3);
	} finally {
		await h.dispose();
	}
});

test("PermissionRequest：放行时改了参数的，Plume 改不了审批里的参数，交给人批；参数原样交回、带 updatedPermissions 的照样放行一次", async () => {
	const allow = (decision: Record<string, unknown>) =>
		command(`echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", ...decision } } })}'`);
	const h = await harness({
		PermissionRequest: [
			{ matcher: "Bash", hooks: [allow({ updatedInput: { command: "npm run lint" } })] },
			// 照 jq '.tool_input' 原样交回：file_path 是 Plume 补给脚本的，翻回去和原参数一样。
			{
				matcher: "Write",
				hooks: [
					command(
						`"${process.execPath}" -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{const {tool_input}=JSON.parse(r);process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PermissionRequest",decision:{behavior:"allow",updatedInput:tool_input}}}))})'`,
					),
				],
			},
			{
				matcher: "Edit",
				hooks: [allow({ updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Edit" }], behavior: "allow", destination: "session" }] })],
			},
		],
	});
	try {
		let asked = 0;
		const human = async () => {
			asked += 1;
			return "reject" as const;
		};
		assert.equal(await h.run("tool.approve", approval(h.dir), human), "reject");
		assert.equal(asked, 1);
		assert.equal(await h.run("tool.approve", approval(h.dir, { call: { id: "c2", name: "write", args: { path: "a.txt", content: "x" } } }), human), "once");
		assert.equal(await h.run("tool.approve", approval(h.dir, { call: { id: "c3", name: "edit", args: {} } }), human), "once");
		assert.equal(asked, 1);
	} finally {
		await h.dispose();
	}
});

test("StopFailure 和 SessionEnd：一轮没完成时跑、带上最后的回复；会话结束只给跑过 SessionStart 的、跑一次、排在 StopFailure 后面", async () => {
	const log = `cat >> "$CLAUDE_PROJECT_DIR/events.log"; echo >> "$CLAUDE_PROJECT_DIR/events.log"`;
	const h = await harness({
		StopFailure: [{ matcher: "error|aborted", hooks: [command(`sleep 0.2; ${log}`)] }],
		SessionEnd: [{ hooks: [command(log)] }],
	});
	try {
		const events = async () =>
			(await readFile(join(h.dir, "events.log"), "utf8").catch(() => ""))
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>);
		// 没开过口的会话结束了，不跑 SessionEnd。
		await h.end("s1", "archived");
		await submit(h, "hello");
		h.messages.set("s1", [{ role: "assistant", content: [{ type: "text", text: "half way" }] } as unknown as Message]);
		h.observe("s1", { type: "turnEnd", stop: { reason: "done" } });
		h.observe("s1", { type: "turnEnd", stop: { reason: "stalled" } });
		h.observe("s1", { type: "turnEnd", stop: { reason: "error", error: "boom" } });
		await h.end("s1", "archived");
		await h.end("s1", "archived");
		const seen = await events();
		assert.deepEqual(
			seen.map((event) => [event.hook_event_name, event.reason]),
			[
				["StopFailure", "error"],
				["SessionEnd", "archived"],
			],
		);
		assert.equal(seen[0]?.error, "boom");
		assert.equal(seen[0]?.last_assistant_message, "half way");
	} finally {
		await h.dispose();
	}
});

test("项目钩子：没信任的不跑、记成被拦下；信任后才跑；设置页写下的自动信任；命令改了要再信任一次", async () => {
	const h = await harness({});
	try {
		await mkdir(join(h.dir, ".plume"));
		const configPath = join(h.dir, ".plume", "config.json");
		await writeFile(configPath, JSON.stringify({ model: "kept", hooks: { events: { PreToolUse: [{ hooks: [command("echo stop >&2; exit 2")] }] } } }));
		await submit(h, "hello");

		let ran = 0;
		const inner = async () => {
			ran += 1;
			return { output: "ok" };
		};
		assert.deepEqual(await h.run("tool.execute", execution(h.dir), inner), { output: "ok" });
		assert.equal(ran, 1);
		const blocked = await until(
			() => h.api.runs("s1"),
			(runs) => runs.length === 1,
		);
		assert.equal(blocked[0]?.status, "blocked");
		assert.equal(blocked[0]?.source, "project");
		assert.match(blocked[0]?.reason ?? "", /not trusted/);

		const view = await h.api.list(h.dir);
		assert.equal(view.projectPath, configPath);
		const [hook] = view.project ?? [];
		assert.ok(hook);
		assert.equal(hook.trusted, false);
		assert.equal((await h.api.trust(h.dir, [hook.id])).project?.[0]?.trusted, true);
		await assert.rejects(h.api.trust(h.dir, ["project:PreToolUse:9:9:nope"]));
		assert.deepEqual(await h.run("tool.execute", execution(h.dir), inner), { output: "stop", isError: true });
		assert.equal(ran, 1);

		// 设置页新建的那一条直接信任，别的键原样留着。
		const saved = await h.api.save("project", h.dir, null, { event: "Stop", type: "command", command: "true" });
		assert.deepEqual(
			saved.project?.map((entry) => [entry.event, entry.trusted]),
			[
				["PreToolUse", true],
				["Stop", true],
			],
		);
		const written = JSON.parse(await readFile(configPath, "utf8")) as { model: string; hooks: { events: Record<string, unknown> } };
		assert.equal(written.model, "kept");
		assert.deepEqual(Object.keys(written.hooks.events).sort(), ["PreToolUse", "Stop"]);

		// 在外面把命令改了：指纹变了，旧的信任不算数。
		written.hooks.events.PreToolUse = [{ hooks: [command("echo changed >&2; exit 2")] }];
		await writeFile(configPath, JSON.stringify(written));
		assert.equal((await h.api.list(h.dir)).project?.find((entry) => entry.event === "PreToolUse")?.trusted, false);

		// 读不懂的项目配置：说出原因，改动被拒绝，文件不被冲掉。
		await writeFile(configPath, "{ broken");
		assert.ok((await h.api.list(h.dir)).projectError);
		await assert.rejects(h.api.save("project", h.dir, null, { event: "Stop", type: "command", command: "x" }));
		assert.equal(await readFile(configPath, "utf8"), "{ broken");
	} finally {
		await h.dispose();
	}
});

test("运行记录：归开口那一轮，撤回时跟着删，会话删掉时清空；变了的会话经 watch 推出去", async () => {
	const h = await harness({ PostToolUse: [{ hooks: [command("exit 7")] }] });
	try {
		const controller = new AbortController();
		const watch = h.api.watch({ signal: controller.signal });
		const pushed = watch.next();
		h.messages.set("s1", [{ role: "user" }, { role: "assistant" }] as unknown as Message[]);
		await submit(h, "third");
		await h.run("tool.execute", execution(h.dir), async () => ({ output: "ok" }));
		const runs = await until(
			() => h.api.runs("s1"),
			(list) => list.length === 1 && list[0]?.status !== "running",
		);
		assert.equal(runs[0]?.status, "failed");
		assert.equal(runs[0]?.at, 3);
		assert.equal(runs[0]?.event, "PostToolUse");
		assert.ok(runs[0]?.durationMs !== undefined);
		assert.deepEqual((await pushed).value, ["s1"]);

		// 撤回到这一轮开口之前：它的记录跟着删。
		h.observe("s1", { type: "rewound", sessionId: "s1", count: 2, compactions: [], runs: [] });
		await until(
			() => h.api.runs("s1"),
			(list) => list.length === 0,
		);
		await h.run("tool.execute", execution(h.dir), async () => ({ output: "ok" }));
		await until(
			() => h.api.runs("s1"),
			(list) => list.length === 1 && list[0]?.status !== "running",
		);
		h.deleted("s1");
		assert.deepEqual(
			await until(
				() => h.api.runs("s1"),
				(list) => list.length === 0,
			),
			[],
		);

		controller.abort();
		assert.equal((await watch.next()).done, true);
	} finally {
		await h.dispose();
	}
});
