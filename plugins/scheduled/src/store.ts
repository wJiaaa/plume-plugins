/**
 * 定时任务存在插件数据目录的 `tasks.json` 里，只有逻辑入口读写。
 *
 * 写是一个接一个排队的：页面连着改两处时，后一次读到的是前一次写完的结果，不会互相盖掉。先写临时文件再改名，
 * 写到一半退出也不会留下半个文件。文件读不懂时报错，不当成空列表——当成空的话，下一次保存就把用户的任务全冲掉了。
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScheduledApi, ScheduledTask } from "./api.ts";

/** 运行记录：只由运行任务的那一边写，页面改不了（`TaskPatch` 里没有它们）。 */
type RunRecord = Pick<ScheduledTask, "lastRunAt" | "lastSessionId" | "lastError">;

export interface TaskStore extends Pick<ScheduledApi, "list" | "add" | "update" | "remove"> {
	/**
	 * 写一次运行记录。给了 `when` 时只在它对那个任务（排到这一次时读到的最新样子）说是时才写：判断和写在同一次排队里，
	 * 中间插不进别的写。值为 undefined 的字段写下去就没了（上一次的失败原因跟着清掉）。
	 */
	record(id: string, patch: RunRecord, when?: (task: ScheduledTask) => boolean): Promise<ScheduledTask[]>;
}

/** `changed` 在每次写完以后调，告诉看着的界面列表变了。 */
export function createTaskStore(dataDir: string, changed: () => void = () => undefined): TaskStore {
	const file = join(dataDir, "tasks.json");
	let queue: Promise<unknown> = Promise.resolve();

	async function read(): Promise<ScheduledTask[]> {
		let text: string;
		try {
			text = await readFile(file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const tasks = JSON.parse(text) as unknown;
		// i18n-exempt：文件被手改坏了才会到这里，原因进日志和开发者工具。
		if (!Array.isArray(tasks)) throw new Error(`${file} 不是任务列表`);
		return tasks as ScheduledTask[];
	}

	/** 排进队里改一次：读最新的、改、写回，返回写下去的那份。 */
	function change(edit: (tasks: ScheduledTask[]) => ScheduledTask[]): Promise<ScheduledTask[]> {
		const next = queue.then(async () => {
			const tasks = edit(await read());
			await writeFile(`${file}.tmp`, JSON.stringify(tasks, null, "\t"));
			await rename(`${file}.tmp`, file);
			changed();
			return tasks;
		});
		queue = next.catch(() => undefined);
		return next;
	}

	return {
		list: () => queue.then(read),
		add: (task) => change((tasks) => [...tasks, task]),
		update: (id, patch) => change((tasks) => tasks.map((task) => (task.id === id ? { ...task, ...patch } : task))),
		remove: (id) => change((tasks) => tasks.filter((task) => task.id !== id)),
		record: (id, patch, when) => change((tasks) => tasks.map((task) => (task.id === id && (!when || when(task)) ? { ...task, ...patch } : task))),
	};
}
