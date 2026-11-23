/**
 * 一个 ChatGPT 连接：登录、提前刷新令牌、断开，以及交给模型设置的那个供应商。
 *
 * 宿主每次发请求前都读一遍供应商（`ProviderSource.list()` 是同步的），所以令牌只在这里换：`tick` 由逻辑入口每半分钟叫一次，
 * 到期前 5 分钟（且不早于服务端给的 `earliest_refresh_at`）刷新；电脑睡醒后下一次 `tick` 就补上。刷新令牌每次都轮换，
 * 换到的新一份先写盘再用：旧的已经作废，丢了新的就只能重新登录。
 *
 * 失败怎么办（官方「Errors and recovery」页）：刷新令牌被明确拒绝（`invalid_grant` 等）时清掉令牌、要人重新登录，
 * 注册来的 client_id 和账号留着；网络、服务端的临时故障不清，退避后再试。
 */

import type { Logger, ModelEntry, PluginFetch, PluginProvider, PluginSecrets, ProviderFailure } from "@plume/contract";
import type { ChatGptState, ErrorCode } from "./api.ts";
import { ChatGptError, codeOf, messageOf } from "./errors.ts";
import { verifyIdToken } from "./id-token.ts";
import { listModels, mergeModels } from "./models.ts";
import {
	authorizationUrl,
	type Callback,
	discover,
	type Endpoints,
	exchangeCode,
	listenForCallback,
	newAttempt,
	RESOURCE,
	refreshTokens,
	revoke,
	SHARING_SCOPE,
	type TokenSet,
} from "./oauth.ts";
import { EMPTY_RECORD, hostId, readRecord, type SavedRecord, sealTokens, unsealTokens, writeRecord } from "./store.ts";

const PROVIDER_ID = "chatgpt";
/** 到期前多久刷新。 */
const REFRESH_AHEAD_MS = 5 * 60_000;
/** 浏览器里的授权最多等这么久，过了关掉回调端口。 */
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const BACKOFF_MIN_MS = 30_000;
const BACKOFF_MAX_MS = 10 * 60_000;
const MODELS_RETRY_MS = 5 * 60_000;

export interface ConnectionDeps {
	fetch: PluginFetch;
	secrets: PluginSecrets;
	dataDir: string;
	log: Logger;
	/** 插件停用时中止：刷新、吊销这些不跟着哪一次界面调用的请求用它。 */
	signal: AbortSignal;
	/** 回给浏览器的那一页。 */
	callbackPage(ok: boolean): string;
	/** 设置页改、删时抛给人看的话。 */
	describe(code: ErrorCode): string;
	/** 状态或供应商可能变了。 */
	changed(): void;
}

/** 令牌里不留 id_token：校验完就没用了，也不该跟着令牌一起长期存着。 */
const withoutIdToken = ({ idToken: _, ...tokens }: TokenSet): TokenSet => tokens;

export class Connection {
	private record: SavedRecord = { ...EMPTY_RECORD };
	private tokens: TokenSet | undefined;
	/** 连接记录读不出来：什么都不写，免得盖掉也许还救得回来的那份。 */
	private unreadable = false;
	private error: ErrorCode | undefined;
	private signingIn: AbortController | undefined;
	private refreshing: Promise<void> | undefined;
	private retryAt = 0;
	private backoff = 0;
	private modelsRetryAt = 0;
	private writes: Promise<void> = Promise.resolve();
	private readonly deps: ConnectionDeps;

	constructor(deps: ConnectionDeps) {
		this.deps = deps;
	}

	async load(): Promise<void> {
		try {
			this.record = await readRecord(this.deps.dataDir);
			this.tokens = await unsealTokens(this.deps.secrets, this.record.tokens);
			if (this.record.failure) this.error = this.record.failure === "usage-limit" ? "usage_limit" : "not_eligible";
			// 封着的令牌解不开（换了钥匙）：只在内存里当成要重新登录，文件不动。
			if (this.record.status === "connected" && !this.tokens) this.record = { ...this.record, status: "reauth_required" };
		} catch (error) {
			this.unreadable = true;
			this.error = "storage_unreadable";
			this.deps.log.warn(`读不了保存的 ChatGPT 连接，没有改动它：${messageOf(error)}`);
		}
		this.deps.changed();
	}

	private usable(): boolean {
		return this.record.status === "connected" && this.tokens !== undefined && this.record.scopes.includes(SHARING_SCOPE);
	}

