import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	HookLayer,
	LetterFate,
	LetterInput,
	LetterReceipt,
	Message,
	ModelContext,
	PluginContext,
	SessionObservation,
	SessionScope,
	SessionSummary,
	ToolDefinition,
	ToolRun,
} from "@plume/contract";
import { currentStep } from "../src/history.ts";
import plugin from "../src/index.ts";
import type { SessionsApi } from "../src/api.ts";
import { PEER_DEDUP_MS } from "../src/pacing.ts";
import { familyOf, resolveSession, sessionAddress, together } from "../src/peers.ts";

/** 会话摘要；`kind` 和本体一样按 `parentId`、`owner` 算。 */
const summary = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
	({
		id,
		title: id,
		cwd: "/w/app",
		running: false,
		createdAt: 0,
		updatedAt: 0,
		kind: extra.parentId ? "child" : extra.owner ? "standalone" : "top",
		...extra,
	}) as SessionSummary;

/** 钩子输入和 `run` 上的 `session`，照会话摘要填。 */
const scope = (session: SessionSummary | undefined, id: string): SessionScope =>
	session
		? {
				id,
				kind: session.kind,
				...(session.parentId ? { parentId: session.parentId } : {}),
				...(session.owner ? { owner: session.owner } : {}),
				...(session.spawnedFrom ? { spawnedFrom: session.spawnedFrom } : {}),
			}
		: { id, kind: "top" };

const said = (role: "user" | "assistant", text: string): Message =>
	(role === "user"
		? { role, content: [{ type: "text", text }], timestamp: 1 }
		: { role, content: [{ type: "text", text }], api: "x", provider: "x", model: "x", usage: {}, stopReason: "stop", timestamp: 1 }) as unknown as Message;

/** 寄出的一封：谁寄给谁、写了什么；`settle` 定它的下落。 */
interface Posted {
	from: string;
	to: string;
	input: LetterInput;
	receipt: LetterReceipt;
	settle(fate: LetterFate): void;
}

/**
 * 几个会话：`plan` 在项目 p1；`exec` 是从它开出来的、开在别处（短名 exec）；`near` 在同一个目录；`far` 在别处；`side` 是 `plan` 的子会话；
 * `grand` 是从 `exec` 开出来的。
 */
