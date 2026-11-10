/**
 * 侧栏「SSH 主机」页：运维台。左边是主机库（搜索名字、地址、标签，按收藏和分组筛，按分组排开），点一台就在中间开一个终端
 * 标签连上它（已经有它的标签就切过去）；中间是终端标签，一个标签一条连接；右边固定一列「AI 运维助手」，它能请求在这里连着的
 * 任意一条连接上执行命令，每条都要人批准。头上「资源占用」开关管所有连接的状态栏读数，「批量命令」「管理分组」开各自的对话框。
 *
 * 连接住在逻辑入口里：离开这一页再回来，标签和终端里的字都还在。
 */

import type { Remote, UiContext } from "@plume/contract/ui";
import {
	Button,
	Dialog,
	IconButton,
	Input,
	MENU_MAX_HEIGHT,
	MenuBody,
	MenuItem,
	MenuLabel,
	MenuSeparator,
	PageTopRow,
	PanelEmpty,
	Popover,
	Scroller,
	SearchField,
	Select,
	Text,
	Toggle,
	useConfirmer,
	useI18n,
	usePopover,
} from "@plume/ui";
import { field, fieldLabel } from "@plume/styles";
import {
	Check,
	FileSpreadsheet,
	FolderTree,
	MoreHorizontal,
	PanelLeftClose,
	PanelLeftOpen,
	Pencil,
	Plus,
	Server,
	SquareTerminal,
	Star,
	Terminal,
	Trash2,
	X,
} from "@plume/ui/icons";
import { type ReactNode, useMemo, useState } from "react";
import type { ConnectionView, HostGroup, HostInput, HostProfile, SshApi } from "./api.ts";
import { AssistantColumn } from "./AssistantColumn.tsx";
import { BatchDialog } from "./BatchDialog.tsx";
import { errorText, type SshClient, useSshState } from "./client.ts";
import { ConnectionPane } from "./ConnectionPane.tsx";
import { address, fuzzyMatch, parseTags } from "./format.ts";
import { ImportDialog } from "./ImportDialog.tsx";
import { type Messages, MESSAGES } from "./messages.ts";

type Host = Pick<UiContext, "notify" | "droppedPaths" | "Conversation" | "useSession">;
/** 主机列表的筛选：全部、收藏、未分组，或某个分组的 id。 */
type Filter = "all" | "favorites" | "none" | (string & {});

const HOSTS_KEY = "plume.ssh.hosts.collapsed";
const NO_HOSTS: HostProfile[] = [];
const NO_GROUPS: HostGroup[] = [];
const NO_CONNECTIONS: ConnectionView[] = [];

/** 选中的终端标签：离开这一页、页面卸掉再挂上时接着显示它。 */
let lastTab: string | null = null;

function storedCollapsed(): boolean {
	try {
		return localStorage.getItem(HOSTS_KEY) === "1";
	} catch {
		return false;
	}
}

