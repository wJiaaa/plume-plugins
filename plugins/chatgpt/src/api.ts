/**
 * 两个入口共用的类型：逻辑入口经 `ctx.serve` 开的接口、经 `ctx.store` 推给界面的连接状态。
 * 凭据从不出逻辑入口：界面只知道连没连上、是哪个账号、出了什么错。
 */

import type { CallContext } from "@plume/contract";

/** 出错的原因，界面按它从 `MESSAGES` 里取给人看的话（切语言时跟着换）。 */
export type ErrorCode =
	| "busy"
	| "network"
	| "discovery_failed"
	| "callback_denied"
	| "workspace_denied"
	| "registration_incomplete"
	| "client_mismatch"
	| "account_mismatch"
	| "code_rejected"
	| "token_invalid"
	| "identity_invalid"
	| "identity_unavailable"
	| "timeout"
	| "refresh_terminal"
	| "models_failed"
	| "usage_limit"
	| "not_eligible"
	| "storage_unreadable"
	| "revocation_failed";

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "reauth_required";

export interface ChatGptState {
	status: ConnectionStatus;
	/** 连上了、而且授权里有 `chatgpt.tokens.use.direct`：套餐额度能用。 */
	sharing: boolean;
	/** 这台机器已经为 Plume 注册过应用：再登录沿用它，只能登注册时的那个工作区；换别的要重新注册。 */
	registered: boolean;
	account?: { name?: string; email?: string };
	/** 模型设置里「ChatGPT」供应商下有几个模型。 */
	models: number;
	error?: ErrorCode;
}

export const STATE_KEY = "state";

export const INITIAL_STATE: ChatGptState = { status: "disconnected", sharing: false, registered: false, models: 0 };

/** 套餐用量在 ChatGPT 里看，官方「Errors and recovery」页给的地址。 */
export const USAGE_URL = "https://chatgpt.com/settings/usage";

export interface ChatGptApi {
	/**
	 * 先交回授权页的地址（界面经 `ui.openExternal` 打开），等浏览器里授权完成后结束；结果看推过去的状态。
	 * `fresh` 为 true 时不沿用已注册的应用、重新注册：换账号、换工作区用它。
	 */
	signIn(fresh: boolean, call: CallContext): AsyncGenerator<string, void>;
	/** 删掉本机的凭据并吊销；`revoked` 为 false 时远端没能确认断开，要人到 ChatGPT 设置里断开。 */
	disconnect(): Promise<{ revoked: boolean }>;
}
