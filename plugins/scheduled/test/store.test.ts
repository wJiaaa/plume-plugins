import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ScheduledTask } from "../src/api.ts";
import { nextRunAt } from "../src/schedule.ts";
import { createTaskStore } from "../src/store.ts";

function task(patch: Partial<ScheduledTask> = {}): ScheduledTask {
	return { id: "a", name: "审改动", cwd: "/repo", prompt: "看看", schedule: { kind: "daily", time: "09:00" }, enabled: true, ...patch };
}

/** 本地时区的今天几点几分。 */
function at(hours: number, minutes = 0): number {
	const date = new Date(2026, 10, 4);
	date.setHours(hours, minutes, 0, 0);
	return date.getTime();
}

describe("任务存储", () => {
	it("连着改几次都按顺序落盘，读回来是最后的样子", async () => {
		const dir = await mkdtemp(join(tmpdir(), "plume-scheduled-"));
		const store = createTaskStore(dir);
		expect(await store.list()).toEqual([]);
		void store.add(task());
		void store.add(task({ id: "b" }));
		void store.update("a", { enabled: false, name: "改过" });
		const last = await store.remove("b");
		expect(last).toEqual([task({ enabled: false, name: "改过" })]);
		expect(JSON.parse(await readFile(join(dir, "tasks.json"), "utf8"))).toEqual(last);
		expect(await createTaskStore(dir).list()).toEqual(last);
	});

	it("文件读不懂时报错，不当成空列表冲掉", async () => {
		const dir = await mkdtemp(join(tmpdir(), "plume-scheduled-"));
		await writeFile(join(dir, "tasks.json"), "{");
		const store = createTaskStore(dir);
		await expect(store.add(task())).rejects.toThrow();
		expect(await readFile(join(dir, "tasks.json"), "utf8")).toBe("{");
	});
});

describe("下次运行", () => {
	it("每天的任务：点还没到是今天，过了是明天，今天跑过也是明天", () => {
		expect(nextRunAt(task(), at(8))).toBe(at(9));
		expect(nextRunAt(task(), at(10))).toBe(at(9) + 24 * 3600_000);
		expect(nextRunAt(task({ lastRunAt: at(7) }), at(8))).toBe(at(9) + 24 * 3600_000);
	});

	it("间隔的任务从上次运行算起，没跑过就是现在", () => {
		const every = task({ schedule: { kind: "interval", minutes: 30 } });
		expect(nextRunAt(every, at(8))).toBe(at(8));
		expect(nextRunAt({ ...every, lastRunAt: at(8) }, at(8, 10))).toBe(at(8, 30));
	});

	it("停用的、时间写坏了的没有下次", () => {
		expect(nextRunAt(task({ enabled: false }), at(8))).toBeNull();
		expect(nextRunAt(task({ schedule: { kind: "daily", time: "nope" } }), at(8))).toBeNull();
	});
});
