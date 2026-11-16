import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { HookLayer, Message, PluginContext, SessionScope, SessionSummary, ToolDefinition, ToolRun } from "@plume/contract";
import { reviewHandoff, reviewIntent, userWords } from "../src/brief.ts";
import plugin from "../src/index.ts";
import { MESSAGES } from "../src/messages.ts";
import { reviewBody } from "../src/review.ts";

const brief = MESSAGES.en.brief;
const user = (text: string, extra: Partial<Message> = {}): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1, ...extra }) as Message;
// 审阅背景的这一项和行内样式的属性同名，用变量当键，免得样式检查当成 style 里的底色。
const BACKGROUND = "background";
const complete = {
	[BACKGROUND]: "The person asked for reviews to be done by sub-agents so the author does not agree with itself.",
	decisions: '"不要 commit" — nothing committed.',
	implementation: "Replaced the review session with a brief the reviewer sub-agents read, and moved the fixes into this conversation.",
	files: [{ path: "src/index.ts", change: "adds the review_brief tool" }],
	unverified: "Nothing known unverified: the tests cover it.",
};

test("审阅背景：缺的、太短的一次列全", () => {
	const short = reviewHandoff({ [BACKGROUND]: "too short", files: [{ path: "a.ts" }] });
	assert.ok("error" in short);
	for (const key of [
		"background (9 characters, at least 40)",
		"decisions (missing)",
		"implementation (missing)",
		"files[0].change for a.ts",
		"unverified (missing)",
	])
		assert.ok(short.error.includes(key), key);
	assert.deepEqual(reviewHandoff(complete), complete);
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

test("intent.md：计划、原话原样包进标签，没填的写明未提供", () => {
	const handoff = reviewHandoff(complete);
	assert.ok(!("error" in handoff));
	const intent = reviewIntent(handoff, "新计划", [user("把登录改成 OAuth")], "改登录", brief);
	assert.ok(intent.startsWith("# Review brief\n\nThe conversation “改登录” wrote this change"));
	assert.ok(intent.includes("<approved_plan>\n新计划\n</approved_plan>"));
	assert.ok(intent.includes('<user_message n="1">\n把登录改成 OAuth\n</user_message>'));
	assert.ok(intent.includes("- `src/index.ts` — adds the review_brief tool"));
	assert.ok(intent.includes("## Out of scope\n\nNot given."));
	assert.ok(reviewIntent(handoff, null, [], "改登录", brief).includes("## Approved plan\n\nThis conversation has no approved plan."));
});

test("正文：在这个对话里派子智能体，low 也派一个；发现原样列出、不凭自己删，每条都有处置；没有审阅会话那一套", () => {
	const full = reviewBody({ delegate: "dispatch", question: "ask_person" });
	assert.ok(full.includes("You have the `review_brief` tool"));
	assert.ok(full.includes("**low** — one `review` finder for A, B and C"));
	assert.ok(full.includes("**medium** — three `review` finders"));
	assert.ok(full.includes("If you do not have the `dispatch` tool here"));
	assert.ok(full.includes("**Finder prompt**"));
	assert.ok(full.includes("none is dropped on yours either"));
	assert.ok(full.includes("Copy each finding's location, problem and trigger from the sub-agent's result as it wrote them"));
	assert.ok(full.includes("Every finding gets a decision"));
	assert.ok(full.includes("ask the person with `ask_person`, about those findings only"));
	assert.ok(full.includes('call `ask_person` with the options "Post this comment" and "Do not post"'));
	// 子智能体里改动是它自己写的：不审，叫人回主会话。
	assert.ok(full.includes("tell the person to send `/review` in the main conversation"));
	assert.doesNotMatch(full, /review_session|ask_implementer|answer_review|spawn_session|--fix|`task`|`ask_user`/);

	// 没有派子智能体的工具：主会话不自己审，力度那一节不出现。
	const bare = reviewBody({});
	assert.ok(bare.includes("There is no tool here for dispatching sub-agents"));
	assert.ok(bare.includes("do not review the change yourself: tell the person `/review` needs the sub-agents"));
	assert.ok(!bare.includes("**medium** —"));
	assert.ok(!bare.includes("**Finder prompt**"));
	assert.ok(bare.includes("ask the person in one message and end your turn"));
	assert.ok(bare.includes('ask whether to post it — "Post this comment" or "Do not post" — and end your turn'));
	assert.doesNotMatch(bare, /`undefined`/);
});

async function fixture(t: TestContext) {
	const scratch = mkdtempSync(join(tmpdir(), "plume-review-"));
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
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
		["main", summary("main")],
		["side", summary("side", { parentId: "main", owner: "plume.side-chat" })],
		["ops", summary("ops", { owner: "plume.ssh" })],
	]);
	const messages = new Map<string, Message[]>([["main", [user("把登录改成 OAuth")]]]);
	// 计划向服务 session.plan 要，这里是假的那份。
	const plans = new Map<string, string>([["main", "新计划\n\n## 执行时注意\n别动接口"]]);
	const layers = new Map<string, unknown>();
	const tools = new Map<string, ToolDefinition>();
	const ctx = {
		name: "plume.review",
		dataDir: scratch,
		locale: () => "en",
		log: { info() {}, warn() {}, error() {} },
		hook: (name: string, layer: unknown) => void layers.set(name, layer),
		use: (name: string) => {
			assert.equal(name, "session.plan");
			return { approved: async (sessionId: string) => plans.get(sessionId) ?? null };
		},
		tools: {
			register: (definition: ToolDefinition) => {
				tools.set(definition.name, definition);
				return () => {};
			},
			list: () => [{ name: "read", plugin: "plume.tools", kind: "view" }],
		},
		commands: { provide() {} },
		sessions: {
			get: async (id: string) => sessions.get(id),
			messages: async (id: string) => structuredClone(messages.get(id) ?? []),
		},
	} as unknown as PluginContext;
	await plugin.apply(ctx);
	const scope = (sessionId: string): SessionScope => {
		const self = sessions.get(sessionId)!;
		return { id: sessionId, kind: self.kind, ...(self.parentId ? { parentId: self.parentId } : {}), ...(self.owner ? { owner: self.owner } : {}) };
	};
	const run = (sessionId: string) =>
		({ sessionId, session: scope(sessionId), toolCallId: "call", cwd: "/w", scratchDir: join(scratch, sessionId) }) as unknown as ToolRun;
	const context = layers.get("model.context") as HookLayer<"model.context">;
	/** 这个会话的模型看得到哪几件工具（经 `model.context`）。 */
	const visible = async (sessionId: string): Promise<string[]> => {
		let seen: string[] = [];
		const input = { sessionId, session: scope(sessionId), tools: [{ name: "review_brief" }, { name: "read" }] } as unknown as Parameters<typeof context>[0];
		await context(input, async (next) => {
			seen = next.tools.map((tool) => tool.name);
			return next as never;
		});
		return seen;
	};
	return { tool: tools.get("review_brief")!, run, visible, scratch, layers };
}

