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

/** 每个会话的 `SummaryState` 经 `ctx.sessionStore` 推给界面，用的 key。 */
export const STATE_KEY = "state";

/** 逻辑入口经 `ctx.serve` 开给界面入口的接口。 */
export interface SummaryApi {
	/** 人点「重试」：现在就生成一次，和后台到点的那次是同一份。 */
	summarize(sessionId: string): Promise<SummaryState>;
}

/** 设置（`ctx.settings`），设置分区经 `ui.useSettings` 读、改。 */
export interface SummarySettings {
	/** 生成摘要用的模型（`SessionModel.id`）；没选时是 undefined，用这个会话自己的模型。 */
	model: string | undefined;
}

export function normalizeSettings(saved: Record<string, unknown>): SummarySettings {
	return { model: typeof saved.model === "string" && saved.model ? saved.model : undefined };
}
