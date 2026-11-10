import type { CallContext, ChangeHunk } from "@plume/contract";

export type ForgeKind = "github" | "gitlab" | "gitee" | "gitea";
export type ReviewVerdict = "approve" | "request-changes" | "comment";

/** 账号视图不含令牌，令牌只在逻辑入口保存和使用。 */
export interface ForgeAccount {
	id: string;
	kind: ForgeKind;
	label: string;
	baseUrl: string;
	login: string;
	avatarUrl: string | null;
	enabled: boolean;
	lastError?: string;
}

export interface ForgeKindInfo {
	kind: ForgeKind;
	name: string;
	baseUrl: string;
	tokenUrl: string;
	scopes: string;
	note: string;
}

export interface PullRequestCheck {
	name: string;
	state: "pass" | "fail" | "pending";
	url?: string;
}

export interface PullRequestSummary {
	accountId: string;
	repo: string;
	number: number;
	title: string;
	author: string;
	avatarUrl: string | null;
	state: string;
	isDraft: boolean;
	url: string;
	createdAt: string;
	updatedAt: string;
	comments: number;
	relation: "reviewing" | "authored" | "reviewed";
	additions: number | null;
	deletions: number | null;
	headRefName: string | null;
	checkState: PullRequestCheck["state"] | null;
	reviewDecision: string | null;
}

export interface PullRequestDetail extends PullRequestSummary {
	body: string;
	changedFiles: number | null;
	headRefName: string;
	baseRefName: string;
	threads: { author: string; body: string; createdAt: string }[];
	reviews: { author: string; state: string; body: string; submittedAt: string }[];
	reviewers: { login: string; state: string }[];
	checks: { total: number; passed: number; failed: number; pending: number; items: PullRequestCheck[] } | null;
	mergeable: string;
	labels: string[];
	commits: { sha: string; headline: string; author: string; at: string }[];
}

export interface WorkspaceDiffFile {
	path: string;
	status: "added" | "modified" | "deleted" | "renamed" | "untracked";
	added: number;
	removed: number;
	hunks: ChangeHunk[];
	binary?: boolean;
	bytes?: number;
}

export interface ListResult {
	pullRequests: PullRequestSummary[];
	errors: Record<string, string>;
	error?: string;
}

interface SignInInput {
	kind: ForgeKind;
	baseUrl: string;
	token: string;
	label?: string;
}

/** 每个远端方法的参数个数固定，运行时在末尾追加取消上下文。 */
export interface PullRequestsApi {
	kinds(): Promise<{ kinds: ForgeKindInfo[] }>;
	accounts(): Promise<ForgeAccount[]>;
	signIn(input: SignInInput, call: CallContext): Promise<{ account?: ForgeAccount; error?: string }>;
	signOut(id: string): Promise<void>;
	setEnabled(id: string, enabled: boolean): Promise<ForgeAccount | null>;
	rename(id: string, label: string): Promise<ForgeAccount | null>;
	myPullRequests(call: CallContext): Promise<ListResult>;
	pullRequest(accountId: string, repo: string, number: number, call: CallContext): Promise<{ detail?: PullRequestDetail; error?: string }>;
	pullRequestDiff(accountId: string, repo: string, number: number, call: CallContext): Promise<{ files: WorkspaceDiffFile[]; error?: string }>;
	commentOnPullRequest(accountId: string, repo: string, number: number, body: string, call: CallContext): Promise<{ error?: string }>;
	reviewPullRequest(accountId: string, repo: string, number: number, verdict: ReviewVerdict, body: string, call: CallContext): Promise<{ error?: string }>;
	avatars(people: { login: string; url?: string | null }[], call: CallContext): Promise<Record<string, string | null>>;
	/** 匹配 origin 的主机和仓库，不能把别的服务上的同名仓库认作本地检出。 */
	findLocalCheckout(accountId: string, repo: string, candidates: string[], call: CallContext): Promise<string | null>;
	/** 工作目录检出着的分支（环境卡片里找这个分支的拉取请求）；分离头指针、不是仓库时是 null。 */
	currentBranch(cwd: string, call: CallContext): Promise<string | null>;
	/** 无本地检出时，只在本插件私有目录里准备 PR.md。 */
	scratchForPullRequest(accountId: string, repo: string, number: number, call: CallContext): Promise<string>;
}
