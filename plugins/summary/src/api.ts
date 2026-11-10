import type { CallContext } from "@plume/contract";
import type { SessionSummaryText } from "./summary.ts";

/** 存着的那份：`upto` 见 `SessionSummaryText`，`updatedAt` 是生成的时刻。 */
export interface StoredSummary extends SessionSummaryText {
	updatedAt: number;
}

/** 一个会话的摘要现在什么样：存着的那份、后台是不是正在生成、上一次失败的原因。 */
export interface SummaryState {
	summary: StoredSummary | null;
	pending: boolean;
	error?: string;
}

/** 逻辑入口经 `ctx.serve` 开给界面入口的接口。 */
export interface SummaryApi {
	/** 先给一次现在的样子，之后每次变了（开始生成、生成完、失败、会话删了）再给一次，直到界面取消。 */
	watch(sessionId: string, call: CallContext): AsyncGenerator<SummaryState, void>;
	/** 人点「重试」：现在就生成一次，和后台到点的那次是同一份。 */
	summarize(sessionId: string): Promise<SummaryState>;
	/** 生成摘要用的模型（`SessionModel.id`）；没选时是 undefined，用这个会话自己的模型。 */
	model(): Promise<string | undefined>;
	setModel(model: string | undefined): Promise<void>;
}