export function hostsPage(ui: Host, api: Remote<SshApi>, client: SshClient) {
	return function HostsPage() {
		const text = MESSAGES[useI18n().resolvedLocale];
		const state = useSshState(client);
		const [active, setActive] = useState<string | null>(lastTab);
		const [collapsed, setCollapsed] = useState(storedCollapsed);
		const [editing, setEditing] = useState<HostProfile | "new" | null>(null);
		const [dialog, setDialog] = useState<"groups" | "import" | "batch" | null>(null);
		const confirmer = useConfirmer();
		const report = (cause: unknown) => ui.notify(errorText(cause), "error");

		const hosts = state?.hosts ?? NO_HOSTS;
		const groups = state?.groups ?? NO_GROUPS;
		const connections = state?.connections ?? NO_CONNECTIONS;
		const current = connections.find((entry) => entry.tab === active) ?? connections.at(-1);
		const live = connections.filter((entry) => entry.state === "connected").length;
		const choose = (tab: string | null) => {
			lastTab = tab;
			setActive(tab);
		};

		/** 点一台主机：已经有它的标签就切过去，`fresh` 时总是新开一个。 */
		const connect = (host: HostProfile, fresh = false) => {
			const existing = fresh ? undefined : connections.find((entry) => entry.serverId === host.id);
			if (existing) {
				choose(existing.tab);
				return;
			}
			const tab = crypto.randomUUID();
			void api.connect(tab, host.id).then(() => choose(tab), report);
		};
		/** 关标签就是断开。还连着时先问一句：终端里可能有没跑完的事。 */
		const close = (connection: ConnectionView) => {
			if (connection.state === "closed") {
				void api.close(connection.tab).catch(report);
				return;
			}
			confirmer.ask({
				title: text.closeTitle(connection.label),
				detail: text.closeDetail,
				confirmLabel: text.closeConfirm,
				onConfirm: () => void api.close(connection.tab).catch(report),
			});
		};
		const remove = (host: HostProfile) =>
			confirmer.ask({
				title: text.deleteHostTitle(host.name),
				detail: text.deleteHostDetail,
				confirmLabel: text.delete,
				onConfirm: () => void api.deleteHost(host.id).catch(report),
			});
		const toggleHosts = () => {
			setCollapsed((was) => {
				try {
					localStorage.setItem(HOSTS_KEY, was ? "0" : "1");
				} catch {}
				return !was;
			});
		};
		const ask = (content: string) => void api.ask(content).catch(report);

		return (
			<div className="ssh-desk" data-ssh-hosts="">
				{!collapsed && (
					<HostColumn
						hosts={hosts}
						groups={groups}
						connections={connections}
						loaded={state !== null}
						text={text}
						head={
							<PageTopRow start className="ssh-row">
								<IconButton size="sm" label={text.hideHosts} icon={<PanelLeftClose size={15} />} onClick={toggleHosts} />
								<Text size="label" weight="medium" className="ssh-keep">
									{text.hostsTitle}
								</Text>
								<Text size="detail" tone="faint" numeric className="ssh-ellipsis">
									{text.deskSummary(hosts.length, live)}
								</Text>
								<span className="ssh-spacer" />
								<IconButton size="sm" label={text.manageGroups} icon={<FolderTree size={14} />} onClick={() => setDialog("groups")} />
							</PageTopRow>
						}
						onConnect={connect}
						onEdit={setEditing}
						onFavorite={(host) => void api.setFavorite(host.id, !host.favorite).catch(report)}
						onMove={(host, groupId) => void api.moveHosts([host.id], groupId).catch(report)}
						onDelete={remove}
						onNew={() => setEditing("new")}
						onImport={() => setDialog("import")}
					/>
				)}
				<section className="ssh-terminals" aria-label={text.terminals}>
					<PageTopRow start={collapsed} className="ssh-row">
						{collapsed && <IconButton size="sm" label={text.showHosts} icon={<PanelLeftOpen size={15} />} onClick={toggleHosts} />}
						<div className="ssh-tabs" role="tablist" aria-label={text.terminals}>
							{connections.map((entry) => (
								<div key={entry.tab} className="ssh-tab" data-active={entry.tab === current?.tab || undefined}>
									<button
										type="button"
										role="tab"
										aria-selected={entry.tab === current?.tab}
										className="ssh-tab-button"
										onClick={() => choose(entry.tab)}
										data-ssh-tab={entry.label}
									>
										<span className="ssh-dot" data-state={entry.state} />
										<Text size="detail" className="ssh-ellipsis">
											{entry.label}
										</Text>
									</button>
									<IconButton size="xs" label={text.closeTab} ariaLabel={text.closeTitle(entry.label)} icon={<X size={12} />} onClick={() => close(entry)} />
								</div>
							))}
						</div>
						<label className="ssh-monitor">
							<Text size="detail" tone="muted">
								{text.monitoring}
							</Text>
							<Toggle checked={state?.monitoring ?? false} onChange={(on) => void api.setMonitoring(on).catch(report)} ariaLabel={text.monitoring} />
						</label>
						<IconButton size="sm" label={text.batch} icon={<SquareTerminal size={14} />} onClick={() => setDialog("batch")} data-ssh-batch="" />
					</PageTopRow>
					{current ? (
						connections.map((entry) => (
							<div key={entry.tab} className="ssh-tab-body" hidden={entry.tab !== current.tab}>
								<ConnectionPane
									ui={ui}
									api={api}
									client={client}
									connection={entry}
									monitoring={state?.monitoring ?? false}
									shown={entry.tab === current.tab}
									text={text}
									onReconnect={() => void api.connect(entry.tab, entry.serverId).catch(report)}
									onAsk={ask}
								/>
							</div>
						))
					) : (
						<PanelEmpty icon={Terminal} title={text.noTerminals}>
							{hosts.length > 0 ? text.noTerminalsHint : text.noHostsHint}
						</PanelEmpty>
					)}
				</section>
				<AssistantColumn ui={ui} api={api} sessionId={state?.assistant ?? null} text={text} />

				{editing && <HostEditor host={editing === "new" ? null : editing} groups={groups} api={api} text={text} onClose={() => setEditing(null)} />}
				{dialog === "groups" && <GroupsDialog groups={groups} hosts={hosts} api={api} text={text} onClose={() => setDialog(null)} />}
				{dialog === "import" && <ImportDialog ui={ui} api={api} groups={groups} onClose={() => setDialog(null)} />}
				{dialog === "batch" && <BatchDialog ui={ui} api={api} client={client} onClose={() => setDialog(null)} />}
				{confirmer.element}
			</div>
		);
	};
}

