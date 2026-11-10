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
	SessionSummary,
	ToolDefinition,
	ToolRun,
	TurnStop,
} from "@plume/contract";
import plugin from "../src/index.ts";
import { PEER_DEDUP_MS } from "../src/pacing.ts";
import { resolveSession, sessionAddress, together } from "../src/peers.ts";
import { REPLY_LIMIT } from "../src/router.ts";

const summary = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
	({ id, title: id, cwd: "/w/app", running: false, createdAt: 0, updatedAt: 0, ...extra }) as SessionSummary;

const said = (role: "user" | "assistant", text: string): Message =>
	(role === "user"
		? { role, content: [{ type: "text", text }], timestamp: 1 }
		: { role, content: [{ type: "text", text }], api: "x", provider: "x", model: "x", usage: {}, stopReason: "stop", timestamp: 1 }) as unknown as Message;

/** 寄出的一封：谁寄给谁、写了什么；`settle` 定它的下落，`answers` 是经它代答的那几封。 */
interface Posted {
	from: string;
	to: string;
	input: LetterInput;
	receipt: LetterReceipt;
	settle(fate: LetterFate): void;
	answers: Posted[];
}

/** 几个会话：`plan` 在项目 p1；`exec` 是从它开出来的、开在别处；`near` 在同一个目录；`far` 在别处；`side` 是 `plan` 的子会话。 */
function fixture() {
	const sessions: SessionSummary[] = [
		summary("aaaaaa11-0000-4000-8000-000000000000", { title: "定计划", cwd: "/w/app", project: "p1" }),
		summary("bbbbbb22-0000-4000-8000-000000000000", { title: "执行", cwd: "/elsewhere", spawnedFrom: { sessionId: "aaaaaa11-0000-4000-8000-000000000000" } }),
		summary("cccccc33-0000-4000-8000-000000000000", { title: "旁边", cwd: "/w/app/src", running: true }),
		summary("dddddd44-0000-4000-8000-000000000000", { title: "别处", cwd: "/other" }),
		summary("eeeeee55-0000-4000-8000-000000000000", {
			title: "侧边",
			cwd: "/w/app",
			parentId: "aaaaaa11-0000-4000-8000-000000000000",
			owner: "plume.side-chat",
		}),
	];
	const [plan, exec, near, far, side] = sessions as [SessionSummary, SessionSummary, SessionSummary, SessionSummary, SessionSummary];
	const messages = new Map<string, Message[]>([[plan.id, [said("user", "做个计划"), said("assistant", "选 SQLite，因为单机。")]]]);
	const tools = new Map<string, ToolDefinition>();
	const layers = new Map<string, unknown>();
	const observers: Array<(observation: SessionObservation) => void> = [];
	const deleted: Array<(sessionId: string) => void> = [];
	const posted: Posted[] = [];
	let letters = 0;
	const post = (from: string, to: string, input: LetterInput): Posted => {
		const fate = Promise.withResolvers<LetterFate>();
		const entry: Posted = {
			from,
			to,
			input,
			settle: fate.resolve,
			answers: [],
			receipt: {
				id: `letter-${++letters}`,
				read: fate.promise,
				answer: (letter) => {
					const answer = post(to, from, letter);
					entry.answers.push(answer);
					return answer.receipt;
				},
			},
		};
		return entry;
	};
	const ctx = {
		name: "plume.sessions",
		log: { info() {}, warn() {}, error() {} },
		tools: { register: (tool: ToolDefinition) => void tools.set(tool.name, tool) },
		hook: (name: string, layer: unknown) => void layers.set(name, layer),
		sessions: {
			list: async () => structuredClone(sessions),
			messages: async (id: string) => structuredClone(messages.get(id) ?? []),
			observe: (listener: (observation: SessionObservation) => void) => void observers.push(listener),
			onDeleted: (listener: (sessionId: string) => void) => void deleted.push(listener),
		},
	} as unknown as PluginContext;
	void plugin.apply(ctx);
	/** 调一件工具；顶层会话的调用拿得到寄信的口子，和本体一样。 */
	const call = (name: string, sessionId: string, args: Record<string, unknown>) => {
		const top = !sessions.find((session) => session.id === sessionId)?.parentId;
		const letter = (to: string, input: LetterInput) => {
			const entry = post(sessionId, to, input);
			posted.push(entry);
			return entry.receipt;
		};
		return (tools.get(name) as ToolDefinition).execute(args, { sessionId, ...(top ? { letter } : {}) } as unknown as ToolRun);
	};
	const context = (sessionId: string) =>
		(layers.get("model.context") as HookLayer<"model.context">)(
			{
				sessionId,
				sections: [{ id: "identity", text: "Plume" }],
				tools: ["read", "list_sessions", "read_session", "ask_session", "reply_session", "notify_session"].map((name) => ({ name })),
			} as unknown as ModelContext,
			async (input) => input,
		);
	const approval = (sessionId: string, waiting: boolean) => {
		const event = { type: "approval", sessionId, approval: waiting ? { toolCallId: "t" } : undefined } as unknown as SessionObservation["event"];
		for (const listener of observers) listener({ sessionId, at: 0, timestamp: 0, event });
	};
	const turnEnd = (sessionId: string, stop: TurnStop = { reason: "done" }) => {
		for (const listener of observers) listener({ sessionId, at: 0, timestamp: 0, event: { type: "turnEnd", stop } });
	};
	const speak = (sessionId: string, synthetic = false) =>
		(layers.get("prompt.submit") as HookLayer<"prompt.submit">)({ sessionId, synthetic } as never, async () => ({ block: false }));
	const remove = (sessionId: string) => {
		for (const listener of deleted) listener(sessionId);
	};
	return { plan, exec, near, far, side, messages, posted, call, context, approval, turnEnd, speak, remove };
}

