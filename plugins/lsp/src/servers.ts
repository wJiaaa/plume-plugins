/**
 * 哪种文件交给哪台语言服务器——一张表，加一种语言就是加一行。
 *
 * 服务器不随包附带，只用本机 PATH 上找得到的。原因是体积和版本：rust-analyzer、clangd 各几十兆，
 * 还都得和本机的工具链对得上（rust-analyzer 跟着 rustup 的 toolchain 走，clangd 要读项目的
 * `compile_commands.json`），带一份自己的反而更容易和用户的项目对不上。找不到时工具照旧退回
 * 文本搜索，并把 `install` 那句话交给模型，让它知道这次是文本搜索、也能转告人该装什么。
 */

import { statSync, accessSync, constants } from "node:fs";
import { join } from "node:path";

export interface LanguageServerSpec {
	/** 给人看的名字，也是 backend 的 `name`。 */
	name: string;
	/** 扩展名（小写、带点）→ LSP 的 languageId。 */
	languages: Record<string, string>;
	/** 依次在 PATH 上找，用第一个找得到的。 */
	commands: { command: string; args: string[] }[];
	/** 一个都找不到时，写进工具结果里的「需要安装 …」。 */
	install: string;
}

export const LANGUAGE_SERVERS: LanguageServerSpec[] = [
	{
		name: "pyright",
		languages: { ".py": "python", ".pyi": "python" },
		// basedpyright 在前：它是 pyright 的分支，协议一样，默认开着的检查更多。
		commands: [
			{ command: "basedpyright-langserver", args: ["--stdio"] },
			{ command: "pyright-langserver", args: ["--stdio"] },
		],
		// i18n-exempt：交给模型的话（工具结果、错误）。
		install: "basedpyright 或 pyright（`pip install basedpyright` 或 `npm i -g pyright`）",
	},
	{
		name: "gopls",
		languages: { ".go": "go" },
		commands: [{ command: "gopls", args: [] }],
		install: "gopls（`go install golang.org/x/tools/gopls@latest`）",
	},
	{
		name: "rust-analyzer",
		languages: { ".rs": "rust" },
		commands: [{ command: "rust-analyzer", args: [] }],
		install: "rust-analyzer（`rustup component add rust-analyzer`）",
	},
	{
		name: "clangd",
		languages: {
			".c": "c",
			".h": "c",
			".cc": "cpp",
			".cpp": "cpp",
			".cxx": "cpp",
			".hh": "cpp",
			".hpp": "cpp",
			".hxx": "cpp",
		},
		commands: [{ command: "clangd", args: [] }],
		install: "clangd（macOS 装 Xcode 命令行工具即带，Linux 用包管理器装 clangd，Windows 装 LLVM）",
	},
];

/**
 * Windows 上变量名不分大小写，而 `{ ...process.env }` 之后的普通对象分：系统里拼作 `Path`，
 * 直接读 `env.PATH` 是 undefined。
 */
function envValue(env: NodeJS.ProcessEnv, name: string, windows: boolean): string | undefined {
	if (!windows) return env[name];
	const key = Object.keys(env).find((k) => k.toUpperCase() === name);
	return key === undefined ? undefined : env[key];
}

/**
 * 像 shell 那样在 PATH 上找一个命令，返回它的完整路径。
 *
 * Windows 上按 PATHEXT 补扩展名：npm 装的 `pyright-langserver` 在那里是 `.cmd`，同目录还有一个
 * 不带扩展名的 sh 脚本——那个 Windows 起不了，所以不试空扩展名。
 */
export function findExecutable(name: string, env: NodeJS.ProcessEnv, windows = process.platform === "win32"): string | null {
	const raw = envValue(env, "PATH", windows) ?? "";
	const dirs = raw.split(windows ? ";" : ":").filter(Boolean);
	const exts = windows ? (envValue(env, "PATHEXT", windows) ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
	for (const dir of dirs) {
		// PATH 里带引号的目录（`"C:\Program Files\LLVM\bin"`）在 Windows 上是合法的。
		const bare = dir.replace(/^"(.*)"$/, "$1");
		for (const ext of exts) {
			const candidate = join(bare, name + ext.toLowerCase());
			if (isExecutable(candidate, windows)) return candidate;
		}
	}
	return null;
}

function isExecutable(file: string, windows: boolean): boolean {
	try {
		if (!statSync(file).isFile()) return false;
		// Windows 没有执行位，能不能起只看扩展名，扩展名已经由 PATHEXT 限定了。
		if (!windows) accessSync(file, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * 怎么起这个可执行文件。
 *
 * Windows 上 `.cmd`/`.bat` 不能直接 spawn（Node 18.20 起报 EINVAL），只能经 `cmd.exe`，也就是
 * `shell: true`。参数拼进命令行而不是另传：Node 24 对「shell 加参数数组」报弃用警告（DEP0190）。
 * 路径加引号，因为 `C:\Program Files\nodejs\` 是 npm 全局目录的常见位置。参数都是表里写死的
 * `--stdio` 这类字面量，不经用户输入，拼进命令行不会被 cmd 另作解释。
 */
export function spawnPlan(file: string, args: string[], windows = process.platform === "win32"): { command: string; args: string[]; shell: boolean } {
	if (windows && /\.(cmd|bat)$/i.test(file)) {
		return { command: [`"${file}"`, ...args].join(" "), args: [], shell: true };
	}
	return { command: file, args, shell: false };
}
