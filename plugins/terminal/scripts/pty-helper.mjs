/**
 * 给 node-pty 预编译包里的 spawn-helper 加上执行权限（`pnpm install` 后作为这个插件的 postinstall 自动跑）。
 *
 * Plume 用 node-pty 自带的 N-API 预编译包，不为 Electron 现编：N-API 跨 Node 和 Electron 的 ABI 通用，现编要
 * 下载 Electron 的头文件、要本机有编译工具链。但 1.1.0 的发布包里 spawn-helper 没有执行位，它的安装脚本也
 * 不补，macOS 上每次起 shell 都是 `posix_spawnp failed`，终端面板里只有一行红字。
 *
 * 每个平台、架构的那份都加，不只本机的：插件构建时带上各平台的预编译包，市场按平台打包（插件仓库的
 * scripts/build-dist.mjs），在 Linux 的 CI 上打出来的 macOS 包里也要是能执行的。
 *
 * 不会让安装失败：没装上 node-pty、这个平台没有预编译包，都只是没有终端。
 */

import { chmodSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

try {
	const require = createRequire(join(import.meta.dirname, "../package.json"));
	const prebuilds = join(dirname(require.resolve("node-pty/package.json")), "prebuilds");
	for (const target of existsSync(prebuilds) ? readdirSync(prebuilds) : []) {
		const helper = join(prebuilds, target, "spawn-helper");
		if (existsSync(helper)) chmodSync(helper, 0o755);
	}
} catch (error) {
	console.warn(`没能给 node-pty 的 spawn-helper 加执行权限，终端会起不来：${error instanceof Error ? error.message : String(error)}`);
}
