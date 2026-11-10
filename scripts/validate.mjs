/**
 * 校验市场的源头（`pnpm validate`，`pnpm check` 的一部分，发布前 CI 也跑）：
 *
 * 1. 根目录的 marketplace.json 是收录清单：每条一个插件，`name` 是目录名（也是安装目录名、`plume-plugin://` 的主机名），
 *    `source` 是 `./plugins/<name>`；plugins/ 下的每个目录都要登记，登记的都要在。
 * 2. 每个插件的 package.json 写了市场要的说明：版本号（x.y.z，发出去以后不可变，改了内容要升）、`plume.displayName`、
 *    `description`；有 README.md。
 * 3. 图标 icon.png：正方形 PNG、不超过 256 KiB、不和别的插件共用一张。
 *
 *   node scripts/validate.mjs
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const MAX_ICON_BYTES = 256 * 1024;

const problems = [];
const report = (where, message) => problems.push(`  ${where}：${message}`);

/** 收录清单里的插件：名字和源码目录。打包（build-dist.mjs）也按它来。 */
export function listed(base = root) {
	const catalog = JSON.parse(readFileSync(join(base, "marketplace.json"), "utf8"));
	if (!Array.isArray(catalog.plugins)) throw new Error("marketplace.json 没有 plugins 数组");
	return catalog.plugins.map((plugin) => ({ name: String(plugin?.name ?? ""), source: String(plugin?.source ?? "") }));
}

if (import.meta.main) {
	let plugins = [];
	try {
		plugins = listed();
	} catch (error) {
		// 清单读不了也接着查目录，一次报全。
		report("marketplace.json", error instanceof Error ? error.message : String(error));
	}
	const seen = new Set();
	for (const { name, source } of plugins) {
		if (!NAME.test(name)) report("marketplace.json", `${name || "（空）"}：名字只能用小写字母、数字和连字符`);
		if (seen.has(name)) report("marketplace.json", `${name} 登记了两次`);
		seen.add(name);
		if (source !== `./plugins/${name}`) report("marketplace.json", `${name} 的 source 应为 ./plugins/${name}`);
	}
	for (const name of readdirSync(join(root, "plugins"))) {
		if (statSync(join(root, "plugins", name)).isDirectory() && !seen.has(name)) report(`plugins/${name}`, "没在 marketplace.json 里登记");
	}

	const icons = new Map();
	for (const { name } of plugins) {
		const dir = join(root, "plugins", name);
		const where = `plugins/${name}`;
		if (!existsSync(join(dir, "package.json"))) {
			report(where, "没有 package.json");
			continue;
		}
		const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		const plume = manifest.plume ?? {};
		if (!VERSION.test(manifest.version ?? "")) report(where, `version 要写成 x.y.z（现在是 ${manifest.version ?? "空的"}）`);
		if (typeof plume.displayName !== "string" || !plume.displayName.trim()) report(where, "package.json 没写 plume.displayName（市场里的名字）");
		if (typeof manifest.description !== "string" || !manifest.description.trim()) report(where, "package.json 没写 description");
		if (!existsSync(join(dir, "README.md"))) report(where, "没有 README.md（市场详情页的介绍）");

		const iconFile = join(dir, "icon.png");
		if (!existsSync(iconFile)) {
			report(where, "没有 icon.png");
			continue;
		}
		const icon = readFileSync(iconFile);
		if (icon.length > MAX_ICON_BYTES) report(where, "icon.png 超过 256 KiB");
		if (icon.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || icon.toString("ascii", 12, 16) !== "IHDR") report(where, "icon.png 不是 PNG");
		else if (icon.readUInt32BE(16) === 0 || icon.readUInt32BE(16) !== icon.readUInt32BE(20)) report(where, "icon.png 要是正方形");
		const hash = createHash("sha256").update(icon).digest("hex");
		if (icons.has(hash)) report(where, `icon.png 和 ${icons.get(hash)} 是同一张`);
		icons.set(hash, name);
	}

	if (problems.length > 0) {
		console.error(`市场校验没通过：\n\n${problems.join("\n")}\n`);
		process.exit(1);
	}
	console.log(`✓ 市场校验通过（${plugins.length} 个插件）`);
}