/** 等读到、代答这些 `then` 跑完。 */
const settled = () => new Promise((resolve) => setTimeout(resolve, 10));

/** 收件方对话里那条带着这封信的消息。 */
const letterMessage = (id: string): Message =>
	({ role: "user", content: [{ type: "text", text: "…" }], timestamp: 1, synthetic: true, peer: [{ id, sessionId: "x", from: "x", text: "x" }] }) as Message;

test("地址是「名字 [ref]」，ref 说了算；重名不猜；同一个项目、目录套着、开出来的彼此看得见", () => {
	const f = fixture();
	assert.equal(sessionAddress({ id: f.plan.id, title: " 定 [计划]\n", cwd: "/w" }), "定 计划 [aaaaaa]");
	assert.equal(sessionAddress({ id: f.plan.id, title: "", cwd: "/w/app" }), "app [aaaaaa]");
	const all = [f.plan, f.near, { ...f.far, title: "旁边" }];
	assert.equal(resolveSession("改了名的 [aaaaaa]", all).kind, "found");
	assert.equal(resolveSession("aaaaaa", all).kind, "found");
	assert.equal(resolveSession("旁边", all).kind, "ambiguous");
	assert.equal(resolveSession("没有", all).kind, "none");
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
	assert.deepEqual(list.output.split("\n"), ["执行 [bbbbbb] · idle · /elsewhere", "旁边 [cccccc] · busy · /w/app/src"]);
	// 弹着审批卡的说在等它的人，卡收了回到忙或闲。
	f.approval(f.near.id, true);
	assert.match((await f.call("list_sessions", f.plan.id, {})).output, /^旁边 \[cccccc\] · waiting for its user · /m);
	f.approval(f.near.id, false);
	assert.match((await f.call("list_sessions", f.plan.id, {})).output, /^旁边 \[cccccc\] · busy · /m);
	// 子会话的工具表里没有这几件。
	assert.deepEqual(
		(await f.context(f.side.id)).tools.map((tool) => tool.name),
		["read"],
	);
	assert.equal((await f.context(f.plan.id)).tools.length, 6);
});

