/**
 * plume.chatgpt 的界面入口：插件详情里「设置」那一节，登录、断开、看用量。
 * 只和这个插件的账号有关，不占设置导航；模型本身在模型设置的「ChatGPT」供应商里。
 * 状态经 `ui.useStore` 读逻辑入口推来的那份，操作经 `ui.remote()`；令牌从不到这里。
 */

import { useEffect, useRef, useState } from "react";
import { Button, SettingsCard, SettingsNotice, SettingsRow, useI18n } from "@plume/ui";
import type { Remote, UiContext, UiPlugin } from "@plume/contract/ui";
import { type ChatGptApi, type ChatGptState, STATE_KEY, USAGE_URL } from "./api.ts";
import { MESSAGES } from "./messages.ts";

type Text = (typeof MESSAGES)["en"];

function statusLine(state: ChatGptState, text: Text): string {
	switch (state.status) {
		case "disconnected":
			return text.disconnected;
		case "connecting":
			return text.connecting;
		case "reauth_required":
			return text.reauth;
		case "connected": {
			const who = state.account?.email ?? state.account?.name;
			return who ? text.connected(who) : text.connectedAnonymous;
		}
	}
}

function ChatGptSettings({ ui, api }: { ui: UiContext; api: Remote<ChatGptApi> }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const state = ui.useStore<ChatGptState>(STATE_KEY);
	const pending = useRef<ReturnType<typeof api.signIn> | undefined>(undefined);
	/** 正在走的那一趟登录：沿用已注册的应用（`same`）还是重新注册（`fresh`），转圈只转点的那个按钮。 */
	const [signingIn, setSigningIn] = useState<"same" | "fresh" | undefined>(undefined);
	const [disconnecting, setDisconnecting] = useState(false);
	const [openFailed, setOpenFailed] = useState(false);

	// 设置页关掉时取消还在等的登录：逻辑入口那边关掉回调端口。
	useEffect(() => () => pending.current?.cancel(), []);

	if (!state) return null;

	/** 逻辑入口先交回授权页的地址，这里打开；打不开就放弃这一趟。结果看推过来的状态，这里不读返回值。 */
	const signIn = async (fresh: boolean) => {
		setOpenFailed(false);
		const call = api.signIn(fresh);
		pending.current = call;
		setSigningIn(fresh ? "fresh" : "same");
		try {
			for await (const url of call) {
				try {
					await ui.openExternal(url);
				} catch {
					setOpenFailed(true);
					break;
				}
			}
			await call;
		} catch {
			// 取消、插件停用：原因在状态里，或者本来就不用说。
		} finally {
			if (pending.current === call) pending.current = undefined;
			setSigningIn(undefined);
		}
	};

	const disconnect = async () => {
		setDisconnecting(true);
		try {
			await api.disconnect();
		} catch {
			// 失败的原因由逻辑入口记在状态里。
		} finally {
			setDisconnecting(false);
		}
	};

	const connected = state.status === "connected";
	const signInLabel = state.status === "disconnected" ? text.signIn : text.signInAgain;
	const showSignIn = state.status !== "connecting" && (!connected || !state.sharing);
	const showDisconnect = connected || state.status === "reauth_required";
	const busy = signingIn !== undefined || disconnecting;
	const detail = connected && state.sharing ? text.withModels(statusLine(state, text), state.models) : statusLine(state, text);

	return (
		<>
			<SettingsCard>
				<SettingsRow
					title={text.account}
					detail={detail}
					control={
						<>
							{state.status === "connecting" && signingIn ? <Button onClick={() => pending.current?.cancel()}>{text.cancel}</Button> : null}
							{showSignIn ? (
								<Button variant="primary" loading={signingIn === "same"} disabled={busy} onClick={() => void signIn(false)}>
									{signInLabel}
								</Button>
							) : null}
							{showDisconnect ? (
								<Button variant="ghost" loading={disconnecting} disabled={signingIn !== undefined} onClick={() => void disconnect()}>
									{text.disconnect}
								</Button>
							) : null}
						</>
					}
				/>
				{state.registered && state.status !== "connecting" ? (
					<SettingsRow
						title={text.switchTitle}
						detail={text.switchDetail}
						control={
							<Button loading={signingIn === "fresh"} disabled={busy} onClick={() => void signIn(true)}>
								{text.signInOther}
							</Button>
						}
					/>
				) : null}
				{connected && state.sharing ? (
					<SettingsRow title={text.usage} detail={text.usageDetail} control={<Button onClick={() => void ui.openExternal(USAGE_URL)}>{text.usage}</Button>} />
				) : null}
			</SettingsCard>
			{openFailed ? <SettingsNotice tone="danger">{text.openFailed}</SettingsNotice> : null}
			{state.error ? <SettingsNotice tone="danger">{text.errors[state.error]}</SettingsNotice> : null}
			{connected && !state.sharing && !state.error ? <SettingsNotice tone="accent">{text.sharingOff}</SettingsNotice> : null}
		</>
	);
}

export default {
	name: "plume.chatgpt",
	apply(ui) {
		const api = ui.remote<ChatGptApi>();
		function Section() {
			return <ChatGptSettings ui={ui} api={api} />;
		}
		ui.settingsSection("account", Section, { title: (locale) => MESSAGES[locale].title, detail: (locale) => MESSAGES[locale].detail });
	},
} satisfies UiPlugin;
