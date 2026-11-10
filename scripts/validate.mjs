/**
 * 校验市场的源头（`pnpm validate`，`pnpm check` 的一部分，发布前 CI 也跑）：
 *
 * 1. 根目录的 marketplace.json 是收录清单：每条一个插件，`name` 是目录名（也是安装目录名、`plume-plugin://` 的主机名），
 *    `source` 是 `./<分组>/<name>`。三个分组各放一类（`GROUPS`）：plugins/ 是写代码的插件，skills/ 是技能合集，
 *    connectors/ 是连接器（MCP 服务）；分组下的每个目录都要登记，登记的都要在，名字在三组里不能重。
 * 2. 每个插件的 package.json 写了市场要的说明：版本号（x.y.z，发出去以后不可变，改了内容要升）、`plume.displayName`、
 *    `description`，`plume.kind` 和所在分组对得上；有 README.md。格式见插件 SDK 的 `@plumeai/plugin-sdk/manifest`。
 * 3. 图标 icon.png：正方形 PNG、不超过 256 KiB。同一品牌的几个插件（同一家的连接器、技能合集）可以用同一张标志。
 * 4. 技能合集只带技能：`skills/` 下至少一个 `<技能>/SKILL.md`，没有源码；连接器只带 `.mcp.json`，里面的 `mcpServers`
 *    至少一台。从上游搬来的（写了 `plume.upstream`）要带上游的 LICENSE。
 *
 *   node scripts/validate.mjs
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DIR_NAME, manifestProblems, readManifest } from "@plumeai/plugin-sdk/manifest";

const root = resolve(import.meta.dirname, "..");
const MAX_ICON_BYTES = 256 * 1024;
/** 分组目录和放在里面的插件的 `plume.kind`。 */
export const GROUPS = { plugins: "plugin", skills: "skill", connectors: "connector" };

const problems = [];
const report = (where, message) => problems.push(`  ${where}：${message}`);

/** 收录清单里的插件：名字、登记的 source、分组（source 不合规矩时是 undefined）和目录。打包（build-dist.mjs）也按它来。 */
export function listed(base = root) {
	const catalog = JSON.parse(readFileSync(join(base, "marketplace.json"), "utf8"));
	if (!Array.isArray(catalog.plugins)) throw new Error("marketplace.json 没有 plugins 数组");
	return catalog.plugins.map((plugin) => {
		const name = String(plugin?.name ?? "");
		const source = String(plugin?.source ?? "");
		const group = Object.keys(GROUPS).find((candidate) => source === `./${candidate}/${name}`);
		return { name, source, group, dir: join(base, source) };
	});
}

/** 一个目录下的子目录名；目录不存在是空的。 */
function subdirs(dir) {
	return existsSync(dir) ? readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory()) : [];
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
	for (const { name, source, group } of plugins) {
		if (!DIR_NAME.test(name)) report("marketplace.json", `${name || "（空）"}：名字只能用小写字母、数字和连字符`);
		if (seen.has(name)) report("marketplace.json", `${name} 登记了两次`);
		seen.add(name);
		if (!group) report("marketplace.json", `${name} 的 source 应为 ./<${Object.keys(GROUPS).join("|")}>/${name}（现在是 ${source || "空的"}）`);
	}
	for (const group of Object.keys(GROUPS)) {
		for (const name of subdirs(join(root, group))) {
			if (!plugins.some((plugin) => plugin.group === group && plugin.name === name)) report(`${group}/${name}`, "没在 marketplace.json 里登记");
		}
	}

	for (const { name, group, dir } of plugins) {
		if (!group) continue;
		const where = `${group}/${name}`;
		if (!existsSync(join(dir, "package.json"))) {
			report(where, "没有 package.json");
			continue;
		}
		const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		for (const problem of manifestProblems(manifest)) report(where, problem);
		const kind = readManifest(manifest).kind;
		if (kind !== GROUPS[group]) report(where, `放在 ${group}/ 下的 plume.kind 要写成 ${GROUPS[group]}（现在是 ${kind}）`);
		if (!existsSync(join(dir, "README.md"))) report(where, "没有 README.md（市场详情页的介绍）");
		if (group !== "plugins" && existsSync(join(dir, "src"))) report(where, `${group}/ 下只放内容，不写代码（有 src/）`);
		if (group === "skills" && !subdirs(join(dir, "skills")).some((skill) => existsSync(join(dir, "skills", skill, "SKILL.md"))))
			report(where, "skills/ 下没有技能（<技能>/SKILL.md）");
		if (group === "connectors") {
			let servers;
			try {
				servers = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")).mcpServers;
			} catch (error) {
				report(where, `.mcp.json 读不了：${error instanceof Error ? error.message : String(error)}`);
			}
			if (servers !== undefined && (typeof servers !== "object" || servers === null || Object.keys(servers).length === 0))
				report(where, ".mcp.json 的 mcpServers 里没有服务");
		}
		if (manifest.plume?.upstream && !existsSync(join(dir, "LICENSE"))) report(where, "从上游搬来的内容要带上游的 LICENSE");

		const iconFile = join(dir, "icon.png");
		if (!existsSync(iconFile)) {
			report(where, "没有 icon.png");
			continue;
		}
		const icon = readFileSync(iconFile);
		if (icon.length > MAX_ICON_BYTES) report(where, "icon.png 超过 256 KiB");
		if (icon.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || icon.toString("ascii", 12, 16) !== "IHDR") report(where, "icon.png 不是 PNG");
		else if (icon.readUInt32BE(16) === 0 || icon.readUInt32BE(16) !== icon.readUInt32BE(20)) report(where, "icon.png 要是正方形");
	}

	if (problems.length > 0) {
		console.error(`市场校验没通过：\n\n${problems.join("\n")}\n`);
		process.exit(1);
	}
	console.log(`✓ 市场校验通过（${plugins.length} 个插件）`);
}
