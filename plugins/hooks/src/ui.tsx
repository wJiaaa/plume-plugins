/**
 * plume.hooks 的界面入口，跑在渲染进程：设置页里「钩子」那一节、回复底下的「钩子」运行记录按钮、输入框上方的「待审核」提示。
 * 设置页列出用户钩子或某个项目的钩子，开关、新建、编辑、删除、信任都经逻辑入口（`ui.remote()`）改插件数据目录里的
 * `hooks.json` 或项目的 `.plume/config.json`。
 *
 * 样式只用 @plume/ui 的组件（文字用 Text）和 var(--plume-*)，不写 Tailwind 类（插件单独构建，产品扫不到）。
 */

import type { ProjectInfo, Remote, UiPlugin } from "@plume/contract/ui";
import {
	Button,
	Dialog,
	MENU_MAX_HEIGHT,
	MenuBody,
	MenuItem,
	MenuLabel,
	MenuSeparator,
	Popover,
	Segmented,
	Select,
	SettingsCard,
	Text,
	TextArea,
	Toggle,
	useConfirmer,
	useI18n,
	usePopover,
} from "@plume/ui";
import { Anchor, Check, ChevronDown, ChevronRight, Folder, Monitor, Plus, RefreshCw, ShieldCheck, TriangleAlert } from "@plume/ui/icons";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { HookDraft, HookEventName, HookScope, HooksApi, HookView, HooksView } from "./api.ts";
import { HookRunsAction, RunsCache } from "./HookRuns.tsx";
import { HookTrustBanner } from "./HookTrustBanner.tsx";
import hooksCss from "./hooks.css";
import { type Messages, MESSAGES } from "./messages.ts";
import { hooksChanged, hooksProject } from "./scope.ts";

type Notify = (message: string, level?: "info" | "warn" | "error") => void;

const EVENTS: HookEventName[] = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PermissionRequest",
	"PostToolUse",
	"PostToolUseFailure",
	"Stop",
	"StopFailure",
	"SessionEnd",
];

type MatcherSubject = "tool" | "start" | "turnEnd" | "sessionEnd";

/**
 * 匹配器在每种事件上比的是什么：工具类事件比工具名，SessionStart 比会话怎么开始，StopFailure、SessionEnd 比结束原因。
 * UserPromptSubmit 和 Stop 什么也不传——那里写了匹配器，钩子就一次也不会跑，所以表单在这两个事件上把它关掉，
 * 而不是让人填一个静默失效的东西。
 */
const SUBJECTS: Record<HookEventName, MatcherSubject | null> = {
	SessionStart: "start",
	UserPromptSubmit: null,
	PreToolUse: "tool",
	PermissionRequest: "tool",
	PostToolUse: "tool",
	PostToolUseFailure: "tool",
	Stop: null,
	StopFailure: "turnEnd",
	SessionEnd: "sessionEnd",
};

function matcherHint(text: Messages, subject: MatcherSubject | null): string {
	if (subject === "tool") return text.matcherHintTool;
	if (subject === "start") return text.matcherHintStart;
	if (subject === "turnEnd") return text.matcherHintTurnEnd;
	if (subject === "sessionEnd") return text.matcherHintSessionEnd;
	return text.matcherHintNone;
}

