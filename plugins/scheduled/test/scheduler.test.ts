import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CallContext, Locale, SessionAccess, SessionSummary, TurnStop } from "@plume/contract";
import type { ScheduledState, ScheduledTask } from "../src/api.ts";
import { MESSAGES } from "../src/messages.ts";
import { isDue, nextRunAt } from "../src/schedule.ts";
import { createScheduler } from "../src/scheduler.ts";
import { createTaskStore } from "../src/store.ts";

const MINUTE = 60_000;
const NOW = new Date(2026, 8, 27, 10, 0).getTime();

const TASK: ScheduledTask = {
	id: "nightly",
	name: "夜里审一遍",
	cwd: "/work/app",
	prompt: "看看改了什么。",
	schedule: { kind: "interval", minutes: 60 },
	enabled: true,
};

type Launch = SessionAccess["launch"];

/** 一段由测试亲手结束的第一轮，和真的一样开跑几分钟以后才结束。 */
function pendingTurn() {
	let end!: (stop: TurnStop) => void;
	let fail!: (error: Error) => void;
	const done = new Promise<TurnStop>((resolve, reject) => {
		end = resolve;
		fail = reject;
	});
	return { done, end, fail };
}

/** 一个任务的调度：`launch` 是开会话那一步做什么；语言可以中途换。 */
async function harness(launch: Launch, task: ScheduledTask = TASK) {
	const dir = await mkdtemp(join(tmpdir(), "plume-scheduler-"));
	let locale: Locale = "zh-CN";
	const store = createTaskStore(dir, () => scheduler.changed());
	const scheduler = createScheduler({ store, launch, text: () => MESSAGES[locale] });
	await store.add(task);
	return {
		scheduler,
		store,
		task: async () => (await store.list())[0]!,
		setLocale: (next: Locale) => void (locale = next),
	};
}

/** 一次开会话：编号的会话，第一轮怎么结束由 `turn` 给；`idle` 不给就是第一轮一结束就真闲下来。 */
function sessions(turn: () => Promise<TurnStop>, idle?: () => Promise<void>) {
	const asked: Parameters<Launch>[0][] = [];
	let created = 0;
	const launch: Launch = async (options) => {
		asked.push(options);
		const session = { id: `session-${++created}` } as SessionSummary;
		const done = turn();
		return {
			session,
			done,
			idle: (idle ? idle() : done.then(noop, noop)).then(() => ({ reply: "" })),
			reportBack: () => false,
		};
	};
	return { launch, asked, created: () => created };
}

const noop = () => undefined;
const settled = () => new Promise((resolve) => setTimeout(resolve, 30));

/** 读一份状态：开一次 watch，拿到第一份就断开。 */
async function state(scheduler: ReturnType<typeof createScheduler>): Promise<ScheduledState> {
	const controller = new AbortController();
	const stream = scheduler.watch({ signal: controller.signal } as CallContext);
	const { value } = await stream.next();
	controller.abort();
	await stream.return(undefined);
	return value as ScheduledState;
}

