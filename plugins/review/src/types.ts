/** 把审阅背景写成 `review/intent.md` 的工具（`/review` 正文第 3 步）。只列给侧栏里的会话。 */
export const REVIEW_BRIEF = "review_brief";

/** 写代码的对话交给审阅子智能体的背景，字段见 `/review` 正文第 3 步。审 PR 时没有。 */
export interface ReviewHandoff {
	background: string;
	decisions: string;
	implementation: string;
	files: { path: string; change: string }[];
	outOfScope?: string;
	unverified: string;
	focus?: string;
}
