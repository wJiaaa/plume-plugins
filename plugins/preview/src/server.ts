import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname } from "node:path";
import { withBridge } from "./bridge.ts";
import type { PreviewDocument } from "./types.ts";
import { safeName } from "./types.ts";

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".txt": "text/plain; charset=utf-8",
};

/** 地址只对应提交的文件快照；不把任何磁盘目录交给网页。 */
export function createPages(load: (session: string, id: string) => Promise<PreviewDocument>) {
	const secret = randomBytes(32).toString("hex");
	const pages = new Map<string, { session: string; id: string }>();
	let running: Promise<{ server: Server; origin: string }> | undefined;
	const start = () =>
		(running ??= new Promise((resolve, reject) => {
			const server = createServer((request, response) => {
				void (async () => {
					const match = /^\/([a-f0-9]{32})\/(.+?)(?:\?.*)?$/.exec(request.url ?? "");
					const page = match && pages.get(match[1]!);
					const name = match ? decodeURIComponent(match[2]!) : "";
					if (request.method !== "GET" || !page || !safeName(name)) {
						response.writeHead(404).end();
						return;
					}
					const document = await load(page.session, page.id);
					const file = document.files.find((file) => file.path === name);
					if (!file) {
						response.writeHead(404).end();
						return;
					}
					const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
					const own = `${origin}/${match![1]}/`;
					response.writeHead(200, {
						"content-type": MIME[extname(name).toLowerCase()] ?? "application/octet-stream",
						"cache-control": "no-store",
						"x-content-type-options": "nosniff",
						"referrer-policy": "no-referrer",
						"access-control-allow-origin": "null",
						"content-security-policy": `sandbox allow-scripts allow-forms allow-pointer-lock allow-modals; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' ${own} https:; style-src 'unsafe-inline' ${own} https:; img-src ${own} https: data: blob:; font-src ${own} https: data:; media-src ${own} https: data: blob:; connect-src ${own} https:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`,
					});
					response.end(/\.html?$/i.test(name) ? withBridge(file.content) : file.content);
				})().catch(() => {
					if (!response.headersSent) response.writeHead(404);
					response.end();
				});
			});
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
		}));
	return {
		async address(document: PreviewDocument) {
			const { sessionId: session, id, entry } = document.preview;
			const token = createHash("sha256").update(`${secret}/${session}/${id}`).digest("hex").slice(0, 32);
			pages.set(token, { session, id });
			return `${(await start()).origin}/${token}/${entry.split("/").map(encodeURIComponent).join("/")}`;
		},
		release(session: string) {
			for (const [token, page] of pages) if (page.session === session) pages.delete(token);
		},
		async close() {
			if (running) {
				const { server } = await running;
				server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		},
	};
}
