import type { Locale } from "@plume/contract";
import type { ErrorCode } from "./api.ts";

const zhCN = {
	title: "ChatGPT 账号",
	detail: "用 ChatGPT 账号登录后，套餐里的额度可以给 Plume 用，模型出现在模型设置的「ChatGPT」供应商里，不需要 API key。",
	account: "账号",
	disconnected: "未登录",
	connecting: "正在浏览器里登录…",
	reauth: "登录已失效，需要重新登录",
	connected: (who: string) => `已登录：${who}`,
	connectedAnonymous: "已登录",
	withModels: (status: string, count: number) => `${status}。模型设置里有 ${count} 个 ChatGPT 模型可用。`,
	signIn: "用 ChatGPT 登录",
	signInAgain: "重新登录",
	switchTitle: "换账号或工作区",
	switchDetail: "再次登录会沿用第一次登录时注册的应用，只能进注册时选的那个工作区。要换账号或工作区，就重新注册一次；新的登录成功后替换现在的连接。",
	signInOther: "重新注册并登录",
	cancel: "取消",
	disconnect: "断开",
	usage: "查看用量",
	usageDetail: "套餐额度用了多少、什么时候恢复，在 ChatGPT 的设置里看。",
	sharingOff: "登录成功了，但这次授权没有允许 Plume 使用套餐额度。重新登录，在授权页上允许它。",
	openFailed: "打不开浏览器，没有开始登录。",
	callbackOk: "已登录，可以回到 Plume 了。",
	callbackFailed: "登录没有完成，回到 Plume 看看原因。",
	errors: {
		busy: "已经有一次登录在进行了。",
		network: "连不上 OpenAI，检查网络或代理后再试。",
		discovery_failed: "没能核对 OpenAI 的登录配置，稍后再试。",
		callback_denied: "在浏览器里取消了授权，或者授权被拒绝了。",
		workspace_denied: "OpenAI 拒绝了这次登录：选的账号或工作区可能不是第一次登录时注册 Plume 的那一个。选回那一个再登录，或者在「换账号或工作区」里重新注册。",
		registration_incomplete: "OpenAI 没有完成应用注册，再登录一次试试。",
		client_mismatch: "授权回来的应用和之前注册的不一致，没有接受这次登录。",
		account_mismatch: "登录的不是之前那个 ChatGPT 账号，没有接受。要换账号，在「换账号或工作区」里重新注册。",
		code_rejected: "浏览器里授权成功了，但 OpenAI 没有接受这次的授权码。再登录一次（不会重新注册应用）；还不行的话，原因记在 Plume 的日志里。",
		token_invalid: "OpenAI 返回的凭据不完整，再登录一次试试。",
		identity_invalid: "没能核实 ChatGPT 账号的身份，再登录一次试试。",
		identity_unavailable: "暂时没法核实 ChatGPT 账号的身份，稍后再试。",
		timeout: "等了 10 分钟没等到浏览器里的授权，已经取消。",
		refresh_terminal: "登录已失效（可能在 ChatGPT 里断开了 Plume），需要重新登录。",
		models_failed: "没拉到这个账号能用的模型，过几分钟会自动再试。",
		usage_limit: "ChatGPT 套餐额度已用完，供应商已暂停。额度恢复后，请在模型设置里重新启用。",
		not_eligible: "这个 ChatGPT 账号或工作区不能使用套餐额度，供应商已暂停。",
		storage_unreadable: "读不了保存的连接（插件数据目录里的 connection.json），没有改动它。修好或删掉这个文件后重启 Plume。",
		revocation_failed: "本机的凭据已经删了，但没能确认 OpenAI 那边也断开了：到 ChatGPT 设置里断开 Plume。",
	} satisfies Record<ErrorCode, string>,
};