test("ask_session 寄一封请求给对方：带地址、链和怎么回的说明，当场返回；空的、太长的、刚问过一模一样的不发", async () => {
	const f = fixture();
	const asked = await f.call("ask_session", f.exec.id, { to: "定计划 [aaaaaa]", message: "为什么选 SQLite？" });
	assert.match(asked.output, /^Sent to 定计划 \[aaaaaa\]\. It is idle, so it starts a turn to read it\./);
	assert.equal(f.posted.length, 1);
	const letter = f.posted[0]!;
	assert.equal(letter.to, f.plan.id);
	assert.deepEqual(
		{ ...letter.input, guide: undefined },
		{ from: "执行 [bbbbbb]", text: "为什么选 SQLite？", request: true, chain: [f.exec.id], guide: undefined },
	);
	assert.match(letter.input.guide!, /reply_session/);
	assert.match((await f.call("ask_session", f.plan.id, { to: "旁边", message: "x" })).output, /It reads it between its steps/);

	assert.equal((await f.call("ask_session", f.exec.id, { to: "aaaaaa", message: " " })).output, "`message` is required.");
	assert.match((await f.call("ask_session", f.exec.id, { to: "aaaaaa", message: "长".repeat(20_001) })).output, /limit is 20000/);
	assert.equal(
		(await f.call("ask_session", f.exec.id, { to: "aaaaaa", message: "为什么选 SQLite？" })).output,
		`You sent the same message to 定计划 [aaaaaa] less than ${PEER_DEDUP_MS / 1000} seconds ago; it was not sent again.`,
	);
	assert.match((await f.call("ask_session", f.side.id, { to: "aaaaaa", message: "x" })).output, /only work in a main conversation/);
	assert.equal(f.posted.length, 2);
});

test("reply_session 一起答掉读到了的问；没有待答的问就当通知寄过去；答过的不再代答", async () => {
	const f = fixture();
	await f.call("ask_session", f.exec.id, { to: "aaaaaa", message: "第一问" });
	await f.call("ask_session", f.exec.id, { to: "aaaaaa", message: "第二问" });
	await f.call("ask_session", f.exec.id, { to: "aaaaaa", message: "还没读到的第三问" });
	f.posted[0]!.settle({ status: "read", opened: true });
	f.posted[1]!.settle({ status: "read", opened: true });
	await settled();
	const reply = await f.call("reply_session", f.plan.id, { to: "执行 [bbbbbb]", message: "因为单机。" });
	assert.equal(reply.output, "执行 [bbbbbb] gets your answer as a message.");
	const answer = f.posted[3]!;
	assert.equal(answer.to, f.exec.id);
	assert.deepEqual(
		{ ...answer.input, guide: undefined },
		// 这一轮是 exec 的信叫起来的：plan 寄出的信接着那条链。
		{ from: "定计划 [aaaaaa]", text: "因为单机。", answer: "replied", re: ["第一问", "第二问"], chain: [f.exec.id, f.plan.id], guide: undefined },
	);
	assert.match(answer.input.guide!, /answer="unreplied"/);
	f.turnEnd(f.plan.id);
	await settled();
	assert.deepEqual(
		f.posted.flatMap((one) => one.answers),
		[],
	);

	const later = await f.call("reply_session", f.plan.id, { to: "执行", message: "做完了，结果在 out.md。" });
	assert.equal(later.output, "执行 [bbbbbb] had no open question to you, so it reads this as a notice.");
	assert.equal(f.posted[4]!.input.answer, undefined);
	assert.deepEqual(f.posted[4]!.input.chain, [f.plan.id]);
});

