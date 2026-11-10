/**
 * 「Token 构成」「耗时构成」两张环图和缓存未命中卡片背后的算术，和请求那一栏吃同一批筛过的行。
 *
 * 和画图分开放：会话要跨小时、跨模型去重而不是相加，思考要从生成里扣出来，这几件事错了在环图上看不出来，每一段都还是一段。
 */

import type { UsageCacheMiss, UsageRequestBucket, UsageTokenPart } from "@plume/contract";

export const TOKEN_PARTS: readonly UsageTokenPart[] = [
	"system",
	"instructions",
	"skills",
	"toolDefs",
	"user",
	"injected",
	"assistant",
	"toolResults",
	"outputThinking",
	"outputReply",
];

export interface ActivityTotals extends Record<UsageTokenPart, number> {
	/** 区间里发过请求的会话，去重；其中已归档的。 */
	sessions: number;
	archived: number;
	turns: number;
	timedReplies: number;
	modelMs: number;
	generateMs: number;
	thinkingMs: number;
	tools: number;
	toolErrors: number;
	toolMs: number;
	cacheMiss: UsageCacheMiss;
}

const SUMMED = ["turns", "timedReplies", "modelMs", "generateMs", "thinkingMs", "tools", "toolErrors", "toolMs"] as const;

export function activityTotals(rows: UsageRequestBucket[], archived: readonly string[]): ActivityTotals {
	const totals = { sessions: 0, archived: 0, cacheMiss: { tokens: 0, cost: 0, unpriced: 0, byCause: {} } } as ActivityTotals;
	for (const key of [...SUMMED, ...TOKEN_PARTS]) totals[key] = 0;
	const seen = new Set<string>();
	const shelved = new Set(archived);
	for (const row of rows) {
		for (const session of row.sessions) {
			if (seen.has(session)) continue;
			seen.add(session);
			totals.sessions += 1;
			if (shelved.has(session)) totals.archived += 1;
		}
		for (const key of SUMMED) totals[key] += row[key];
		for (const part of TOKEN_PARTS) totals[part] += row.parts[part];
		const miss = totals.cacheMiss;
		miss.tokens += row.cacheMiss.tokens;
		miss.cost += row.cacheMiss.cost;
		miss.unpriced += row.cacheMiss.unpriced;
		for (const [cause, tokens] of Object.entries(row.cacheMiss.byCause) as [keyof UsageCacheMiss["byCause"], number][])
			miss.byCause[cause] = (miss.byCause[cause] ?? 0) + tokens;
	}
	return totals;
}

export interface Segment {
	key: string;
	value: number;
	color: string;
}

/**
 * 一次请求的时间：发出到第一个 token 是等，之后是生成，生成里思考块的那段算思考、其余算回复。工具执行另起一段。
 * 思考记的时候已经截在生成以内，这里的减法不会出负数。
 */
export function timeSegments(totals: ActivityTotals): Segment[] {
	return [
		{ key: "wait", value: totals.modelMs - totals.generateMs, color: "var(--plume-accent)" },
		{ key: "thinking", value: totals.thinkingMs, color: "var(--plume-violet)" },
		{ key: "reply", value: totals.generateMs - totals.thinkingMs, color: "var(--plume-chart-5)" },
		{ key: "tool", value: totals.toolMs, color: "var(--plume-chart-2)" },
	];
}

/*
 * 十种颜色：提示词那四类走蓝、黄两个色系里的深浅，消息四类各自一色，输出两类用紫和玫红。紫色只给思考：助手消息用了紫色的话，
 * 和「输出 · 思考」两个点并排时分不开。注入内容是替人塞进来的，用中性灰。
 */
const TOKEN_COLORS: Record<UsageTokenPart, string> = {
	system: "var(--plume-accent)",
	instructions: "color-mix(in oklab, var(--plume-accent) 50%, var(--plume-on-accent))",
	skills: "var(--plume-chart-3)",
	toolDefs: "color-mix(in oklab, var(--plume-chart-3) 50%, var(--plume-chart-5))",
	user: "var(--plume-ok)",
	injected: "color-mix(in oklab, var(--plume-ink) 45%, transparent)",
	assistant: "var(--plume-chart-6)",
	toolResults: "var(--plume-chart-2)",
	outputThinking: "var(--plume-violet)",
	outputReply: "var(--plume-chart-5)",
};

/** 每次请求送进去的各部分和吐出来的两部分，加起来是这些请求计费的全部 token（含缓存读写）。 */
export function tokenSegments(totals: ActivityTotals): Segment[] {
	return TOKEN_PARTS.map((key) => ({ key, value: totals[key], color: TOKEN_COLORS[key] }));
}

/** 占比：有、但不到千分之一的写「<0.1%」，写成 0.0% 读起来是一点都没有；不到 10% 留一位小数。 */
export function percent(value: number, total: number): string {
	const share = total > 0 ? (value / total) * 100 : 0;
	if (share <= 0) return "0%";
	if (share < 0.05) return "<0.1%";
	return `${share.toFixed(share < 10 ? 1 : 0)}%`;
}
