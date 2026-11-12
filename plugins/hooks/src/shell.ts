/**
 * 命令类钩子跑在哪个 shell 里：和智能体自己的命令同一个。
 *
 * 选法照抄 Plume 宿主选 shell 的规则（本体仓库 packages/infra/platform 的 systemShell）：插件只能用公开接口，宿主的这个库
 * 不随 SDK 发；宿主起命令的 `ToolRun.shell()`、`exec()` 只在一次工具调用里有，钩子不在调用里，`exec` 也不能给命令写 stdin
 * （钩子要从 stdin 读输入）。宿主改了选法，这里要跟着改。
 *
 * **Unix。** 用户自己的 shell 是 bash 或 zsh 时用它，否则用 bash，最后退到 `/bin/sh`。zsh 关掉 `NOMATCH`，和 bash 一样把
 * 没匹配上的通配符原样传下去。
 *
 * **Windows。** 先 Git Bash，再 PowerShell 7，最后 Windows PowerShell 5.1。
 *
 * `PLUME_SHELL` 指定一个 shell 时优先用它。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, win32 } from "node:path";

export interface CommandShell {
	/** 启动哪个程序。 */
	file: string;
	/** 让 `file` 跑一行命令就退出的参数。 */
	args(command: string): string[];
}

export function systemShell(): CommandShell {
	if (cachedShell && cachedFor === shellKey()) return cachedShell;
	cachedFor = shellKey();
	cachedShell = pickShell();
	return cachedShell;
}

let cachedShell: CommandShell | undefined;
let cachedFor: string | undefined;
/** 答案取决于这几样；环境变了（测试、改了设置）就重新选。 */
const shellKey = () => `${process.platform}\0${process.env.PLUME_SHELL ?? ""}\0${process.env.SHELL ?? ""}`;

function pickShell(): CommandShell {
	const override = process.env.PLUME_SHELL?.trim();
	if (override && existsSync(override)) {
		const shell = shellAt(override);
		if (shell) return shell;
	}
	if (process.platform === "win32") return windowsShell();
	const login = process.env.SHELL;
	if (login && existsSync(login)) {
		const shell = shellAt(login);
		if (shell) return shell;
	}
	for (const candidate of ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash", "/run/current-system/sw/bin/bash"]) {
		if (existsSync(candidate)) return posix(candidate);
	}
	return posix("/bin/sh");
}

/** 这个路径上的 shell，只认会驱动的那几种。 */
function shellAt(file: string): CommandShell | undefined {
	const name = basename(file)
		.toLowerCase()
		.replace(/\.exe$/, "");
	if (name === "bash" || name === "sh" || name === "dash" || name === "ksh") return posix(file);
	if (name === "zsh") return { file, args: (command) => ["+o", "nomatch", "-c", command] };
	if (name === "pwsh" || name === "powershell") return powershell(file);
	return undefined;
}

function posix(file: string): CommandShell {
	return { file, args: (command) => ["-c", command] };
}

/**
 * 经 PowerShell 跑：命令写进脚本文件用 `-File` 跑，输出强制 UTF-8。`-Command` 经 `CreateProcess` 时 5.1 会丢引号，
 * `-EncodedCommand` 会把错误写成 CLIXML、长命令起不来。
 */
function powershell(file: string): CommandShell {
	return {
		file,
		args: (command) => ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-OutputFormat", "Text", "-File", scriptFile(command)],
	};
}

const PRELUDE = "$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8";

/**
 * 把命令写成 PowerShell 能用 `-File` 跑的脚本：带 BOM（5.1 有它才按 UTF-8 读），最后一行保住命令该有的退出码。
 * 按内容命名、放在临时目录下自己的目录里，第一次往里写时清掉一周前的文件。
 */
function scriptFile(command: string): string {
	const body = `${PRELUDE}\n${command}\nif (-not $?) { exit $(if ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }) }\n`;
	const dir = join(tmpdir(), "plume-commands");
	mkdirSync(dir, { recursive: true });
	if (!sweptScripts) {
		sweptScripts = true;
		const stale = Date.now() - 7 * 24 * 60 * 60 * 1000;
		for (const name of readdirSync(dir)) {
			try {
				const path = join(dir, name);
				if (statSync(path).mtimeMs < stale) rmSync(path, { force: true });
			} catch {
				// 别的进程的文件，或者已经没了：都不值得让钩子失败。
			}
		}
	}
	const file = join(dir, `${createHash("sha256").update(body).digest("hex").slice(0, 16)}.ps1`);
	writeFileSync(file, `\uFEFF${body}`, "utf8");
	return file;
}

let sweptScripts = false;

function windowsShell(): CommandShell {
	const bash = gitBash();
	if (bash) return posix(bash);
	const pwsh = onPath("pwsh.exe") ?? [join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe")].find(existsSync);
	if (pwsh) return powershell(pwsh);
	const root = process.env.SystemRoot ?? "C:\\Windows";
	const legacy = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	return powershell(existsSync(legacy) ? legacy : "powershell.exe");
}

/**
 * Git for Windows 的 `bin\bash.exe`：先从 `PATH` 上的 `git.exe` 推，再找各安装器的默认位置。不认 WSL 的 bash
 * （`System32\bash.exe`、`WindowsApps` 里的别名）：工作区路径在那边没有意义。
 */
function gitBash(): string | undefined {
	const seen = new Set<string>();
	const candidates: string[] = [];
	for (const dir of pathDirs()) {
		if (!existsSync(win32.join(dir, "git.exe"))) continue;
		const lower = dir.toLowerCase().replace(/[\\/]+$/, "");
		let root = dir;
		if (/[\\/](mingw64|mingw32|clangarm64)[\\/]bin$/.test(lower)) root = win32.dirname(win32.dirname(dir));
		else if (/[\\/](cmd|bin)$/.test(lower)) root = win32.dirname(dir);
		candidates.push(win32.join(root, "bin", "bash.exe"));
	}
	const programFiles = [process.env.ProgramW6432, process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean) as string[];
	for (const base of programFiles) candidates.push(win32.join(base, "Git", "bin", "bash.exe"));
	if (process.env.LOCALAPPDATA) candidates.push(win32.join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
	candidates.push(win32.join(homedir(), "scoop", "apps", "git", "current", "bin", "bash.exe"));
	for (const candidate of candidates) {
		const key = candidate.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		if (isWslLauncher(candidate)) continue;
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

function isWslLauncher(file: string): boolean {
	const lower = file.toLowerCase();
	const root = (process.env.SystemRoot ?? "C:\\Windows").toLowerCase();
	return lower.startsWith(`${root}\\`) || lower.includes("\\windowsapps\\");
}

/** `PATH` 上的目录，不管这个平台把变量名拼成什么样。 */
function pathDirs(): string[] {
	const raw = process.env.PATH ?? process.env.Path ?? "";
	return raw.split(process.platform === "win32" ? ";" : ":").filter(Boolean);
}

function onPath(file: string): string | undefined {
	for (const dir of pathDirs()) {
		const candidate = process.platform === "win32" ? win32.join(dir, file) : join(dir, file);
		if (!isWslLauncher(candidate) && existsSync(candidate)) return candidate;
	}
	return undefined;
}
