import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type {
	DeliveryInput,
	HookLayer,
	LaunchedIdle,
	LaunchedSession,
	Message,
	PluginContext,
	PromptSubmit,
	SessionLaunch,
	SessionScope,
	SessionSummary,
	ToolDefinition,
	ToolRun,
	TurnStop,
} from "@plume/contract";
import { latestApprovedPlan, reviewHandoff, reviewPrompt, reviewRequest, userWords } from "../src/brief.ts";
import plugin from "../src/index.ts";
import { MESSAGES } from "../src/messages.ts";
import { REVIEW_BODY, REVIEW_SESSION_OPENING } from "../src/review.ts";

const brief = MESSAGES.en.brief;
const user = (text: string, extra: Partial<Message> = {}): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1, ...extra }) as Message;
// 交接单的这一项和行内样式的属性同名，用变量当键，免得样式检查当成 style 里的底色。
const BACKGROUND = "background";
const complete = {
	[BACKGROUND]: "The person asked for reviews to run in a separate session so the author does not agree with itself.",
	decisions: '"不要 commit" — nothing committed.',
	implementation: "Moved the hand-off into a plugin tool that launches a new session with the brief as its first message.",
	files: [{ path: "src/index.ts", change: "adds the review_session tool" }],
	unverified: "Nothing known unverified: the tests cover it.",
};

test("交接单：缺的、太短的一次列全；审 PR 时可以一项不填", () => {
	const short = reviewHandoff({ [BACKGROUND]: "too short", files: [{ path: "a.ts" }] }, false);
	assert.ok(short && "error" in short);
	for (const key of [
		"background (9 characters, at least 40)",
		"decisions (missing)",
		"implementation (missing)",
		"files[0].change for a.ts",
		"unverified (missing)",
	])
		assert.ok(short.error.includes(key), key);
	assert.equal(reviewHandoff({}, true), undefined);
	assert.deepEqual(reviewHandoff(complete, false), { ...complete, files: [{ path: "src/index.ts", change: "adds the review_session tool" }] });
	assert.deepEqual(reviewRequest({ effort: "max" }, "t", brief), { error: "effort must be one of low, medium, high." });
	assert.deepEqual(reviewRequest({ target: "#12" }, "改登录", brief), { kind: "review_session", title: "Review · #12", subject: "#12", target: "#12" });
});

test("用户原话：只收人说的，太长时留首条和最近几条", () => {
	const messages = [
		user("先做 A"),
		user("继续", { synthetic: true }),
		user("别的会话的信", { peer: [{ sessionId: "x", from: "x [1]", text: "hi" }] }),
		user("子会话（比如侧边聊天）交过来的", { origin: "child" }),
		user("/review", { displayText: "/review" }),
	];
	assert.deepEqual(
		userWords(messages).words.map((one) => one.text),
		["先做 A", "/review"],
	);
	const long = Array.from({ length: 6 }, (_, at) => user(`${at}${"字".repeat(3_000)}`));
	const { words, omitted } = userWords(long);
	assert.equal(words[0]!.n, 1);
	assert.equal(words.at(-1)!.n, 6);
	assert.equal(omitted, 6 - words.length);
	assert.ok(omitted > 0);
});

test("计划取最近批准的那份，带着注意事项；交接单第一行认得出审阅会话", () => {
	const result = (details: unknown, isError = false): Message =>
		({ role: "toolResult", toolCallId: "p", toolName: "submit_plan", content: [], details, isError, timestamp: 1 }) as Message;
	const messages = [
		result({ kind: "plan", plan: "旧计划", approved: true }),
		result({ kind: "plan", plan: "打回的", approved: false }),
		result({ kind: "plan", plan: "新计划", approved: true, notes: "别动接口" }),
	];
	assert.equal(latestApprovedPlan(messages), "新计划\n\n## 执行时注意\n别动接口");
	assert.equal(latestApprovedPlan([]), null);
	const request = reviewRequest(complete, "改登录", brief);
	assert.ok(!("error" in request));
	const prompt = reviewPrompt(request, "新计划", [user("把登录改成 OAuth")], "改登录", "改登录 [abc123]", brief);
	assert.ok(prompt.startsWith(REVIEW_SESSION_OPENING));
	assert.ok(prompt.includes("<approved_plan>\n新计划\n</approved_plan>"));
	assert.ok(prompt.includes('<user_message n="1">\n把登录改成 OAuth\n</user_message>'));
	assert.ok(prompt.includes("`改登录 [abc123]`"));
	assert.ok(prompt.includes("- `src/index.ts` — adds the review_session tool"));
	assert.ok(prompt.includes("Arguments: none (the uncommitted local changes)"));
	// 没有 ask_session 时不问、不修。
	assert.ok(reviewPrompt(request, null, [], "改登录", undefined, brief).includes("skip step F's question"));
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => (resolve = settle));
	return { promise, resolve };
}