function fixture() {
	const sessions: SessionSummary[] = [
		summary("aaaaaa11-0000-4000-8000-000000000000", { title: "定计划", cwd: "/w/app", project: "p1" }),
		summary("bbbbbb22-0000-4000-8000-000000000000", {
			title: "执行",
			cwd: "/elsewhere",
			spawnedFrom: { sessionId: "aaaaaa11-0000-4000-8000-000000000000", toolCallId: "c1", name: "exec" },
		}),
		summary("cccccc33-0000-4000-8000-000000000000", { title: "旁边", cwd: "/w/app/src", running: true }),
		summary("dddddd44-0000-4000-8000-000000000000", { title: "别处", cwd: "/other" }),
		summary("eeeeee55-0000-4000-8000-000000000000", {
			title: "侧边",
			cwd: "/w/app",
			parentId: "aaaaaa11-0000-4000-8000-000000000000",
			owner: "plume.side-chat",
		}),
		summary("ffffff66-0000-4000-8000-000000000000", {
			title: "孙辈",
			cwd: "/elsewhere",
			spawnedFrom: { sessionId: "bbbbbb22-0000-4000-8000-000000000000", toolCallId: "c2" },
		}),
	];
	const [plan, exec, near, far, side, grand] = sessions as [SessionSummary, SessionSummary, SessionSummary, SessionSummary, SessionSummary, SessionSummary];
	const messages = new Map<string, Message[]>([[plan.id, [said("user", "做个计划"), said("assistant", "选 SQLite，因为单机。")]]]);
	const tools = new Map<string, ToolDefinition>();
	const layers = new Map<string, unknown>();
	const observers: Array<(observation: SessionObservation) => void> = [];
	const posted: Posted[] = [];
	/** 给了就让寄信抛这句错，和本体拒寄（对方刚好不在了）时一样。 */
	const refuse: { reason?: string } = {};
	let letters = 0;
	const post = (from: string, to: string, input: LetterInput): Posted => {
		const fate = Promise.withResolvers<LetterFate>();
		const busy = sessions.find((session) => session.id === to)?.running === true;
		return { from, to, input, settle: (result) => fate.resolve(result), receipt: { id: `letter-${++letters}`, queued: busy, read: fate.promise } };
	};
	let served: SessionsApi | undefined;
	const ctx = {
		name: "plume.sessions",
		log: { info() {}, warn() {}, error() {} },
		tools: { register: (tool: ToolDefinition) => void tools.set(tool.name, tool) },
		hook: (name: string, layer: unknown) => void layers.set(name, layer),
		sessions: {
			list: async () => structuredClone(sessions),
			get: async (id: string) => structuredClone(sessions.find((session) => session.id === id)),
			messages: async (id: string) => structuredClone(messages.get(id) ?? []),
			observe: (listener: (observation: SessionObservation) => void) => void observers.push(listener),
			onDeleted() {},
		},
		serve: (api: SessionsApi) => void (served = api),
	} as unknown as PluginContext;
	void plugin.apply(ctx);
	/** 调一件工具；顶层会话的调用拿得到寄信的口子，和本体一样。 */
	const call = (name: string, sessionId: string, args: Record<string, unknown>) => {
		const self = sessions.find((session) => session.id === sessionId);
		const top = !self?.parentId;
		const letter = (to: string, input: LetterInput) => {
			if (refuse.reason) throw new Error(refuse.reason);
			const entry = post(sessionId, to, input);
			posted.push(entry);
			return entry.receipt;
		};
		return (tools.get(name) as ToolDefinition).execute(args, { sessionId, session: scope(self, sessionId), ...(top ? { letter } : {}) } as unknown as ToolRun);
	};
	const context = (sessionId: string) =>
		(layers.get("model.context") as HookLayer<"model.context">)(
			{
				sessionId,
				session: scope(
					sessions.find((session) => session.id === sessionId),
					sessionId,
				),
				sections: [{ id: "identity", text: "Plume" }],
				tools: ["read", "list_sessions", "read_session", "send_message"].map((name) => ({ name })),
			} as unknown as ModelContext,
			async (input) => input,
		);
	const approval = (sessionId: string, waiting: boolean) => {
		const event = { type: "approval", sessionId, approval: waiting ? { toolCallId: "t" } : undefined } as unknown as SessionObservation["event"];
		for (const listener of observers) listener({ sessionId, at: 0, timestamp: 0, event });
	};
	return { plan, exec, near, far, side, grand, posted, refuse, call, context, approval, api: () => served! };
}

/** 等读到这些 `then` 跑完。 */
const settled = () => new Promise((resolve) => setTimeout(resolve, 10));

test("地址是「名字 [ref]」，ref 说了算；重名不猜；同一个项目、目录套着、开出来的彼此看得见", () => {
	const f = fixture();
	assert.equal(sessionAddress({ id: f.plan.id, title: " 定 [计划]\n", cwd: "/w" }), "定 计划 [aaaaaa]");
	assert.equal(sessionAddress({ id: f.plan.id, title: "", cwd: "/w/app" }), "app [aaaaaa]");
	const all = [f.plan, f.near, { ...f.far, title: "旁边" }];
	assert.equal(resolveSession("改了名的 [aaaaaa]", all).kind, "found");
	assert.equal(resolveSession("aaaaaa", all).kind, "found");
	assert.equal(resolveSession("旁边", all).kind, "ambiguous");
	assert.equal(resolveSession("没有", all).kind, "none");
	// 名册里写的完整 id、开出它的一方起的短名也认。
	assert.equal(resolveSession(f.near.id, all).kind, "found");
	assert.equal(resolveSession("exec", [f.plan, f.exec]).kind, "found");
	assert.equal(together(f.plan, f.near), true);
	assert.equal(together(f.plan, f.exec), true);
	assert.equal(together(f.near, f.far), false);
	assert.equal(together({ ...f.far, project: "p1" }, f.plan), true);
	// 会话目录是 git 工作树时，主工作树也算它的目录。
	const tree = { ...f.far, cwd: "/data/worktrees/app-1" };
	assert.equal(together(tree, f.near), false);
	assert.equal(together(tree, f.near, new Map([[tree.cwd, ["/w/app"]]])), true);
	assert.equal(together(f.near, tree, new Map([[tree.cwd, ["/w/app"]]])), true);
});