function HostColumn({
	hosts,
	groups,
	connections,
	loaded,
	text,
	head,
	onConnect,
	onEdit,
	onFavorite,
	onMove,
	onDelete,
	onNew,
	onImport,
}: {
	hosts: HostProfile[];
	groups: HostGroup[];
	connections: ConnectionView[];
	loaded: boolean;
	text: Messages;
	/** 这一栏顶上那一行（`PageTopRow`）。 */
	head: ReactNode;
	onConnect(host: HostProfile, fresh?: boolean): void;
	onEdit(host: HostProfile): void;
	onFavorite(host: HostProfile): void;
	onMove(host: HostProfile, groupId: string | null): void;
	onDelete(host: HostProfile): void;
	onNew(): void;
	onImport(): void;
}) {
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<Filter>("all");
	const connected = useMemo(() => new Set(connections.filter((entry) => entry.state === "connected").map((entry) => entry.serverId)), [connections]);
	// 按分组排开（分组按名字，未分组在最后），组里收藏的在前、再按最近连接。
	const sections = useMemo(() => {
		const recent = (host: HostProfile) => Date.parse(host.lastConnectedAt ?? "") || 0;
		const visible = hosts
			.filter(
				(host) =>
					(filter === "all" || (filter === "favorites" ? host.favorite : filter === "none" ? host.groupId === null : host.groupId === filter)) &&
					fuzzyMatch(query, host.name, address(host), ...host.tags),
			)
			.sort((a, b) => Number(b.favorite) - Number(a.favorite) || recent(b) - recent(a) || a.name.localeCompare(b.name));
		const named = [...groups].sort((a, b) => a.name.localeCompare(b.name));
		return [
			...named.map((group) => ({ id: group.id, name: group.name, hosts: visible.filter((host) => host.groupId === group.id) })),
			{ id: "", name: text.ungrouped, hosts: visible.filter((host) => host.groupId === null || !groups.some((group) => group.id === host.groupId)) },
		].filter((section) => section.hosts.length > 0);
	}, [hosts, groups, filter, query, text.ungrouped]);
	const grouped = groups.length > 0 && filter !== "none" && !groups.some((group) => group.id === filter);

	return (
		<div className="ssh-host-column">
			{head}
			<div className="ssh-host-search">
				<SearchField
					value={query}
					onChange={setQuery}
					placeholder={text.searchHosts}
					onEnter={() => {
						const first = sections[0]?.hosts[0];
						if (first) onConnect(first);
					}}
				/>
				<div className="ssh-chips" role="group" aria-label={text.groups}>
					<Button size="xs" variant="subtle" pressed={filter === "all"} onClick={() => setFilter("all")}>
						{text.allGroups}
					</Button>
					<Button
						size="xs"
						variant="subtle"
						pressed={filter === "favorites"}
						icon={<Star size={12} fill={filter === "favorites" ? "currentColor" : "none"} />}
						onClick={() => setFilter("favorites")}
					>
						{text.favoritesOnly}
					</Button>
					{groups.map((entry) => (
						<Button key={entry.id} size="xs" variant="subtle" pressed={filter === entry.id} onClick={() => setFilter(entry.id)}>
							{entry.name}
						</Button>
					))}
				</div>
			</div>
			<Scroller className="ssh-host-scroll" contentClassName="ssh-host-list">
				{loaded && hosts.length === 0 ? (
					<div className="ssh-host-none">
						<Server size={20} className="ssh-faint" />
						<Text as="p" tone="muted">
							{text.noHosts}
						</Text>
						<Text as="p" size="detail" tone="faint">
							{text.noHostsHint}
						</Text>
					</div>
				) : loaded && sections.length === 0 ? (
					<Text as="p" size="detail" tone="faint" className="ssh-host-none">
						{text.noMatch}
					</Text>
				) : (
					sections.map((section) => (
						<div key={section.id} role="group" aria-label={section.name}>
							{grouped && (
								<Text as="div" size="caption" tone="faint" className="ssh-host-group">
									{section.name}
								</Text>
							)}
							{section.hosts.map((host) => (
								<div key={host.id} className="plume-item ssh-host-row" data-ssh-host={host.id}>
									<button
										type="button"
										className="ssh-host-open"
										title={text.connectHint(host.name)}
										onClick={() => onConnect(host)}
										data-ssh-connect={host.id}
									>
										<span className="ssh-dot" data-state={connected.has(host.id) ? "connected" : "idle"} />
										<span className="ssh-host-text">
											<span className="ssh-host-title">
												<Text weight="medium" className="ssh-ellipsis">
													{host.name}
												</Text>
												{host.favorite && <Star size={11} className="ssh-star" fill="currentColor" aria-label={text.favorite} />}
											</span>
											<Text size="detail" tone="faint" mono className="ssh-ellipsis">
												{address(host)}
											</Text>
										</span>
									</button>
									<HostActions
										host={host}
										groups={groups}
										text={text}
										onConnect={() => onConnect(host, true)}
										onEdit={() => onEdit(host)}
										onFavorite={() => onFavorite(host)}
										onMove={(groupId) => onMove(host, groupId)}
										onDelete={() => onDelete(host)}
									/>
								</div>
							))}
						</div>
					))
				)}
			</Scroller>
			<div className="ssh-host-foot">
				<Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={onNew} data-ssh-new-host="">
					{text.newHost}
				</Button>
				<Button size="sm" icon={<FileSpreadsheet size={14} />} onClick={onImport} data-ssh-import="">
					{text.import}
				</Button>
			</div>
		</div>
	);
}

