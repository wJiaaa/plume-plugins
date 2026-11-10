/**
 * 构建 plugins/ 下的每个插件。怎么打包由 npm 上的插件 SDK 定（`@plumeai/plugin-sdk/build`），和插件作者用 `plume-plugin build`
 * 的是同一份：仓库里的插件不走另一条路。
 */

import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { buildPlugin } from "@plumeai/plugin-sdk/build";

const root = resolve(import.meta.dirname, "..");
const plugins = join(root, "plugins");
const dirs = (await readdir(plugins, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => join(plugins, entry.name));
let failed = false;

for (const dir of dirs) {
	const name = relative(root, dir);
	try {
		console.log(`✓ ${name} → ${await buildPlugin(dir)}`);
	} catch (error) {
		// esbuild 的报错它自己已经打过了。
		if (!error?.errors) console.error(`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`);
		failed = true;
	}
}

if (failed) process.exit(1);
