/**
 * 插件规则（`pnpm check:plugins`）：只引用公开接口、颜色和样式只用主题 token、界面文字走 messages.ts。规则在 npm 上的
 * 插件 SDK 里（`@plumeai/plugin-sdk/lint`），和 `plume-plugin check` 查的是同一份，Plume 本体的内置插件也按它查。
 */

import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { formatProblem, lintPlugin, pluginTailwind } from "@plumeai/plugin-sdk/lint";

const root = resolve(import.meta.dirname, "..");
const plugins = join(root, "plugins");
const dirs = (await readdir(plugins, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => join(plugins, entry.name));

const isTailwind = await pluginTailwind();
let count = 0;
for (const dir of dirs) {
	for (const problem of await lintPlugin(dir, { isTailwind })) {
		console.error(formatProblem(problem, root));
		count++;
	}
}

if (count > 0) {
	console.error(`\n✖ 插件规则：${count} 处。`);
	process.exit(1);
}
console.log(`✓ 插件规则（${dirs.length} 个插件）`);
