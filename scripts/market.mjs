/**
 * 在本机起一个插件市场，和本体联调用（`pnpm market`）：构建插件、按这台机器的平台打一份市场（scripts/build-dist.mjs，
 * 格式和发布的一样）放进 .market/，只听 127.0.0.1 服务起来，打印地址。本体那边设 PLUME_MARKET_URL=<地址> 再
 * `pnpm dev` 或 `pnpm smoke`，应用就从这里装插件，和装线上的走同一条路（下载、核对、解开）；应用只允许本机地址用 http。
 *
 *   pnpm market [--port <端口>]      不给端口时随便挑一个空闲的；Ctrl+C 停下
 */

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, normalize, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const root = resolve(import.meta.dirname, "..");
const out = join(root, ".market");
const { values: args } = parseArgs({ options: { port: { type: "string" } } });

const run = (script, ...rest) => execFileSync(process.execPath, [join(import.meta.dirname, script), ...rest], { stdio: "inherit" });
run("build-plugins.mjs");
run("build-dist.mjs", "--out", out, "--targets", `${process.platform}-${process.arch}`);

const server = createServer((request, response) => {
	const path = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
	const file = join(out, normalize(path));
	if (!file.startsWith(out + sep)) return void response.writeHead(404).end();
	readFile(file).then(
		(bytes) => response.writeHead(200, { "content-length": bytes.length }).end(bytes),
		() => response.writeHead(404).end(),
	);
});
server.listen(Number(args.port ?? 0), "127.0.0.1", () => {
	console.log(`\n插件市场：PLUME_MARKET_URL=http://127.0.0.1:${server.address().port}/marketplace.json`);
});
