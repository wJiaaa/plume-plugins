/**
 * 活动栏「SSH 主机」页：运维台。左边是主机库（搜索名字、地址、标签，按收藏和分组筛，按分组排开），点一台就在中间开一个终端
 * 标签连上它（已经有它的标签就切过去）；中间是终端标签，一个标签一条连接；右边固定一列「AI 运维助手」，它能请求在这里连着的
 * 任意一条连接上执行命令，每条都要人批准。主机库头上的「+」收着新建、导入和管理分组；标签行右边是当前标签的查找、问 AI、
 * SFTP，「资源占用」弹出当前连接的卡片（读数、所有连接共用的开关、断开），「批量命令」开对话框。
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
	ResizeHandle,
	Scroller,
	SearchField,
	Select,
	Text,
	useConfirmer,
	useI18n,
	usePopover,
} from "@plume/ui";
import { field, fieldLabel } from "@plume/styles";
import {
	Activity,
	Check,
	FileSpreadsheet,
	FolderOpen,
	FolderTree,
	MessageSquarePlus,
	MoreHorizontal,
	PanelLeftClose,
	PanelLeftOpen,
	Pencil,
	Plus,
	Search,
	Server,
	SquareTerminal,
	Star,
	Terminal,
	Trash2,
	X,
} from "@plume/ui/icons";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionView, HostGroup, HostInput, HostProfile, SshApi } from "./api.ts";
import { AssistantColumn } from "./AssistantColumn.tsx";
import { BatchDialog } from "./BatchDialog.tsx";
import { errorText, type SshClient, useSshState } from "./client.ts";
import { ConnectionCard, ConnectionPane, type PaneControls } from "./ConnectionPane.tsx";
import { address, fuzzyMatch, parseTags } from "./format.ts";
import { ImportDialog } from "./ImportDialog.tsx";
import { type Messages, MESSAGES } from "./messages.ts";

type Host = Pick<UiContext, "notify" | "droppedPaths" | "Conversation" | "useSession" | "usePageToolbar">;
/** 主机列表的筛选：全部、收藏、未分组，或某个分组的 id。 */
type Filter = "all" | "favorites" | "none" | (string & {});

const HOSTS_KEY = "plume.ssh.hosts.collapsed";
/** 主机列表能拖多宽：默认、最窄、最宽。拖过的宽度存在本机，下次打开还是这么宽。 */
const HOSTS_WIDTH = { key: "plume.ssh.hosts.width", initial: 224, min: 200, max: 420 };
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

function storedWidth(): number {
	try {
		const saved = Number(localStorage.getItem(HOSTS_WIDTH.key));
		return saved >= HOSTS_WIDTH.min && saved <= HOSTS_WIDTH.max ? saved : HOSTS_WIDTH.initial;
	} catch {
		return HOSTS_WIDTH.initial;
	}
}