test("read_session 读得到看得见的会话；看不见的、自己、子会话里调都退回", async () => {
	const f = fixture();
	const read = await f.call("read_session", f.exec.id, { to: "定计划 [aaaaaa]" });
	assert.equal(read.isError, undefined);
	const page = JSON.parse(read.output) as { sessionId: string; totalMessages: number; messages: { text: string }[] };
	assert.equal(page.sessionId, f.plan.id);
	assert.equal(page.totalMessages, 2);
	assert.match(page.messages[1]!.text, /选 SQLite/);
	assert.match((await f.call("read_session", f.near.id, { to: "别处" })).output, /^别处 \[dddddd\] is not reachable/);
	assert.equal((await f.call("read_session", f.plan.id, { to: "定计划" })).output, "That address is this conversation.");
	assert.match((await f.call("read_session", f.plan.id, { to: "侧边" })).output, /^No conversation is addressed "侧边"/);
	assert.match((await f.call("read_session", f.side.id, { to: "旁边" })).output, /only work in a main conversation/);
	assert.equal((await f.call("read_session", f.plan.id, { to: "旁边", start: -1 })).isError, true);

	const list = await f.call("list_sessions", f.plan.id, {});
	assert.deepEqual(list.output.split("\n"), [
		`执行 [bbbbbb] · ${f.exec.id} · name: exec · idle · /elsewhere`,
		`旁边 [cccccc] · ${f.near.id} · working · /w/app/src`,
	]);
	// 只列一家子的：开出来的、开出来的又开出来的（不在一处也列），不列旁边的。
	assert.deepEqual(
		(await f.call("list_sessions", f.plan.id, { linked: true })).output.split("\n").map((row) => row.split(" · ")[0]),
		["执行 [bbbbbb]", "孙辈 [ffffff]"],
	);
	assert.equal((await f.call("list_sessions", f.near.id, { linked: true })).output, "No session is linked to this one.");
	// 弹着审批卡的说在等它的人，卡收了回到忙或闲。
	f.approval(f.near.id, true);
	assert.match((await f.call("list_sessions", f.plan.id, {})).output, /^旁边 \[cccccc\] · \S+ · waiting for its user · /m);
	f.approval(f.near.id, false);
	assert.match((await f.call("list_sessions", f.plan.id, {})).output, /^旁边 \[cccccc\] · \S+ · working · /m);
	// 子会话的工具表里没有这几件。
	assert.deepEqual(
		(await f.context(f.side.id)).tools.map((tool) => tool.name),
		["read"],
	);
	assert.equal((await f.context(f.plan.id)).tools.length, 4);
});

test("从别的会话开出来的：系统提示词多一段点名来源；一家子都有名册，写着谁开了谁；来源归档了、不在一家的都不加", async () => {
	const f = fixture();
	const sections = async (sessionId: string) => (await f.context(sessionId)).sections;
	const [identity, origin, roster] = await sections(f.exec.id);
	assert.equal(identity?.id, "identity");
	assert.equal(origin?.id, "plume.sessions.origin");
	assert.match(origin?.text ?? "", new RegExp(`^This conversation was started from another one, \`${f.plan.id}\``));
	assert.equal(roster?.id, "plume.sessions.linked");
	assert.match(roster?.text ?? "", new RegExp(`- 定计划 \\[aaaaaa\\] = \`${f.plan.id}\` \\(started this session\\)`));
	assert.match(roster?.text ?? "", new RegExp(`- 孙辈 \\[ffffff\\] = \`${f.grand.id}\` \\(started by this session\\)`));
	// 名册里称呼开出来的会话用它的短名，不列自己。
	const top = (await sections(f.plan.id)).find((section) => section.id === "plume.sessions.linked")?.text ?? "";
	assert.match(top, new RegExp(`- exec = \`${f.exec.id}\` \\(started by this session\\)`));
	assert.doesNotMatch(top, /定计划/);
	// 照着名册写的 `to` 认得出来。
	assert.equal((await f.call("read_session", f.exec.id, { to: f.plan.id })).isError, undefined);
	assert.equal((await sections(f.near.id)).length, 1);
	f.plan.archived = true;
	assert.deepEqual(
		(await sections(f.exec.id)).map((section) => section.id),
		["identity", "plume.sessions.linked"],
	);
});