	state(): ChatGptState {
		const { account } = this.record;
		return {
			status: this.signingIn ? "connecting" : this.record.status,
			sharing: this.usable(),
			registered: this.record.clientId !== undefined,
			...(account && (account.name || account.email) ? { account: { ...account } } : {}),
			models: this.record.models?.length ?? 0,
			...(this.error ? { error: this.error } : {}),
		};
	}

	/** 交给模型设置的供应商。从没登录过、或断开了的不交；要重新登录、没开套餐额度时交一个停用着的，人还看得到它。 */
	provider(): PluginProvider | undefined {
		if (!this.record.clientId || this.record.status === "disconnected") return undefined;
		const usable = this.usable();
		return {
			id: PROVIDER_ID,
			name: this.record.provider?.name ?? "ChatGPT",
			api: "openai-responses",
			baseUrl: RESOURCE,
			enabled: usable && this.record.provider?.enabled !== false,
			models: this.record.models ?? [],
			apiKey: usable && this.tokens ? this.tokens.accessToken : "",
			route: "chatgpt-plan",
		};
	}

	private async persist(next: SavedRecord): Promise<void> {
		if (this.unreadable) throw new ChatGptError("storage_unreadable");
		this.record = next;
		const write = this.writes.catch(() => {}).then(() => writeRecord(this.deps.dataDir, next));
		this.writes = write;
		await write;
	}

	/**
	 * 登录：先交回授权页的地址，等浏览器回到 127.0.0.1 的回调，换令牌、校验身份、拉模型表。出错不抛，记在状态里给界面看；
	 * 界面取消（关掉设置页、点取消）时什么都不记。
	 *
	 * 注册来的 client_id 绑定在注册时选的那个工作区（官方「Registration and sign-in」页），沿用它就只能登那个工作区。
	 * `fresh` 为 true 时不沿用，用 `dynamic_agent_client` 重新注册：换账号、换工作区都走这条。回调带回新的 client_id 之前
	 * 原来的注册不动，中途取消、失败都还在。
	 */
	async *signIn(signal: AbortSignal, fresh: boolean): AsyncGenerator<string, void> {
		if (this.unreadable) throw new ChatGptError("storage_unreadable");
		if (this.signingIn) throw new ChatGptError("busy");
		const own = new AbortController();
		this.signingIn = own;
		const timeout = AbortSignal.timeout(SIGN_IN_TIMEOUT_MS);
		const abort = AbortSignal.any([signal, own.signal, timeout, this.deps.signal]);
		this.error = undefined;
		this.deps.changed();
		let callback: Callback | undefined;
		try {
			// 一次刷新正写着令牌时不插进来：它写完会盖掉这次登录的那份。
			await this.refreshing?.catch(() => {});
			const host = await hostId(this.deps.dataDir);
			const endpoints = await discover(this.deps.fetch, abort);
			const attempt = newAttempt();
			callback = await listenForCallback(attempt.state, this.deps.callbackPage, abort);
			const known = fresh ? undefined : this.record.clientId;
			yield authorizationUrl(endpoints, {
				clientId: known,
				redirectUri: callback.redirectUri,
				attempt,
				hostId: host,
				loginHint: known ? this.record.account?.email : undefined,
			});
			const result = await callback.result.catch((error: unknown) => {
				// 沿用注册过的应用时授权页没有确认这一步，被拒多半是选的账号或工作区不在注册时绑定的那个工作区里。
				if (known && codeOf(error) === "callback_denied") throw new ChatGptError("workspace_denied", messageOf(error));
				throw error;
			});

			const previous = this.record;
			const previousTokens = this.tokens;
			let clientId: string;
			let switching = false;
			if (known) {
				// 再次登录时回调可能不带 client_id；带了就要是同一个。
				if (result.clientId && result.clientId !== known) throw new ChatGptError("client_mismatch", "callback carried a different client id");
				clientId = known;
			} else {
				if (!result.clientId) throw new ChatGptError("registration_incomplete", "registration callback carried no client id");
				clientId = result.clientId;
				switching = previous.clientId !== undefined && previous.clientId !== clientId;
				// 第一次注册先记下 client_id：授权码过期、换失败了，下次沿用它，不再重复注册。换已有连接时则等新身份完全验过，旧连接不能先丢。
				if (!switching) await this.persist({ ...this.record, clientId });
			}

			const tokens = await exchangeCode(
				this.deps.fetch,
				endpoints,
				{ code: result.code, clientId, redirectUri: callback.redirectUri, verifier: attempt.verifier },
				abort,
			);
			if (!tokens.idToken) throw new ChatGptError("identity_invalid", "token response carried no id_token");
			const identity = await verifyIdToken(this.deps.fetch, endpoints, tokens.idToken, { clientId, nonce: attempt.nonce }, abort);
			if (known && this.record.subject && identity.subject !== this.record.subject)
				throw new ChatGptError("account_mismatch", "signed in as a different account");

			let models = switching ? undefined : this.record.models;
			if (tokens.scopes.includes(SHARING_SCOPE)) {
				try {
					models = mergeModels(await listModels(this.deps.fetch, tokens.accessToken, abort), models);
				} catch (error) {
					if (abort.aborted) throw error;
					// 模型表没拉到不算登录失败：`tick` 过一会儿再拉。
					this.error = "models_failed";
					this.modelsRetryAt = Date.now() + MODELS_RETRY_MS;
					this.deps.log.warn(`拉 ChatGPT 的模型表失败：${messageOf(error)}`);
				}
			}
			const kept = withoutIdToken(tokens);
			const { failure: _, ...connected } = switching ? EMPTY_RECORD : this.record;
			await this.persist({
				...connected,
				clientId,
				subject: identity.subject,
				account: { ...(identity.name ? { name: identity.name } : {}), ...(identity.email ? { email: identity.email } : {}) },
				status: "connected",
				scopes: tokens.scopes,
				tokens: await sealTokens(this.deps.secrets, kept),
				...(models ? { models } : {}),
				...(switching && previous.provider ? { provider: previous.provider } : {}),
			});
			this.tokens = kept;
			this.backoff = 0;
			this.retryAt = 0;
			if (switching) await this.revokePrevious(previous, previousTokens, endpoints);
		} catch (error) {
			const cancelled = signal.aborted || own.signal.aborted || this.deps.signal.aborted;
			if (!cancelled) {
				this.error = timeout.aborted ? "timeout" : codeOf(error);
				this.deps.log.warn(`ChatGPT 登录失败：${messageOf(error)}`);
			}
		} finally {
			callback?.close();
			this.signingIn = undefined;
			this.deps.changed();
		}
	}