const en: typeof zhCN = {
	title: "ChatGPT account",
	detail:
		"Sign in with your ChatGPT account to let Plume use your plan. Its models appear under the “ChatGPT” provider in model settings, with no API key needed.",
	account: "Account",
	disconnected: "Not signed in",
	connecting: "Signing in in your browser…",
	reauth: "Your sign-in has expired. Sign in again.",
	connected: (who: string) => `Signed in as ${who}`,
	connectedAnonymous: "Signed in",
	withModels: (status: string, count: number) => `${status}. ${count} ChatGPT ${count === 1 ? "model is" : "models are"} available in model settings.`,
	signIn: "Sign in with ChatGPT",
	signInAgain: "Sign in again",
	switchTitle: "Switch account or workspace",
	switchDetail:
		"Signing in again reuses the app registered on your first sign-in, which only works for the workspace chosen then. To switch account or workspace, register again; the new sign-in replaces the current connection once it succeeds.",
	signInOther: "Register and sign in",
	cancel: "Cancel",
	disconnect: "Disconnect",
	usage: "View usage",
	usageDetail: "See how much of your plan is used and when it resets in ChatGPT settings.",
	sharingOff: "You're signed in, but this authorization didn't let Plume use your plan. Sign in again and allow it on the authorization page.",
	openFailed: "Couldn't open the browser, so sign-in didn't start.",
	callbackOk: "You're signed in. You can return to Plume.",
	callbackFailed: "Sign-in didn't finish. Return to Plume to see why.",
	errors: {
		busy: "A sign-in is already in progress.",
		network: "Couldn't reach OpenAI. Check your network or proxy and try again.",
		discovery_failed: "Couldn't verify OpenAI's sign-in configuration. Try again later.",
		callback_denied: "Authorization was cancelled or denied in the browser.",
		workspace_denied:
			"OpenAI declined this sign-in. The account or workspace you chose may not be the one Plume was registered with on first sign-in. Choose that one, or register again under “Switch account or workspace”.",
		registration_incomplete: "OpenAI didn't finish registering the app. Try signing in again.",
		client_mismatch: "The authorization came back for a different app than the one registered, so it wasn't accepted.",
		account_mismatch:
			"This isn't the ChatGPT account you signed in with before, so it wasn't accepted. To switch accounts, register again under “Switch account or workspace”.",
		code_rejected:
			"Authorization succeeded in the browser, but OpenAI didn't accept the authorization code. Sign in again (the app won't be registered again). If it still fails, the reason is in Plume's log.",
		token_invalid: "OpenAI returned incomplete credentials. Try signing in again.",
		identity_invalid: "Couldn't verify your ChatGPT account. Try signing in again.",
		identity_unavailable: "Your ChatGPT account can't be verified right now. Try again later.",
		timeout: "No authorization arrived from the browser within 10 minutes, so sign-in was cancelled.",
		refresh_terminal: "Your sign-in is no longer valid (Plume may have been disconnected in ChatGPT). Sign in again.",
		models_failed: "Couldn't load the models for this account. Plume will try again in a few minutes.",
		usage_limit: "Your ChatGPT plan usage limit has been reached, so this provider is paused. After usage is available again, re-enable it in model settings.",
		not_eligible: "This ChatGPT account or workspace is not eligible for plan usage, so this provider is paused.",
		storage_unreadable:
			"Couldn't read the saved connection (connection.json in the plugin's data folder) and left it untouched. Fix or delete it, then restart Plume.",
		revocation_failed: "Credentials were removed from this computer, but OpenAI didn't confirm the disconnection. Disconnect Plume in ChatGPT settings.",
	},
};

export const MESSAGES: Record<Locale, typeof zhCN> = { "zh-CN": zhCN, en };

/** 回给浏览器的那一页：不带脚本、不带回调参数。 */
export function callbackPage(locale: Locale, ok: boolean): string {
	const text = MESSAGES[locale];
	const line = ok ? text.callbackOk : text.callbackFailed;
	const lang = locale === "zh-CN" ? "zh-CN" : "en";
	return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>Plume</title></head><body><p>${line}</p></body></html>`;
}
