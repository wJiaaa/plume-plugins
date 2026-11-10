/**
 * Windows 上整份替换：杀毒、索引程序刚看到文件写出时会开着它一会儿，这时 rename 被拒（EPERM、EBUSY）。按需复现不了，
 * 所以平台和拒绝都是假的。
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const refusals = { left: 0, code: "EPERM" };

vi.mock("node:fs/promises", async (original) => {
	const real = await original<typeof import("node:fs/promises")>();
	return {
		...real,
		rename: async (from: string, to: string) => {
			if (refusals.left > 0) {
				refusals.left -= 1;
				throw Object.assign(new Error(`${refusals.code}: operation not permitted, rename '${from}' -> '${to}'`), { code: refusals.code });
			}
			return real.rename(from, to);
		},
	};
});

const { writeAtomic } = await import("../src/files.ts");

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const asPlatform = (value: string) => Object.defineProperty(process, "platform", { ...platform, value });
afterEach(() => {
	Object.defineProperty(process, "platform", platform);
	refusals.left = 0;
});

it("Windows 上一时被拒的改名等一下重试，不算失败", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-memory-files-"));
	try {
		asPlatform("win32");
		refusals.left = 2;
		await writeAtomic(join(dir, "learned.md"), "kept");
		expect(refusals.left).toBe(0);
		expect(await readFile(join(dir, "learned.md"), "utf8")).toBe("kept");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

it("别处同样的码是权限问题，不等；失败时不留下临时文件", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-memory-files-"));
	try {
		asPlatform("darwin");
		refusals.left = 1;
		await expect(writeAtomic(join(dir, "learned.md"), "lost")).rejects.toMatchObject({ code: "EPERM" });
		expect(await readdir(dir)).toEqual([]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
