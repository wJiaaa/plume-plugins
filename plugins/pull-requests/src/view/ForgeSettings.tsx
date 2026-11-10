import { useEffect, useRef, useState, type ReactNode } from "react";
import {
	Button,
	Confirm,
	Dialog,
	DialogAction,
	IconButton,
	Input,
	SettingsCard,
	SettingsRow,
	SettingsSectionTitle,
	SkeletonList,
	Text,
	Toggle,
} from "@plume/ui";
import { Check, ExternalLink, Pencil, Plus, ShieldCheck, Trash2 } from "@plume/ui/icons";
import type { ForgeAccount, ForgeKind, ForgeKindInfo } from "../api";
import { format } from "../messages";
import { Avatar } from "./avatars";
import { useMessages, useServices, useStore } from "./context";
import { host, httpUrl, tokenUrl } from "./model";

export function ForgeSettings() {
	const text = useMessages();
	const { api, store } = useServices();
	const state = useStore();
	const [kinds, setKinds] = useState<ForgeKindInfo[]>([]);
	const [adding, setAdding] = useState(false);
	const [editing, setEditing] = useState<string | null>(null);
	const [removing, setRemoving] = useState<ForgeAccount | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		void store.reloadAccounts();
		void api
			.kinds()
			.then((result) => {
				if (!cancelled) setKinds(result.kinds);
			})
			.catch((failure) => {
				if (!cancelled) setError(String(failure));
			});
		return () => {
			cancelled = true;
		};
	}, [api, store]);
	const mutate = async (id: string, change: () => PromiseLike<unknown>): Promise<boolean> => {
		if (busy) return false;
		setBusy(id);
		setError(null);
		try {
			await change();
			await store.invalidateAccounts();
			return true;
		} catch (failure) {
			setError(String(failure));
			return false;
		} finally {
			setBusy(null);
		}
	};
	const identityOf = (account: ForgeAccount) => {
		const parts = account.login !== account.label ? [account.login] : [];
		const info = kinds.find((entry) => entry.kind === account.kind);
		if (info && host(info.baseUrl) !== host(account.baseUrl)) parts.push(host(account.baseUrl));
		return parts.join(" · ");
	};
	return (
		<div className="plume-pr-forges">
			<SettingsSectionTitle>{text.accounts}</SettingsSectionTitle>
			{(error || state.accountError) && (
				<Text as="p" size="detail" tone="danger" role="alert">
					{error ?? state.accountError}
				</Text>
			)}
			{!state.ready && !state.accountError && <SkeletonList count={2} label={text.reading} />}
			{state.ready && !state.accounts.length && (
				<SettingsCard>
					<Text as="p" tone="faint" className="plume-pr-setting-empty">
						{text.noAccounts}
					</Text>
				</SettingsCard>
			)}
			{state.accounts.map((account) => (
				<SettingsCard key={account.id} className="plume-pr-account-card">
					<SettingsRow
						title={
							<span className="plume-pr-account-title">
								<Avatar accountId={account.id} login={account.login} url={account.avatarUrl} size={26} />
								{editing === account.id ? (
									<RenameField
										initial={account.label}
										disabled={busy === account.id}
										onSave={async (label) => {
											if (await mutate(account.id, () => api.rename(account.id, label))) setEditing(null);
										}}
										onCancel={() => setEditing(null)}
									/>
								) : (
									<>
										<Text className="plume-pr-truncate">{account.label}</Text>
										<Text size="caption" tone="muted" className="plume-pr-badge">
											{kinds.find((info) => info.kind === account.kind)?.name ?? account.kind}
										</Text>
									</>
								)}
							</span>
						}
						detail={
							account.lastError && account.enabled ? (
								<Text size="detail" tone="danger">
									{account.lastError}
								</Text>
							) : (
								identityOf(account)
							)
						}
						control={
							editing === account.id ? undefined : (
								<div className="plume-pr-account-actions">
									<IconButton size="sm" label={text.rename} disabled={Boolean(busy)} icon={<Pencil size={13} />} onClick={() => setEditing(account.id)} />
									<IconButton
										size="sm"
										label={text.signOut}
										disabled={Boolean(busy)}
										tone="danger"
										icon={<Trash2 size={13} />}
										onClick={() => setRemoving(account)}
									/>
									<Toggle
										checked={account.enabled}
										disabled={Boolean(busy)}
										ariaLabel={format(text.enabled, { account: account.label })}
										onChange={(enabled) => void mutate(account.id, () => api.setEnabled(account.id, enabled))}
									/>
								</div>
							)
						}
					/>
				</SettingsCard>
			))}
			<Button icon={<Plus size={14} />} disabled={!kinds.length} onClick={() => setAdding(true)}>
				{text.addAccount}
			</Button>
			{adding && <ForgeSignIn kinds={kinds} onClose={() => setAdding(false)} />}
			{removing && (
				<Confirm
					title={format(text.signOutTitle, { account: removing.label })}
					detail={text.signOutDetail}
					confirmLabel={text.signOut}
					cancelLabel={text.cancel}
					onCancel={() => setRemoving(null)}
					onConfirm={() => {
						const target = removing;
						setRemoving(null);
						void mutate(target.id, () => api.signOut(target.id));
					}}
				/>
			)}
		</div>
	);
}

