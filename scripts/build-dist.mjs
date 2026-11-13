/**
 * 把构建好的插件打成市场发出去的静态目录（格式见 docs/distribution.md）。CI 把它发到 GitHub Pages。
 *
 *   node scripts/build-dist.mjs [--out <目录>] [--targets darwin-arm64,win32-x64] [--published <线上 marketplace.json 的地址>]
 *
 * 输出（缺省 dist/）：
 *   marketplace.json                          收录的插件、说明和每个平台的包
 *   assets/<name>/icon.png、README.md、images/  市场页安装前就要画的东西
 *   plugins/<name>/<version>/<平台>-<架构>.tgz  装下的文件（`@plumeai/plugin-sdk/manifest` 的 SHIPPED：package.json、README.md、images、
 *                                              icon.png、dist、skills、.mcp.json、LICENSE）
 *
 * 每个平台一个包：插件构建时带上了各平台的原生模块（插件 SDK 的 lib/targets.mjs），这里按目标只留那一份。
 * 技能合集（skills/）和连接器（connectors/）只有内容、不用构建：这里替它们写一个什么都不做的逻辑入口，应用装上后照常当插件加载，
 * 技能插件读它的 skills/，MCP 插件读它的 .mcp.json。
 * 每个包记下内容指纹（文件的相对路径和内容）：`--published` 给了线上那份时，版本号没变而内容变了就失败——发出去的版本不可变，
 * 应用按版本号判断有没有更新，同一个版本换了内容，装过的人永远拿不到。
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { trimNative } from "@plumeai/plugin-sdk/targets";
import { PLUGIN_ENTRY, readManifest, SHIPPED } from "@plumeai/plugin-sdk/manifest";
import { listed } from "./validate.mjs";

const root = resolve(import.meta.dirname, "..");
/** Plume 发安装包的平台和架构。 */
const TARGETS = ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"];
const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;

const { values: args } = parseArgs({ options: { out: { type: "string" }, targets: { type: "string" }, published: { type: "string" } } });
const out = resolve(args.out ?? join(root, "dist"));
const targets = args.targets ? args.targets.split(",") : TARGETS;

/** 一个目录下的普通文件（不跟符号链接），相对路径用 /。 */
function files(dir, base = dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return files(path, base);
		return entry.isFile() ? [relative(base, path).replaceAll("\\", "/")] : [];
	});
}

/** 内容指纹：文件的相对路径和内容，按路径排好。 */
function fingerprint(dir) {
	const hash = createHash("sha256");
	for (const file of files(dir).sort())
		hash
			.update(file)
			.update("\0")
			.update(readFileSync(join(dir, file)));
	return hash.digest("hex");
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** 线上那份目录：拿不到（第一次发布、断网）就不比。 */
async function publishedCatalog(url) {
	if (!url) return null;
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return await response.json();
	} catch (error) {
		console.warn(`没拿到线上的 marketplace.json（${error instanceof Error ? error.message : String(error)}），不检查版本号`);
		return null;
	}
}

const published = await publishedCatalog(args.published);
const problems = [];
const work = mkdtempSync(join(tmpdir(), "plume-market-"));
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const entries = [];
try {
	for (const { name, group, dir } of listed(root)) {
		if (!group) throw new Error(`${name} 的 source 不合规矩：先 pnpm validate`);
		const code = group === "plugins";
		if (code && !existsSync(join(dir, PLUGIN_ENTRY))) throw new Error(`plugins/${name} 没构建：先 pnpm build:plugins`);
		const manifest = readManifest(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")));
		const version = manifest.version;

		// 市场页安装前就要画的：图标、介绍和介绍里的图。
		const assets = join(out, "assets", name);
		mkdirSync(assets, { recursive: true });
		cpSync(join(dir, "icon.png"), join(assets, "icon.png"));
		cpSync(join(dir, "README.md"), join(assets, "README.md"));
		for (const image of files(join(dir, "images")).filter((file) => IMAGE.test(file))) {
			mkdirSync(dirname(join(assets, "images", image)), { recursive: true });
			cpSync(join(dir, "images", image), join(assets, "images", image));
		}

		const builds = {};
		for (const target of targets) {
			const staging = join(work, name, target);
			mkdirSync(staging, { recursive: true });
			for (const item of SHIPPED) {
				const from = join(dir, item);
				// 符号链接不发：解压到别人的机器上，它指向哪里就说不准了。
				if (existsSync(from) && !lstatSync(from).isSymbolicLink())
					cpSync(from, join(staging, item), { recursive: true, filter: (path) => !lstatSync(path).isSymbolicLink() });
			}
			if (!code) {
				mkdirSync(join(staging, "dist"), { recursive: true });
				writeFileSync(join(staging, PLUGIN_ENTRY), `export default { name: ${JSON.stringify(`plume.${name}`)}, apply() {} };\n`);
			}
			trimNative(join(staging, "dist", "node_modules"), target);
			const path = `plugins/${name}/${version}/${target}.tgz`;
			const archive = join(out, path);
			mkdirSync(dirname(archive), { recursive: true });
			// COPYFILE_DISABLE：macOS 的 tar 不往包里塞 ._ 开头的扩展属性文件，装下的文件和这里算指纹的一样。
			execFileSync("tar", ["-czf", archive, "-C", staging, ...SHIPPED.filter((item) => existsSync(join(staging, item)))], {
				env: { ...process.env, COPYFILE_DISABLE: "1" },
			});
			builds[target] = { path, sha256: sha256(archive), size: statSync(archive).size, fingerprint: fingerprint(staging) };
		}

		const live = published?.plugins?.find((plugin) => plugin?.name === name);
		if (live?.version === version) {
			for (const [target, build] of Object.entries(builds)) {
				const before = live.builds?.[target]?.fingerprint;
				if (before && before !== build.fingerprint)
					problems.push(`  ${group}/${name}：内容变了，版本号还是 ${version}；发出去的版本不可变，改 package.json 的 version`);
			}
		}

		// 说明照 readManifest 读出的写（应用读目录时按同样的字段读回来），再加上图标、介绍和每个平台的包。
		entries.push({ name, ...manifest, icon: `assets/${name}/icon.png`, readme: `assets/${name}/README.md`, builds });
		console.log(`✓ ${name} ${version}`);
	}
} finally {
	rmSync(work, { recursive: true, force: true });
}

if (problems.length > 0) {
	console.error(`\n${problems.join("\n")}\n`);
	process.exit(1);
}

const source = JSON.parse(readFileSync(join(root, "marketplace.json"), "utf8"));
writeFileSync(
	join(out, "marketplace.json"),
	`${JSON.stringify({ name: source.name, description: source.description, owner: source.owner, plugins: entries }, null, 2)}\n`,
);
// GitHub Pages 缺省按 Jekyll 处理，会丢掉下划线开头的文件。
writeFileSync(join(out, ".nojekyll"), "");
console.log(`→ ${relative(process.cwd(), out) || "."}（${entries.length} 个插件 × ${targets.length} 个平台）`);