async function fixture(t: TestContext, tools: string[] = ["ask_session"]) {
	const directory = mkdtempSync(join(tmpdir(), "plume-review-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	// `kind` 和本体一样按 `parentId`、`owner` 算。
	const summary = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
		({
			id,
			title: "改登录",
			cwd: "/w",
			running: false,
			createdAt: 0,
			updatedAt: 0,
			kind: extra.parentId ? "child" : extra.owner ? "standalone" : "top",
			...extra,
		}) as SessionSummary;
	const sessions = new Map([
		["main", summary("main", { project: "p", model: "m1", cwd: "/w/.worktrees/a" })],
		["side", summary("side", { parentId: "main", owner: "plume.side-chat" })],
		["ops", summary("ops", { owner: "plume.ssh" })],
	]);
	const messages = new Map<string, Message[]>([["main", [user("把登录改成 OAuth")]]]);
	const layers = new Map<string, unknown>();
	let tool: ToolDefinition | undefined;
	const launches: SessionLaunch[] = [];
	const reports: { text: string; delivery: DeliveryInput }[] = [];
	const done = deferred<TurnStop>();
	const idle = deferred<LaunchedIdle>();
	const ctx = {
		name: "plume.review",
		dataDir: directory,
		locale: () => "en",
		log: { info() {}, warn() {}, error() {} },
		hook: (name: string, layer: unknown) => void layers.set(name, layer),
		tools: {
			register: (definition: ToolDefinition) => {
				tool = definition;
				return () => {};
			},
			names: () => tools,
			// 写、改文件的工具按声明的种类认（这里照 plume.tools 的声明），不认名字。
			list: () => [
				{ name: "read", plugin: "plume.tools", kind: "view" },
				{ name: "write", plugin: "plume.tools", kind: "create" },
				{ name: "edit", plugin: "plume.tools", kind: "modify" },
				{ name: "apply_patch", plugin: "example.patch", kind: "modify" },
			],
		},
		commands: { provide() {} },
		sessions: {
			get: async (id: string) => sessions.get(id),
			messages: async (id: string) => structuredClone(messages.get(id) ?? []),
			observe() {},
			onDeleted() {},
			launch: async (launch: SessionLaunch): Promise<LaunchedSession> => {
				launches.push(launch);
				const session = summary("review", { project: "p", cwd: "/w", spawnedFrom: { sessionId: "main", toolCallId: "call" } });
				sessions.set("review", session);
				return {
					session,
					done: done.promise,
					idle: idle.promise,
					reportBack: (text, delivery) => {
						reports.push({ text, delivery });
						return true;
					},
				};
			},
		},
	} as unknown as PluginContext;
	await plugin.apply(ctx);
	/** 钩子输入和 `run` 上的 `session`，照会话摘要填。 */
	const scope = (sessionId: string): SessionScope => {
		const self = sessions.get(sessionId)!;
		return { id: sessionId, kind: self.kind, ...(self.parentId ? { parentId: self.parentId } : {}), ...(self.owner ? { owner: self.owner } : {}) };
	};
	const run = (sessionId: string) => ({ sessionId, session: scope(sessionId), toolCallId: "call" }) as ToolRun;
	const submit = layers.get("prompt.submit") as HookLayer<"prompt.submit">;
	const execute = layers.get("tool.execute") as HookLayer<"tool.execute">;
	const call = (sessionId: string, name: string) =>
		execute({ sessionId, session: scope(sessionId), call: { id: "c", name, args: {} } } as Parameters<typeof execute>[0], async () => ({ output: "ran" }));
	const context = layers.get("model.context") as HookLayer<"model.context">;
	return { tool: tool!, run, scope, submit, call, context, launches, reports, messages, sessions, done, idle };
}

test("review_session 只列给侧栏里的会话：子会话、插件的独立会话的工具表里没有", async (t) => {
	const f = await fixture(t);
	const names = async (sessionId: string) => {
		let seen: string[] = [];
		const input = { sessionId, session: f.scope(sessionId), tools: [{ name: "review_session" }, { name: "read" }] } as unknown as Parameters<
			typeof f.context
		>[0];
		await f.context(input, async (next) => {
			seen = next.tools.map((tool) => tool.name);
			return next as never;
		});
		return seen;
	};
	assert.deepEqual(await names("main"), ["review_session", "read"]);
	assert.deepEqual(await names("side"), ["read"]);
	assert.deepEqual(await names("ops"), ["read"]);
});

test("review_session：开出审阅会话、第一轮接上正文和原会话的目录，只读到原会话答复为止，做完把报告交回", async (t) => {
	const f = await fixture(t);
	// 子会话、插件的独立会话里拒绝。
	assert.equal((await f.tool.execute({}, f.run("side"))).isError, true);
	assert.equal((await f.tool.execute(complete, f.run("ops"))).isError, true);
	// 交接单不全时退回、什么都不开。
	assert.match((await f.tool.execute({ [BACKGROUND]: "short" }, f.run("main"))).output, /hand-off is incomplete/);
	assert.equal(f.launches.length, 0);

	const result = await f.tool.execute(complete, f.run("main"));
	assert.equal(result.isError, undefined);
	assert.equal(result.terminate, "done");
	assert.deepEqual(result.details, {
		kind: "review_session",
		title: "Review · 改登录",
		subject: "改登录",
		handoff: complete,
		sessionId: "review",
	});
	const [launch] = f.launches;
	assert.equal(launch!.project, "p");
	assert.equal(launch!.model, "m1");
	assert.deepEqual(launch!.spawnedFrom, { sessionId: "main", toolCallId: "call" });
	assert.ok(launch!.message.startsWith(REVIEW_SESSION_OPENING));

	// 审阅会话的第一轮：正文接在交接单后面，挪进原会话的目录（工作树）。
	const verdict = await f.submit(
		{ sessionId: "review", cwd: "/w", text: launch!.message, attachments: [], synthetic: false, fresh: true } as unknown as PromptSubmit,
		async () => ({ block: false }),
	);
	assert.deepEqual(verdict, { block: false, context: REVIEW_BODY, cwd: "/w/.worktrees/a" });
	// 审阅会话自己再交一次不行。
	assert.match((await f.tool.execute(complete, f.run("review"))).output, /This conversation is the review session/);

	// 只读：审阅会话和它的子 Agent 写不了文件，读照常；原会话答复以后放行。
	f.sessions.set("worker", { ...f.sessions.get("side")!, id: "worker", parentId: "review", owner: "plume.subagents" });
	assert.equal((await f.call("review", "write")).isError, true);
	assert.equal((await f.call("worker", "edit")).isError, true);
	assert.equal((await f.call("review", "apply_patch")).isError, true, "别的插件声明了改文件的工具同样拦");
	assert.deepEqual(await f.call("review", "read"), { output: "ran" });
	assert.deepEqual(await f.call("main", "write"), { output: "ran" });
	f.messages.set("review", [user("修 1、2", { peer: [{ sessionId: "main", from: "改登录 [abc]", text: "修 1、2", answer: "dropped" }] })]);
	assert.equal((await f.call("review", "write")).isError, true);
	f.messages.set("review", [user("修 1、2", { peer: [{ sessionId: "main", from: "改登录 [abc]", text: "修 1、2", answer: "replied" }] })]);
	assert.deepEqual(await f.call("review", "write"), { output: "ran" });

	// 做完、真闲下来以后交回最后那段回复。
	f.done.resolve({ reason: "done" });
	f.idle.resolve({ stop: { reason: "done" }, reply: "## Review: local changes\nNo defects found." });
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(f.reports.length, 1);
	// 那一行由宿主按通用字段画：标题是审阅会话现在的标题，点了过去由宿主填 id。
	assert.deepEqual(f.reports[0]!.delivery, { id: "review", title: "改登录", status: "done" });
	assert.match(
		f.reports[0]!.text,
		/<session_result id="review" title="改登录" status="done">\n## Review: local changes\nNo defects found\.\n<\/session_result>/,
	);
});
