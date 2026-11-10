/**
 * 读写文件的几件小事：整份替换、按文件排队、读不出时分清「没有」和「不知道」。
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** 先写临时文件再改名：写到一半崩掉，留下的是旧的整份，不是截断的一半。 */
export async function writeAtomic(file: string, data: string): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(temp, data, "utf8");
		await renameWithRetry(temp, file);
	} catch (error) {
		// 临时文件名每次都不同，失败留下的不会被下一次覆盖，只会越积越多。
		await rm(temp, { force: true }).catch(() => {});
		throw error;
	}
}

/** Windows 上别的进程开着目标文件时 rename 的回答。 */
const HELD_OPEN = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * `rename`，在 Windows 上等别的进程放开目标文件：杀毒、索引程序刚看到文件写出时会开着它一会儿，这时 rename 报
 * EPERM、EBUSY、EACCES。只在那边等：macOS、Linux 上同样的码是权限问题，等也不会变。一共试 8 次，每次多等 20ms，
 * 合计半秒多，够小文件被放开。
 */
async function renameWithRetry(from: string, to: string, attempts = 8, stepMs = 20): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			await rename(from, to);
			return;
		} catch (error) {
			const code = (error as { code?: string } | null)?.code ?? "";
			if (attempt >= attempts || process.platform !== "win32" || !HELD_OPEN.has(code)) throw error;
			await new Promise((resolve) => setTimeout(resolve, stepMs * attempt));
		}
	}
}

/** 文件不存在时是 null；其余读错照常抛。 */
export async function readText(file: string): Promise<string | null> {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

/**
 * 同一个文件的读—改—写一次只走一个。
 *
 * 每处都是先读整份再写回整份：设置页连点几次「添加」、模型在一次回复里并行调两次 `learn`，后写的那份不知道先写的那一条，
 * 把它覆盖掉。按文件排队，进程里的写入者就都接得上。
 */
const turns = new Map<string, Promise<unknown>>();

export function inTurn<T>(file: string, work: () => Promise<T>): Promise<T> {
	const run = (turns.get(file) ?? Promise.resolve()).then(work, work);
	turns.set(
		file,
		run.catch(() => {}),
	);
	return run;
}
