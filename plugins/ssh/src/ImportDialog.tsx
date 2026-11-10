/**
 * 从 Excel 导入主机：选一个 .xlsx，逻辑入口解析出预览（密码不回到界面），人勾选要导入的行、选放进哪个分组，
 * 或者按表里「分组」一列建组；已有的（地址、端口、账号都一样）、填得不对的、带公式的行不能勾。
 * 「下载模板」把模板写进本机的「下载」文件夹。
 */

import type { Remote, UiContext } from "@plume/contract/ui";
import { Button, ChoiceMark, Dialog, Select, Text, Toggle, useI18n } from "@plume/ui";
import { Download, FileSpreadsheet, Upload } from "@plume/ui/icons";
import { useEffect, useRef, useState } from "react";
import type { HostGroup, ImportPreview, ImportRow, ImportWarning, SshApi } from "./api.ts";
import { errorText } from "./client.ts";
import { type Messages, MESSAGES } from "./messages.ts";

function warningText(text: Messages, warning: ImportWarning): string {
	if (warning.kind === "numericPassword") return text.warnNumericPassword;
	return {
		hiddenSheet: text.warnHiddenSheet,
		noHeader: text.warnNoHeader,
		duplicateHeader: text.warnDuplicateHeader,
		farColumns: text.warnFarColumns,
	}[warning.kind](warning.sheet);
}

function statusText(text: Messages, status: ImportRow["status"]): string {
	return { ready: "", duplicate: text.rowDuplicate, invalid: text.rowInvalid, formula: text.rowFormula }[status];
}

