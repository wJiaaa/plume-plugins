/**
 * 把构建好的插件打成市场发出去的静态目录（格式见 docs/distribution.md）。CI 把它发到 GitHub Pages；本体的开发和冒烟
 * 在本机起服务给应用，走的是同一条路。
 *
 *   node scripts/build-dist.mjs [--out <目录>] [--targets darwin-arm64,win32-x64] [--published <线上 marketplace.json 的地址>]
 *
 * 输出（缺省 dist/）：
 *   marketplace.json                          收录的插件、说明和每个平台的包
 *   assets/<name>/icon.png、README.md、images/  市场页安装前就要画的东西
 *   plugins/<name>/<version>/<平台>-<架构>.tgz  装下的文件（package.json、README.md、images、icon.png、dist、skills）
 *
 * 每个平台一个包：插件构建时带上了各平台的原生模块（插件 SDK 的 lib/targets.mjs），这里按目标只留那一份。
 * 每个包记下内容指纹（文件的相对路径和内容）：`--published` 给了线上那份时，版本号没变而内容变了就失败——发出去的版本不可变，
 * 应用按版本号判断有没有更新，同一个版本换了内容，装过的人永远拿不到。
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { trimNative } from "../../plume/packages/sdk/plugin-sdk/lib/targets.mjs";
import { listed } from "./validate.mjs";

const root = resolve(import.meta.dirname, "..");
/** Plume 发安装包的平台和架构。 */
const TARGETS = ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"];
/** 发给插件的文件，和应用装下的一致。源码、node_modules 不发。 */
const SHIPPED = ["package.json", "README.md", "images", "icon.png", "dist", "skills"];
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

function optionalString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

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
	for (const { name } of listed(root)) {
		const dir = join(root, "plugins", name);
		if (!existsSync(join(dir, "dist/index.mjs"))) throw new Error(`plugins/${name} 没构建：先 pnpm build:plugins`);
		const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		const plume = manifest.plume ?? {};
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
					problems.push(`  plugins/${name}：内容变了，版本号还是 ${version}；发出去的版本不可变，改 package.json 的 version`);
			}
		}

		const entry = {
			name,
			displayName: plume.displayName,
			description: manifest.description,
			version,
			author: optionalString(manifest.author) ?? optionalString(manifest.author?.name),
			category: optionalString(plume.category),
			keywords: Array.isArray(manifest.keywords) ? manifest.keywords.filter((word) => typeof word === "string") : undefined,
			homepage: optionalString(manifest.homepage),
			license: optionalString(manifest.license),
			prompts: Array.isArray(plume.defaultPrompt) ? plume.defaultPrompt.map(optionalString).filter(Boolean) : undefined,
			icon: `assets/${name}/icon.png`,
			readme: `assets/${name}/README.md`,
			builds,
		};
		entries.push(Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0))));
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
