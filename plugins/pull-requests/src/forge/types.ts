import type { Locale, PluginFetch } from "@plume/contract";
import type { ForgeAccount, ForgeKind, PullRequestDetail, PullRequestSummary, ReviewVerdict, WorkspaceDiffFile } from "../api.ts";

export interface ForgeConnection {
	account: ForgeAccount;
	token: string;
	signal: AbortSignal;
	locale?: Locale;
	fetch?: PluginFetch;
}
export interface ForgeIdentity {
	login: string;
	name: string;
	avatarUrl: string | null;
}
export interface ForgeDriver {
	kind: ForgeKind;
	identify(conn: ForgeConnection): Promise<ForgeIdentity>;
	list(conn: ForgeConnection): Promise<PullRequestSummary[]>;
	detail(conn: ForgeConnection, repo: string, number: number): Promise<PullRequestDetail>;
	diff(conn: ForgeConnection, repo: string, number: number): Promise<WorkspaceDiffFile[]>;
	comment(conn: ForgeConnection, repo: string, number: number, body: string): Promise<void>;
	review(conn: ForgeConnection, repo: string, number: number, verdict: ReviewVerdict, body: string): Promise<void>;
}