export function ImportDialog({ ui, api, groups, onClose }: { ui: Pick<UiContext, "notify">; api: Remote<SshApi>; groups: HostGroup[]; onClose(): void }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const [preview, setPreview] = useState<ImportPreview | null>(null);
	const [chosen, setChosen] = useState<Set<string>>(new Set());
	const [groupId, setGroupId] = useState("");
	const [sheetGroups, setSheetGroups] = useState(true);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState("");
	const input = useRef<HTMLInputElement>(null);
	const previewId = useRef<string | null>(null);

	// 关掉对话框时丢掉逻辑入口那边的预览：里面有密码。
	useEffect(
		() => () => {
			if (previewId.current) void api.discardImport(previewId.current).catch(() => undefined);
		},
		[api],
	);

	const ready = preview?.rows.filter((row) => row.status === "ready") ?? [];
	const hasSheetGroups = preview?.rows.some((row) => row.groupName) ?? false;

	const read = async (file: File) => {
		setBusy(true);
		setFailure("");
		try {
			const result = await api.previewImport(file.name, await file.arrayBuffer());
			previewId.current = result.id;
			setPreview(result);
			setChosen(new Set(result.rows.filter((row) => row.status === "ready").map((row) => row.id)));
		} catch (cause) {
			setFailure(errorText(cause));
		} finally {
			setBusy(false);
		}
	};

	const commit = async (done: () => void) => {
		if (!preview || chosen.size === 0) return;
		setBusy(true);
		setFailure("");
		try {
			const result = await api.commitImport({
				previewId: preview.id,
				rowIds: [...chosen],
				groupId: groupId || null,
				useSheetGroups: sheetGroups && hasSheetGroups,
			});
			previewId.current = null;
			ui.notify(text.imported(result.imported, result.skipped), "info");
			done();
		} catch (cause) {
			setFailure(errorText(cause));
			setBusy(false);
		}
	};

	const template = () =>
		void api.writeTemplate().then(
			(path) => ui.notify(text.templateSaved(path), "info"),
			(cause: unknown) => ui.notify(errorText(cause), "error"),
		);

	const toggle = (id: string) =>
		setChosen((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	const all = ready.length > 0 && ready.every((row) => chosen.has(row.id));

	return (
		<Dialog
			onClose={onClose}
			width={720}
			label={text.importTitle}
			title={text.importTitle}
			icon={<FileSpreadsheet size={16} />}
			detail={text.importDetail}
			status={
				failure ? (
					<Text as="p" size="detail" tone="danger" role="alert">
						{failure}
					</Text>
				) : undefined
			}
			actions={(dismiss) => (
				<>
					<Button variant="subtle" icon={<Download size={14} />} onClick={template} data-ssh-template="">
						{text.downloadTemplate}
					</Button>
					<span className="ssh-spacer" />
					<Button onClick={() => dismiss()}>{text.cancel}</Button>
					<Button
						variant="primary"
						disabled={!preview || chosen.size === 0}
						loading={busy && Boolean(preview)}
						onClick={() => void commit(() => dismiss())}
						data-ssh-import-commit=""
					>
						{text.importCount(chosen.size)}
					</Button>
				</>
			)}
		>
			<div className="ssh-form">
				<input
					ref={input}
					type="file"
					accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
					hidden
					data-ssh-import-file=""
					onChange={(event) => {
						const file = event.target.files?.[0];
						event.target.value = "";
						if (file) void read(file);
					}}
				/>
				<div className="ssh-form-pair">
					<Button icon={<Upload size={14} />} loading={busy && !preview} onClick={() => input.current?.click()}>
						{preview ? text.chooseAnother : text.chooseFile}
					</Button>
					{preview && (
						<Text size="detail" tone="muted" className="ssh-ellipsis">
							{preview.fileName}
						</Text>
					)}
				</div>

				{preview && (
					<>
						{preview.warnings.length > 0 && (
							<ul className="ssh-warnings">
								{preview.warnings.map((warning, index) => (
									<li key={index}>
										<Text size="detail" tone="muted">
											{warningText(text, warning)}
										</Text>
									</li>
								))}
							</ul>
						)}
						<div className="ssh-form-pair">
							<div className="ssh-grow">
								<Select
									value={groupId}
									onChange={setGroupId}
									ariaLabel={text.importGroup}
									options={[
										{ value: "", label: text.importToUngrouped },
										...groups.map((entry) => ({ value: entry.id, label: text.importToGroup(entry.name) })),
									]}
								/>
							</div>
							{hasSheetGroups && (
								<label className="ssh-monitor">
									<Text size="detail" tone="muted">
										{text.useSheetGroups}
									</Text>
									<Toggle checked={sheetGroups} onChange={setSheetGroups} ariaLabel={text.useSheetGroups} />
								</label>
							)}
						</div>
						{preview.rows.length === 0 ? (
							<Text as="p" size="detail" tone="faint">
								{text.importEmpty}
							</Text>
						) : (
							<div className="ssh-import-table" role="table" aria-label={text.importRows}>
								<div role="row" className="ssh-import-row ssh-import-head">
									<span role="columnheader">
										<button
											type="button"
											role="checkbox"
											aria-checked={all ? true : chosen.size > 0 ? "mixed" : false}
											className="ssh-check"
											aria-label={text.selectAll}
											disabled={ready.length === 0}
											onClick={() => setChosen(all ? new Set() : new Set(ready.map((row) => row.id)))}
										>
											<ChoiceMark kind="checkbox" checked={all} indeterminate={!all && chosen.size > 0} />
										</button>
									</span>
									{[text.hostName, text.hostAddress, text.username, text.group, ""].map((label, index) => (
										<Text key={index} role="columnheader" size="caption" tone="faint">
											{label}
										</Text>
									))}
								</div>
								{preview.rows.map((row) => (
									<div key={row.id} role="row" className="ssh-import-row" data-status={row.status}>
										<span role="cell">
											<button
												type="button"
												role="checkbox"
												aria-checked={chosen.has(row.id)}
												className="ssh-check"
												aria-label={text.selectRow(row.sheet, row.row)}
												disabled={row.status !== "ready"}
												onClick={() => toggle(row.id)}
											>
												<ChoiceMark kind="checkbox" checked={chosen.has(row.id)} />
											</button>
										</span>
										<Text role="cell" size="detail" className="ssh-ellipsis" title={`${row.sheet} #${row.row}`}>
											{row.name || "—"}
										</Text>
										<Text role="cell" size="detail" mono tone="muted" className="ssh-ellipsis">
											{row.host ? `${row.host}:${row.port ?? "?"}` : "—"}
										</Text>
										<Text role="cell" size="detail" className="ssh-ellipsis">
											{row.username || "—"}
										</Text>
										<Text role="cell" size="detail" tone="muted" className="ssh-ellipsis">
											{row.groupName || ""}
										</Text>
										<Text role="cell" size="caption" tone={row.status === "duplicate" ? "faint" : "danger"} className="ssh-ellipsis">
											{statusText(text, row.status)}
										</Text>
									</div>
								))}
							</div>
						)}
					</>
				)}
				{!preview && (
					<Text as="p" size="detail" tone="faint">
						{text.importHint}
					</Text>
				)}
			</div>
		</Dialog>
	);
}
