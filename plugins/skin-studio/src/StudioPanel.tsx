import type { Remote, UiContext } from "@plume/contract/ui";
import { Button, Confirm, Dialog, Input, Scroller, Text, TextArea, Tooltip, useI18n } from "@plume/ui";
import { Check, ClipboardPaste, Copy, Paintbrush, Plus, RotateCcw, Trash2 } from "@plume/ui/icons";
import { useId, useMemo, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import type { SkinStudioApi } from "./api.ts";
import { errorText } from "./errors.ts";
import { MESSAGES, skinName } from "./messages.ts";
import { toSkin } from "./palette.ts";
import { parseSkin, type ColorSkin, type StudioSkin } from "./types.ts";
import type { StudioStore } from "./ui-store.ts";

/** 缩略图：侧栏、主区两条字和一颗强调色胶囊，颜色取自作品数据，只在这个子树里覆盖 token。 */
function Thumb({ skin }: { skin: ColorSkin }) {
	const tokens = Object.fromEntries(
		Object.entries({ "root-image": "none", ...toSkin(skin).light }).map(([key, value]) => [`--plume-${key}`, value]),
	) as CSSProperties;
	return (
		<div className="skin-studio-thumb" style={tokens} aria-hidden="true">
			<span className="skin-studio-thumb-side" />
			<span className="skin-studio-thumb-main">
				<span className="skin-studio-thumb-bar" />
				<span className="skin-studio-thumb-bar skin-studio-thumb-short" />
				<span className="skin-studio-thumb-pill" />
			</span>
		</div>
	);
}

function RoundButton({ label, icon, onClick, disabled }: { label: string; icon: ReactNode; onClick(): void; disabled?: boolean }) {
	return (
		<Tooltip label={label} side="top">
			<button type="button" className="skin-studio-round" aria-label={label} disabled={disabled} onClick={onClick}>
				{icon}
			</button>
		</Tooltip>
	);
}

function ConnectionStatus({ store }: { store: StudioStore }) {
	const locale = useI18n().resolvedLocale;
	const text = MESSAGES[locale];
	const state = useSyncExternalStore(store.subscribe, store.get);
	if (state.status !== "error") return null;
	return (
		<div className="skin-studio-problem" role="alert">
			<Text as="p" size="detail" tone="danger">
				{text.loadFailed}
			</Text>
			{state.error !== null && (
				<Text as="p" size="detail" tone="muted">
					{errorText(state.error, locale)}
				</Text>
			)}
			<Button size="sm" onClick={store.start}>
				{text.retry}
			</Button>
		</div>
	);
}

interface DialogProps {
	api: Remote<SkinStudioApi>;
	store: StudioStore;
	onClose(): void;
}

/** 对话框自己记着在不在保存，忙碌只落在它的按钮上，不波及画廊。 */
function useSaving(store: StudioStore) {
	const [saving, setSaving] = useState(false);
	const run = async (action: Parameters<StudioStore["run"]>[0], dismiss: () => void) => {
		setSaving(true);
		const ok = await store.run(action);
		if (!store.active()) return;
		setSaving(false);
		if (ok) dismiss();
	};
	return [saving, run] as const;
}

function SaveDialog({ api, store, onClose, initialName }: DialogProps & { initialName: string }) {
	const locale = useI18n().resolvedLocale;
	const text = MESSAGES[locale];
	const state = useSyncExternalStore(store.subscribe, store.get);
	const [name, setName] = useState(initialName);
	const [saving, run] = useSaving(store);
	const id = useId();
	const valid = name.trim().length > 0 && name.trim().length <= 80;
	const save = (dismiss: () => void) => {
		if (valid && !saving) void run(() => api.saveCurrent(name.trim()), dismiss);
	};
	return (
		<Dialog
			title={text.saveTitle}
			label={text.saveTitle}
			onClose={onClose}
			width={420}
			actions={(dismiss) => (
				<>
					<Button variant="primary" disabled={!valid || state.status !== "ready"} loading={saving} onClick={() => save(dismiss)}>
						{text.save}
					</Button>
					<Button onClick={() => dismiss()}>{text.cancel}</Button>
				</>
			)}
		>
			{(dismiss) => (
				<form
					className="skin-studio-form"
					onSubmit={(event) => {
						event.preventDefault();
						save(dismiss);
					}}
				>
					<Text as="p" size="body" tone="muted">
						{text.saveDetail}
					</Text>
					<Text as="label" className="skin-studio-field">
						{text.name}
						<Input
							id={id}
							name="skin-name"
							className="plume-field"
							value={name}
							placeholder={text.namePlaceholder}
							autoFocus
							maxLength={80}
							disabled={saving}
							onChange={(event) => {
								setName(event.target.value);
								store.clearError();
							}}
						/>
					</Text>
					<Text as="p" size="caption" tone="muted">
						{text.nameHint}
					</Text>
					<ConnectionStatus store={store} />
					{state.actionError !== null && (
						<Text as="p" size="detail" tone="danger" role="alert">
							{errorText(state.actionError, locale)}
						</Text>
					)}
				</form>
			)}
		</Dialog>
	);
}

function ImportDialog({ api, store, onClose }: DialogProps) {
	const locale = useI18n().resolvedLocale;
	const text = MESSAGES[locale];
	const state = useSyncExternalStore(store.subscribe, store.get);
	const [source, setSource] = useState("");
	const [saving, run] = useSaving(store);
	const id = useId();
	const parsed = useMemo(() => {
		if (!source.trim()) return { skin: null, error: "" };
		try {
			return { skin: parseSkin(JSON.parse(source)), error: "" };
		} catch (error) {
			return { skin: null, error: error instanceof SyntaxError ? text.invalidJson : errorText(error, locale) };
		}
	}, [source, text, locale]);
	const save = (dismiss: () => void) => {
		const skin = parsed.skin;
		if (skin && !saving) void run(() => api.save(skin, true), dismiss);
	};
	return (
		<Dialog
			title={text.importTitle}
			label={text.importTitle}
			onClose={onClose}
			width={520}
			actions={(dismiss) => (
				<>
					<Button variant="primary" disabled={!parsed.skin || state.status !== "ready"} loading={saving} onClick={() => save(dismiss)}>
						{text.importApply}
					</Button>
					<Button onClick={() => dismiss()}>{text.cancel}</Button>
				</>
			)}
		>
			{(dismiss) => (
				<form
					className="skin-studio-form"
					onSubmit={(event) => {
						event.preventDefault();
						save(dismiss);
					}}
				>
					<Text as="p" size="body" tone="muted">
						{text.importDetail}
					</Text>
					<label htmlFor={id}>
						<Text>{text.json}</Text>
					</label>
					<TextArea
						id={id}
						name="skin-json"
						value={source}
						onChange={(value) => {
							setSource(value);
							store.clearError();
						}}
						shell="skin-studio-json"
						className="skin-studio-json-input"
						placeholder={text.jsonPlaceholder}
						autoFocus
						spellCheck={false}
						disabled={saving}
						aria-invalid={!!parsed.error}
						aria-describedby={`${id}-hint`}
					/>
					<Text as="p" id={`${id}-hint`} size="caption" tone="muted">
						{text.jsonHint}
					</Text>
					<ConnectionStatus store={store} />
					{parsed.error && (
						<Text as="p" size="detail" tone="danger" role="alert">
							{parsed.error}
						</Text>
					)}
					{parsed.skin && (
						<div className="skin-studio-import-preview">
							<div className="skin-studio-card">
								<Thumb skin={parsed.skin} />
								<div className="skin-studio-card-name">
									<Text size="detail" className="skin-studio-name">
										{parsed.skin.name}
									</Text>
									<Text size="caption" tone="faint">
										{parsed.skin.base === "light" ? text.light : text.dark}
									</Text>
								</div>
							</div>
						</div>
					)}
					{state.actionError !== null && (
						<Text as="p" size="detail" tone="danger" role="alert">
							{errorText(state.actionError, locale)}
						</Text>
					)}
				</form>
			)}
		</Dialog>
	);
}

export function StudioPanel({ ui, api, store, sessionId }: { ui: UiContext; api: Remote<SkinStudioApi>; store: StudioStore; sessionId?: string }) {
	const locale = useI18n().resolvedLocale;
	const text = MESSAGES[locale];
	const state = useSyncExternalStore(store.subscribe, store.get);
	const [dialog, setDialog] = useState<"save" | "import" | null>(null);
	const [removing, setRemoving] = useState<StudioSkin | null>(null);
	const active = state.view?.skins.find((skin) => skin.id === state.view?.activeId);
	// 没用工坊皮肤时，外观页选的是哪张主题卡片，这里就亮哪个。
	const theme = ui.useTheme();
	const mode = state.view && !state.view.activeId ? theme : undefined;
	const ready = state.status === "ready";

	const copy = async (skin: ColorSkin) => {
		try {
			await navigator.clipboard.writeText(JSON.stringify({ name: skin.name, base: skin.base, colors: skin.colors, backdrop: skin.backdrop }, null, 2));
			if (store.active()) ui.notify(text.copied);
		} catch {
			if (store.active()) ui.notify(text.copyFailed, "error");
		}
	};
	const design = async () => {
		// i18n-exempt：这是给模型的设计任务，追加草稿供用户修改，不是界面文案。
		const prompt = `请为 Plume 设计一套温和、清晰、适合长时间阅读的 12 色数据皮肤，优先考虑我在这条消息里补充的风格偏好。请使用 skin_studio_theme 工具，action="apply"，提供 name、base（light 或 dark）和完整的 colors，把它保存为新作品并立即应用，不要只在回复中输出 JSON。colors 必须含 bgRoot、bgMain、bgSidebar、bgElevated、bgHover、bgActive、textPrimary、textSecondary、textTertiary、accent、accentDim、border，所有值都用 #RRGGBB。textPrimary 和 textSecondary 对全部六种背景的对比度至少为 4.5:1，textTertiary 至少为 3:1。想让窗口外圈和停靠侧栏有渐变底纹时，可以再给 backdrop：from、to 两个 #RRGGBB，文字对 from、to 也要满足同样的对比度。只设计配色，不更改布局、字体或背景图片。`;
		try {
			await ui.draftInSession(sessionId || undefined, { text: prompt });
			if (store.active()) ui.notify(text.aiReady);
		} catch {
			if (store.active()) ui.notify(text.aiFailed, "error");
		}
	};

	const addCard = (
		<button
			type="button"
			className="skin-studio-add"
			aria-label={text.saveCurrent}
			disabled={!ready || !active}
			onClick={() => {
				store.clearError();
				setDialog("save");
			}}
		>
			<Plus size={20} strokeWidth={1.75} />
			<Text size="detail">{text.saveCurrent}</Text>
		</button>
	);

	return (
		<div className="skin-studio-panel" data-skin-studio="">
			<Scroller className="skin-studio-scroll" contentClassName="skin-studio-content">
				<Text as="h1" size="title" weight="semibold">
					{text.title}
				</Text>
				<ui.ChatBackgroundSettings title={text.backgroundTitle} />
				<section className="skin-studio-skins" aria-label={text.skinsTitle}>
					<div className="skin-studio-head">
						<Text as="h2" size="label" weight="semibold" tone="muted">
							{text.skinsTitle}
						</Text>
						<div className="skin-studio-row-actions">
							<RoundButton label={text.ai} icon={<Paintbrush size={15} />} onClick={() => void design()} />
							<RoundButton
								label={text.import}
								icon={<ClipboardPaste size={15} />}
								disabled={!ready}
								onClick={() => {
									store.clearError();
									setDialog("import");
								}}
							/>
							<RoundButton
								label={text.restore}
								icon={<RotateCcw size={15} />}
								disabled={!ready || !state.view?.activeId}
								onClick={() => void store.run(() => api.apply(null))}
							/>
						</div>
					</div>
					<div className="skin-studio-row" data-skin-default="">
						<Text size="detail" tone="faint" className="skin-studio-row-label">
							{text.systemTheme}
						</Text>
						<div className="skin-studio-seg" role="group" aria-label={text.systemTheme}>
							{(["system", "light", "dark"] as const).map((value) => (
								<button key={value} type="button" aria-pressed={mode === value} disabled={!ready} onClick={() => void store.chooseTheme(value)}>
									<Text tone={mode === value ? "accent" : "default"} weight={mode === value ? "semibold" : undefined}>
										{text[value]}
									</Text>
								</button>
							))}
						</div>
					</div>
					<ConnectionStatus store={store} />
					{state.actionError !== null && !dialog && (
						<Text as="p" size="detail" tone="danger" role="alert">
							{errorText(state.actionError, locale)}
						</Text>
					)}
					<div className="skin-studio-grid">
						{state.view
							? state.view.skins.map((skin) => {
									const name = skinName(skin, locale);
									const selected = skin.id === state.view?.activeId;
									return (
										<article key={skin.id} className="skin-studio-card" data-selected={selected} data-skin-id={skin.id}>
											<button
												type="button"
												className="skin-studio-choice"
												aria-label={text.apply(name)}
												aria-pressed={selected}
												disabled={!ready}
												onClick={() => {
													if (!selected) void store.run(() => api.apply(skin.id));
												}}
											/>
											<Thumb skin={skin} />
											<div className="skin-studio-card-name">
												<Text size="detail" className="skin-studio-name">
													{name}
												</Text>
												<span className="skin-studio-card-actions">
													<button
														type="button"
														className="skin-studio-mini"
														aria-label={text.copyNamed(name)}
														title={text.copy}
														onClick={() => void copy(skin)}
													>
														<Copy size={11} />
													</button>
													{!skin.builtin && (
														<button
															type="button"
															className="skin-studio-mini"
															aria-label={text.removeNamed(name)}
															title={text.remove}
															disabled={!ready}
															onClick={() => setRemoving(skin)}
														>
															<Trash2 size={11} />
														</button>
													)}
												</span>
											</div>
											{selected && (
												<span className="skin-studio-badge" aria-hidden="true">
													<Check size={12} strokeWidth={3} />
												</span>
											)}
										</article>
									);
								})
							: // 首次加载用和卡片同尺寸的占位，数据到了不跳版。
								[0, 1, 2, 3].map((index) => <div key={index} className="skin-studio-card skin-studio-skeleton" aria-hidden="true" />)}
						{state.view &&
							(active ? (
								addCard
							) : (
								<Tooltip label={text.saveNeedsSkin} side="top">
									{addCard}
								</Tooltip>
							))}
					</div>
				</section>
			</Scroller>
			{dialog === "save" && (
				<SaveDialog
					api={api}
					store={store}
					initialName={active ? text.copyName(skinName(active, locale)) : text.currentCopyName}
					onClose={() => setDialog(null)}
				/>
			)}
			{dialog === "import" && <ImportDialog api={api} store={store} onClose={() => setDialog(null)} />}
			{removing && (
				<Confirm
					title={text.removeTitle(skinName(removing, locale))}
					detail={removing.id === state.view?.activeId ? text.removeActiveDetail : text.removeDetail}
					confirmLabel={text.remove}
					cancelLabel={text.cancel}
					onCancel={() => setRemoving(null)}
					onConfirm={() => {
						const id = removing.id;
						setRemoving(null);
						void store.run(() => api.remove(id));
					}}
				/>
			)}
		</div>
	);
}
