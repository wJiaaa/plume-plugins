import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { PreviewDocument } from "./types.ts";
import { validId } from "./types.ts";

export function createStore(root: string) {
	const queues = new Map<string, Promise<unknown>>();
	const directory = (session: string) => {
		if (!validId(session)) throw new Error("Invalid session id");
		return join(root, session);
	};
	const file = (session: string, id: string) => {
		if (!validId(id)) throw new Error("Invalid preview id");
		return join(directory(session), `${id}.json`);
	};
	const load = async (session: string, id: string) => JSON.parse(await readFile(file(session, id), "utf8")) as PreviewDocument;
	const save = async (document: PreviewDocument) => {
		const { sessionId, id } = document.preview;
		await mkdir(directory(sessionId), { recursive: true });
		const target = file(sessionId, id);
		const temp = `${target}.${randomUUID()}.tmp`;
		try {
			await writeFile(temp, JSON.stringify(document));
			await rename(temp, target);
		} finally {
			await rm(temp, { force: true });
		}
	};
	return {
		load,
		save,
		async update(session: string, id: string, change: (document: PreviewDocument) => void) {
			const key = file(session, id);
			const pending = (queues.get(key) ?? Promise.resolve())
				.catch(() => {})
				.then(async () => {
					const document = await load(session, id);
					change(document);
					await save(document);
					return document;
				});
			queues.set(key, pending);
			try {
				return await pending;
			} finally {
				if (queues.get(key) === pending) queues.delete(key);
			}
		},
		async list(session: string) {
			const entries = await readdir(directory(session)).catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return [];
				throw error;
			});
			return Promise.all(entries.filter((entry) => entry.endsWith(".json")).map((entry) => load(session, entry.slice(0, -5))));
		},
		async delete(session: string) {
			await Promise.allSettled([...queues.entries()].filter(([key]) => key.startsWith(`${directory(session)}${sep}`)).map(([, pending]) => pending));
			await rm(directory(session), { recursive: true, force: true });
		},
	};
}