function HostActions({
	host,
	groups,
	text,
	onConnect,
	onEdit,
	onFavorite,
	onMove,
	onDelete,
}: {
	host: HostProfile;
	groups: HostGroup[];
	text: Messages;
	onConnect(): void;
	onEdit(): void;
	onFavorite(): void;
	onMove(groupId: string | null): void;
	onDelete(): void;
}) {
	const menu = usePopover();
	const pick = (run: () => void) => () => {
		menu.close();
		run();
	};
	const groupItem = (id: string | null, name: string) => (
		<MenuItem key={id ?? ""} selected={host.groupId === id} trailing={host.groupId === id ? <Check size={13} /> : undefined} onClick={pick(() => onMove(id))}>
			{name}
		</MenuItem>
	);
	return (
		<>
			<IconButton size="xs" label={text.more} ariaLabel={text.moreFor(host.name)} icon={<MoreHorizontal size={14} />} menu={menu.open} onClick={menu.toggle} />
			{menu.open && (
				<Popover anchor={menu.anchor} onClose={menu.close} placement="bottom" align="end" width="default" maxHeight={MENU_MAX_HEIGHT}>
					<MenuBody insetIcons>
						<MenuItem icon={<Terminal size={14} />} onClick={pick(onConnect)}>
							{text.connectNew}
						</MenuItem>
						<MenuItem icon={<Pencil size={14} />} onClick={pick(onEdit)}>
							{text.edit}
						</MenuItem>
						<MenuItem icon={<Star size={14} />} onClick={pick(onFavorite)}>
							{host.favorite ? text.unfavorite : text.favorite}
						</MenuItem>
						<MenuSeparator />
						<MenuLabel>{text.moveTo}</MenuLabel>
						{groupItem(null, text.ungrouped)}
						{groups.map((entry) => groupItem(entry.id, entry.name))}
						<MenuSeparator />
						<MenuItem icon={<Trash2 size={14} />} danger onClick={pick(onDelete)}>
							{text.delete}
						</MenuItem>
					</MenuBody>
				</Popover>
			)}
		</>
	);
}