export function hostsPage(ui: Host, api: Remote<SshApi>, client: SshClient) {
	return function HostsPage() {
		const text = MESSAGES[useI18n().resolvedLocale];
		const state = useSshState(client);
		const [active, setActive] = useState<string | null>(lastTab);
		const [collapsed, setCollapsed] = useState(storedCollapsed);
		const [hostsWidth, setHostsWidth] = useState(storedWidth);
		useEffect(() => {
			try {
				localStorage.setItem(HOSTS_WIDTH.key, String(hostsWidth));
			} catch {}
		}, [hostsWidth]);
		const [editing, setEditing] = useState<HostProfile | "new" | null>(null);
		const [dialog, setDialog] = useState<"groups" | "import" | "batch" | null>(null);
		/** 开着 SFTP 文件面板的标签。 */
		const [sftpTabs, setSftpTabs] = useState<ReadonlySet<string>>(() => new Set());
		const panes = useRef(new Map<string, PaneControls>());
		const card = usePopover();
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
		// 开合主机列表的按钮放在窗口左上角、后退和前进后面，和对话里的侧栏开关同一个位置。
		ui.usePageToolbar([
			{
				id: "hosts",
				label: collapsed ? text.showHosts : text.hideHosts,
				icon: collapsed ? PanelLeftOpen : PanelLeftClose,
				onClick: toggleHosts,
			},
		]);
		const ask = (content: string) => void api.ask(content, undefined).catch(report);
		const setSftp = (tab: string, open: boolean) =>
			setSftpTabs((was) => {
				const next = new Set(was);
				if (open) next.add(tab);
				else next.delete(tab);
				return next;
			});
		const monitoring = state?.monitoring ?? false;
		// 最后一个标签关了，卡片的锚点（标签行上的按钮）也没了：收起来，免得下次开标签时挂在旧锚点上弹出来。
		const cardOpen = card.open;
		const closeCard = card.close;
		useEffect(() => {
			if (!current && cardOpen) closeCard();
		}, [current, cardOpen, closeCard]);

		return (
			<div className="ssh-desk" data-ssh-hosts="" style={{ "--ssh-hosts-width": `${hostsWidth}px` } as CSSProperties}>
				{!collapsed && (
					<HostColumn
						hosts={hosts}
						groups={groups}
						connections={connections}
						loaded={state !== null}
						text={text}
						head={
							<PageTopRow className="ssh-row">
								<Text size="label" weight="medium" className="ssh-keep">
									{text.hostsTitle}
								</Text>
								{hosts.length > 0 && (
									<Text size="detail" tone="faint" numeric className="ssh-ellipsis">
										{text.deskSummary(hosts.length, live)}
									</Text>
								)}
								<span className="ssh-spacer" />
								<AddMenu text={text} onNew={() => setEditing("new")} onImport={() => setDialog("import")} onGroups={() => setDialog("groups")} />
							</PageTopRow>
						}
						handle={
							<ResizeHandle
								edge="end"
								width={hostsWidth}
								min={HOSTS_WIDTH.min}
								max={HOSTS_WIDTH.max}
								onResize={(next) => setHostsWidth(Math.round(next))}
								onReset={() => setHostsWidth(HOSTS_WIDTH.initial)}
								label={text.resizeHosts}
							/>
						}
						onConnect={connect}
						onEdit={setEditing}
						onFavorite={(host) => void api.setFavorite(host.id, !host.favorite).catch(report)}
						onMove={(host, groupId) => void api.moveHosts([host.id], groupId).catch(report)}
						onDelete={remove}
					/>
				)}
				<section className="ssh-terminals" aria-label={text.terminals}>
					<PageTopRow className="ssh-row">
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
						{current && (
							<>
								<IconButton size="sm" label={text.find} icon={<Search size={14} />} onClick={() => panes.current.get(current.tab)?.find()} />
								<IconButton
									size="sm"
									label={text.askAi}
									icon={<MessageSquarePlus size={14} />}
									onClick={() => panes.current.get(current.tab)?.ask()}
									data-ssh-ask=""
								/>
								<IconButton
									size="sm"
									label={text.sftp}
									icon={<FolderOpen size={14} />}
									active={sftpTabs.has(current.tab)}
									disabled={current.state !== "connected"}
									onClick={() => setSftp(current.tab, !sftpTabs.has(current.tab))}
								/>
								<span className="ssh-divider" />
								{/* 开着资源占用时右上角挂个小绿点：不打开卡片也看得出在不在读数。 */}
								<span className="ssh-pip" data-on={monitoring || undefined}>
									<IconButton size="sm" label={text.monitoring} icon={<Activity size={14} />} menu={card.open} onClick={card.toggle} data-ssh-card-open="" />
								</span>
								{card.open && (
									<Popover
										anchor={card.anchor}
										onClose={card.close}
										placement="bottom"
										align="end"
										width="panel"
										role="dialog"
										label={text.monitoring}
										surface="panel"
									>
										<ConnectionCard
											connection={current}
											monitoring={monitoring}
											text={text}
											onMonitoring={(on) => void api.setMonitoring(on).catch(report)}
											onDisconnect={() => void api.disconnect(current.tab).catch(report)}
											onReconnect={() => void api.connect(current.tab, current.serverId).catch(report)}
										/>
									</Popover>
								)}
								<IconButton size="sm" label={text.batch} icon={<SquareTerminal size={14} />} onClick={() => setDialog("batch")} data-ssh-batch="" />
							</>
						)}
					</PageTopRow>
					{current ? (
						connections.map((entry) => (
							<div key={entry.tab} className="ssh-tab-body" hidden={entry.tab !== current.tab}>
								<ConnectionPane
									ref={(controls) => {
										if (controls) panes.current.set(entry.tab, controls);
										return () => void panes.current.delete(entry.tab);
									}}
									ui={ui}
									api={api}
									client={client}
									connection={entry}
									shown={entry.tab === current.tab}
									sftp={sftpTabs.has(entry.tab)}
									text={text}
									onSftp={(open) => setSftp(entry.tab, open)}
									onReconnect={() => void api.connect(entry.tab, entry.serverId).catch(report)}
									onAsk={ask}
								/>
							</div>
						))
					) : state !== null && hosts.length === 0 ? (
						<div className="ssh-start">
							<Server size={26} className="ssh-faint" />
							<Text size="title">{text.firstHost}</Text>
							<Text as="p" size="detail" tone="faint">
								{text.firstHostHint}
							</Text>
							<div className="ssh-start-actions">
								<Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setEditing("new")} data-ssh-new-host="">
									{text.newHost}
								</Button>
								<Button size="sm" icon={<FileSpreadsheet size={14} />} onClick={() => setDialog("import")} data-ssh-import="">
									{text.importExcel}
								</Button>
							</div>
						</div>
					) : (
						<PanelEmpty icon={Terminal} title={text.noTerminals}>
							{text.noTerminalsHint}
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
	handle,
	onConnect,
	onEdit,
	onFavorite,
	onMove,
	onDelete,
}: {
	hosts: HostProfile[];
	groups: HostGroup[];
	connections: ConnectionView[];
	loaded: boolean;
	text: Messages;
	/** 这一栏顶上那一行（`PageTopRow`）。 */
	head: ReactNode;
	/** 右边拖宽度的拖把（`ResizeHandle`），贴着这一栏的右边。 */
	handle: ReactNode;
	onConnect(host: HostProfile, fresh?: boolean): void;
	onEdit(host: HostProfile): void;
	onFavorite(host: HostProfile): void;
	onMove(host: HostProfile, groupId: string | null): void;
	onDelete(host: HostProfile): void;
}) {
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<Filter>("all");
	// 主机的点：有一条连着就是绿的，没有连着的但有一条在连（含等着核对指纹）就是黄的，别的不画点。
	const states = useMemo(() => {
		const map = new Map<string, "connected" | "connecting">();
		for (const entry of connections) {
			if (entry.state === "connected") map.set(entry.serverId, "connected");
			else if ((entry.state === "connecting" || entry.state === "hostkey") && !map.has(entry.serverId)) map.set(entry.serverId, "connecting");
		}
		return map;
	}, [connections]);
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
				<div className="ssh-filters" role="group" aria-label={text.groups}>
					{[{ id: "all", name: text.allGroups }, { id: "favorites", name: text.favoritesOnly }, ...groups].map((entry) => (
						<button key={entry.id} type="button" className="ssh-filter" aria-pressed={filter === entry.id} onClick={() => setFilter(entry.id)}>
							<Text size="detail" tone={filter === entry.id ? "default" : "faint"} weight={filter === entry.id ? "medium" : "normal"}>
								{entry.name}
							</Text>
						</button>
					))}
				</div>
			</div>
			<Scroller className="ssh-host-scroll" contentClassName="ssh-host-list">
				{loaded && hosts.length === 0 ? (
					<Text as="p" size="detail" tone="faint" className="ssh-host-none">
						{text.noHosts}
					</Text>
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
										<span className="ssh-dot" data-state={states.get(host.id) ?? "idle"} />
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
			{handle}
		</div>
	);
}

/** 主机库头上的「+」：新建主机、从 Excel 导入、管理分组。 */
function AddMenu({ text, onNew, onImport, onGroups }: { text: Messages; onNew(): void; onImport(): void; onGroups(): void }) {
	const menu = usePopover();
	const pick = (run: () => void) => () => {
		menu.close();
		run();
	};
	return (
		<>
			<IconButton size="sm" label={text.addHost} icon={<Plus size={15} />} menu={menu.open} onClick={menu.toggle} data-ssh-add="" />
			{menu.open && (
				<Popover anchor={menu.anchor} onClose={menu.close} placement="bottom" align="end" width="default">
					<MenuBody insetIcons>
						<MenuItem icon={<Server size={14} />} onClick={pick(onNew)}>
							{text.newHost}
						</MenuItem>
						<MenuItem icon={<FileSpreadsheet size={14} />} onClick={pick(onImport)}>
							{text.importExcel}
						</MenuItem>
						<MenuSeparator />
						<MenuItem icon={<FolderTree size={14} />} onClick={pick(onGroups)}>
							{text.manageGroups}
						</MenuItem>
					</MenuBody>
				</Popover>
			)}
		</>
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