function matcherPlaceholder(text: Messages, subject: MatcherSubject | null): string {
	if (subject === "tool") return text.matcherPlaceholderTool;
	if (subject === "start") return text.matcherPlaceholderStart;
	if (subject === "turnEnd") return text.matcherPlaceholderTurnEnd;
	if (subject === "sessionEnd") return text.matcherPlaceholderSessionEnd;
	return "";
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function mountStyles(): void {
	const id = "plume.hooks";
	let style = document.querySelector<HTMLStyleElement>(`style[data-plugin-style="${id}"]`);
	if (!style) {
		style = document.createElement("style");
		style.dataset.pluginStyle = id;
		document.head.append(style);
	}
	style.textContent = hooksCss;
}

function matchesQuery(hook: HookView, query: string): boolean {
	if (!query) return true;
	return [hook.event, hook.type, hook.matcher, hook.command, ...(hook.args ?? [])].some((value) => value?.toLowerCase().includes(query));
}

/** 一个文件夹一个选择：几个项目登记在同一个文件夹上时，这几页改的是那个文件夹里的东西，名字一起说出来。 */
function folders(projects: readonly ProjectInfo[]): { path: string; name: string }[] {
	const byPath = new Map<string, string[]>();
	for (const project of projects) byPath.set(project.path, [...(byPath.get(project.path) ?? []), project.name]);
	return [...byPath].map(([path, names]) => ({ path, name: names.join(" / ") }));
}

function HooksSettings({ api, notify, projects }: { api: Remote<HooksApi>; notify: Notify; projects: readonly ProjectInfo[] }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const choices = useMemo(() => folders(projects), [projects]);
	/** null 是用户级；项目被移除后回到用户级，而不是继续读一个已经不在列表里的目录。 */
	const projectPath = useSyncExternalStore(hooksProject.subscribe, hooksProject.get);
	const project = choices.find((entry) => entry.path === projectPath) ?? null;
	const cwd = project?.path ?? null;
	const scope: HookScope = project ? "project" : "user";
	const [view, setView] = useState<HooksView | null>(null);
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	/** `undefined` 是没开弹窗；`null` 是新建；一条钩子是在编辑它。 */
	const [editing, setEditing] = useState<HookView | null | undefined>(undefined);
	const confirmer = useConfirmer();

	// 换了项目以后，上一个项目晚到的列表不能落在这一个下面。
	const currentCwd = useRef(cwd);
	currentCwd.current = cwd;
	const refresh = useCallback(() => {
		void api
			.list(cwd)
			.then((next) => {
				if (currentCwd.current === cwd) setView(next);
			})
			.catch((error: unknown) => notify(text.readFailed(reasonOf(error)), "error"));
	}, [api, cwd, notify, text]);
	useEffect(refresh, [refresh]);
	// 配置文件也可能在外面的编辑器里改过、拉一次代码就变了，回到窗口时重读，不留一份过期的列表。
	useEffect(() => {
		window.addEventListener("focus", refresh);
		return () => window.removeEventListener("focus", refresh);
	}, [refresh]);

	const run = async (id: string, action: () => Promise<HooksView>) => {
		setBusy(id);
		try {
			setView(await action());
			hooksChanged.emit();
		} catch (error) {
			notify(reasonOf(error), "error");
		} finally {
			setBusy(null);
		}
	};

	const scopes = useMemo(
		() => [{ value: "user" as const, label: text.user }, ...(project ? [{ value: "project" as const, label: project.name }] : [])],
		[project, text],
	);
	const hooks = (scope === "project" ? view?.project : view?.user) ?? [];
	const needle = query.trim().toLowerCase();
	const visible = hooks.filter((hook) => matchesQuery(hook, needle));
	const untrusted = scope === "project" && hooks.some((hook) => hook.trusted === false);
	// 用户钩子的文件读不懂时，用户这一层改不了；项目那一层不受它连累。
	const blocked = scope === "user" ? Boolean(view?.error) : Boolean(view?.projectError);

	return (
		<div data-hooks-settings="">
			<ProjectScope value={project} choices={choices} onChange={hooksProject.set} text={text} />
			{untrusted && view?.projectPath && (
				<div className="hook-notice" role="status" data-hook-trust-notice="">
					<TriangleAlert size={14} strokeWidth={1.8} className="hook-notice-icon" aria-hidden />
					<Text size="detail" tone="muted">
						{text.trustNotice(view.projectPath)}
					</Text>
				</div>
			)}
			{scope === "user" && view?.error && (
				<div className="hook-problem" role="status">
					<Text size="detail" tone="danger">
						{view.error}
					</Text>
				</div>
			)}
			{scope === "project" && view?.projectError && (
				<div className="hook-problem" role="status">
					<Text size="detail" tone="danger">
						{text.projectError(view.projectError)}
					</Text>
				</div>
			)}

			<div className="hook-head">
				<div className="hook-head-title">
					<Text size="label" weight="medium">
						{text.installed}
					</Text>
					<Text size="detail" tone="faint" numeric>
						{hooks.length}
					</Text>
				</div>
				<div className="hook-head-actions">
					<Button variant="subtle" size="sm" icon={<RefreshCw size={13} aria-hidden />} label={text.refresh} onClick={refresh} />
					<Button size="sm" icon={<Plus size={13} aria-hidden />} disabled={blocked} onClick={() => setEditing(null)}>
						{text.newHook}
					</Button>
				</div>
			</div>

			{hooks.length > 0 && (
				<Text size="label">
					<input
						className="hook-search"
						type="search"
						value={query}
						placeholder={text.searchPlaceholder}
						aria-label={text.searchPlaceholder}
						onChange={(event) => setQuery(event.target.value)}
					/>
				</Text>
			)}

			{view && !blocked && hooks.length === 0 ? (
				<SettingsCard>
					<div className="hook-empty">
						<Text size="label" weight="medium">
							{text.emptyTitle}
						</Text>
						<Text as="p" size="detail" tone="faint">
							{text.emptyDetail}
						</Text>
						<Button variant="primary" icon={<Plus size={13} aria-hidden />} onClick={() => setEditing(null)}>
							{text.add}
						</Button>
					</div>
				</SettingsCard>
			) : hooks.length > 0 && visible.length === 0 ? (
				<SettingsCard>
					<div className="hook-empty">
						<Text size="label" tone="faint">
							{text.searchEmpty}
						</Text>
					</div>
				</SettingsCard>
			) : (
				visible.length > 0 && (
					<SettingsCard>
						{visible.map((hook) => (
							<HookRow
								key={hook.id}
								hook={hook}
								busy={busy === hook.id}
								text={text}
								onEdit={() => setEditing(hook)}
								onTrust={() => cwd && void run(hook.id, async () => await api.trust(cwd, [hook.id]))}
								onToggle={(enabled) => void run(hook.id, async () => await api.setEnabled(hook.scope, cwd, hook.id, enabled))}
							/>
						))}
					</SettingsCard>
				)
			)}

			{editing !== undefined && (
				<HookForm
					key={editing?.id ?? "new"}
					hook={editing ?? undefined}
					text={text}
					scopes={scopes}
					defaultScope={scope}
					onClose={() => setEditing(undefined)}
					onSave={async (saveScope, draft) => {
						try {
							setView(await api.save(saveScope, cwd, editing?.id ?? null, draft));
							hooksChanged.emit();
							if (saveScope === "user") hooksProject.set(null);
							return null;
						} catch (error) {
							return reasonOf(error);
						}
					}}
					onDelete={
						editing
							? () =>
									confirmer.ask({
										title: text.deleteTitle,
										detail: text.deleteDetail(editing.event),
										confirmLabel: text.delete,
										cancelLabel: text.cancel,
										onConfirm: () => {
											void run(editing.id, async () => await api.remove(editing.scope, cwd, editing.id)).then(() => setEditing(undefined));
										},
									})
							: undefined
					}
				/>
			)}
			{confirmer.element}
		</div>
	);
}

/**
 * 这一页看哪一层：用户的，或某一个项目的。胶囊靠一圈细线立住而不是垫底色——它是「在哪儿看」，不是工具条里的又一项。
 */
function ProjectScope({
	value,
	choices,
	onChange,
	text,
}: {
	value: { path: string; name: string } | null;
	choices: { path: string; name: string }[];
	onChange: (path: string | null) => void;
	text: Messages;
}) {
	const menu = usePopover();
	const option = (choice: { path: string; name: string } | null) => {
		const chosen = (choice?.path ?? null) === (value?.path ?? null);
		return (
			<MenuItem
				key={choice?.path ?? ""}
				selected={chosen}
				icon={choice ? <Folder size={14} strokeWidth={1.8} /> : <Monitor size={14} strokeWidth={1.8} />}
				trailing={chosen ? <Check size={13} strokeWidth={2.2} /> : undefined}
				onClick={() => {
					onChange(choice?.path ?? null);
					menu.close();
				}}
			>
				{choice?.name ?? text.user}
			</MenuItem>
		);
	};
	return (
		<>
			<button
				type="button"
				onClick={menu.toggle}
				aria-label={text.projectScope}
				aria-haspopup="menu"
				aria-expanded={menu.open}
				data-project-scope=""
				className="hook-scope"
			>
				{value ? <Folder size={14} strokeWidth={1.8} /> : <Monitor size={14} strokeWidth={1.8} />}
				<Text size="label" className="hook-scope-name">
					{value?.name ?? text.user}
				</Text>
				<ChevronDown size={13} strokeWidth={1.9} className="hook-scope-caret" data-open={menu.open || undefined} />
			</button>
			{menu.open && (
				<Popover anchor={menu.anchor} onClose={menu.close} placement="bottom" align="start" width="default" maxHeight={MENU_MAX_HEIGHT}>
					<MenuBody insetIcons>
						{option(null)}
						{choices.length > 0 && (
							<>
								<MenuSeparator />
								<MenuLabel>{text.workspace}</MenuLabel>
								{choices.map(option)}
							</>
						)}
					</MenuBody>
				</Popover>
			)}
		</>
	);
}

function HookRow({
	hook,
	busy,
	text,
	onEdit,
	onTrust,
	onToggle,
}: {
	hook: HookView;
	busy: boolean;
	text: Messages;
	onEdit: () => void;
	onTrust: () => void;
	onToggle: (enabled: boolean) => void;
}) {
	const untrusted = hook.trusted === false;
	const command = [hook.command, ...(hook.args ?? [])].join(" ");
	return (
		<div
			className="hook-row"
			role="button"
			tabIndex={0}
			data-hook-row=""
			onClick={busy ? undefined : onEdit}
			onKeyDown={(event) => {
				if (event.target !== event.currentTarget || busy || (event.key !== "Enter" && event.key !== " ")) return;
				event.preventDefault();
				onEdit();
			}}
		>
			<span className="hook-row-mark" aria-hidden>
				<Anchor size={16} strokeWidth={1.8} />
			</span>
			<span className="hook-row-body">
				<span className="hook-row-title">
					<Text size="label" weight="medium">
						{hook.event}
					</Text>
					{hook.matcher && (
						<Text size="detail" mono tone="faint">
							{hook.matcher}
						</Text>
					)}
				</span>
				<Text size="detail" mono tone="faint">
					{command}
				</Text>
			</span>
			{/* 行上的控件不冒泡：点「信任」或开关不该顺便打开编辑表单。 */}
			<span className="hook-row-side" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
				{untrusted && (
					<Button size="sm" disabled={busy} icon={<ShieldCheck size={13} aria-hidden />} onClick={onTrust} data-hook-trust="">
						{text.trust}
					</Button>
				)}
				{/* 没信任的强制显示为关、并且不能开：先审，再用。 */}
				<Toggle checked={untrusted ? false : hook.enabled} onChange={onToggle} disabled={busy || untrusted} ariaLabel={hook.event} />
			</span>
		</div>
	);
}

function parseCustom(text: string): Record<string, unknown> | undefined | null {
	if (!text.trim()) return undefined;
	try {
		const parsed = JSON.parse(text) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** 一个表单字段：标签、控件、下面一行提示或错误。 */
function Field({
	id,
	label,
	optional,
	hint,
	error,
	disabled,
	text,
	children,
}: {
	id?: string;
	label: string;
	optional?: boolean;
	hint?: string;
	error?: string | null;
	disabled?: boolean;
	text: Messages;
	children: React.ReactNode;
}) {
	return (
		<div className="hook-field" data-disabled={disabled ? "true" : undefined}>
			<span className="hook-field-label">
				<Text size="detail" weight="medium" tone={disabled ? "faint" : undefined} {...(id ? { id: `${id}-label` } : {})}>
					{label}
				</Text>
				{optional && (
					<Text size="detail" tone="faint">
						{text.optional}
					</Text>
				)}
			</span>
			{children}
			{(error || hint) && (
				<Text as="p" size="detail" tone={error ? "danger" : "faint"}>
					{error ?? hint}
				</Text>
			)}
		</div>
	);
}

function TextField({
	id,
	value,
	onChange,
	placeholder,
	mono,
	disabled,
	inputMode,
}: {
	id?: string;
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	mono?: boolean;
	disabled?: boolean;
	inputMode?: "numeric";
}) {
	return (
		<Text size="label">
			<input
				className={mono ? "hook-input hook-mono" : "hook-input"}
				{...(id ? { "aria-labelledby": `${id}-label` } : {})}
				value={value}
				disabled={disabled}
				placeholder={placeholder}
				spellCheck={false}
				inputMode={inputMode}
				onChange={(event) => onChange(event.target.value)}
			/>
		</Text>
	);
}

/**
 * 新建和编辑一条钩子，在弹窗里。字段：事件、匹配器、运行方式、命令，进程型再加参数，Shell 型再加 shell 和后台运行；
 * 超时、状态消息和原样保留的自定义字段收在「高级」里。
 */
function HookForm({
	hook,
	text,
	scopes,
	defaultScope,
	onSave,
	onClose,
	onDelete,
}: {
	hook?: HookView;
	text: Messages;
	scopes: { value: HookScope; label: string }[];
	defaultScope: HookScope;
	onSave: (scope: HookScope, draft: HookDraft) => Promise<string | null>;
	onClose: () => void;
	onDelete?: () => void;
}) {
	const [scope, setScope] = useState<HookScope>(hook?.scope ?? defaultScope);
	const [event, setEvent] = useState<HookEventName>(hook?.event ?? "PreToolUse");
	const [type, setType] = useState<HookDraft["type"]>(hook?.type ?? "process");
	const [matcher, setMatcher] = useState(hook?.matcher ?? "");
	const [command, setCommand] = useState(hook?.command ?? "");
	const [args, setArgs] = useState((hook?.args ?? []).join("\n"));
	const [background, setBackground] = useState(hook?.async ?? false);
	const [shell, setShell] = useState(typeof hook?.shell === "string" ? hook.shell : "");
	const [timeoutText, setTimeoutText] = useState(hook?.timeout === undefined ? "" : String(hook.timeout));
	const [statusMessage, setStatusMessage] = useState(hook?.statusMessage ?? "");
	const [customJson, setCustomJson] = useState(hook?.custom ? JSON.stringify(hook.custom, null, 2) : "");
	const [saving, setSaving] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	const custom = parseCustom(customJson);
	const canSave = Boolean(command.trim()) && custom !== null && !saving;
	const subject = SUBJECTS[event];
	const title = hook ? text.edit : text.add;

	const save = async (dismiss: () => void) => {
		if (!canSave) return;
		const seconds = Number.parseInt(timeoutText, 10);
		setSaving(true);
		setFailure(null);
		const problem = await onSave(scope, {
			event,
			// 不看匹配器的事件上不存它：存下去，这条钩子就一次也不会跑。
			...(subject && matcher.trim() ? { matcher: matcher.trim() } : {}),
			type,
			command: command.trim(),
			...(type === "process"
				? {
						args: args
							.split("\n")
							.map((arg) => arg.trim())
							.filter(Boolean),
					}
				: {
						async: background,
						// 配置文件里写的是 `shell: true`（用系统默认的那个）时，框里是空的，存回去仍是 true。
						...(shell.trim() ? { shell: shell.trim() } : hook?.shell === true ? { shell: true as const } : {}),
					}),
			...(statusMessage.trim() ? { statusMessage: statusMessage.trim() } : {}),
			...(seconds > 0 ? { timeout: seconds } : {}),
			enabled: hook?.enabled ?? true,
			...(custom ? { custom } : {}),
		});
		setSaving(false);
		if (problem) setFailure(problem);
		else dismiss();
	};

	return (
		<Dialog
			onClose={onClose}
			width={560}
			label={title}
			title={title}
			icon={<Anchor size={16} />}
			status={
				failure ? (
					<Text as="p" size="detail" tone="danger" role="alert">
						{failure}
					</Text>
				) : undefined
			}
			actions={(dismiss) => (
				<>
					{onDelete && (
						<Button variant="danger" onClick={onDelete}>
							{text.delete}
						</Button>
					)}
					<span className="hook-spacer" />
					<Button onClick={() => dismiss()}>{text.cancel}</Button>
					<Button variant="primary" disabled={!canSave} loading={saving} onClick={() => void save(() => dismiss())} data-hook-save="">
						{hook ? text.save : text.create}
					</Button>
				</>
			)}
		>
			{(dismiss) => (
				<form
					className="hook-form"
					data-hook-form=""
					onSubmit={(submitted) => {
						submitted.preventDefault();
						void save(() => dismiss());
					}}
				>
					<div className="hook-pair">
						<Field label={text.event} text={text}>
							<Select value={event} onChange={setEvent} options={EVENTS.map((name) => ({ value: name, label: name }))} ariaLabel={text.event} />
						</Field>
						<Field label={text.scope} text={text}>
							{/* 编辑时不能换范围：换过去就是另一个文件里的另一条了，先删再建说得更清楚。 */}
							{hook || scopes.length < 2 ? (
								<Text as="div" size="label" tone="muted" className="hook-input hook-fixed" data-hook-scope={scope}>
									{scopes.find((entry) => entry.value === scope)?.label ?? scope}
								</Text>
							) : (
								<span className="hook-fit">
									<Segmented value={scope} onChange={setScope} options={scopes} />
								</span>
							)}
						</Field>
					</div>

					<Field
						id="plume-hook-matcher"
						label={text.matcher}
						optional={subject !== null}
						disabled={subject === null}
						hint={matcherHint(text, subject)}
						text={text}
					>
						<TextField
							id="plume-hook-matcher"
							value={subject ? matcher : ""}
							onChange={setMatcher}
							disabled={subject === null}
							placeholder={matcherPlaceholder(text, subject)}
							mono
						/>
					</Field>

					<Field label={text.type} text={text}>
						<span className="hook-fit">
							<Segmented
								value={type}
								onChange={setType}
								options={[
									{ value: "process", label: text.typeProcess },
									{ value: "command", label: text.typeCommand },
								]}
							/>
						</span>
					</Field>

					<Field id="plume-hook-command" label={text.command} text={text}>
						<TextField id="plume-hook-command" value={command} onChange={setCommand} placeholder={text.commandPlaceholder} mono />
					</Field>

					{type === "process" ? (
						<Field label={text.args} optional hint={text.argsHint} text={text}>
							<TextArea value={args} onChange={setArgs} rows={3} className="hook-mono" aria-label={text.args} resizable />
						</Field>
					) : (
						<div className="hook-pair">
							<Field id="plume-hook-shell" label={text.shell} text={text}>
								<TextField id="plume-hook-shell" value={shell} onChange={setShell} placeholder={text.shellPlaceholder} mono />
							</Field>
							<span className="hook-switch">
								<Text size="detail" weight="medium">
									{text.async}
								</Text>
								<Toggle checked={background} onChange={setBackground} ariaLabel={text.async} />
							</span>
						</div>
					)}

					<details className="hook-advanced">
						<summary>
							<ChevronRight size={14} aria-hidden />
							<Text size="detail" tone="muted">
								{text.advanced}
							</Text>
						</summary>
						<div className="hook-advanced-body">
							<div className="hook-pair">
								<Field id="plume-hook-timeout" label={text.timeout} hint={text.timeoutHint} text={text}>
									<TextField id="plume-hook-timeout" value={timeoutText} onChange={setTimeoutText} inputMode="numeric" placeholder="60" />
								</Field>
								<Field id="plume-hook-status" label={text.statusMessage} optional text={text}>
									<TextField id="plume-hook-status" value={statusMessage} onChange={setStatusMessage} placeholder={text.statusMessagePlaceholder} />
								</Field>
							</div>
							<Field label={text.customJson} optional error={custom === null ? text.customJsonError : null} text={text}>
								<TextArea
									value={customJson}
									onChange={setCustomJson}
									rows={4}
									className="hook-mono"
									aria-label={text.customJson}
									placeholder={'{\n  "customKey": "value"\n}'}
									resizable
								/>
							</Field>
						</div>
					</details>
					{/* 表单里按 Enter 提交要有一个 submit 按钮；看不见的这一个只为它。 */}
					<button type="submit" hidden aria-hidden tabIndex={-1} />
				</form>
			)}
		</Dialog>
	);
}

export default {
	name: "plume.hooks",
	apply(ui) {
		mountStyles();
		const api = ui.remote<HooksApi>();
		const notify = ui.notify.bind(ui);
		ui.settingsSection("hooks", () => <HooksSettings api={api} notify={notify} projects={ui.useProjects()} />, {
			title: (locale) => MESSAGES[locale].settingsTitle,
			detail: (locale) => MESSAGES[locale].intro,
			icon: Anchor,
			order: 2,
			group: "agent",
			page: "nav",
		});

		const runs = new RunsCache(api);
		ui.effect(runs.connect());
		ui.replyAction("runs", (props) => <HookRunsAction cache={runs} {...props} />);
		ui.composerAbove("trust", ({ session }) => (
			<HookTrustBanner
				api={api}
				session={session}
				onReview={(cwd) => {
					hooksProject.set(cwd);
					ui.openSettings("hooks");
				}}
			/>
		));
	},
} satisfies UiPlugin;
