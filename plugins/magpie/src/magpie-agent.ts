/**
 * Magpie 那一侧的 Agent 插件：把 Plume 放进 Magpie 的 Agent 页，在那里给 Plume 选模型、分发资源库。
 *
 * 插件包只能带固定的几样文件，带不上它，所以每次启用时写到数据目录的 `magpie-agent/`，人在 Magpie 的「设置 → 插件」里添加
 * 这个文件夹。不放插件的安装目录：插件更新、卸载时那里整个换掉或删掉，Magpie 登记的路径就失效了。
 *
 * Magpie 只会按点分路径原地改 JSON 的对象键，所以写的是 `credentials.json` 顶层的 `magpie` 块和 `defaultModel`（见 `gateway.ts`）；
 * 模型引用 `magpie/<网关里的模型 id>` 和插件交出的供应商对得上。路径按实际的数据目录生成，自定义 `PLUME_HOME` 也不用手改。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENT_ICON } from "./agent-icon.ts";
import { CREDENTIALS_FILE } from "./gateway.ts";
import { INSTRUCTIONS_FILE, MCP_FILE } from "./library.ts";

const AGENT_DIR = "magpie-agent";

/** Agent 插件的文件：文件名 → 内容。`dataDir` 是这个插件的数据目录，`appDataDir` 是 Plume 的。 */
export function agentFiles(dataDir: string, appDataDir: string, home = homedir()): Record<string, string> {
	const at = (path: string) => (path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);
	const agent = {
		id: "plume",
		name: "Plume",
		icon: AGENT_ICON,
		// Magpie 按这个目录判断 Plume 装没装：装上 plume.magpie 才有。
		dir: at(dataDir),
		config: at(join(dataDir, CREDENTIALS_FILE)),
		model: "defaultModel",
		prefix: "magpie/",
		library: {
			instructions: at(join(dataDir, INSTRUCTIONS_FILE)),
			mcp: at(join(dataDir, MCP_FILE)),
			mcpFormat: "claude",
			skills: at(join(appDataDir, "skills")),
		},
		notice: "Plume uses the new model from its next turn.",
	};
	const script = [
		"// Written by the Plume plugin plume.magpie each time it starts; edits here are overwritten.",
		"// Plume as a Magpie agent: pick one of Magpie's models for it on the Agents page.",
		"",
		`export const agent = ${JSON.stringify(agent, null, "\t")};`,
		"",
		"export function connect({ gateway, models }) {",
		"\treturn {",
		// 不带 /v1：Plume 的适配器拼路径时自己处理。Magpie 看 apiKey 还是不是它给的那个，判断这一行是否仍然接着。
		'\t\t"magpie.baseUrl": gateway.url,',
		'\t\t"magpie.apiKey": gateway.key,',
		'\t\t"magpie.models": models,',
		"\t};",
		"}",
		"",
	].join("\n");
	const manifest = {
		name: "@magpie-community/agent-plume",
		version: "0.1.0",
		private: true,
		description: "Plume as a magpie agent: pick one of magpie's models for it on the Agents page",
		type: "module",
		files: ["plume.agent.js"],
		keywords: ["magpie", "magpie-agent", "plume"],
		magpie: { agent: "./plume.agent.js" },
	};
	return { "package.json": `${JSON.stringify(manifest, null, 2)}\n`, "plume.agent.js": script };
}

/** 写出 Agent 插件，返回它的目录。内容没变的文件不重写：Magpie 可能盯着它们。 */
export async function writeAgent(dataDir: string, appDataDir: string): Promise<string> {
	const dir = join(dataDir, AGENT_DIR);
	await mkdir(dir, { recursive: true });
	for (const [name, content] of Object.entries(agentFiles(dataDir, appDataDir))) {
		const path = join(dir, name);
		if ((await readFile(path, "utf8").catch(() => undefined)) !== content) await writeFile(path, content);
	}
	return dir;
}