describe("按时运行", () => {
	it("无法启动：原因记在任务上，按当时的界面语言说一句", async () => {
		const refused: Launch = async () => {
			throw new Error("no model is configured");
		};
		for (const [locale, said] of [
			["en", "Scheduled task “夜里审一遍” could not start: no model is configured"],
			["zh-CN", "定时任务「夜里审一遍」无法启动：no model is configured"],
		] as const) {
			const run = await harness(refused);
			run.setLocale(locale);
			await run.scheduler.tick(NOW);
			expect(await run.task()).toMatchObject({ lastRunAt: NOW, lastError: "no model is configured" });
			expect((await run.task()).lastSessionId).toBeUndefined();
			expect(await state(run.scheduler)).toMatchObject({ unseen: [{ taskId: "nightly", message: said }], runs: {} });
		}
	});

	it("开跑以后才失败：失败也写到任务上，语言按失败那一刻的", async () => {
		const turn = pendingTurn();
		const run = await harness(sessions(() => turn.done).launch);
		run.setLocale("en");
		await run.scheduler.tick(NOW);
		expect(await run.task()).toMatchObject({ lastRunAt: NOW, lastSessionId: "session-1" });
		expect((await run.task()).lastError).toBeUndefined();
		expect((await state(run.scheduler)).runs).toEqual({ nightly: "session-1" });

		run.setLocale("zh-CN");
		turn.fail(new Error("rate limited"));
		await settled();
		expect((await run.task()).lastError).toBe("rate limited");
		expect(await state(run.scheduler)).toMatchObject({ unseen: [{ message: "定时任务「夜里审一遍」失败：rate limited" }], runs: {} });
	});

	it("一轮正常结束却没做完：出错、打转、用满步数写到任务上；人按了停止、做完了不算", async () => {
		for (const [stop, said] of [
			[{ reason: "stalled" }, "反复做同一个调用、没有进展，没做完就停下了"],
			[{ reason: "max_turns" }, "到了轮数上限，没做完"],
			[{ reason: "error", error: "HTTP 401" }, "HTTP 401"],
			[{ reason: "error" }, "模型服务出错"],
			[{ reason: "aborted" }, undefined],
			[{ reason: "done" }, undefined],
		] as const) {
			const run = await harness(sessions(async () => stop).launch);
			await run.scheduler.tick(NOW);
			await settled();
			expect((await run.task()).lastError, stop.reason).toBe(said);
			expect((await state(run.scheduler)).unseen.length, stop.reason).toBe(said ? 1 : 0);
		}
	});

	it("第一轮结束了、派出去的活还没回来：仍算在跑，到点不再开一个；真闲下来才收尾", async () => {
		let idle!: () => void;
		const quiet = new Promise<void>((resolve) => (idle = resolve));
		const run = await harness(
			sessions(
				async () => ({ reason: "done" }),
				() => quiet,
			).launch,
		);
		await run.scheduler.tick(NOW);
		await settled();
		expect((await state(run.scheduler)).runs).toEqual({ nightly: "session-1" });
		await run.scheduler.tick(NOW + 61 * MINUTE);
		expect((await run.task()).lastSessionId).toBe("session-1");
		idle();
		await settled();
		expect((await state(run.scheduler)).runs).toEqual({});
		await run.scheduler.tick(NOW + 122 * MINUTE);
		expect((await run.task()).lastSessionId).toBe("session-2");
	});

	it("晚到的失败不覆盖之后那一次运行", async () => {
		const turns = [pendingTurn(), pendingTurn()];
		let next = 0;
		const run = await harness(sessions(() => turns[next++]!.done).launch);
		await run.scheduler.tick(NOW);
		turns[0]!.end({ reason: "done" });
		await settled();
		await run.scheduler.tick(NOW + 61 * MINUTE);
		expect((await run.task()).lastSessionId).toBe("session-2");
		// 第一次运行的会话里人接着聊、那时才出错，也不写到第二次的头上。
		await run.store.record("nightly", { lastError: "旧的失败" }, (task) => task.lastSessionId === "session-1");
		expect((await run.task()).lastError).toBeUndefined();
	});

	it("开跑时那次记录还没写完就失败了，失败也不丢", async () => {
		const run = await harness(sessions(() => Promise.reject(new Error("the model is unavailable"))).launch);
		await run.scheduler.tick(NOW);
		await settled();
		expect(await run.task()).toMatchObject({ lastSessionId: "session-1", lastError: "the model is unavailable" });
	});

	it("上一次还没收尾，到期也不再开一个；收尾之后只补跑一次", async () => {
		const turn = pendingTurn();
		const opened = sessions(() => turn.done);
		const run = await harness(opened.launch, { ...TASK, schedule: { kind: "interval", minutes: 1 } });
		await run.scheduler.tick(NOW);
		await run.scheduler.tick(NOW + 2 * MINUTE);
		await run.scheduler.tick(NOW + 3 * MINUTE);
		expect(opened.created()).toBe(1);

		turn.end({ reason: "done" });
		await settled();
		await run.scheduler.tick(NOW + 5 * MINUTE);
		await run.scheduler.tick(NOW + 5 * MINUTE + 1);
		expect(opened.created()).toBe(2);
	});

	it("停用的、没到点的不跑；运行开在任务的项目里，没有项目时开在它的目录", async () => {
		const opened = sessions(async () => ({ reason: "done" }));
		const off = await harness(opened.launch, { ...TASK, enabled: false });
		await off.scheduler.tick(NOW);
		const early = await harness(opened.launch, { ...TASK, schedule: { kind: "daily", time: "23:00" } });
		await early.scheduler.tick(NOW);
		expect(opened.created()).toBe(0);

		await (await harness(opened.launch, { ...TASK, project: "proj-b" })).scheduler.tick(NOW);
		await (await harness(opened.launch)).scheduler.tick(NOW);
		await (await harness(opened.launch, { ...TASK, cwd: "" })).scheduler.tick(NOW);
		expect(opened.asked).toEqual([{ project: "proj-b", message: TASK.prompt }, { cwd: "/work/app", message: TASK.prompt }, { message: TASK.prompt }]);
	});

	it("立即运行：不看开关和到没到点，还在跑时不再开一个", async () => {
		const turn = pendingTurn();
		const opened = sessions(() => turn.done);
		const run = await harness(opened.launch, { ...TASK, enabled: false, lastRunAt: Date.now() });
		await run.scheduler.runNow("nightly");
		await run.scheduler.runNow("nightly");
		expect(opened.created()).toBe(1);
		expect((await run.task()).lastSessionId).toBe("session-1");
		await expect(run.scheduler.runNow("gone")).rejects.toThrow();
		turn.end({ reason: "done" });
	});

	it("看过了就清掉没人看见的失败；同一个任务只留最新的一条", async () => {
		let n = 0;
		const run = await harness(async () => {
			throw new Error(`第 ${++n} 次`);
		});
		await run.scheduler.runNow("nightly");
		await run.scheduler.runNow("nightly");
		expect((await state(run.scheduler)).unseen).toEqual([{ taskId: "nightly", message: "定时任务「夜里审一遍」无法启动：第 2 次" }]);
		await run.scheduler.markSeen();
		expect((await state(run.scheduler)).unseen).toEqual([]);
	});
});

