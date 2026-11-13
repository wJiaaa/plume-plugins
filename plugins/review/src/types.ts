/** `review_session` 的结果 details：逻辑入口写进去，界面入口的那一行读出来。会话里存的可能是旧版本写的，读之前先校验。 */

export const REVIEW_SESSION = "review_session";
/** 审阅会话问原会话修哪几条的工具（`/review` 正文第 F 步）。只列给审阅会话。 */
export const ASK_IMPLEMENTER = "ask_implementer";

export type Effort = "low" | "medium" | "high";

/** 原会话交给审阅会话的交接单，字段见 `/review` 正文第 H 步。审 PR 时没有。 */
export interface ReviewHandoff {
	background: string;
	decisions: string;
	implementation: string;
	files: { path: string; change: string }[];
	outOfScope?: string;
	unverified: string;
	focus?: string;
}

export interface ReviewSessionDetails {
	kind: "review_session";
	/** 审阅会话的标题（侧栏里的名字）。 */
	title: string;
	/** 那一行写的是审什么：目标，或原会话的标题。 */
	subject: string;
	target?: string;
	effort?: Effort;
	handoff?: ReviewHandoff;
	/** 开出来的审阅会话；开不出来时这次调用是错误，没有 details。 */
	sessionId: string;
}

export function isReviewSession(value: unknown): value is ReviewSessionDetails {
	const details = value as Partial<ReviewSessionDetails> | undefined;
	return details?.kind === "review_session" && typeof details.sessionId === "string" && typeof details.subject === "string";
}
