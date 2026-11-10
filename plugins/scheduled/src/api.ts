/**
 * 逻辑入口经 ctx.serve 开给页面的接口，两个入口共用这一份类型。任务存在逻辑入口那边（见 store.ts），也由那边按时运行
 * （见 scheduler.ts）；页面只是读写它、看它的运行状态。
 */

import type { CallContext } from "@plume/contract";

export interface ScheduledTask {
	id: string;
	name: string;
	/** 任务在哪个目录里跑：建任务时打开着的会话所在项目的目录（不在项目里时是会话的工作目录），没有会话时为空。 */
	cwd: string;
	/** 建任务时那个会话所在的项目：每次运行开的会话归到这个项目下面。 */
	project?: string;
	prompt: string;
	schedule: { kind: "interval"; minutes: number } | { kind: "daily"; time: string };
	enabled: boolean;
	/** 上一次开跑的时刻（不是跑完的时刻），下次什么时候到点按它算。 */
	lastRunAt?: number;
	/** 上一次开出来的会话；没开出来时为空。 */
	lastSessionId?: string;
	/** 上一次为什么没做成：没开出来，或者开出来以后第一轮出错、打转、用满步数。人按了停止不算。 */
	lastError?: string;
}

/** 能改的字段：id 不能改，运行记录（`last*`）只由运行的那一边写。 */
export type TaskPatch = Partial<Pick<ScheduledTask, "name" | "prompt" | "schedule" | "enabled">>;

/** 一次还没人看见的失败，给输入框上方那一行和侧栏的数目用。 */
export interface UnseenFailure {
	taskId: string;
	/** 那句话，已经是界面语言。 */
	message: string;
}

/** 逻辑入口推给界面的全部状态。 */
export interface ScheduledState {
	tasks: ScheduledTask[];
	/** 开跑了、第一轮还没结束的运行：任务 id → 它的会话。 */
	runs: Record<string, string>;
	/** 一个任务最多一条，后来的换掉先前的，最新的在最后。只在内存里：失败本身记在任务的 `lastError` 上。 */
	unseen: UnseenFailure[];
}

/** 改任务的几个方法都返回改完以后的整份列表，页面拿它替换自己手上的那份。 */
export interface ScheduledApi {
	list(): Promise<ScheduledTask[]>;
	add(task: ScheduledTask): Promise<ScheduledTask[]>;
	update(id: string, patch: TaskPatch): Promise<ScheduledTask[]>;
	remove(id: string): Promise<ScheduledTask[]>;
	/** 现在就跑一次，不管到没到点、开没开着；上一次还没跑完时什么都不做。没有这个任务时抛错。 */
	runNow(id: string): Promise<void>;
	/** 人看见了那些失败：页面开着，或者在输入框上方那一行点了「查看」「知道了」。 */
	markSeen(): Promise<void>;
	/** 状态变了就推一份，连上时先推一份。 */
	watch(call: CallContext): AsyncGenerator<ScheduledState, void>;
}
