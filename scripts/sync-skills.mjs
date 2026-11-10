/**
 * 把技能合集（skills/<id>/）同步成上游在登记的 commit 上的内容。
 *
 *   node scripts/sync-skills.mjs [<id> ...]      不带参数同步全部合集，带了只同步这几个
 *
 * 每个合集的 package.json 里 `plume.upstream` 记着上游：`repo`（https://github.com/<owner>/<repo>）、`commit`（完整 40 位 sha）、
 * `path`（仓库里放技能的子目录，根目录写空串）。脚本按 commit 从 codeload 下载 tar.gz，用系统 tar 解进临时目录：
 *
 * - `path` 下直接含 SKILL.md 的子目录各是一个技能，整目录放进 skills/<id>/skills/<技能目录名>/（先清掉旧的 skills/）；
 * - 上游根目录的许可证（LICENSE、LICENSE.md、LICENSE.txt、COPYING 之一）复制成 skills/<id>/LICENSE，上游没有就删掉旧的。
 *
 * 下载的内容只当数据：不执行里面的任何脚本。符号链接不原样拷（发布时也不发符号链接）：指向仓库里的换成它指向的内容，
 * 指向仓库外的跳过并提示。
 *
 * 换上游版本：改 `plume.upstream.commit`，跑一遍，核对改动，再升这个合集的 `version`（发出去的版本不可变，见 docs/distribution.md）。
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const skillsRoot = join(root, "skills");
const LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"];
const REPO = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const COMMIT = /^[0-9a-f]{40}$/;
const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** 合集的上游，写得不对就抛错。 */
function upstreamOf(id) {
	const manifest = JSON.parse(readFileSync(join(skillsRoot, id, "package.json"), "utf8"));
	const upstream = manifest.plume?.upstream ?? {};
	const repo = REPO.exec(String(upstream.repo ?? ""));
	if (!repo) throw new Error(`plume.upstream.repo 要写成 https://github.com/<owner>/<repo>（现在是 ${upstream.repo ?? "空的"}）`);
	if (!COMMIT.test(String(upstream.commit ?? ""))) throw new Error(`plume.upstream.commit 要是完整的 40 位 sha（现在是 ${upstream.commit ?? "空的"}）`);
	const path = String(upstream.path ?? "");
	if (path.split("/").includes("..") || path.startsWith("/")) throw new Error(`plume.upstream.path 只能是仓库里的相对路径（现在是 ${path}）`);
	return { owner: repo[1], repo: repo[2], commit: upstream.commit, path: path.replace(/^\/+|\/+$/g, "") };
}

/** 下载上游在这个 commit 的内容，解进 work 下，返回解出来的仓库根目录。 */
async function fetchRepo({ owner, repo, commit }, work) {
	const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/${commit}`;
	const archive = join(work, "repo.tar.gz");
	// codeload 偶尔连不上或半路卡住，超时后重试两次。
	for (let attempt = 1; ; attempt++) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
			break;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (attempt >= 3) throw new Error(`下载 ${url} 失败：${message}`, { cause: error });
			console.warn(`  下载 ${owner}/${repo} 失败（${message}），重试`);
		}
	}
	const extracted = join(work, "repo");
	mkdirSync(extracted);
	execFileSync("tar", ["-xzf", archive, "-C", extracted], { stdio: ["ignore", "ignore", "inherit"] });
	// codeload 的包里只有一层 <repo>-<commit>/。
	const tops = readdirSync(extracted);
	if (tops.length !== 1) throw new Error(`包里的顶层目录不止一个：${tops.join("、")}`);
	return realpathSync(join(extracted, tops[0]));
}

/** 拷一个目录：普通文件和目录照拷；符号链接指向仓库里的拷它指向的内容，指向仓库外的或断了的跳过。 */
function copyTree(from, to, repoRoot, warnings, seen = new Set()) {
	const real = realpathSync(from);
	if (seen.has(real)) {
		warnings.push(`${relative(repoRoot, from)}：符号链接绕成了环，跳过`);
		return;
	}
	seen = new Set(seen).add(real);
	mkdirSync(to, { recursive: true });
	for (const entry of readdirSync(from)) {
		const source = join(from, entry);
		const target = join(to, entry);
		let path = source;
		if (lstatSync(source).isSymbolicLink()) {
			let resolved;
			try {
				resolved = realpathSync(source);
			} catch {
				warnings.push(`${relative(repoRoot, source)}：符号链接指向的东西不存在，跳过`);
				continue;
			}
			if (resolved !== repoRoot && !resolved.startsWith(repoRoot + sep)) {
				warnings.push(`${relative(repoRoot, source)}：符号链接指向仓库外，跳过`);
				continue;
			}
			path = resolved;
		}
		const stat = statSync(path);
		if (stat.isDirectory()) copyTree(path, target, repoRoot, warnings, seen);
		else if (stat.isFile()) copyFileSync(path, target);
	}
}

/** 同步一个合集，返回技能目录名。 */
async function sync(id) {
	const upstream = upstreamOf(id);
	const work = mkdtempSync(join(tmpdir(), `plume-skills-${id}-`));
	try {
		const repoRoot = await fetchRepo(upstream, work);
		const base = upstream.path ? join(repoRoot, upstream.path) : repoRoot;
		if (!existsSync(base) || !statSync(base).isDirectory()) throw new Error(`上游在这个 commit 没有目录 ${upstream.path}`);
		const realBase = realpathSync(base);
		if (realBase !== repoRoot && !realBase.startsWith(repoRoot + sep)) throw new Error(`${upstream.path} 指向仓库外`);

		const names = readdirSync(realBase)
			.filter((name) => {
				const dir = join(realBase, name);
				return !lstatSync(dir).isSymbolicLink() && statSync(dir).isDirectory() && existsSync(join(dir, "SKILL.md"));
			})
			.sort();
		if (names.length === 0) throw new Error(`${upstream.path || "仓库根目录"} 下没有含 SKILL.md 的目录`);

		// 先在临时目录拼好，拼成了再换进仓库，中途失败不留半截。
		const staged = join(work, "skills");
		const warnings = [];
		for (const name of names) copyTree(join(realBase, name), join(staged, name), repoRoot, warnings);
		const license = LICENSE_FILES.map((file) => join(repoRoot, file)).find((file) => existsSync(file) && lstatSync(file).isFile());

		const dir = join(skillsRoot, id);
		rmSync(join(dir, "skills"), { recursive: true, force: true });
		copyTree(staged, join(dir, "skills"), staged, warnings);
		rmSync(join(dir, "LICENSE"), { force: true });
		if (license) copyFileSync(license, join(dir, "LICENSE"));

		for (const warning of warnings) console.warn(`  ${id}：${warning}`);
		if (!license) console.warn(`  ${id}：上游根目录没有许可证文件`);
		return names;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

const all = existsSync(skillsRoot) ? readdirSync(skillsRoot).filter((id) => existsSync(join(skillsRoot, id, "package.json"))) : [];
const wanted = process.argv.slice(2);
for (const id of wanted) {
	if (!NAME.test(id) || !all.includes(id)) {
		console.error(`没有这个技能合集：${id}（有：${all.join("、")}）`);
		process.exit(1);
	}
}

let failed = 0;
for (const id of wanted.length > 0 ? wanted : all) {
	try {
		const names = await sync(id);
		console.log(`✓ ${id}：${names.length} 个技能`);
	} catch (error) {
		failed++;
		console.error(`✗ ${id}：${error instanceof Error ? error.message : String(error)}`);
	}
}
if (failed > 0) process.exit(1);