test("review_brief 只列给侧栏里的会话；写出 intent.md，附上计划和人的原话", async (t) => {
	const f = await fixture(t);
	// 只剩这一件工具和这一层钩子：不再开会话、拦写文件、交回报告。
	assert.deepEqual([...f.layers.keys()], ["model.context"]);
	assert.deepEqual(await f.visible("main"), ["review_brief", "read"]);
	assert.deepEqual(await f.visible("side"), ["read"]);
	assert.deepEqual(await f.visible("ops"), ["read"]);
	assert.equal((await f.tool.execute(complete, f.run("side"))).isError, true);
	assert.equal((await f.tool.execute(complete, f.run("ops"))).isError, true);

	// 不全时退回、什么都不写。
	const short = await f.tool.execute({ [BACKGROUND]: "short" }, f.run("main"));
	assert.match(short.output, /brief is incomplete/);
	assert.throws(() => readFileSync(join(f.scratch, "main", "review", "intent.md")));

	const result = await f.tool.execute(complete, f.run("main"));
	assert.equal(result.isError, undefined);
	const path = join(f.scratch, "main", "review", "intent.md");
	assert.ok(result.output.includes(path));
	const intent = readFileSync(path, "utf8");
	assert.ok(intent.includes("<approved_plan>\n新计划\n\n## 执行时注意\n别动接口\n</approved_plan>"), "计划取自服务 session.plan");
	assert.ok(intent.includes('<user_message n="1">\n把登录改成 OAuth\n</user_message>'));
});