function HostEditor({
	host,
	groups,
	api,
	text,
	onClose,
}: {
	host: HostProfile | null;
	groups: HostGroup[];
	api: Remote<SshApi>;
	text: Messages;
	onClose(): void;
}) {
	const [name, setName] = useState(host?.name ?? "");
	const [hostname, setHostname] = useState(host?.host ?? "");
	const [port, setPort] = useState(String(host?.port ?? 22));
	const [username, setUsername] = useState(host?.username ?? "root");
	const [password, setPassword] = useState("");
	const [groupId, setGroupId] = useState(host?.groupId ?? "");
	const [tags, setTags] = useState(host?.tags.join(", ") ?? "");
	const [saving, setSaving] = useState(false);
	const [failure, setFailure] = useState("");
	const title = host ? text.editHost : text.newHost;
	const canSave = Boolean(name.trim() && hostname.trim() && username.trim() && port.trim() && (host || password));

	const save = async (done: () => void) => {
		if (!canSave || saving) return;
		setSaving(true);
		setFailure("");
		const input: HostInput = {
			...(host ? { id: host.id } : {}),
			name: name.trim(),
			host: hostname.trim(),
			port: Number(port),
			username: username.trim(),
			...(password ? { password } : {}),
			groupId: groupId || null,
			tags: parseTags(tags),
		};
		try {
			await api.saveHost(input);
			done();
		} catch (cause) {
			setFailure(errorText(cause));
			setSaving(false);
		}
	};

	return (
		<Dialog
			onClose={onClose}
			width={520}
			label={title}
			title={title}
			icon={<Server size={16} />}
			status={
				failure ? (
					<Text as="p" size="detail" tone="danger" role="alert">
						{failure}
					</Text>
				) : undefined
			}
			actions={(dismiss) => (
				<>
					<Button onClick={() => dismiss()}>{text.cancel}</Button>
					<Button variant="primary" disabled={!canSave} loading={saving} onClick={() => void save(() => dismiss())} data-ssh-save-host="">
						{text.save}
					</Button>
				</>
			)}
		>
			{(dismiss) => (
				<form
					className="ssh-form"
					data-ssh-host-form=""
					onSubmit={(event) => {
						event.preventDefault();
						void save(() => dismiss());
					}}
				>
					<label className={fieldLabel}>
						{text.hostName}
						<Input className={field} value={name} onChange={(event) => setName(event.target.value)} autoFocus placeholder={text.hostNamePlaceholder} />
					</label>
					<div className="ssh-form-pair">
						<label className={`${fieldLabel} ssh-grow`}>
							{text.hostAddress}
							<Input className={field} value={hostname} onChange={(event) => setHostname(event.target.value)} spellCheck={false} placeholder="192.168.1.10" />
						</label>
						<label className={`${fieldLabel} ssh-form-port`}>
							{text.port}
							<Input className={field} value={port} inputMode="numeric" onChange={(event) => setPort(event.target.value.replace(/\D/g, "").slice(0, 5))} />
						</label>
					</div>
					<div className="ssh-form-pair">
						<label className={`${fieldLabel} ssh-grow`}>
							{text.username}
							<Input className={field} value={username} onChange={(event) => setUsername(event.target.value)} spellCheck={false} autoComplete="off" />
						</label>
						<label className={`${fieldLabel} ssh-grow`}>
							{text.password}
							<Input
								className={field}
								type="password"
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								autoComplete="new-password"
								placeholder={host ? text.passwordKeep : ""}
							/>
						</label>
					</div>
					<div className="ssh-form-pair">
						<div className={`${fieldLabel} ssh-grow`}>
							{text.group}
							<Select
								value={groupId}
								onChange={setGroupId}
								ariaLabel={text.group}
								options={[{ value: "", label: text.ungrouped }, ...groups.map((entry) => ({ value: entry.id, label: entry.name }))]}
							/>
						</div>
						<label className={`${fieldLabel} ssh-grow`}>
							{text.tags}
							<Input className={field} value={tags} onChange={(event) => setTags(event.target.value)} placeholder={text.tagsPlaceholder} />
						</label>
					</div>
					<Text as="p" size="caption" tone="faint">
						{text.passwordNote}
					</Text>
					<button type="submit" hidden />
				</form>
			)}
		</Dialog>
	);
}