test("send_message 寄一封单向的信：带发件方的地址和处理说明，当场返回回执；空的、太长的、刚发过一模一样的不发", async () => {
	const f = fixture();
	const sent = await f.call("send_message", f.exec.id, { to: "定计划 [aaaaaa]", message: "为什么选 SQLite？" });
	assert.match(sent.output, /^Sent to 定计划 \[aaaaaa\]\. It is idle, so it starts a turn to read it\./);
	assert.deepEqual(sent.details, { kind: "session_message", to: "定计划 [aaaaaa]", sessionId: f.plan.id, letterId: "letter-1", queued: false });
	assert.equal(f.posted.length, 1);
	const letter = f.posted[0]!;
	assert.equal(letter.to, f.plan.id);
	assert.deepEqual({ ...letter.input, guide: undefined }, { from: "执行 [bbbbbb]", text: "为什么选 SQLite？", guide: undefined });
	assert.match(letter.input.guide!, /send_message/);
	assert.match((await f.call("send_message", f.plan.id, { to: "旁边", message: "x" })).output, /It is busy, so it reads it after its current step/);

	assert.equal((await f.call("send_message", f.exec.id, { to: "aaaaaa", message: " " })).output, "`message` is required.");
	assert.match((await f.call("send_message", f.exec.id, { to: "aaaaaa", message: "长".repeat(20_001) })).output, /limit is 20000/);
	assert.equal(
		(await f.call("send_message", f.exec.id, { to: "aaaaaa", message: "为什么选 SQLite？" })).output,
		`You sent the same message to 定计划 [aaaaaa] less than ${PEER_DEDUP_MS / 1000} seconds ago; it was not sent again.`,
	);
	assert.match((await f.call("send_message", f.side.id, { to: "aaaaaa", message: "x" })).output, /only work in a main conversation/);
	assert.equal(f.posted.length, 2);
});

test("send_message 的下落记在内存里给界面：读到了、拦下了；本体拒寄时把它的话原样交给模型，不算发过", async () => {
	const f = fixture();
	await f.call("send_message", f.exec.id, { to: "aaaaaa", message: "一" });
	await f.call("send_message", f.exec.id, { to: "aaaaaa", message: "二" });
	f.posted[0]!.settle({ status: "read" });
	f.posted[1]!.settle({ status: "dropped" });
	await settled();
	assert.deepEqual(await f.api().fates(["letter-1", "letter-2", "letter-9"]), { "letter-1": "read", "letter-2": "dropped" });

	f.refuse.reason = "对方刚好不在了。";
	assert.deepEqual(await f.call("send_message", f.exec.id, { to: "aaaaaa", message: "再问一次" }), { output: "对方刚好不在了。", isError: true });
	// 没寄出去的不记作发过：同一句之后照样寄得出去，不算重复。
	delete f.refuse.reason;
	assert.equal((await f.call("send_message", f.exec.id, { to: "aaaaaa", message: "再问一次" })).isError, undefined);
	assert.equal(f.posted.length, 3);
	assert.deepEqual(
		familyOf(f.near, [f.plan, f.exec, f.near]).map((one) => one.id),
		[],
	);
});

test("正在做的那一项认最新一份成功的进度清单（details.checklist），不认是哪个工具记的", () => {
	const result = (details: unknown, isError = false): Message =>
		({ role: "toolResult", toolCallId: "c", toolName: "plan_steps", content: [], details, isError, timestamp: 0 }) as Message;
	const items = (doing: string) => ({
		checklist: [
			{ content: "读代码", status: "completed" },
			{ content: doing, status: "in_progress" },
		],
	});
	assert.equal(currentStep([result(items("改路由")), result(items("写测试"))]), "写测试");
	assert.equal(currentStep([result(items("改路由")), result(items("坏的"), true), result({ other: 1 })]), "改路由");
	assert.equal(currentStep([result(items("改路由")), result({ checklist: [{ content: "读代码", status: "completed" }] })]), undefined);
});
