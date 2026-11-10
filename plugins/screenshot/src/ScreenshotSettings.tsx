/**
 * 设置页里「截图」那一节：快捷键、输入框按钮、保存位置和完成后做什么。页头由宿主画。
 */

import type { ScreenCapture } from "@plume/contract/ui";
import { Button, SettingsCard, SettingsRow, SettingsSectionTitle, ShortcutRecorder, shortcutLabel, Toggle, useI18n } from "@plume/ui";
import { Camera, Eraser, FolderOpen, RotateCcw } from "@plume/ui/icons";
import type { ScreenshotSettings as Settings } from "./api.ts";
import { MESSAGES } from "./messages.ts";
import { type SettingsStore, useSettings, useShortcutStatus } from "./settings-store.ts";

export function ScreenshotSettings({ store, screen }: { store: SettingsStore; screen: ScreenCapture }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const config = useSettings(store);
	const shortcutStatus = useShortcutStatus(store);

	const patch = (patchObj: Partial<Settings>) => void store.update(patchObj);

	/** 两个目标用同一个选择器，填进哪个是调用方的事。 */
	const pickDirectory = async (into: "saveLocation" | "downloadLocation", title: string) => {
		const dir = await screen.pickDirectory(title);
		if (dir) patch({ [into]: dir });
	};

	const shortcutProblem =
		config.enabled && config.shortcut ? (shortcutStatus === "taken" ? text.shortcutTaken : shortcutStatus === "invalid" ? text.shortcutInvalid : null) : null;

	return (
		<div data-screenshot-settings="">
			<SettingsSectionTitle>{text.shortcutSection}</SettingsSectionTitle>
			<SettingsCard className="shot-settings-card">
				<SettingsRow title={text.enable} detail={text.enableDetail} control={<Toggle checked={config.enabled} onChange={(enabled) => patch({ enabled })} />} />
				<SettingsRow
					title={text.shortcut}
					detail={shortcutProblem ? <span className="shot-settings-problem">{shortcutProblem}</span> : text.shortcutDetail}
					control={
						<div className="shot-settings-actions">
							<ShortcutRecorder value={config.shortcut} onChange={(shortcut) => patch({ shortcut })} />
							{config.shortcut && (
								<Button size="sm" icon={<Eraser size={13} strokeWidth={1.8} aria-hidden />} onClick={() => patch({ shortcut: "" })}>
									{text.clear}
								</Button>
							)}
						</div>
					}
				/>
				<SettingsRow
					title={text.composerButton}
					detail={text.composerButtonDetail}
					control={<Toggle checked={config.showInComposer} onChange={(showInComposer) => patch({ showInComposer })} />}
				/>
				<SettingsRow
					title={text.test}
					detail={text.testDetail}
					control={
						<Button size="sm" disabled={!config.enabled} icon={<Camera size={14} strokeWidth={2} aria-hidden />} onClick={() => void screen.start()}>
							{text.now}
						</Button>
					}
				/>
			</SettingsCard>

			<SettingsSectionTitle>{text.saveSection}</SettingsSectionTitle>
			<SettingsCard className="shot-settings-card">
				<SettingsRow
					title={text.saveLocation}
					detail={config.saveLocation.trim() ? text.savedTo(config.saveLocation) : text.noDirectory}
					control={
						<div className="shot-settings-actions">
							{config.saveLocation.trim() && (
								<Button size="sm" icon={<Eraser size={13} strokeWidth={1.8} aria-hidden />} onClick={() => patch({ saveLocation: "" })}>
									{text.clear}
								</Button>
							)}
							<Button
								size="sm"
								icon={<FolderOpen size={14} strokeWidth={2} aria-hidden />}
								onClick={() => void pickDirectory("saveLocation", text.chooseSaveDirectory)}
							>
								{config.saveLocation.trim() ? text.chooseDirectory : text.chooseSaveDirectory}
							</Button>
						</div>
					}
				/>
				{/*
				 * 「下载」存到哪，和上面是两个问题。上面那个是每次完成都自动留下的一份，多数人故意空着；这是工具栏的下载按钮，
				 * 文件本身就是目的——空着等于桌面而不是不存，这一行直接说出来，不让人按了再去找。
				 */}
				<SettingsRow
					title={text.downloadLocation}
					detail={config.downloadLocation.trim() ? text.downloadTo(config.downloadLocation) : text.downloadToDesktop}
					control={
						<div className="shot-settings-actions">
							{config.downloadLocation.trim() && (
								<Button size="sm" icon={<RotateCcw size={13} strokeWidth={1.8} aria-hidden />} onClick={() => patch({ downloadLocation: "" })}>
									{text.restoreDefault}
								</Button>
							)}
							<Button
								size="sm"
								icon={<FolderOpen size={14} strokeWidth={2} aria-hidden />}
								onClick={() => void pickDirectory("downloadLocation", text.chooseDownloadDirectory)}
							>
								{config.downloadLocation.trim() ? text.chooseDirectory : text.chooseDownloadDirectory}
							</Button>
						</div>
					}
				/>
				<SettingsRow
					title={text.annotate}
					detail={text.annotateDetail}
					control={<Toggle checked={config.openEditor} onChange={(openEditor) => patch({ openEditor })} />}
				/>
				<SettingsRow
					title={text.autoInsert}
					detail={text.autoInsertDetail}
					control={<Toggle checked={config.insertIntoComposer} onChange={(insertIntoComposer) => patch({ insertIntoComposer })} />}
				/>
				<SettingsRow
					title={text.copyOnDone}
					detail={shortcutLabel(text.copyOnDoneDetail)}
					control={<Toggle checked={config.copyToClipboard} onChange={(copyToClipboard) => patch({ copyToClipboard })} />}
				/>
			</SettingsCard>
		</div>
	);
}