function GroupsDialog({
	groups,
	hosts,
	api,
	text,
	onClose,
}: {
	groups: HostGroup[];
	hosts: HostProfile[];
	api: Remote<SshApi>;
	text: Messages;
	onClose(): void;
}) {
	const [draft, setDraft] = useState("");
	const [failure, setFailure] = useState("");
	const confirmer = useConfirmer();
	const attempt = async (work: () => PromiseLike<unknown>) => {
		setFailure("");
		try {
			await work();
			return true;
		} catch (cause) {
			setFailure(errorText(cause));
			return false;
		}
	};
	const add = async () => {
		const name = draft.trim();
		if (name && (await attempt(() => api.saveGroup({ name })))) setDraft("");
	};
	return (
		<Dialog
			onClose={onClose}
			width={440}
			label={text.manageGroups}
			title={text.manageGroups}
			icon={<FolderTree size={16} />}
			status={
				failure ? (
					<Text as="p" size="detail" tone="danger" role="alert">
						{failure}
					</Text>
				) : undefined
			}
			actions={(dismiss) => <Button onClick={() => dismiss()}>{text.done}</Button>}
		>
			<div className="ssh-form">
				<form
					className="ssh-form-pair"
					onSubmit={(event) => {
						event.preventDefault();
						void add();
					}}
				>
					<Input
						className={`${field} ssh-grow`}
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
						placeholder={text.newGroupPlaceholder}
						aria-label={text.newGroup}
						autoFocus
					/>
					<Button type="submit" icon={<Plus size={14} />} disabled={!draft.trim()}>
						{text.add}
					</Button>
				</form>
				{groups.length === 0 ? (
					<Text as="p" size="detail" tone="faint">
						{text.noGroups}
					</Text>
				) : (
					<div className="ssh-group-list">
						{groups.map((entry) => (
							<GroupRow
								key={entry.id}
								group={entry}
								count={hosts.filter((host) => host.groupId === entry.id).length}
								text={text}
								onRename={(name) => void attempt(() => api.saveGroup({ id: entry.id, name }))}
								onDelete={(count) =>
									confirmer.ask({
										title: text.deleteGroupTitle(entry.name),
										detail: text.deleteGroupDetail(count),
										confirmLabel: text.delete,
										onConfirm: () => void attempt(() => api.deleteGroup(entry.id)),
									})
								}
							/>
						))}
					</div>
				)}
			</div>
			{confirmer.element}
		</Dialog>
	);
}

function GroupRow({
	group,
	count,
	text,
	onRename,
	onDelete,
}: {
	group: HostGroup;
	count: number;
	text: Messages;
	onRename(name: string): void;
	onDelete(count: number): void;
}) {
	const [name, setName] = useState(group.name);
	const commit = () => {
		const next = name.trim();
		if (!next) setName(group.name);
		else if (next !== group.name) onRename(next);
	};
	return (
		<div className="ssh-group-row">
			<Input
				className={`${field} ssh-grow`}
				value={name}
				aria-label={text.groupName}
				onChange={(event) => setName(event.target.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") event.currentTarget.blur();
					if (event.key === "Escape") setName(group.name);
				}}
			/>
			<Text size="caption" tone="faint" numeric>
				{text.hostCount(count)}
			</Text>
			<IconButton
				size="sm"
				tone="danger"
				label={text.delete}
				ariaLabel={text.deleteGroupTitle(group.name)}
				icon={<Trash2 size={14} />}
				onClick={() => onDelete(count)}
			/>
		</div>
	);
}