function RenameField({
	initial,
	disabled,
	onSave,
	onCancel,
}: {
	initial: string;
	disabled: boolean;
	onSave: (value: string) => Promise<void>;
	onCancel: () => void;
}) {
	const text = useMessages();
	const [value, setValue] = useState(initial);
	const saving = useRef(false);
	const cancelled = useRef(false);
	const save = async () => {
		if (cancelled.current || saving.current || disabled) return;
		if (!value.trim() || value.trim() === initial) {
			onCancel();
			return;
		}
		saving.current = true;
		try {
			await onSave(value.trim());
		} finally {
			saving.current = false;
		}
	};
	return (
		<Text className="plume-pr-rename">
			<Input
				className="plume-field"
				aria-label={text.rename}
				value={value}
				autoFocus
				disabled={disabled}
				onChange={(event) => setValue(event.target.value)}
				onBlur={() => void save()}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						void save();
					}
					if (event.key === "Escape") {
						cancelled.current = true;
						onCancel();
					}
				}}
			/>
		</Text>
	);
}

function ForgeSignIn({ kinds, onClose }: { kinds: ForgeKindInfo[]; onClose: () => void }) {
	const text = useMessages();
	const { api, ui, store } = useServices();
	const [kind, setKind] = useState<ForgeKind>("github");
	const [baseUrl, setBaseUrl] = useState(kinds.find((entry) => entry.kind === "github")?.baseUrl ?? "https://github.com");
	const [token, setToken] = useState("");
	const [label, setLabel] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [added, setAdded] = useState<ForgeAccount | null>(null);
	const call = useRef<ReturnType<typeof api.signIn> | null>(null);
	const mounted = useRef(true);
	const success = useRef<HTMLDivElement>(null);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			call.current?.cancel();
		};
	}, []);
	useEffect(() => {
		if (added) success.current?.closest('[role="dialog"]')?.querySelector<HTMLElement>("[data-plume-forge-done]")?.focus();
	}, [added]);
	const info = kinds.find((entry) => entry.kind === kind);
	const help = info ? tokenUrl(info, baseUrl) : null;
	const ready = Boolean(token.trim() && baseUrl.trim() && !busy);
	const choose = (next: ForgeKind) => {
		const untouched = !baseUrl.trim() || kinds.some((entry) => entry.baseUrl === baseUrl.trim());
		setKind(next);
		setError(null);
		if (untouched) setBaseUrl(kinds.find((entry) => entry.kind === next)?.baseUrl ?? "");
	};
	const save = async () => {
		if (!ready || call.current) return;
		if (!httpUrl(baseUrl.trim())) {
			setError(text.invalidUrl);
			return;
		}
		setBusy(true);
		setError(null);
		const request = api.signIn({ kind, baseUrl: baseUrl.trim(), token: token.trim(), label: label.trim() });
		call.current = request;
		try {
			const result = await request;
			if (result.account) await store.invalidateAccounts();
			if (!mounted.current) return;
			if (result.error || !result.account) {
				setError(result.error ?? text.verifyFailed);
				return;
			}
			setToken("");
			setAdded(result.account);
		} catch (failure) {
			if (mounted.current) setError(String(failure));
		} finally {
			call.current = null;
			if (mounted.current) setBusy(false);
		}
	};
	return (
		<Dialog
			title={text.addTitle}
			label={text.addTitle}
			width={500}
			onClose={onClose}
			actions={(dismiss) =>
				added ? (
					<DialogAction tone="primary" onClick={() => dismiss()} data-plume-forge-done="" autoFocus>
						{text.done}
					</DialogAction>
				) : (
					<>
						<DialogAction tone="primary" disabled={!ready} onClick={() => void save()}>
							{busy ? text.verifying : text.verifyAndSave}
						</DialogAction>
						<DialogAction onClick={() => dismiss()}>{text.cancel}</DialogAction>
					</>
				)
			}
		>
			{added ? (
				<div className="plume-pr-signin-success plume-pr-fade" tabIndex={-1} ref={success} role="status">
					<div className="plume-pr-success-avatar">
						<Avatar accountId={added.id} login={added.login} url={added.avatarUrl} size={52} />
						<span className="plume-pr-success-mark">
							<Check size={12} />
						</span>
					</div>
					<Text size="body" weight="medium">
						{added.login}
					</Text>
					<Text size="detail" tone="muted">
						{info?.name} · {host(added.baseUrl)}
					</Text>
					<Text size="detail" className="plume-pr-ok">
						{text.connected}
					</Text>
				</div>
			) : (
				<form
					className="plume-pr-signin"
					onSubmit={(event) => {
						event.preventDefault();
						void save();
					}}
				>
					<div role="group" aria-label={text.host} className="plume-pr-kind-choices">
						{kinds.map((entry) => (
							<Button key={entry.kind} pressed={kind === entry.kind} disabled={busy} onClick={() => choose(entry.kind)}>
								{entry.name}
							</Button>
						))}
					</div>
					{info?.note && (
						<Text as="p" size="caption" tone="faint">
							{info.note}
						</Text>
					)}
					<Field label={text.baseUrl} hint={text.baseUrlDetail}>
						<Input
							name="forge-base-url"
							aria-label={text.baseUrl}
							type="url"
							autoComplete="off"
							spellCheck={false}
							className="plume-field"
							value={baseUrl}
							disabled={busy}
							onChange={(event) => {
								setBaseUrl(event.target.value);
								setError(null);
							}}
						/>
					</Field>
					<Field
						label={text.token}
						action={
							help && (
								<Button
									size="xs"
									variant="subtle"
									icon={<ExternalLink size={11} />}
									onClick={() => void ui.openExternal(help).catch((failure) => setError(String(failure)))}
								>
									{text.createToken}
								</Button>
							)
						}
					>
						<Input
							name="forge-token"
							aria-label={text.token}
							type="password"
							autoComplete="off"
							className="plume-field"
							value={token}
							disabled={busy}
							autoFocus
							placeholder={text.pasteToken}
							onChange={(event) => {
								setToken(event.target.value);
								setError(null);
							}}
						/>
					</Field>
					{error && (
						<Text as="p" size="caption" tone="danger" role="alert">
							{error}
						</Text>
					)}
					{info?.scopes && (
						<Text as="p" size="caption" tone="faint">
							{format(text.needsScopes, { scopes: info.scopes })}
						</Text>
					)}
					<Text as="p" size="caption" tone="faint" className="plume-pr-token-note">
						<ShieldCheck size={12} />
						{text.tokenStorage}
					</Text>
					<Field label={text.nickname} hint={text.nicknameDetail}>
						<Input
							name="forge-label"
							aria-label={text.nickname}
							className="plume-field"
							value={label}
							disabled={busy}
							placeholder={text.nicknamePlaceholder}
							onChange={(event) => setLabel(event.target.value)}
						/>
					</Field>
					<Button type="submit" className="plume-pr-submit-proxy" disabled={!ready}>
						{text.verifyAndSave}
					</Button>
				</form>
			)}
		</Dialog>
	);
}
function Field({ label, hint, action, children }: { label: string; hint?: string; action?: ReactNode; children: ReactNode }) {
	return (
		<div className="plume-pr-field">
			<span className="plume-pr-field-label">
				<Text weight="medium">{label}</Text>
				{action}
			</span>
			<Text as="label">{children}</Text>
			{hint && (
				<Text size="caption" tone="faint">
					{hint}
				</Text>
			)}
		</div>
	);
}
