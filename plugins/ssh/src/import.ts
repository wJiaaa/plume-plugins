/**
 * 从 Excel 导入主机：界面把选的 .xlsx 读成字节交过来，这里在本机解析，不经 Agent。
 *
 * 每张可见的工作表在前 20 行里找表头（地址、账号、密码三列必须有），之后每个非空行是一台主机。公式不认（值可能是
 * 算出来的，看着对、存进去的不对），已有的（地址、端口、账号都一样）和本文件里重复的标出来、不导入。预览留 10 分钟，
 * 只把选中的那几行交给 Vault 一次写进去；密码只在逻辑入口里。
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ExcelJS from "exceljs";
import type { ImportInput, ImportPreview, ImportRow, ImportWarning } from "./api.ts";
import type { Messages } from "./messages.ts";
import { availablePath } from "./paths.ts";
import { type HostFields, hostIdentity, validateHostFields } from "./vault.ts";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 1000;
const MAX_SHEETS = 20;
const MAX_COLUMNS = 64;
const PREVIEW_TTL = 10 * 60 * 1000;

type Field = "name" | "host" | "port" | "username" | "password" | "groupName";

// i18n-exempt：表头按中英文常见写法认，和人填的表格比对，不是界面文字。
const ALIASES: Record<Field, string[]> = {
	name: ["名称", "服务器名称", "主机名称", "name", "servername", "hostname"],
	host: ["地址", "主机地址", "服务器地址", "ip", "host", "address", "ip地址", "主机"],
	username: ["账号", "帐号", "用户名", "ssh账号", "ssh帐号", "username", "user", "login"],
	password: ["密码", "登录密码", "ssh密码", "password", "passwd", "pwd"],
	port: ["端口", "ssh端口", "port"],
	groupName: ["分组", "组", "group", "groupname", "分组名称"],
};

const FIELDS = new Map<string, Field>();
for (const field of Object.keys(ALIASES) as Field[]) for (const alias of ALIASES[field]) FIELDS.set(alias, field);

class FormulaCell extends Error {}

function cellText(cell: ExcelJS.Cell): string {
	const value = cell.value;
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return cell.text;
	if (typeof value === "object" && ("formula" in value || "sharedFormula" in value)) throw new FormulaCell();
	if (typeof value === "object" && "richText" in value && Array.isArray(value.richText)) return value.richText.map((part) => part.text).join("");
	throw new Error("unsupported cell");
}

function headerField(cell: ExcelJS.Cell): Field | undefined {
	try {
		return FIELDS.get(
			cellText(cell)
				.trim()
				.toLowerCase()
				.replace(/[\s_-]/g, ""),
		);
	} catch {
		return undefined;
	}
}

interface Candidate {
	fields: HostFields;
	groupName: string;
}

export class HostImports {
	private current?: { id: string; candidates: Map<string, Candidate>; timer: ReturnType<typeof setTimeout> };

	constructor(
		private readonly deps: {
			exists(fields: HostFields): boolean;
			t(): Messages;
		},
	) {}

	async preview(fileName: string, data: ArrayBuffer): Promise<ImportPreview> {
		const t = this.deps.t();
		this.clear();
		if (!/\.xlsx$/i.test(fileName)) throw new Error(t.errors.importXlsxOnly);
		if (!(data instanceof ArrayBuffer) || data.byteLength > MAX_BYTES) throw new Error(t.errors.importUnreadable);
		const workbook = new ExcelJS.Workbook();
		try {
			await workbook.xlsx.load(data);
		} catch {
			throw new Error(t.errors.importUnreadable);
		}
		if (workbook.worksheets.length > MAX_SHEETS) throw new Error(t.errors.importUnreadable);

		const rows: ImportRow[] = [];
		const warnings: ImportWarning[] = [];
		const candidates = new Map<string, Candidate>();
		const seen = new Set<string>();
		let dataRows = 0;
		let numericPassword = false;
		for (const [index, sheet] of workbook.worksheets.entries()) {
			const number = index + 1;
			if (sheet.state !== "visible") {
				warnings.push({ kind: "hiddenSheet", sheet: number });
				continue;
			}
			let header: { row: number; columns: Partial<Record<Field, number>> } | undefined;
			let duplicate = false;
			let outside = false;
			for (let rowNumber = 1; rowNumber <= Math.min(20, sheet.rowCount); rowNumber++) {
				const columns: Partial<Record<Field, number>> = {};
				const found = new Set<Field>();
				let repeated = false;
				sheet.getRow(rowNumber).eachCell((cell, column) => {
					const field = headerField(cell);
					if (!field) return;
					if (found.has(field)) repeated = true;
					found.add(field);
					if (column > MAX_COLUMNS) outside = true;
					else columns[field] = column;
				});
				if (columns.host && columns.username && columns.password) {
					if (repeated) duplicate = true;
					else header = { row: rowNumber, columns };
					break;
				}
			}
			if (duplicate) {
				warnings.push({ kind: "duplicateHeader", sheet: number });
				continue;
			}
			if (!header) {
				warnings.push({ kind: "noHeader", sheet: number });
				continue;
			}
			if (outside) warnings.push({ kind: "farColumns", sheet: number });
			const { row: headerRow, columns } = header;
			for (let rowNumber = headerRow + 1; rowNumber <= sheet.rowCount; rowNumber++) {
				const row = sheet.getRow(rowNumber);
				let nonempty = false;
				row.eachCell((cell) => {
					if (cell.value !== null && cell.value !== undefined && (typeof cell.value !== "string" || cell.value.trim())) nonempty = true;
				});
				if (!nonempty) continue;
				if (++dataRows > MAX_ROWS) throw new Error(t.errors.importUnreadable);
				const id = randomUUID();
				const base = { id, sheet: sheet.name, row: rowNumber };
				try {
					const values = {} as Record<Field, string>;
					for (const field of Object.keys(ALIASES) as Field[]) {
						const column = columns[field];
						values[field] = column === undefined ? "" : cellText(row.getCell(column));
					}
					if (columns.password !== undefined && typeof row.getCell(columns.password).value === "number") numericPassword = true;
					const groupName = values.groupName.trim();
					const port = values.port.trim();
					if (groupName.length > 80 || (port && !/^\d+$/.test(port))) throw new Error("invalid row");
					const fields = validateHostFields(
						{
							name: values.name.trim() || t.importedName(dataRows),
							host: values.host,
							port: port ? Number(port) : 22,
							username: values.username,
							password: values.password,
						},
						t.errors,
					);
					const identity = hostIdentity(fields);
					const repeated = seen.has(identity) || this.deps.exists(fields);
					seen.add(identity);
					rows.push({
						...base,
						name: fields.name,
						host: fields.host,
						port: fields.port,
						username: fields.username,
						groupName,
						status: repeated ? "duplicate" : "ready",
					});
					if (!repeated) candidates.set(id, { fields, groupName });
				} catch (error) {
					rows.push({ ...base, name: "", host: "", port: null, username: "", groupName: "", status: error instanceof FormulaCell ? "formula" : "invalid" });
				}
			}
		}
		if (numericPassword) warnings.push({ kind: "numericPassword" });
		const id = randomUUID();
		const timer = setTimeout(() => this.discard(id), PREVIEW_TTL);
		timer.unref?.();
		this.current = { id, candidates, timer };
		return { id, fileName, rows, warnings };
	}

	/** 选中的行；预览不在了、行不能导入时抛错。 */
	selected(input: ImportInput): Candidate[] {
		const t = this.deps.t();
		const current = this.current;
		if (!current || current.id !== input.previewId) throw new Error(t.errors.importExpired);
		if (!Array.isArray(input.rowIds) || input.rowIds.length === 0 || new Set(input.rowIds).size !== input.rowIds.length)
			throw new Error(t.errors.invalidRequest);
		return input.rowIds.map((id) => {
			const candidate = current.candidates.get(id);
			if (!candidate) throw new Error(t.errors.importExpired);
			return { fields: { ...candidate.fields }, groupName: candidate.groupName };
		});
	}

	discard(id: string): void {
		if (this.current?.id === id) this.clear();
	}

	clear(): void {
		if (!this.current) return;
		clearTimeout(this.current.timer);
		this.current.candidates.clear();
		this.current = undefined;
	}
}

/** 写一份导入模板到 `directory`，表头按当前语言，返回路径。 */
export async function writeTemplate(directory: string, t: Messages): Promise<string> {
	const workbook = new ExcelJS.Workbook();
	const sheet = workbook.addWorksheet(t.template.sheet);
	const { headers } = t.template;
	sheet.columns = [
		{ header: headers.name, width: 28 },
		{ header: headers.host, width: 26 },
		{ header: headers.port, width: 12 },
		{ header: headers.username, width: 22 },
		{ header: headers.password, width: 30 },
		{ header: headers.group, width: 22 },
	];
	// 密码列设成文本：数字密码的前导 0、长数字的精度不会被 Excel 吃掉。
	sheet.getColumn(5).numFmt = "@";
	sheet.addRow(t.template.example);
	sheet.getRow(1).font = { bold: true };
	sheet.views = [{ state: "frozen", ySplit: 1 }];
	await mkdir(directory, { recursive: true });
	const path = await availablePath(join(directory, t.template.fileName));
	await writeFile(path, Buffer.from(await workbook.xlsx.writeBuffer()), { flag: "wx" });
	return path;
}