	/** 逻辑入口定时叫：该刷新就刷新，模型表没拉到就再拉一次。 */
	async tick(): Promise<void> {
		if (this.unreadable || this.signingIn) return;
		const now = Date.now();
		const tokens = this.tokens;
		if (
			this.record.status === "connected" &&
			tokens &&
			this.record.clientId &&
			now >= this.retryAt &&
			now >= (tokens.earliestRefreshAt ?? 0) &&
			tokens.expiresAt - REFRESH_AHEAD_MS <= now
		) {
			await this.refresh();
		}
		if (this.usable() && this.tokens && !this.record.models?.length && now >= this.modelsRetryAt) await this.fetchModels(this.tokens.accessToken);
	}

	private async fetchModels(accessToken: string): Promise<void> {
		try {
			const models = mergeModels(await listModels(this.deps.fetch, accessToken, this.deps.signal), this.record.models);
			if (this.error === "models_failed") this.error = undefined;
			await this.persist({ ...this.record, models });
		} catch (error) {
			if (this.deps.signal.aborted) return;
			this.modelsRetryAt = Date.now() + MODELS_RETRY_MS;
			this.deps.log.warn(`拉 ChatGPT 的模型表失败：${messageOf(error)}`);
		} finally {
			this.deps.changed();
		}
	}

	/** 同一时间只刷一次：两次一起拿同一个刷新令牌去换，后一次会被当成重用、整个授权作废。 */
	refresh(): Promise<void> {
		this.refreshing ??= this.refreshOnce().finally(() => {
			this.refreshing = undefined;
		});
		return this.refreshing;
	}

	private async refreshOnce(): Promise<void> {
		const tokens = this.tokens;
		const clientId = this.record.clientId;
		if (!tokens || !clientId) return;
		const signal = this.deps.signal;
		try {
			const endpoints = await discover(this.deps.fetch, signal);
			const next = await refreshTokens(this.deps.fetch, endpoints, { clientId, refreshToken: tokens.refreshToken, scopes: this.record.scopes }, signal);
			const kept = withoutIdToken(next);
			await this.persist({ ...this.record, scopes: next.scopes, tokens: await sealTokens(this.deps.secrets, kept) });
			this.tokens = kept;
			this.backoff = 0;
			this.retryAt = 0;
			if (this.error === "refresh_terminal" || this.error === "network") this.error = undefined;
			if (next.idToken) {
				try {
					const identity = await verifyIdToken(this.deps.fetch, endpoints, next.idToken, { clientId, nonce: undefined }, signal);
					if (this.record.subject && identity.subject !== this.record.subject) await this.dropTokens("account_mismatch");
				} catch (error) {
					if (codeOf(error) === "identity_invalid") await this.dropTokens("identity_invalid");
					// 取不到公钥只是暂时核对不了：令牌已经存下，照常用，下次刷新再核对。
					else this.deps.log.warn(`刷新后核对 ChatGPT 身份没成：${messageOf(error)}`);
				}
			}
		} catch (error) {
			if (signal.aborted) return;
			if (codeOf(error) === "refresh_terminal") {
				this.deps.log.warn(`ChatGPT 的刷新令牌失效了，要重新登录：${messageOf(error)}`);
				await this.dropTokens("refresh_terminal");
				return;
			}
			this.backoff = Math.min(this.backoff ? this.backoff * 2 : BACKOFF_MIN_MS, BACKOFF_MAX_MS);
			this.retryAt = Date.now() + this.backoff;
			this.deps.log.warn(`刷新 ChatGPT 令牌失败，${Math.round(this.backoff / 1000)} 秒后再试：${messageOf(error)}`);
		} finally {
			this.deps.changed();
		}
	}

