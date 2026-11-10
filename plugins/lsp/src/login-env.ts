/**
 * 在 PATH 上找语言服务器、起语言服务器用的环境。
 *
 * 从图标启动的应用只从 launchd 拿到 `/usr/bin:/bin:/usr/sbin:/sbin`，`gopls`（在 `~/go/bin`）、`rust-analyzer`
 * （在 `~/.cargo/bin`）、npm 全局装的 `pyright-langserver` 都找不到；所以第一次用时问一遍用户的登录 shell
 * （`-l -i`，登录文件和 `~/.zshrc` 都读）它会给终端什么环境，之后一直用这一份。本进程是从终端启动的，
 * 或者问不到时，用继承来的环境。
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

const ENV_MARK = "__PLUME_LSP_ENV__";
const ENV_TIMEOUT_MS = 5000;
let asked: Promise<Record<string, string> | null> | undefined;

/** 继承来的环境每次现取，登录 shell 的那份只问一次：会话开着时装上的服务器，PATH 早就在登录 shell 里了。 */
export async function commandEnv(): Promise<Record<string, string>> {
	const inherited = Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => typeof pair[1] === "string"));
	const login = await (asked ??= askLoginShell(inherited));
	return login ? { ...inherited, ...login } : inherited;
}

async function askLoginShell(inherited: Record<string, string>): Promise<Record<string, string> | null> {
	const shell = process.env.SHELL;
	const term = process.env.TERM;
	// Windows 上没有登录 shell 可问，PATH 由注册表给全；那边的 SHELL 只由 Git Bash 这类设置，问它拿到的是 MSYS 的环境。
	if (process.platform === "win32" || (term && term !== "dumb") || process.env.TERM_PROGRAM || !shell || !existsSync(shell)) return null;
	const stdout = await new Promise<string>((resolve) => {
		execFile(
			shell,
			["-l", "-i", "-c", `printf ${ENV_MARK}; /usr/bin/env -0; printf ${ENV_MARK}`],
			{ timeout: ENV_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: inherited },
			(_error, out) => resolve(String(out ?? "")),
		);
	});
	const answer = stdout.split(ENV_MARK)[1];
	if (!answer) return null;
	const env: Record<string, string> = {};
	for (const pair of answer.split("\0")) {
		const at = pair.indexOf("=");
		if (at > 0) env[pair.slice(0, at)] = pair.slice(at + 1);
	}
	// 描述 shell 自己的那几个不要：它们是那次询问的，不是用户的。
	for (const key of ["SHLVL", "PWD", "OLDPWD", "_"]) delete env[key];
	return env.PATH ? env : null;
}
