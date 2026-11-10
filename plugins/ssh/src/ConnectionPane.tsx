/**
 * 主机页上一个终端标签的内容：顶上一条状态栏（账号地址、资源占用、查找、问 AI、SFTP、断开），下面是终端，SFTP 开着时
 * 文件面板在终端右边；第一次连这台机器先在终端上方核对指纹。
 *
 * 连接在逻辑入口里，组件卸了不断：离开主机页再回来按连接 id 接上，先回放最近的输出。
 */

import type { Remote, UiContext } from "@plume/contract/ui";
import { ActionSpinner, Button, ContextMenu, IconButton, macKeyboard, MenuItem, MenuSeparator, Text } from "@plume/ui";
import { ClipboardPaste, Copy, FolderOpen, MessageSquarePlus, RotateCw, Search, ShieldCheck, TriangleAlert, Unplug, X } from "@plume/ui/icons";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ConnectionView, SshApi } from "./api.ts";
import { errorText, type SshClient } from "./client.ts";
import { address, percent, rate } from "./format.ts";
import { terminalKey, windowsKeyboard } from "./keys.ts";
import { paletteFromTheme, typography } from "./look.ts";
import type { Messages } from "./messages.ts";
import { SftpPane } from "./SftpPane.tsx";
import { TerminalSearch } from "./TerminalSearch.tsx";

/** 「问 AI」没选中东西时带上最近这么多行。 */
const RECENT_LINES = 200;

const CODE_DEFAULTS = {
	codeFont: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
	codeFontSize: 12,
};

type Host = Pick<UiContext, "notify" | "droppedPaths">;

export function ConnectionPane({
	ui,
	api,
	client,
	connection,
	monitoring,
	shown,
	text,
	onReconnect,
	onAsk,
}: {
	ui: Host;
	api: Remote<SshApi>;
	client: SshClient;
	connection: ConnectionView;
	monitoring: boolean;
	shown: boolean;
	text: Messages;
	onReconnect(): void;
	/** 「问 AI」：清理过的终端内容交给运维助手。 */
	onAsk(content: string): void;
}) {
	const [sftp, setSftp] = useState(false);
	const [finding, setFinding] = useState(0);
	const terminal = useRef<Terminal | null>(null);
	const search = useRef<SearchAddon | null>(null);
	const report = (error: unknown) => ui.notify(errorText(error), "error");
	const connected = connection.state === "connected";

	/** 选中的字，没选中就是最近 200 行，去掉控制序列、遮住密码后交给运维助手。 */
	const ask = async () => {
		const term = terminal.current;
		if (!term) return;
		let picked = term.getSelection();
		if (!picked.trim()) {
			const buffer = term.buffer.active;
			const lines: string[] = [];
			for (let index = Math.max(0, buffer.length - RECENT_LINES); index < buffer.length; index++)
				lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
			picked = lines.join("\n").replace(/\s+$/, "");
		}
		if (!picked.trim()) {
			ui.notify(text.askNothing, "info");
			return;
		}
		try {
			const clean = await api.scrub(picked);
			const fence = clean.includes("```") ? "````" : "```";
			onAsk(`${text.askPrefix(connection.label, connection.id)}\n${fence}text\n${clean}\n${fence}\n\n${text.askQuestion}`);
		} catch (error) {
			report(error);
		}
	};

	return (
		<div className="ssh-connection">
			<div className="ssh-status" data-ssh-state={connection.state}>
				<span className="ssh-dot" data-state={connection.state} />
				<Text weight="medium" className="ssh-ellipsis ssh-status-name">
					{connection.label}
				</Text>
				<Text size="detail" tone="faint" mono className="ssh-ellipsis ssh-status-address">
					{address(connection)}
				</Text>
				{monitoring && connected && <Stats connection={connection} text={text} />}
				<span className="ssh-spacer" />
				<IconButton size="sm" label={text.find} icon={<Search size={14} />} disabled={!terminal.current} onClick={() => setFinding((count) => count + 1)} />
				<IconButton size="sm" label={text.askAi} icon={<MessageSquarePlus size={14} />} onClick={() => void ask()} data-ssh-ask="" />
				<IconButton size="sm" label={text.sftp} icon={<FolderOpen size={14} />} active={sftp} disabled={!connected} onClick={() => setSftp((open) => !open)} />
				{connection.state === "closed" ? (
					<IconButton size="sm" label={text.reconnect} icon={<RotateCw size={14} />} onClick={onReconnect} />
				) : (
					<IconButton size="sm" label={text.disconnect} icon={<Unplug size={14} />} onClick={() => void api.disconnect(connection.tab).catch(report)} />
				)}
			</div>
			<div className="ssh-body">
				<div className="ssh-terminal-wrap">
					<SshTerminal
						api={api}
						connection={connection}
						shown={shown}
						onReady={(term, searcher) => {
							terminal.current = term;
							search.current = searcher;
						}}
						onFind={() => setFinding((count) => count + 1)}
						onAsk={() => void ask()}
						text={text}
						droppedPaths={ui.droppedPaths}
					/>
					{finding > 0 && search.current && (
						<TerminalSearch
							search={search.current}
							request={finding}
							onClose={() => {
								setFinding(0);
								terminal.current?.focus();
							}}
						/>
					)}
					{connection.state === "connecting" && (
						<div className="ssh-overlay">
							<ActionSpinner size={18} />
							<Text tone="muted">{text.connecting(connection.label)}</Text>
						</div>
					)}
					{connection.state === "hostkey" && connection.fingerprint && (
						<HostKeyCard connection={connection} text={text} onAnswer={(accept) => void api.trust(connection.tab, accept).catch(report)} />
					)}
				</div>
				{sftp && connected && <SftpPane ui={ui} api={api} client={client} connection={connection.id} onClose={() => setSftp(false)} />}
			</div>
			{connection.state === "closed" && (
				<div className="ssh-closed" role="status">
					<TriangleAlert size={14} className="ssh-faint" />
					<Text size="detail" tone="muted" className="ssh-closed-text">
						{connection.error ?? text.closed}
					</Text>
					<Button size="sm" onClick={onReconnect} icon={<RotateCw size={13} />}>
						{text.reconnect}
					</Button>
				</div>
			)}
		</div>
	);
}

