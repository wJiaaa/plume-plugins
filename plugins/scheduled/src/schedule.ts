/**
 * 定时任务下次什么时候跑。
 *
 * 纯函数，两个入口都能用：页面拿它显示「下次运行」，运行任务的那一边（scheduler.ts）按同一套规则判断到没到点，
 * 两边算的不会对不上——卡片上写着 09:00，就不会在 09:05 才跑。
 */

import type { ScheduledTask } from "./api.ts";

/** 现在该不该跑。间隔的：从没跑过，或者离上次开跑满了一个周期；每天的：今天的点过了，今天还没跑过。不看开关。 */
export function isDue(task: ScheduledTask, now: number): boolean {
	if (task.schedule.kind === "interval") {
		const period = Math.max(1, task.schedule.minutes) * 60_000;
		return task.lastRunAt === undefined || now - task.lastRunAt >= period;
	}

	const at = timeOfDay(task.schedule.time);
	if (!at) return false;

	const target = new Date(now);
	target.setHours(at.hours, at.minutes, 0, 0);
	if (now < target.getTime()) return false;

	// 每天的任务一天只跑一次，应用开了多久都一样。
	return task.lastRunAt === undefined || !sameDay(task.lastRunAt, now);
}

/** 下次运行的时刻；停用的、时间写坏了的为 null。只用来显示。 */
export function nextRunAt(task: ScheduledTask, now = Date.now()): number | null {
	if (!task.enabled) return null;

	if (task.schedule.kind === "interval") {
		const period = Math.max(1, task.schedule.minutes) * 60_000;
		return task.lastRunAt === undefined ? now : task.lastRunAt + period;
	}

	const at = timeOfDay(task.schedule.time);
	if (!at) return null;

	const target = new Date(now);
	target.setHours(at.hours, at.minutes, 0, 0);
	// 今天的点已经过了，或者今天已经跑过。
	if (target.getTime() <= now || (task.lastRunAt !== undefined && sameDay(task.lastRunAt, now))) {
		target.setDate(target.getDate() + 1);
	}
	return target.getTime();
}

/** `"09:30"` → 时和分；不是时间时为 null。 */
function timeOfDay(value: string): { hours: number; minutes: number } | null {
	const [hours, minutes] = value.split(":").map(Number);
	if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
	return { hours: hours!, minutes: minutes! };
}

function sameDay(a: number, b: number): boolean {
	const x = new Date(a);
	const y = new Date(b);
	return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}
