/**
 * 冒烟（`PLUME_SMOKE_ONLY=ssh`，apps/desktop/src/main/smoke-ssh.ts）用的本机 SSH 服务：只听 127.0.0.1，每次起一把新的主机密钥，
 * 账号 plume、密码 smoke-pass。终端是一个假 shell：回显打的字，回车后对几条命令给固定输出；exec 通道照命令给固定输出、退出码 0。
 * 起好后往标准输出打一行 `PORT <端口>`。不是给人用的服务器，也不碰本机的任何 SSH 配置。
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Server, utils } = require("ssh2");

const PROMPT = "plume@smoke:~$ ";
const DISK = "Filesystem      Size  Used Avail Use% Mounted on\r\n/dev/vda1        40G   37G  3.1G  92% /\r\n";

const output = (command) => (command.startsWith("df") ? DISK : command.trim() ? `ran: ${command.trim()}\r\n` : "");

const server = new Server({ hostKeys: [utils.generateKeyPairSync("ed25519").private] }, (client) => {
	client.on("authentication", (context) => {
		if (context.method === "password" && context.username === "plume" && context.password === "smoke-pass") context.accept();
		else context.reject(["password"]);
	});
	client.on("ready", () => {
		client.on("session", (acceptSession) => {
			const session = acceptSession();
			session.on("pty", (accept) => accept?.());
			session.on("window-change", (accept) => accept?.());
			session.on("shell", (accept) => {
				const stream = accept();
				stream.write(`Welcome to the Plume smoke server\r\n${PROMPT}`);
				let line = "";
				stream.on("data", (data) => {
					for (const char of data.toString()) {
						if (char === "\r") {
							stream.write(`\r\n${output(line)}${PROMPT}`);
							line = "";
						} else {
							line += char;
							stream.write(char);
						}
					}
				});
			});
			session.on("exec", (accept, _reject, info) => {
				const stream = accept();
				stream.write(output(info.command).replace(/\r\n/g, "\n"));
				stream.exit(0);
				stream.end();
			});
		});
	});
	client.on("error", () => undefined);
});

server.listen(0, "127.0.0.1", () => console.log(`PORT ${server.address().port}`));