function Stats({ connection, text }: { connection: ConnectionView; text: Messages }) {
	const stats = connection.stats;
	if (!stats) return null;
	if (stats.failed) {
		return (
			<Text size="detail" tone="faint">
				{text.statsFailed}
			</Text>
		);
	}
	return (
		<Text size="detail" tone="muted" numeric className="ssh-stats" data-ssh-stats="">
			<span>CPU {percent(stats.cpu)}</span>
			<span>
				{text.memory} {percent(stats.memory)}
			</span>
			<span>
				{text.disk} {percent(stats.disk)}
			</span>
			<span>↓ {rate(stats.rxRate)}</span>
			<span>↑ {rate(stats.txRate)}</span>
		</Text>
	);
}

/** 第一次连这台机器：指纹要人和管理员给的核对过才记下，之后变了直接拒绝。 */
function HostKeyCard({ connection, text, onAnswer }: { connection: ConnectionView; text: Messages; onAnswer(accept: boolean): void }) {
	const card = useRef<HTMLDivElement>(null);
	// 卡片一出来焦点就给「信任并连接」，回车就是答；Esc、Tab 照常。
	useEffect(() => {
		card.current?.querySelector<HTMLButtonElement>("[data-ssh-trust]")?.focus();
	}, []);
	return (
		<div className="ssh-overlay">
			<div ref={card} className="plume-menu-card ssh-hostkey" role="dialog" aria-label={text.hostKeyTitle} data-ssh-hostkey="">
				<div className="ssh-hostkey-head">
					<ShieldCheck size={16} className="ssh-accent" />
					<Text size="title">{text.hostKeyTitle}</Text>
				</div>
				<Text as="p" tone="muted">
					{text.hostKeyDetail}
				</Text>
				<div className="ssh-hostkey-facts">
					<Text size="detail" tone="faint">
						{text.hostKeyAddress}
					</Text>
					<Text mono size="detail" className="ssh-break">
						{`${connection.host}:${connection.port}`}
					</Text>
					<Text size="detail" tone="faint">
						{text.hostKeyFingerprint}
					</Text>
					<Text mono size="detail" className="ssh-break" data-ssh-fingerprint="">
						{connection.fingerprint}
					</Text>
				</div>
				<div className="ssh-actions">
					<Button variant="subtle" icon={<X size={14} />} onClick={() => onAnswer(false)}>
						{text.hostKeyReject}
					</Button>
					<span className="ssh-spacer" />
					<Button variant="primary" icon={<ShieldCheck size={14} />} onClick={() => onAnswer(true)} data-ssh-trust="">
						{text.hostKeyTrust}
					</Button>
				</div>
			</div>
		</div>
	);
}

