import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { checkCancelled, ForgeError } from "./errors.ts";

export async function privateDirectory(path: string): Promise<string> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const stat = await lstat(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ForgeError("unsafePath");
	return realpath(path);
}
export async function readPrivateFile(path: string, maxBytes: number): Promise<string | null> {
	let handle;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > maxBytes) throw new ForgeError("storeError");
		await handle.chmod(0o600);
		return await handle.readFile("utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		if (error instanceof ForgeError) throw error;
		throw new ForgeError("storeError");
	} finally {
		await handle?.close();
	}
}
export async function atomicPrivateWrite(directory: string, name: string, content: string, signal?: AbortSignal): Promise<void> {
	if (signal) checkCancelled(signal);
	const path = join(directory, name);
	try {
		const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new ForgeError("unsafePath");
		const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
		try {
			const handle = await open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(content, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			if (signal) checkCancelled(signal);
			await rename(temporary, path);
		} finally {
			await unlink(temporary).catch(() => {});
		}
	} catch (error) {
		if (error instanceof ForgeError) throw error;
		throw new ForgeError("storeError");
	}
}