describe("到点", () => {
	const at = (hour: number, minute = 0) => new Date(2026, 2, 10, hour, minute, 0, 0).getTime();
	const daily = (patch: Partial<ScheduledTask> = {}): ScheduledTask => ({ ...TASK, schedule: { kind: "daily", time: "09:00" }, ...patch });

	it("每天的任务：点到了才到，应用整个上午都关着也照样到；今天跑过就不再到，明天再到", () => {
		expect(isDue(daily(), at(8, 59))).toBe(false);
		expect(isDue(daily(), at(9))).toBe(true);
		expect(isDue(daily(), at(23))).toBe(true);
		const ran = daily({ lastRunAt: at(9, 1) });
		expect(isDue(ran, at(18))).toBe(false);
		expect(isDue(ran, at(9) + 24 * 3600_000)).toBe(true);
	});

	it("间隔的任务：从没跑过就到，满一个周期再到", () => {
		const every = { ...TASK, schedule: { kind: "interval" as const, minutes: 30 } };
		expect(isDue(every, at(9))).toBe(true);
		expect(isDue({ ...every, lastRunAt: at(9) }, at(9, 29))).toBe(false);
		expect(isDue({ ...every, lastRunAt: at(9) }, at(9, 30))).toBe(true);
	});

	it("两边说的一样：到点的那一刻不早于「下次运行」写的时刻", () => {
		const task = daily({ lastRunAt: at(9, 1) - 24 * 3600_000 });
		const predicted = nextRunAt(task, at(0))!;
		for (let t = at(0); t < at(23, 50); t += 10 * MINUTE) {
			if (isDue(task, t)) {
				expect(t).toBeGreaterThanOrEqual(predicted);
				return;
			}
		}
		throw new Error("一整天都没到点");
	});
});