function SshTerminal({
	api,
	connection,
	shown,
	onReady,
	onFind,
	onAsk,
	text,
	droppedPaths,
}: {
	api: Remote<SshApi>;
	connection: ConnectionView;
	shown: boolean;
	onReady(terminal: Terminal | null, search: SearchAddon | null): void;
	onFind(): void;
	onAsk(): void;
	text: Messages;
	droppedPaths: Host["droppedPaths"];
}) {
	const host = useRef<HTMLDivElement>(null);
	const term = useRef<Terminal | null>(null);
	const fit = useRef<FitAddon | null>(null);
	const size = useRef({ cols: 100, rows: 30 });
	const id = connection.id;
	const idRef = useRef(id);
	idRef.current = id;
	const actions = useRef({ onFind, onAsk });
	actions.current = { onFind, onAsk };
	const [menu, setMenu] = useState<{ x: number; y: number; selection: string } | null>(null);

	useLayoutEffect(() => {
		const element = host.current;
		if (!element) return;
		const theme = paletteFromTheme();
		element.style.background = theme?.background ?? "";
		const terminal = new Terminal({
			...typography(CODE_DEFAULTS),
			cursorStyle: "bar",
			cursorInactiveStyle: "outline",
			cursorBlink: true,
			theme,
			allowProposedApi: true,
			scrollback: 5000,
		});
		terminal.attachCustomKeyEventHandler((event) => {
			const action = terminalKey(event, terminal.hasSelection());
			if (action === "shell") return true;
			if (action === "find" && event.type === "keydown") {
				event.preventDefault();
				actions.current.onFind();
			}
			if (action === "copy" && event.type === "keydown") {
				event.preventDefault();
				const selected = terminal.getSelection();
				if (selected) void navigator.clipboard.writeText(selected);
				terminal.clearSelection();
			}
			return false;
		});
		const fitter = new FitAddon();
		terminal.loadAddon(fitter);
		terminal.loadAddon(new Unicode11Addon());
		terminal.unicode.activeVersion = "11";
		const searcher = new SearchAddon();
		terminal.loadAddon(searcher);
		terminal.open(element);
		term.current = terminal;
		fit.current = fitter;
		onReady(terminal, searcher);

		// 尺寸要告诉远端的 shell，不然里面的程序按旧宽度折行。量出 0（面板收起）时不动。
		const refit = () => {
			if (element.clientWidth === 0 || element.clientHeight === 0) return;
			const next = fitter.proposeDimensions();
			if (!next) return;
			terminal.resize(next.cols, next.rows);
			if (next.cols === size.current.cols && next.rows === size.current.rows) return;
			size.current = next;
			void api.resize(idRef.current, next.cols, next.rows).catch(() => undefined);
		};
		refit();
		void document.fonts.ready.then(() => {
			if (term.current === terminal) refit();
		});
		const observer = new ResizeObserver(refit);
		observer.observe(element);
		const typing = terminal.onData((data) => void api.write(idRef.current, data).catch(() => undefined));
		const scheme = window.matchMedia("(prefers-color-scheme: dark)");
		const retheme = () => {
			const next = paletteFromTheme();
			terminal.options.theme = next;
			element.style.background = next?.background ?? "";
		};
		scheme.addEventListener("change", retheme);
		return () => {
			scheme.removeEventListener("change", retheme);
			observer.disconnect();
			typing.dispose();
			terminal.dispose();
			term.current = null;
			onReady(null, null);
		};
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- 终端只建一次，回调经 ref 读最新的
	}, [api]);

	// 接上这条连接：先回放，再收新的。换了连接（重新连接）清屏重接。
	useEffect(() => {
		const terminal = term.current;
		if (!terminal) return;
		terminal.reset();
		let stopped = false;
		const call = api.attach(id);
		void (async () => {
			try {
				for await (const output of call) {
					if (stopped) break;
					if (output.type === "data") await new Promise<void>((resolve) => terminal.write(output.data, resolve));
					else if (output.type === "ready") void api.resize(id, size.current.cols, size.current.rows).catch(() => undefined);
				}
			} catch {}
		})();
		return () => {
			stopped = true;
			call.cancel();
		};
	}, [api, id]);

	// 连上、切回这个标签时把键盘交给终端。
	useEffect(() => {
		if (shown && connection.state === "connected") term.current?.focus();
	}, [shown, connection.state]);

	return (
		<>
			<div
				ref={host}
				className="ssh-terminal"
				data-ssh-terminal={id}
				onContextMenu={(event) => {
					const terminal = term.current;
					if (!terminal) return;
					event.preventDefault();
					setMenu({ x: event.clientX, y: event.clientY, selection: terminal.getSelection() });
				}}
				onDragOver={(event) => {
					if (!droppedPaths(event.dataTransfer)) return;
					event.preventDefault();
					event.dataTransfer.dropEffect = "copy";
				}}
				onDrop={(event) => {
					const paths = droppedPaths(event.dataTransfer);
					if (!paths || !term.current) return;
					event.preventDefault();
					// 本机路径对远端没有意义，打出来只是方便人照着改；不回车。
					term.current.paste(paths.map((path) => (/\s/.test(path) ? `'${path}'` : path)).join(" "));
				}}
			/>
			{menu && (
				<TerminalMenu
					at={menu}
					canCopy={menu.selection.length > 0}
					text={text}
					onCopy={() => void navigator.clipboard.writeText(menu.selection)}
					onPaste={() =>
						void navigator.clipboard.readText().then((value) => {
							if (value && term.current) {
								term.current.paste(value);
								term.current.focus();
							}
						})
					}
					onAsk={onAsk}
					onClose={() => setMenu(null)}
				/>
			)}
		</>
	);
}

const ICON = { size: 13, strokeWidth: 1.8 } as const;

function TerminalMenu({
	at,
	canCopy,
	text,
	onCopy,
	onPaste,
	onAsk,
	onClose,
}: {
	at: { x: number; y: number };
	canCopy: boolean;
	text: Messages;
	onCopy(): void;
	onPaste(): void;
	onAsk(): void;
	onClose(): void;
}) {
	const mac = macKeyboard();
	return (
		<ContextMenu anchor={at} onClose={onClose} width="compact">
			<MenuItem icon={<Copy {...ICON} />} hint={mac ? "⌘C" : "Ctrl+Shift+C"} disabled={!canCopy} onClick={onCopy}>
				{text.copy}
			</MenuItem>
			<MenuItem icon={<ClipboardPaste {...ICON} />} hint={mac ? "⌘V" : windowsKeyboard() ? "Ctrl+V" : "Ctrl+Shift+V"} onClick={onPaste}>
				{text.paste}
			</MenuItem>
			<MenuSeparator />
			<MenuItem icon={<MessageSquarePlus {...ICON} />} onClick={onAsk}>
				{canCopy ? text.askSelection : text.askRecent}
			</MenuItem>
		</ContextMenu>
	);
}
