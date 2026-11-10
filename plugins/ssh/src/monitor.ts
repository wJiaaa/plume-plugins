/**
 * 资源占用：开着时每 5 秒对每条连上的连接跑一条固定的只读命令，读 /proc/stat、/proc/meminfo、/proc/net/dev 和
 * `df -Pk /`，算出 CPU、内存、磁盘和网络速率。不经 Agent、不逐条问人；和 Agent、批量命令共用连接的 exec 队列，
 * 一次最多 4 秒。只认 Linux，别的系统读出来是「读取失败」。每次启动都是关着的。
 */

import type { ResourceStats } from "./api.ts";

const STATS_COMMAND =
	"{ printf '__CPU__\\n'; awk '/^cpu /{print;exit}' /proc/stat; printf '__MEM__\\n'; grep -E '^Mem(Total|Available):' /proc/meminfo; printf '__NET__\\n'; cat /proc/net/dev; printf '__DISK__\\n'; df -Pk /; } 2>/dev/null; :";

export interface Sample {
	cpuTotal: number | null;
	cpuIdle: number | null;
	memTotalKb: number | null;
	memAvailableKb: number | null;
	rxBytes: number | null;
	txBytes: number | null;
	diskPercent: number | null;
}

function counter(value: string | undefined): number | null {
	if (value === undefined || !/^\d+$/.test(value)) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseStatsSample(stdout: string): Sample {
	const sample: Sample = { cpuTotal: null, cpuIdle: null, memTotalKb: null, memAvailableKb: null, rxBytes: null, txBytes: null, diskPercent: null };
	let section = "";
	let networkSeen = false;
	let networkMalformed = false;
	let rxBytes = 0;
	let txBytes = 0;
	for (const raw of stdout.split(/\r?\n/)) {
		const line = raw.trim();
		if (/^__(CPU|MEM|NET|DISK)__$/.test(line)) {
			section = line;
			continue;
		}
		if (section === "__CPU__" && /^cpu\s/.test(line)) {
			const values = line.split(/\s+/).slice(1).map(counter);
			if (values.length < 4 || values.some((value) => value === null)) continue;
			// guest、guest_nice 已经算在 user、nice 里。
			const numbers = values as number[];
			const total = numbers.slice(0, 8).reduce((sum, value) => sum + value, 0);
			const idle = numbers[3]! + (numbers[4] ?? 0);
			if (Number.isSafeInteger(total) && Number.isSafeInteger(idle)) {
				sample.cpuTotal = total;
				sample.cpuIdle = idle;
			}
		} else if (section === "__MEM__") {
			const match = /^(MemTotal|MemAvailable):\s+(\d+)\s+kB$/.exec(line);
			if (match) sample[match[1] === "MemTotal" ? "memTotalKb" : "memAvailableKb"] = counter(match[2]);
		} else if (section === "__NET__") {
			if (/^(Inter-\||face\s*\|)/.test(line)) networkSeen = true;
			const colon = line.lastIndexOf(":");
			if (colon < 0) continue;
			networkSeen = true;
			if (line.slice(0, colon).trim() === "lo") continue;
			const fields = line
				.slice(colon + 1)
				.trim()
				.split(/\s+/)
				.map(counter);
			if (fields.length < 16 || fields.some((value) => value === null)) {
				networkMalformed = true;
				continue;
			}
			rxBytes += fields[0]!;
			txBytes += fields[8]!;
		} else if (section === "__DISK__") {
			// 也认 BusyBox 把长文件系统名折到下一行的写法。
			const match = /(?:^|\s)(\d+)%\s+\/$/.exec(line);
			if (match) sample.diskPercent = counter(match[1]);
		}
	}
	if (networkSeen && !networkMalformed) {
		sample.rxBytes = Number.isSafeInteger(rxBytes) ? rxBytes : null;
		sample.txBytes = Number.isSafeInteger(txBytes) ? txBytes : null;
	}
	return sample;
}

function percent(value: number | null): number | null {
	return value !== null && Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : null;
}

function rate(previous: number | null, current: number | null, elapsedMs: number): number | null {
	if (previous === null || current === null || !(elapsedMs > 0) || current < previous) return null;
	const value = ((current - previous) * 1000) / elapsedMs;
	return Number.isFinite(value) ? Math.round(value) : null;
}

export function computeStats(previous: Sample | null, current: Sample, elapsedMs: number, at: string): ResourceStats {
	let cpu: number | null = null;
	if (previous?.cpuTotal != null && previous.cpuIdle != null && current.cpuTotal !== null && current.cpuIdle !== null) {
		const total = current.cpuTotal - previous.cpuTotal;
		const idle = current.cpuIdle - previous.cpuIdle;
		if (total > 0 && idle >= 0) cpu = percent(((total - idle) / total) * 100);
	}
	const memory =
		current.memTotalKb !== null && current.memTotalKb > 0 && current.memAvailableKb !== null
			? percent(((current.memTotalKb - current.memAvailableKb) / current.memTotalKb) * 100)
			: null;
	return {
		cpu,
		memory,
		disk: percent(current.diskPercent),
		rxRate: rate(previous?.rxBytes ?? null, current.rxBytes, elapsedMs),
		txRate: rate(previous?.txBytes ?? null, current.txBytes, elapsedMs),
		at,
	};
}

interface Watched {
	previous: Sample | null;
	at: number | null;
}

export class ResourceMonitor {
	private readonly watched = new Map<string, Watched>();
	private readonly inFlight = new Map<string, AbortController>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private monitoring = false;

	constructor(
		private readonly deps: {
			exec(id: string, command: string, timeoutMs: number, signal: AbortSignal): Promise<{ stdout: string; code: number | null }>;
			/** 新读数；null 是没有读数了（关掉、断开）。 */
			emit(id: string, stats: ResourceStats | null): void;
			intervalMs?: number;
		},
	) {}

	get enabled(): boolean {
		return this.monitoring;
	}

	setConnections(ids: string[]): void {
		const wanted = new Set(ids);
		for (const id of this.watched.keys()) {
			if (wanted.has(id)) continue;
			this.watched.delete(id);
			this.inFlight.get(id)?.abort();
		}
		for (const id of wanted) {
			if (this.watched.has(id)) continue;
			const state: Watched = { previous: null, at: null };
			this.watched.set(id, state);
			if (this.monitoring) void this.sample(id, state);
		}
	}

	setEnabled(enabled: boolean): void {
		if (this.monitoring === enabled) return;
		this.monitoring = enabled;
		if (enabled) {
			this.tick();
			return;
		}
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
		for (const controller of this.inFlight.values()) controller.abort();
		for (const [id, state] of this.watched) {
			state.previous = null;
			state.at = null;
			this.deps.emit(id, null);
		}
	}

	stop(): void {
		this.setEnabled(false);
		this.watched.clear();
	}

	private tick(): void {
		if (!this.monitoring) return;
		for (const [id, state] of this.watched) void this.sample(id, state);
		this.timer = setTimeout(() => this.tick(), this.deps.intervalMs ?? 5000);
		this.timer.unref?.();
	}

	private async sample(id: string, state: Watched): Promise<void> {
		if (!this.monitoring || this.inFlight.has(id)) return;
		const controller = new AbortController();
		this.inFlight.set(id, controller);
		const active = () => this.monitoring && !controller.signal.aborted && this.watched.get(id) === state;
		try {
			const result = await this.deps.exec(id, STATS_COMMAND, 4000, controller.signal);
			if (!active()) return;
			if (result.code !== 0) throw new Error("resource command failed");
			const now = Date.now();
			const current = parseStatsSample(result.stdout);
			const stats = computeStats(state.previous, current, state.at === null ? 0 : now - state.at, new Date(now).toISOString());
			state.previous = current;
			state.at = now;
			this.deps.emit(id, stats);
		} catch {
			if (!active()) return;
			state.previous = null;
			state.at = null;
			this.deps.emit(id, { cpu: null, memory: null, disk: null, rxRate: null, txRate: null, at: new Date().toISOString(), failed: true });
		} finally {
			if (this.inFlight.get(id) === controller) this.inFlight.delete(id);
		}
	}
}