	/** 令牌不能再用：清掉、要人重新登录；client_id、账号、人改过的供应商留着。 */
	private async dropTokens(code: ErrorCode): Promise<void> {
		this.tokens = undefined;
		this.error = code;
		const { tokens: _, ...rest } = this.record;
		await this.persist({ ...rest, status: "reauth_required" });
	}

	/** 新连接已经验明身份并写盘后才吊销旧连接；吊销失败不回滚能用的新连接。 */
	private async revokePrevious(record: SavedRecord, tokens: TokenSet | undefined, endpoints: Endpoints): Promise<void> {
		if (!tokens || !record.clientId) return;
		try {
			await revoke(this.deps.fetch, endpoints, { clientId: record.clientId, refreshToken: tokens.refreshToken }, this.deps.signal);
		} catch (error) {
			this.deps.log.warn(`换注册时没能吊销原来那个应用的令牌：${messageOf(error)}`);
		}
	}

	/** 断开：先吊销刷新令牌，不管成没成都删掉本机的令牌。 */
	async disconnect(): Promise<{ revoked: boolean }> {
		if (this.unreadable) throw new ChatGptError("storage_unreadable");
		this.signingIn?.abort();
		await this.refreshing?.catch(() => {});
		const tokens = this.tokens;
		const clientId = this.record.clientId;
		let revoked = true;
		if (tokens && clientId) {
			try {
				const endpoints = await discover(this.deps.fetch, this.deps.signal);
				await revoke(this.deps.fetch, endpoints, { clientId, refreshToken: tokens.refreshToken }, this.deps.signal);
			} catch (error) {
				revoked = false;
				this.deps.log.warn(`吊销 ChatGPT 令牌没成，本机的照样删了：${messageOf(error)}`);
			}
		}
		this.tokens = undefined;
		this.error = revoked ? undefined : "revocation_failed";
		const { failure: _, tokens: __, ...rest } = this.record;
		try {
			await this.persist({ ...rest, status: "disconnected", scopes: [] });
		} finally {
			this.deps.changed();
		}
		return { revoked };
	}

	/** 设置页改了供应商：名字、模型照存；启停只在能用的时候存（不能用时界面上那个「停用」是这里定的，不是人选的）。 */
	async saveProvider(provider: PluginProvider): Promise<void> {
		if (this.unreadable) throw new Error(this.deps.describe("storage_unreadable"));
		const saved = { ...this.record.provider, name: provider.name, ...(this.usable() ? { enabled: provider.enabled } : {}) };
		const recovering = provider.enabled && (this.error === "usage_limit" || this.error === "not_eligible");
		let record = this.record;
		if (recovering) {
			const { failure: _, ...withoutFailure } = record;
			record = withoutFailure;
		}
		await this.persist({ ...record, provider: saved, models: provider.models as ModelEntry[] });
		if (recovering) this.error = undefined;
		this.deps.changed();
	}

	/** 套餐通道的终局失败会持久化停用；恢复后由人在模型设置里重新启用。 */
	async failed(providerId: string, failure: ProviderFailure): Promise<void> {
		if (providerId !== PROVIDER_ID) throw new Error(`unknown provider: ${providerId}`);
		this.error = failure === "usage-limit" ? "usage_limit" : "not_eligible";
		await this.persist({
			...this.record,
			provider: { ...this.record.provider, enabled: false },
			failure,
		});
		this.deps.changed();
	}

	/** 设置页删除这个供应商：就是断开。 */
	async removeProvider(): Promise<void> {
		if (this.unreadable) throw new Error(this.deps.describe("storage_unreadable"));
		await this.disconnect();
	}
}
