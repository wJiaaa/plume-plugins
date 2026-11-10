import type { Remote, UiPlugin } from "@plume/contract/ui";
import { Button, Input, SettingsCard, SettingsRow, SettingsSectionTitle, Text, Toggle, useI18n } from "@plume/ui";
import { useCallback, useEffect, useState } from "react";
import type { ChannelId, ConfigPatch, ImApi, ImSettingsView } from "./api.ts";
import { MESSAGES } from "./messages.ts";
import imCss from "./im.css";

function mountStyles(): void {
	const id = "plume.im";
	let style = document.querySelector<HTMLStyleElement>(`style[data-plugin-style="${id}"]`);
	if (!style) {
		style = document.createElement("style");
		style.dataset.pluginStyle = id;
		document.head.append(style);
	}
	style.textContent = imCss;
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Messages = (typeof MESSAGES)["zh-CN"];
type Notify = (message: string, level?: "info" | "warn" | "error") => void;

function Field({
	value,
	onChange,
	onBlur,
	type = "text",
	placeholder,
}: {
	value: string;
	onChange: (value: string) => void;
	onBlur?: () => void;
	type?: string;
	placeholder?: string;
}) {
	return <Input className="im-input" type={type} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} onBlur={onBlur} />;
}

function SecretField({
	set,
	api,
	channel,
	text,
	notify,
	onSaved,
}: {
	set: boolean;
	api: Remote<ImApi>;
	channel: ChannelId;
	text: Messages;
	notify: Notify;
	onSaved: (view: ImSettingsView) => void;
}) {
	const [value, setValue] = useState("");
	const save = () => {
		const next = value.trim();
		if (!next) return;
		void api.setSecret(channel, next).then(
			(view) => {
				setValue("");
				onSaved(view);
			},
			(error: unknown) => notify(text.saveFailed(reasonOf(error)), "error"),
		);
	};
	return (
		<div className="im-secret">
			<Field value={value} onChange={setValue} onBlur={save} type="password" placeholder={text.secretPlaceholder} />
			<Text as="span" size="caption" tone="faint" className="im-secret-status">
				{set ? text.secretSet : text.secretMissing}
			</Text>
			{set && (
				<Button
					size="sm"
					variant="subtle"
					onClick={() => void api.clearSecret(channel).then(onSaved, (error: unknown) => notify(text.saveFailed(reasonOf(error)), "error"))}
				>
					{text.clear}
				</Button>
			)}
		</div>
	);
}

function ImSettings({ api, notify }: { api: Remote<ImApi>; notify: Notify }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const [view, setView] = useState<ImSettingsView | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const load = useCallback(() => {
		api.settings().then(
			(next) => {
				setView(next);
				setLoadError(null);
			},
			(error: unknown) => setLoadError(reasonOf(error)),
		);
	}, [api]);
	useEffect(load, [load]);

	const saveConfig = (input: ConfigPatch) => {
		void api.setConfig(input).then(
			(next) => setView(next),
			(error: unknown) => {
				notify(text.saveFailed(reasonOf(error)), "error");
				load();
			},
		);
	};
	const saveEnabled = (channel: ChannelId, enabled: boolean) => {
		void api.setEnabled(channel, enabled).then(
			(next) => setView(next),
			(error: unknown) => notify(text.saveFailed(reasonOf(error)), "error"),
		);
	};
	if (loadError)
		return (
			<Text as="p" size="label" tone="danger">
				{text.loadFailed(loadError)}
			</Text>
		);
	if (!view) return null;

	return (
		<div data-im-settings="">
			<SettingsSectionTitle>{text.wechat}</SettingsSectionTitle>
			<SettingsCard className="im-card">
				<SettingsRow
					title={text.enabled}
					detail={text.enabledDetail}
					control={<Toggle checked={view.wechat.enabled} onChange={(enabled) => saveEnabled("wechat", enabled)} ariaLabel={text.enabled} />}
				/>
				<SettingsRow
					title={text.baseUrl}
					detail={text.baseUrlDetail}
					control={
						<Field
							value={view.wechat.baseUrl}
							onChange={(baseUrl) => setView({ ...view, wechat: { ...view.wechat, baseUrl } })}
							onBlur={() => saveConfig({ channel: "wechat", patch: { baseUrl: view.wechat.baseUrl } })}
						/>
					}
				/>
				<SettingsRow
					title={text.botType}
					detail={text.botTypeDetail}
					control={
						<Field
							value={view.wechat.botType}
							onChange={(botType) => setView({ ...view, wechat: { ...view.wechat, botType } })}
							onBlur={() => saveConfig({ channel: "wechat", patch: { botType: view.wechat.botType } })}
						/>
					}
				/>
				<SettingsRow
					title={text.wechatToken}
					detail={text.secret}
					control={<SecretField set={view.wechat.tokenSet} api={api} channel="wechat" text={text} notify={notify} onSaved={setView} />}
				/>
			</SettingsCard>

			<SettingsSectionTitle>{text.feishu}</SettingsSectionTitle>
			<SettingsCard className="im-card">
				<SettingsRow
					title={text.enabled}
					detail={text.enabledDetail}
					control={<Toggle checked={view.feishu.enabled} onChange={(enabled) => saveEnabled("feishu", enabled)} ariaLabel={text.enabled} />}
				/>
				<SettingsRow
					title={text.appId}
					detail={text.appIdDetail}
					control={
						<Field
							value={view.feishu.appId}
							onChange={(appId) => setView({ ...view, feishu: { ...view.feishu, appId } })}
							onBlur={() => saveConfig({ channel: "feishu", patch: { appId: view.feishu.appId } })}
						/>
					}
				/>
				<SettingsRow
					title={text.domain}
					control={
						<select
							className="im-select"
							value={view.feishu.domain}
							onChange={(event) => saveConfig({ channel: "feishu", patch: { domain: event.target.value as "feishu" | "lark" } })}
						>
							<option value="feishu">{text.feishuDomain}</option>
							<option value="lark">{text.larkDomain}</option>
						</select>
					}
				/>
				<SettingsRow
					title={text.appSecret}
					detail={text.secret}
					control={<SecretField set={view.feishu.appSecretSet} api={api} channel="feishu" text={text} notify={notify} onSaved={setView} />}
				/>
			</SettingsCard>

			<SettingsSectionTitle>{text.telegram}</SettingsSectionTitle>
			<SettingsCard className="im-card">
				<SettingsRow
					title={text.enabled}
					detail={text.enabledDetail}
					control={<Toggle checked={view.telegram.enabled} onChange={(enabled) => saveEnabled("telegram", enabled)} ariaLabel={text.enabled} />}
				/>
				<SettingsRow
					title={text.botToken}
					detail={text.secret}
					control={<SecretField set={view.telegram.botTokenSet} api={api} channel="telegram" text={text} notify={notify} onSaved={setView} />}
				/>
			</SettingsCard>

			<Text as="p" size="detail" tone="faint" className="im-trust">
				{text.trust}
			</Text>
		</div>
	);
}

export default {
	name: "plume.im",
	apply(ui) {
		mountStyles();
		const api = ui.remote<ImApi>();
		const notify = ui.notify.bind(ui);
		ui.settingsSection("im", () => <ImSettings api={api} notify={notify} />, {
			title: (locale) => MESSAGES[locale].title,
			detail: (locale) => MESSAGES[locale].detail,
		});
	},
} satisfies UiPlugin;
