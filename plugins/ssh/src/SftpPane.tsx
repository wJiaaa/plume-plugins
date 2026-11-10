/**
 * 终端右边的 SFTP 文件面板：从登录用户的家目录开始，双击文件夹进去、双击文件下载到「下载」文件夹；把本机文件拖进来
 * 上传到当前目录（同名覆盖）；选中后可以改名（F2）、删除（Delete，只删文件和空文件夹）。浏览走一条独立的 SFTP 通道，
 * Agent 跑着长命令时照样能翻；每个传输自己一条通道，能随时取消。
 */

import type { Remote, UiContext } from "@plume/contract/ui";
import { Button, IconButton, Input, Scroller, Text, useConfirmer, useI18n } from "@plume/ui";
import { ArrowUp, Download, File, Folder, FolderPlus, Link, Pencil, RotateCw, Trash2, Upload, X } from "@plume/ui/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DirectoryListing, RemoteEntry, SshApi } from "./api.ts";
import { errorText, type SshClient, useSshState } from "./client.ts";
import { bytes, parentPath } from "./format.ts";
import { MESSAGES } from "./messages.ts";

type Host = Pick<UiContext, "notify" | "droppedPaths">;

export function SftpPane({ ui, api, client, connection, onClose }: { ui: Host; api: Remote<SshApi>; client: SshClient; connection: string; onClose(): void }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const state = useSshState(client);
	const [listing, setListing] = useState<DirectoryListing | null>(null);
	const [path, setPath] = useState("");
	const [pathInput, setPathInput] = useState("");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [selected, setSelected] = useState<string | null>(null);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [draft, setDraft] = useState("");
	const [dragging, setDragging] = useState(false);
	const request = useRef(0);
	const finished = useRef(new Set<string>());
	const confirmer = useConfirmer();
	const report = (cause: unknown) => ui.notify(errorText(cause), "error");

	const load = useCallback(
		async (target: string) => {
			const token = ++request.current;
			setLoading(true);
			setError("");
			try {
				const result = await api.sftpList(connection, target);
				if (token !== request.current) return;
				setListing(result);
				setPath(result.path);
				setPathInput(result.path);
				setSelected(null);
			} catch (cause) {
				if (token === request.current) setError(errorText(cause));
			} finally {
				if (token === request.current) setLoading(false);
			}
		},
		[api, connection],
	);

	useEffect(() => {
		let alive = true;
		setListing(null);
		setPath("");
		void api.sftpHome(connection).then(
			(home) => alive && void load(home),
			(cause: unknown) => alive && setError(errorText(cause)),
		);
		return () => {
			alive = false;
			// request 是给 load 作废旧请求用的计数，不是 DOM 引用：卸载时加一，还在路上的结果就不再落到状态里。
			// oxlint-disable-next-line react-hooks/exhaustive-deps
			request.current++;
		};
	}, [api, connection, load]);

	const transfers = (state?.transfers ?? []).filter((transfer) => transfer.connection === connection);
	// 传到当前目录的上传完成后刷新一次列表。
	useEffect(() => {
		for (const transfer of transfers) {
			if (transfer.status !== "done" || finished.current.has(transfer.id)) continue;
			finished.current.add(transfer.id);
			if (transfer.direction === "upload" && parentPath(transfer.remotePath) === path) void load(path);
		}
	}, [transfers, path, load]);

	const act = async (work: () => PromiseLike<unknown>, reload = true) => {
		try {
			await work();
			if (reload && path) await load(path);
		} catch (cause) {
			report(cause);
		}
	};
	const download = (entry: RemoteEntry) =>
		void api.download(connection, entry.path).then(
			(local) => ui.notify(text.downloadingTo(local), "info"),
			(cause: unknown) => report(cause),
		);
	const open = (entry: RemoteEntry) => {
		if (entry.kind === "directory" || entry.kind === "link") void load(entry.path);
		else download(entry);
	};
	const finishRename = (entry: RemoteEntry) => {
		const name = draft.trim();
		setRenaming(null);
		if (name && name !== entry.name) void act(() => api.sftpRename(connection, entry.path, name));
	};
	const finishCreate = () => {
		const name = draft.trim();
		setCreating(false);
		if (name) void act(() => api.sftpMkdir(connection, path, name));
	};
	const remove = (entry: RemoteEntry) =>
		confirmer.ask({
			title: entry.kind === "directory" ? text.deleteFolderTitle(entry.name) : text.deleteFileTitle(entry.name),
			detail: entry.kind === "directory" ? text.deleteFolderDetail(entry.path) : text.deleteFileDetail(entry.path),
			confirmLabel: text.delete,
			onConfirm: () => void act(() => api.sftpRemove(connection, entry.path, entry.kind)),
		});
	const current = listing?.entries.find((entry) => entry.path === selected) ?? null;

	return (
		<div
			className="ssh-sftp"
			data-dragging={dragging || undefined}
			onDragOver={(event) => {
				if (!path || !ui.droppedPaths(event.dataTransfer)) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "copy";
				setDragging(true);
			}}
			onDragLeave={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
			}}
			onDrop={(event) => {
				setDragging(false);
				const paths = ui.droppedPaths(event.dataTransfer);
				if (!paths?.length || !path) return;
				event.preventDefault();
				void act(() => api.upload(connection, path, paths), false);
			}}
		>
			<div className="ssh-sftp-toolbar">
				<IconButton
					size="sm"
					label={text.parentFolder}
					icon={<ArrowUp size={14} />}
					disabled={!path || path === "/"}
					onClick={() => void load(parentPath(path))}
				/>
				<Text as="div" size="detail" className="ssh-sftp-path">
					<Input
						value={pathInput}
						onChange={(event) => setPathInput(event.target.value)}
						aria-label={text.remotePath}
						spellCheck={false}
						onKeyDown={(event) => {
							if (event.key === "Enter") void load(pathInput.trim() || "/");
							if (event.key === "Escape") setPathInput(path);
						}}
					/>
				</Text>
				<IconButton size="sm" label={text.refresh} icon={<RotateCw size={14} />} disabled={!path || loading} onClick={() => void load(path)} />
				<IconButton
					size="sm"
					label={text.newFolder}
					icon={<FolderPlus size={14} />}
					disabled={!path}
					onClick={() => {
						setCreating(true);
						setDraft("");
					}}
				/>
				<IconButton size="sm" label={text.close} icon={<X size={14} />} onClick={onClose} />
			</div>
			<Scroller className="ssh-sftp-scroll" contentClassName="ssh-sftp-list">
				<div
					role="listbox"
					aria-label={text.remoteFiles}
					tabIndex={0}
					className="ssh-sftp-rows"
					onKeyDown={(event) => {
						if (renaming || creating || !listing?.entries.length) return;
						const index = listing.entries.findIndex((entry) => entry.path === selected);
						if (event.key === "ArrowDown" || event.key === "ArrowUp") {
							event.preventDefault();
							const next = listing.entries[Math.min(listing.entries.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))];
							if (next) setSelected(next.path);
						}
						if (event.key === "Enter" && current) open(current);
						if (event.key === "Backspace" && path !== "/") void load(parentPath(path));
						if (event.key === "F2" && current) {
							setRenaming(current.path);
							setDraft(current.name);
						}
						if (event.key === "Delete" && current) remove(current);
					}}
				>
					{creating && (
						<div className="plume-item ssh-sftp-row" data-selected="">
							<Folder size={14} className="ssh-accent" />
							<Text as="div" className="ssh-sftp-edit">
								<Input
									autoFocus
									value={draft}
									aria-label={text.newFolderName}
									onChange={(event) => setDraft(event.target.value)}
									onBlur={finishCreate}
									onKeyDown={(event) => {
										if (event.key === "Enter") finishCreate();
										if (event.key === "Escape") setCreating(false);
									}}
								/>
							</Text>
						</div>
					)}
					{listing?.entries.map((entry) => (
						<div
							key={entry.path}
							role="option"
							tabIndex={-1}
							aria-selected={selected === entry.path}
							data-selected={selected === entry.path || undefined}
							className="plume-item ssh-sftp-row"
							title={entry.permissions}
							onClick={() => setSelected(entry.path)}
							onDoubleClick={() => open(entry)}
						>
							{entry.kind === "directory" ? (
								<Folder size={14} className="ssh-accent" />
							) : entry.kind === "link" ? (
								<Link size={14} className="ssh-faint" />
							) : (
								<File size={14} className="ssh-faint" />
							)}
							{renaming === entry.path ? (
								<Text as="div" className="ssh-sftp-edit">
									<Input
										autoFocus
										value={draft}
										aria-label={text.newName}
										onChange={(event) => setDraft(event.target.value)}
										onBlur={() => finishRename(entry)}
										onKeyDown={(event) => {
											if (event.key === "Enter") finishRename(entry);
											if (event.key === "Escape") setRenaming(null);
										}}
									/>
								</Text>
							) : (
								<Text className="ssh-ellipsis ssh-grow">{entry.name}</Text>
							)}
							<Text size="detail" tone="faint" numeric>
								{entry.kind === "file" ? bytes(entry.size) : ""}
							</Text>
						</div>
					))}
					{!loading && listing && listing.entries.length === 0 && !creating && (
						<Text as="p" tone="faint" className="ssh-sftp-note">
							{text.emptyFolder}
						</Text>
					)}
					{loading && !listing && (
						<Text as="p" tone="faint" className="ssh-sftp-note">
							{text.reading}
						</Text>
					)}
					{error && (
						<Text as="p" size="detail" tone="danger" className="ssh-sftp-note" role="alert">
							{error}
						</Text>
					)}
				</div>
			</Scroller>
			{current && (
				<div className="ssh-sftp-toolbar">
					<Text size="detail" tone="muted" className="ssh-ellipsis ssh-grow">
						{current.name}
					</Text>
					{current.kind === "file" && <IconButton size="sm" label={text.download} icon={<Download size={14} />} onClick={() => download(current)} />}
					<IconButton
						size="sm"
						label={text.rename}
						icon={<Pencil size={14} />}
						onClick={() => {
							setRenaming(current.path);
							setDraft(current.name);
						}}
					/>
					<IconButton size="sm" tone="danger" label={text.delete} icon={<Trash2 size={14} />} onClick={() => remove(current)} />
				</div>
			)}
			{transfers.length > 0 && (
				<div className="ssh-transfers" aria-label={text.transfers}>
					{transfers.slice(0, 20).map((transfer) => (
						<div key={transfer.id} className="ssh-transfer" data-status={transfer.status}>
							{transfer.direction === "upload" ? <Upload size={13} className="ssh-faint" /> : <Download size={13} className="ssh-faint" />}
							<Text size="detail" className="ssh-ellipsis ssh-grow" title={transfer.direction === "upload" ? transfer.remotePath : transfer.localPath}>
								{transfer.name}
							</Text>
							{transfer.status === "running" ? (
								<>
									<Text size="caption" tone="faint" numeric>
										{transfer.total ? `${Math.min(100, Math.round((transfer.bytes / transfer.total) * 100))}%` : bytes(transfer.bytes)}
									</Text>
									<IconButton size="xs" label={text.cancel} icon={<X size={12} />} onClick={() => void api.cancelTransfer(transfer.id).catch(report)} />
								</>
							) : (
								<Text size="caption" tone={transfer.status === "failed" ? "danger" : "faint"} className="ssh-ellipsis" title={transfer.error}>
									{transfer.status === "done"
										? text.transferDone
										: transfer.status === "cancelled"
											? text.transferCancelled
											: (transfer.error ?? text.transferFailed)}
								</Text>
							)}
						</div>
					))}
				</div>
			)}
			<div className="ssh-sftp-foot">
				<Text size="caption" tone="faint">
					{listing ? text.itemCount(listing.entries.length, listing.truncated) : " "}
				</Text>
				{path && (
					<Button size="xs" variant="subtle" icon={<Upload size={12} />} label={text.uploadHint} onClick={() => ui.notify(text.uploadHint, "info")}>
						{text.upload}
					</Button>
				)}
			</div>
			{confirmer.element}
		</div>
	);
}