test("读到请求的那一轮收场了还没回：拿那一轮最后说的话代答，太长的截掉；没跑完的说明怎么收的场", async () => {
	const f = fixture();
	await f.call("ask_session", f.exec.id, { to: "aaaaaa", message: "选了什么？" });
	const ask = f.posted[0]!;
	ask.settle({ status: "read", opened: false });
	await settled();
	f.messages.set(f.plan.id, [said("assistant", "更早的话"), letterMessage(ask.receipt.id), said("assistant", "长".repeat(REPLY_LIMIT + 5))]);
	f.turnEnd(f.plan.id);
	await settled();
	const [answer] = ask.answers;
	assert.equal(answer!.to, f.exec.id);
	assert.equal(answer!.input.answer, "unreplied");
	assert.deepEqual(answer!.input.re, ["选了什么？"]);
	assert.deepEqual(answer!.input.chain, [f.exec.id, f.plan.id]);
	assert.match(answer!.input.text, /^长{4000}\n\[cut after 4000 characters; 5 more not shown/);

	await f.call("ask_session", f.near.id, { to: "aaaaaa", message: "另一问" });
	const second = f.posted[1]!;
	second.settle({ status: "read", opened: true });
	await settled();
	f.messages.set(f.plan.id, [said("assistant", "上一轮的话"), letterMessage(second.receipt.id)]);
	f.turnEnd(f.plan.id, { reason: "error", error: "坏了" });
	await settled();
	assert.equal(second.answers[0]!.input.text, "[The turn that read your message ended early (error).]\n(It said nothing.)");
});

test("没读到就被对方的人停下：代它说 dropped；问的一方删掉了就不再等", async () => {
	const f = fixture();
	await f.call("ask_session", f.exec.id, { to: "aaaaaa", message: "一" });
	await f.call("ask_session", f.near.id, { to: "aaaaaa", message: "二" });
	assert.equal((await f.call("ask_session", f.near.id, { to: "执行", message: "看不见的" })).isError, true);
	f.posted[0]!.settle({ status: "dropped" });
	f.posted[1]!.settle({ status: "read", opened: true });
	await settled();
	assert.equal(f.posted[0]!.answers[0]!.input.answer, "dropped");
	assert.match(f.posted[0]!.answers[0]!.input.text, /stopped it before it read your message/);
	// 「二」是 near 问的，near 删掉了：plan 这一轮收场、plan 删掉都不再替它代答。
	f.remove(f.near.id);
	f.turnEnd(f.plan.id);
	await settled();
	f.remove(f.plan.id);
	await settled();
	assert.deepEqual(f.posted[1]!.answers, []);
});

test("对方删掉了：读到还没答的替它说 closed", async () => {
	const f = fixture();
	await f.call("ask_session", f.exec.id, { to: "aaaaaa", message: "一" });
	f.posted[0]!.settle({ status: "read", opened: true });
	await settled();
	f.remove(f.plan.id);
	await settled();
	assert.equal(f.posted[0]!.answers[0]!.input.answer, "closed");
	assert.equal(f.posted[0]!.answers[0]!.input.text, "That session was closed before it answered.");
	// 本体告诉 closed 的（还没读到就删掉了）也一样。
	await f.call("ask_session", f.near.id, { to: "aaaaaa", message: "二" });
	f.posted[1]!.settle({ status: "closed" });
	await settled();
	assert.equal(f.posted[1]!.answers[0]!.input.answer, "closed");
});

test("notify_session 寄一句通知；往来链只接叫起这一轮的信，人开口、这一轮收场就从头算", async () => {
	const f = fixture();
	const notice = await f.call("notify_session", f.exec.id, { to: "aaaaaa", message: "dev server 停了，归你了。" });
	assert.match(notice.output, /^Delivered to 定计划 \[aaaaaa\]\. .*There is no answer to a notice\.$/);
	assert.equal(f.posted[0]!.input.request, undefined);
	assert.match(f.posted[0]!.input.guide!, /通知/);
	f.posted[0]!.settle({ status: "read", opened: true });
	await settled();
	await f.call("notify_session", f.plan.id, { to: "旁边", message: "接着" });
	assert.deepEqual(f.posted[1]!.input.chain, [f.exec.id, f.plan.id]);
	await f.speak(f.plan.id, true);
	await f.call("notify_session", f.plan.id, { to: "旁边", message: "合成的不算人开口" });
	assert.deepEqual(f.posted[2]!.input.chain, [f.exec.id, f.plan.id]);
	await f.speak(f.plan.id);
	await f.call("notify_session", f.plan.id, { to: "旁边", message: "人开口以后" });
	assert.deepEqual(f.posted[3]!.input.chain, [f.plan.id]);

	f.posted[1]!.settle({ status: "read", opened: true });
	await settled();
	f.turnEnd(f.near.id);
	await f.call("notify_session", f.near.id, { to: "aaaaaa", message: "收场以后" });
	assert.deepEqual(f.posted[4]!.input.chain, [f.near.id]);
});
