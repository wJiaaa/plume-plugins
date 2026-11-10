/** 资源占用的读数：从固定命令的输出里算 CPU、内存、磁盘和网速。 */

import { expect, it } from "vitest";
import { computeStats, parseStatsSample } from "../src/monitor.ts";

function output(cpu: string, rx: number, tx: number): string {
	return [
		"__CPU__",
		cpu,
		"__MEM__",
		"MemTotal:        8000000 kB",
		"MemAvailable:    2000000 kB",
		"__NET__",
		"Inter-|   Receive                                                |  Transmit",
		" face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
		"    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0",
		`  eth0: ${rx} 10 0 0 0 0 0 0 ${tx} 10 0 0 0 0 0 0`,
		"__DISK__",
		"Filesystem     1024-blocks     Used Available Capacity Mounted on",
		"/dev/sda1        41152736 17000000  22000000      44% /",
	].join("\n");
}

it("两次采样之间算出百分比和每秒字节数，跳过 lo", () => {
	const first = parseStatsSample(output("cpu  100 0 100 800 0 0 0 0 0 0", 1000, 500));
	const second = parseStatsSample(output("cpu  150 0 150 900 0 0 0 0 0 0", 6000, 3000));
	expect(computeStats(first, second, 5000, "now")).toEqual({ cpu: 50, memory: 75, disk: 44, rxRate: 1000, txRate: 500, at: "now" });
});

it("第一次只有内存和磁盘；读不到的项为空", () => {
	expect(computeStats(null, parseStatsSample(output("cpu  1 2 3 4", 0, 0)), 0, "t")).toMatchObject({ cpu: null, memory: 75, disk: 44, rxRate: null });
	expect(parseStatsSample("not linux")).toMatchObject({ cpuTotal: null, memTotalKb: null, diskPercent: null, rxBytes: null });
});
