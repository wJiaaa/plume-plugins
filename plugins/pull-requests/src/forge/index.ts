/* oxlint-disable preserve-caught-error -- 见 failure 的注释：这里是不带原始错误出去的边界 */
import { randomUUID } from "node:crypto";
import type { CallContext, Locale, PluginFetch, SecretsService } from "@plume/contract";
import type { ForgeAccount, ForgeKind, PullRequestsApi, PullRequestSummary, ReviewVerdict } from "../api.ts";
import { backendText } from "../messages.ts";
import { forgeKinds, isKind, normalizeServer, validateNumber, validateRepo } from "./accounts.ts";
import { fetchAvatars } from "./avatars.ts";
import { checkCancelled, describe, ForgeError } from "./errors.ts";
import { gitea } from "./gitea.ts";
import { gitee } from "./gitee.ts";
import { github } from "./github.ts";
import { gitlab } from "./gitlab.ts";
import { currentBranch, findLocalCheckout, writePullRequestScratch } from "./local.ts";
import { newestFirst } from "./pr-summary.ts";
import type { ForgeConnection, ForgeDriver } from "./types.ts";
import { AccountStore } from "./vault.ts";

const DRIVERS: Record<ForgeKind, ForgeDriver> = { github, gitlab, gitee, gitea };
export function createPullRequestsApi(options: {
	dataDir: string;
	secrets: SecretsService;
	locale: () => Locale;
	signal: AbortSignal;
	fetch?: PluginFetch;
}): PullRequestsApi {
	const store = new AccountStore(options.dataDir, options.secrets);
	const signalFor = (call: CallContext) => AbortSignal.any([options.signal, call.signal]);
	/*
	 * 交给界面的错误只有 describe 翻译过的那一句：不认识的错误一律说成「未知错误」，原始错误（可能带令牌、实例地址）
	 * 有意不跟着走，所以下面换掉错误时不挂 cause。
	 */
	const failure = (error: unknown) => describe(error, options.locale());
	async function connect(id: string, signal: AbortSignal): Promise<ForgeConnection> {
		if (typeof id !== "string" || !id || id.length > 256) throw new ForgeError("badInput");
		const conn = await store.connect(id, signal);
		checkCancelled(signal);
		return { ...conn, locale: options.locale(), fetch: options.fetch };
	}
	async function withConn<T>(
		id: string,
		repo: string,
		number: number,
		call: CallContext,
		work: (driver: ForgeDriver, conn: ForgeConnection) => Promise<T>,
	): Promise<T> {
		const signal = signalFor(call);
		const conn = await connect(id, signal);
		validateRepo(repo, conn.account.kind);
		validateNumber(number);
		const result = await work(DRIVERS[conn.account.kind], conn);
		checkCancelled(signal);
		return result;
	}
	function validateBody(body: string, required: boolean): void {
		if (typeof body !== "string" || body.length > 100_000) throw new ForgeError("badInput");
		if (required && !body.trim()) throw new ForgeError("emptyComment");
	}
	const api: PullRequestsApi = {
		async kinds() {
			return { kinds: forgeKinds(options.locale()) };
		},
		async accounts() {
			try {
				checkCancelled(options.signal);
				return await store.list();
			} catch (error) {
				throw new Error(failure(error));
			}
		},
		async signIn(input, call) {
			try {
				const signal = signalFor(call);
				checkCancelled(signal);
				if (
					!input ||
					!isKind(input.kind) ||
					typeof input.baseUrl !== "string" ||
					input.baseUrl.length > 4096 ||
					(input.label !== undefined && (typeof input.label !== "string" || input.label.length > 256))
				)
					throw new ForgeError("badInput");
				const baseUrl = normalizeServer(input.baseUrl);
				if (!baseUrl) throw new ForgeError("badServer");
				if (typeof input.token !== "string" || !input.token.trim()) throw new ForgeError("noToken");
				const token = input.token.trim();
				if (token.length > 16_384 || /[\x00-\x20\x7f]/.test(token)) throw new ForgeError("badInput");
				const draft: ForgeAccount = {
					id: randomUUID(),
					kind: input.kind,
					baseUrl,
					label: (input.label?.trim() || "").split(token).join("[redacted]"),
					login: "",
					avatarUrl: null,
					enabled: true,
				};
				const identity = await DRIVERS[input.kind].identify({ account: draft, token, signal, locale: options.locale(), fetch: options.fetch });
				checkCancelled(signal);
				return { account: await store.saveIdentity(draft, identity, token, signal) };
			} catch (error) {
				return { error: failure(error) };
			}
		},
		async signOut(id) {
			try {
				if (typeof id !== "string") throw new ForgeError("badInput");
				await store.remove(id, options.signal);
			} catch (error) {
				throw new Error(failure(error));
			}
		},
		async setEnabled(id, enabled) {
			try {
				if (typeof id !== "string" || typeof enabled !== "boolean") throw new ForgeError("badInput");
				return await store.update(id, { enabled }, options.signal);
			} catch (error) {
				throw new Error(failure(error));
			}
		},
		async rename(id, label) {
			try {
				if (typeof label !== "string" || label.length > 256) throw new ForgeError("badInput");
				const conn = await connect(id, options.signal);
				return await store.update(id, { label: (label.trim() || conn.account.login).split(conn.token).join("[redacted]") }, options.signal);
			} catch (error) {
				throw new Error(failure(error));
			}
		},
		async myPullRequests(call) {
			try {
				const signal = signalFor(call);
				checkCancelled(signal);
				const accounts = (await store.list()).filter((a) => a.enabled);
				if (!accounts.length) return { pullRequests: [], errors: {}, error: backendText(options.locale(), "noAccounts") };
				// 不共享可取消的在途请求，取消一个页面不能中止另一个页面的刷新。
				const results = await Promise.all(
					accounts.map(async (account) => {
						try {
							const conn = await connect(account.id, signal);
							return { account, rows: await DRIVERS[account.kind].list(conn), error: null as string | null };
						} catch (error) {
							return { account, rows: [] as PullRequestSummary[], error: failure(error) };
						}
					}),
				);
				checkCancelled(signal);
				const errors: Record<string, string> = {};
				for (const result of results) {
					if (result.error) errors[result.account.id] = result.error;
					if ((result.account.lastError ?? "") !== (result.error ?? "")) {
						// 状态落盘失败不抹掉已获取的列表，但取消仍要立即结束。
						await store.update(result.account.id, { lastError: result.error ?? "" }, signal).catch(() => {
							checkCancelled(signal);
						});
					}
				}
				checkCancelled(signal);
				return {
					pullRequests: newestFirst(results.flatMap((r) => r.rows)),
					errors,
					...(results.every((r) => r.error) ? { error: results.length === 1 ? results[0]!.error! : backendText(options.locale(), "allAccountsFailed") } : {}),
				};
			} catch (error) {
				return { pullRequests: [], errors: {}, error: failure(error) };
			}
		},
		async pullRequest(accountId, repo, number, call) {
			try {
				return { detail: await withConn(accountId, repo, number, call, (driver, conn) => driver.detail(conn, repo, number)) };
			} catch (error) {
				return { error: failure(error) };
			}
		},
		async pullRequestDiff(accountId, repo, number, call) {
			try {
				return { files: await withConn(accountId, repo, number, call, (driver, conn) => driver.diff(conn, repo, number)) };
			} catch (error) {
				return { files: [], error: failure(error) };
			}
		},
		async commentOnPullRequest(accountId, repo, number, body, call) {
			try {
				validateBody(body, true);
				await withConn(accountId, repo, number, call, (driver, conn) => driver.comment(conn, repo, number, body));
				return {};
			} catch (error) {
				return { error: failure(error) };
			}
		},
		async reviewPullRequest(accountId, repo, number, verdict, body, call) {
			try {
				if (!["approve", "request-changes", "comment"].includes(verdict as ReviewVerdict)) throw new ForgeError("badInput");
				validateBody(body, verdict === "comment");
				if (verdict === "request-changes" && !body.trim()) throw new ForgeError("changesNeedReason");
				await withConn(accountId, repo, number, call, (driver, conn) => driver.review(conn, repo, number, verdict, body));
				return {};
			} catch (error) {
				return { error: failure(error) };
			}
		},
		async avatars(people, call) {
			try {
				return await fetchAvatars(people, await store.list(), signalFor(call), options.fetch);
			} catch (error) {
				throw new Error(failure(error));
			}
		},
		async findLocalCheckout(accountId, repo, candidates, call) {
			try {
				const signal = signalFor(call);
				const conn = await connect(accountId, signal);
				return await findLocalCheckout(conn.account, repo, candidates, signal);
			} catch (error) {
				throw new Error(failure(error));
			}
		},
		async currentBranch(cwd, call) {
			try {
				return await currentBranch(cwd, signalFor(call));
			} catch (error) {
				throw new Error(failure(error));
			}
		},
		async scratchForPullRequest(accountId, repo, number, call) {
			try {
				return await withConn(accountId, repo, number, call, async (driver, conn) => {
					const detail = await driver.detail(conn, repo, number);
					return writePullRequestScratch(options.dataDir, conn.account, repo, number, detail, conn.signal);
				});
			} catch (error) {
				throw new Error(failure(error));
			}
		},
	};
	return api;
}
