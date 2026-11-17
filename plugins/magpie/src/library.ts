/**
 * Magpie 资源库写进这个插件数据目录的两样东西：全局指令 `AGENTS.md` 和 MCP 服务 `mcp.json`（Claude 格式的 `mcpServers`）。
 * 写的一方是 Magpie 的 Agent 插件（Plume 仓库的 `integrations/magpie`），撤回时删掉。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PromptSection } from "@plume/contract";

const INSTRUCTIONS_FILE = "AGENTS.md";
export const MCP_FILE = "mcp.json";

/** 全局指令最多放进提示词多少个字符。shortcut：超过的只放开头；需要更长时改成截断后告诉模型去读全文。 */
export const INSTRUCTIONS_CHAR_LIMIT = 100 * 1024;

type Log = { warn(message: string): void };

/** 现读全局指令：没有就是没分发过（空串）；读不了只留一句诊断，不拖垮这一轮。 */
export async function readInstructions(dir: string, log: Log): Promise<string> {
	const path = join(dir, INSTRUCTIONS_FILE);
	const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") log.warn(`无法读取 ${path}`);
		return "";
	});
	if (text.length > INSTRUCTIONS_CHAR_LIMIT) log.warn(`${path} 超过 ${INSTRUCTIONS_CHAR_LIMIT} 个字符，只放开头部分`);
	return text
		.replace(/^\uFEFF/, "")
		.slice(0, INSTRUCTIONS_CHAR_LIMIT)
		.trim();
}

/**
 * 把全局指令放成单独一段，插在第一段项目约定（`category: "conventions"`）前面：项目自己的规矩排在后面、优先，
 * 和人在设置里写的全局指令一样。没有项目约定就放在最后。
 */
export function withInstructions(sections: readonly PromptSection[], instructions: string): PromptSection[] {
	if (!instructions) return [...sections];
	const section: PromptSection = {
		id: "magpieInstructions",
		category: "instructions",
		text: `<global_user_instructions>\nUser's global instructions shared from their Magpie library, across all projects and chats:\n${instructions}\n</global_user_instructions>`,
	};
	const at = sections.findIndex((candidate) => candidate.category === "conventions");
	return at < 0 ? [...sections, section] : [...sections.slice(0, at), section, ...sections.slice(at)];
}

/**
 * 现读 MCP 服务：没有文件是 `{}`（没分发过或撤回了）；读不了、读不懂是 null，交给服务 `mcp.servers` 时它留着上一份。
 * 读不懂时只说文件坏了，不转述解析器的话：原文里可能有令牌。
 */
export async function readMcpServers(dir: string, log: Log): Promise<Record<string, unknown> | null> {
	const path = join(dir, MCP_FILE);
	let unreadable = false;
	const raw = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") {
			unreadable = true;
			log.warn(`无法读取 ${path}`);
		}
		return null;
	});
	if (raw === null) return unreadable ? null : {};
	try {
		const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
		if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) throw new Error("invalid");
		return parsed.mcpServers ?? {};
	} catch {
		log.warn(`${path} 不是有效的 MCP 配置，先不改动已登记的服务`);
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
