/**
 * 按时运行定时任务：到点的任务开一个新会话（`ctx.sessions.launch`），把提示词作为第一句话发出去。
 *
 * 每次都开新会话而不是接着上一次的：一个定时任务要是一直往同一段对话里加，越跑历史越长，做的事跟着走样，
 * 迟早撑破上下文窗口。一分钟看一次，这是两种时间写法里最细的一档。
 *
 * 还记着两样给界面看的东西，只在内存里：哪些任务开跑了、还没真闲下来（`runs`），哪些失败还没人看见（`unseen`）。
 */

import type { CallContext, SessionAccess, TurnStop } from "@plume/contract";
import type { ScheduledState, ScheduledTask, UnseenFailure } from "./api.ts";
import type { MESSAGES } from "./messages.ts";
import { isDue } from "./schedule.ts";
import type { TaskStore } from "./store.ts";

export const TICK_MS = 60_000;
/** 应用刚启动时先看一次：上次关着应用时错过的任务不用再等一分钟。 */
export const FIRST_TICK_MS = 5_000;

type Text = (typeof MESSAGES)["zh-CN"];

export interface SchedulerDeps {
	store: TaskStore;
	launch: SessionAccess["launch"];
	/** 现在的界面语言的文字：失败可能在开跑几分钟以后才来，到时语言可能已经换了，每次现取。 */
	text(): Text;
}

export interface Scheduler {
	tick(now?: number): Promise<void>;
	runNow(id: string): Promise<void>;
	markSeen(): Promise<void>;
	watch(call: CallContext): AsyncGenerator<ScheduledState, void>;
	/** 任务列表写完了：看着的界面要一份新的。 */
	changed(): void;
}

export function createScheduler({ store, launch, text }: SchedulerDeps): Scheduler {
	/**
	 * 这一次运行还没收尾的任务：到点了也跳过，不在同一个目录上再开一个会话。收尾 = 新会话第一次真闲下来（`idle`）：
	 * 第一轮结束只是它派出去的子 Agent、后台命令开始干活，结果回来唤起的几轮也做完才算这一次跑完。挂着的不等（本体的规则，
	 * 见 `ParentStatus`）：它起的监视、认出来的开发服务器、约好的唤醒没有做完的那一刻，等它们的话这个任务再也不会到点运行；
	 * 它们留在那个会话里接着跑，下一次到点照样开新会话，和人自己的会话里开着一个服务一样。
	 * 失败与否只看第一轮怎么结束（`done`）：后面那几轮是它自己接着做的，出了错在那个会话里看得到。
	 * `lastRunAt` 记的是开跑的时刻，忙着的时候到点几次，收尾之后的下一次检查都只补跑一次。
	 */
	const running = new Set<string>();
	let runs: Record<string, string> = {};
	let unseen: UnseenFailure[] = [];
	const listeners = new Set<() => void>();
	const changed = () => {
		for (const listener of listeners) listener();
	};

	const fail = (taskId: string, message: string) => {
		unseen = [...unseen.filter((failure) => failure.taskId !== taskId), { taskId, message }];
		changed();
	};

	async function run(task: ScheduledTask, now: number): Promise<void> {
		running.add(task.id);
		let sessionId: string | undefined;
		let error: string | undefined;
		/** 这次开跑的记录正在写：后来的失败排在它后面写，不被它盖掉。 */
		let recorded: Promise<unknown> = Promise.resolve();
		/** 这次运行收尾，见 `running`；没开出会话就没有。 */
		let settled: Promise<void> | null = null;

		try {
			const { session, done, idle } = await launch({
				...(task.project ? { project: task.project } : task.cwd ? { cwd: task.cwd } : {}),
				message: task.prompt,
			});
			const id = session.id;
			sessionId = id;
			runs = { ...runs, [task.id]: id };
			changed();
			const failed = async (reason: string) => {
				fail(task.id, text().failed(task.name, reason));
				// 写失败了的那一次已经由它自己报过了。
				await recorded.catch(() => undefined);
				await recordFailure(task.id, id, reason);
			};
			// 不等它：一轮可能跑好几分钟，不能挡着别的任务到点。
			settled = done
				.then(
					async (stop) => {
						const reason = unfinished(stop, text());
						if (reason) await failed(reason);
					},
					(cause: unknown) => failed(errorText(cause)),
				)
				.then(async () => void (await idle));
		} catch (cause) {
			error = errorText(cause);
			fail(task.id, text().couldNotStart(task.name, error));
		} finally {
			if (settled) {
				const id = sessionId;
				void settled
					.catch(() => undefined)
					.finally(() => {
						running.delete(task.id);
						if (runs[task.id] === id) {
							const { [task.id]: _ended, ...rest } = runs;
							runs = rest;
							changed();
						}
					});
			} else running.delete(task.id);
			// 成没成都记下这次：一个总是失败的任务不该每分钟重试一次。
			recorded = store.record(task.id, { lastRunAt: now, lastSessionId: sessionId, lastError: error });
			await recorded;
		}
	}

	/**
	 * 开跑以后才来的失败也写到任务上，卡片上才看得到：开跑时记的那一次还没有错。只在那一次仍是这个任务最近的一次时写，
	 * 之后又开跑过的话，那一次有它自己的结果。
	 */
	function recordFailure(taskId: string, sessionId: string, reason: string): Promise<unknown> {
		return store.record(taskId, { lastError: reason }, (task) => task.lastSessionId === sessionId);
	}

	return {
		async tick(now = Date.now()) {
			for (const task of await store.list()) {
				if (!task.enabled || running.has(task.id) || !isDue(task, now)) continue;
				await run(task, now);
			}
		},
		async runNow(id) {
			const task = (await store.list()).find((each) => each.id === id);
			// i18n-exempt：页面只列着有的任务，到这里是页面和文件对不上了，原因进开发者工具。
			if (!task) throw new Error(`没有定时任务 ${id}`);
			if (!running.has(id)) await run(task, Date.now());
		},
		async markSeen() {
			if (unseen.length === 0) return;
			unseen = [];
			changed();
		},
		async *watch(call) {
			let dirty = true;
			let wake: (() => void) | undefined;
			const listener = () => {
				dirty = true;
				wake?.();
			};
			listeners.add(listener);
			call.signal.addEventListener("abort", listener, { once: true });
			try {
				while (!call.signal.aborted) {
					if (!dirty) await new Promise<void>((resolve) => (wake = resolve));
					wake = undefined;
					if (call.signal.aborted) break;
					dirty = false;
					yield { tasks: await store.list(), runs, unseen };
				}
			} finally {
				listeners.delete(listener);
				call.signal.removeEventListener("abort", listener);
			}
		},
		changed,
	};
}

/**
 * 第一轮正常结束、却没做完时该说的原因；做完了、被人停下的没有。服务商出错、原地打转、用满步数都是「正常结束」，
 * 不单独说的话卡片上什么问题都没有。人按了停止不算失败：那是人自己按的。
 */
function unfinished(stop: TurnStop, text: Text): string | null {
	if (stop.reason === "error") return stop.error || text.modelError;
	if (stop.reason === "stalled") return text.stalled;
	if (stop.reason === "max_turns") return text.maxTurns;
	return null;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
