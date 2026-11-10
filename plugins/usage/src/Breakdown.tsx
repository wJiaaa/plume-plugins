/**
 * 柱状图下面那三张卡片：这些 token 是什么、这些时间花在哪，以及本该从缓存读到却按全价算的输入各是为什么。
 * 数是 agent 进程在每次请求记账时记下的（`UsageRequestBucket.parts`、计时和 `cacheMiss`），这里只合计和摆放。
 */

import type { UsageCacheMissCause } from "@plume/contract";
import { SettingsCard, SkeletonBar, Text } from "@plume/ui";
import { ChartPie, Clock, Layers } from "@plume/ui/icons";
import { type ActivityTotals, percent, type Segment, TOKEN_PARTS, timeSegments, tokenSegments } from "./activity.ts";
import { Dot } from "./Bars.tsx";
import { formatCompact, formatCost, formatDuration } from "./format.ts";
import { fill, type Messages } from "./messages.ts";
import { EmptyHint } from "./Parts.tsx";
import type { RequestTotals } from "./requests.ts";

const RADIUS = 46;
const STROKE = 12;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** 一圈分段。段与段之间留一道缝，相邻两段同色系时也分得开；太小的段只画缝不画色。 */
function Donut({ segments, total, value, label }: { segments: Segment[]; total: number; value: string; label: string }) {
	const gap = segments.filter((each) => each.value > 0).length > 1 ? 2 : 0;
	let offset = 0;
	return (
		<div className="usage-donut">
			<svg viewBox="0 0 120 120" className="usage-donut-svg" aria-hidden="true">
				<circle cx="60" cy="60" r={RADIUS} fill="none" strokeWidth={STROKE} className="usage-donut-track" />
				{segments.map((each) => {
					const length = total > 0 ? (each.value / total) * CIRCUMFERENCE : 0;
					const start = offset;
					offset += length;
					if (length <= gap) return null;
					return (
						<circle
							key={each.key}
							data-donut-segment={each.key}
							cx="60"
							cy="60"
							r={RADIUS}
							fill="none"
							strokeWidth={STROKE}
							stroke={each.color}
							strokeDasharray={`${length - gap} ${CIRCUMFERENCE}`}
							strokeDashoffset={-start}
						/>
					);
				})}
			</svg>
			<div className="usage-donut-center">
				<Text as="div" size="title" weight="semibold" numeric>
					{value}
				</Text>
				<Text as="div" size="detail" tone="faint">
					{label}
				</Text>
			</div>
		</div>
	);
}

function Legend({ rows }: { rows: { key: string; color: string; label: string; share: string; detail: string }[] }) {
	return (
		<div className="usage-legend">
			{rows.map((row) => (
				<div key={row.key} data-usage-legend={row.key} className="usage-legend-item">
					<div className="usage-legend-row">
						<Dot color={row.color} />
						<Text className="usage-grow usage-truncate">{row.label}</Text>
						<Text weight="medium" numeric className="usage-keep">
							{row.share}
						</Text>
					</div>
					<Text as="div" size="detail" tone="faint" numeric className="usage-legend-detail usage-truncate">
						{row.detail}
					</Text>
				</div>
			))}
		</div>
	);
}

const TOKEN_LABELS = {
	system: "tokenSystem",
	instructions: "tokenInstructions",
	skills: "tokenSkills",
	toolDefs: "tokenToolDefs",
	user: "tokenUser",
	injected: "tokenInjected",
	assistant: "tokenAssistant",
	toolResults: "tokenToolResults",
	outputThinking: "tokenOutputThinking",
	outputReply: "tokenOutputReply",
} as const satisfies Record<(typeof TOKEN_PARTS)[number], keyof Messages>;

const TIME_LABELS: Record<string, keyof Messages> = {
	wait: "timeWait",
	thinking: "timeThinking",
	reply: "timeReply",
	tool: "timeTool",
};

/** 两张环图卡片。缓存那一行换了个来源：账单上的实数，和顶上的命中率同一个口径。 */
export function UsageBreakdown({ tokens, activity, text }: { tokens: RequestTotals; activity: ActivityTotals; text: Messages }) {
	const tokenParts = tokenSegments(activity);
	const tokenTotal = tokenParts.reduce((sum, each) => sum + each.value, 0);
	const cacheInput = tokens.input + tokens.cacheRead + tokens.cacheWrite;
	const timeParts = timeSegments(activity);
	const timeTotal = timeParts.reduce((sum, each) => sum + each.value, 0);
	const times = (n: number) => fill(text.timesCount, { n: n.toLocaleString() });
	const timeDetail: Record<string, string> = {
		wait: [formatDuration(timeParts[0]?.value ?? 0), times(activity.timedReplies)].join(" · "),
		thinking: formatDuration(activity.thinkingMs),
		reply: formatDuration(timeParts[2]?.value ?? 0),
		tool: [
			formatDuration(activity.toolMs),
			times(activity.tools),
			...(activity.toolErrors > 0 ? [fill(text.toolFailed, { n: activity.toolErrors })] : []),
		].join(" · "),
	};
	const counts = [
		activity.archived > 0
			? fill(text.sessionsArchived, { n: activity.sessions, archived: activity.archived })
			: fill(text.sessionsCount, { n: activity.sessions }),
		fill(text.turnsCount, { n: activity.turns.toLocaleString() }),
		fill(text.toolCallsCount, { n: activity.tools.toLocaleString() }),
	];

	return (
		<div className="usage-breakdown" data-usage-breakdown="true">
			<SettingsCard className="usage-breakdown-card" data-usage-token-breakdown="true">
				<Text as="div" weight="medium">
					{text.tokenBreakdown}
				</Text>
				<Text as="div" size="detail" tone="faint" className="usage-card-detail">
					{text.tokenBreakdownDetail}
				</Text>
				{tokenTotal === 0 ? (
					<EmptyHint icon={ChartPie}>{text.noRequests}</EmptyHint>
				) : (
					<div className="usage-breakdown-body">
						<Donut segments={tokenParts} total={tokenTotal} value={formatCompact(tokenTotal)} label={text.tokenAll} />
						<Legend
							rows={tokenParts.map((each) => ({
								key: each.key,
								color: each.color,
								label: text[TOKEN_LABELS[each.key as keyof typeof TOKEN_LABELS]],
								share: percent(each.value, tokenTotal),
								detail: each.value > 0 ? `≈${formatCompact(each.value)}` : "0",
							}))}
						/>
					</div>
				)}
				{tokenTotal > 0 && cacheInput > 0 && (
					<Text as="div" size="detail" tone="faint" numeric className="usage-breakdown-foot" data-usage-cache-split="true">
						{fill(text.tokenCacheSplit, {
							read: percent(tokens.cacheRead, cacheInput),
							write: percent(tokens.cacheWrite, cacheInput),
							fresh: percent(tokens.input, cacheInput),
						})}
					</Text>
				)}
			</SettingsCard>
			<SettingsCard className="usage-breakdown-card" data-usage-time-breakdown="true">
				<div className="usage-breakdown-head">
					<Text as="div" weight="medium">
						{text.timeBreakdown}
					</Text>
					<Text as="div" size="detail" tone="muted" numeric data-usage-activity-counts="true">
						{counts.join(" · ")}
					</Text>
				</div>
				<Text as="div" size="detail" tone="faint" className="usage-card-detail">
					{text.timeBreakdownDetail}
				</Text>
				{timeTotal === 0 ? (
					<EmptyHint icon={Clock}>{text.noActivity}</EmptyHint>
				) : (
					<div className="usage-breakdown-body">
						<Donut segments={timeParts} total={timeTotal} value={formatDuration(timeTotal)} label={text.timeAll} />
						<Legend
							rows={timeParts.map((each) => ({
								key: each.key,
								color: each.color,
								label: text[TIME_LABELS[each.key] ?? "timeWait"] as string,
								share: percent(each.value, timeTotal),
								detail: timeDetail[each.key] ?? "",
							}))}
						/>
					</div>
				)}
			</SettingsCard>
		</div>
	);
}

/**
 * 有未命中的那几种原因，按「要不要去查」排：本地改了工具、提示词或历史的排前面，其次是前缀没变服务商却没读到、没有前缀记录
 * 分不清的；最后几种是有意改写或换模型，付了代价但说得清为什么。
 */
const CAUSES: { cause: UsageCacheMissCause; label: keyof Messages }[] = [
	{ cause: "tools", label: "cacheMissTools" },
	{ cause: "prompt", label: "cacheMissPrompt" },
	{ cause: "rewrite", label: "cacheMissRewrite" },
	{ cause: "provider", label: "cacheMissProvider" },
	{ cause: "unknown", label: "cacheMissUnknown" },
	{ cause: "compaction", label: "cacheMissCompaction" },
	{ cause: "rewind", label: "cacheMissRewind" },
	{ cause: "model", label: "cacheMissModel" },
];

/** 本该从缓存读到、却按全价重算的输入，以及各是为什么。 */
export function CacheMissCard({ tokens, activity, text }: { tokens: RequestTotals; activity: ActivityTotals; text: Messages }) {
	const miss = activity.cacheMiss;
	const input = tokens.input + tokens.cacheRead + tokens.cacheWrite;
	const rows = CAUSES.filter(({ cause }) => (miss.byCause[cause] ?? 0) > 0);
	return (
		<SettingsCard className="usage-card usage-miss" data-usage-cache-miss="true">
			<Text as="div" weight="medium" className="usage-miss-title">
				{text.cacheMiss}
			</Text>
			{miss.tokens === 0 ? (
				<EmptyHint icon={Layers}>{text.cacheMissNone}</EmptyHint>
			) : (
				<div className="usage-miss-body">
					<div>
						<Text as="div" size="heading" weight="semibold" numeric>
							{formatCompact(miss.tokens)}{" "}
							<Text size="label" tone="faint" weight="normal">
								token
							</Text>
						</Text>
						<Text as="div" size="detail" tone="faint" numeric className="usage-miss-sub">
							{fill(text.ofInput, { percent: `${input > 0 ? ((miss.tokens / input) * 100).toFixed(1) : "0.0"}%` })}
							{miss.cost > 0 && ` · ${fill(text.cacheMissCost, { cost: formatCost(miss.cost) ?? "$0.00" })}`}
							{miss.unpriced > 0 && ` · ${fill(text.cacheMissUnpriced, { n: formatCompact(miss.unpriced) })}`}
						</Text>
						<Text as="p" size="detail" tone="faint" className="usage-miss-detail">
							{text.cacheMissDetail}
						</Text>
					</div>
					<div className="usage-miss-causes">
						{rows.map(({ cause, label }) => (
							<div key={cause} data-usage-miss-cause={cause} className="usage-miss-cause">
								<Text tone="muted">{text[label] as string}</Text>
								<Text numeric className="usage-keep">
									{formatCompact(miss.byCause[cause] ?? 0)}
								</Text>
							</div>
						))}
					</div>
				</div>
			)}
		</SettingsCard>
	);
}

/** 一行字的占位：条放在和真文字同一个行高的盒子里，只画一根细条的话数据一到卡片就长高一截。 */
function SkeletonLine({ width, size, className = "" }: { width: string; size: "body" | "detail"; className?: string }) {
	return (
		<Text as="div" size={size === "body" ? undefined : "detail"} className={`usage-skeleton-line ${className}`}>
			<SkeletonBar width={width} height={size === "body" ? 10 : 8} />
		</Text>
	);
}

function SkeletonBreakdownCard({ seed, rows, footer }: { seed: number; rows: number; footer: boolean }) {
	return (
		<SettingsCard className="usage-breakdown-card" aria-hidden="true">
			<SkeletonLine width={`${[72, 64][seed] ?? 68}px`} size="body" />
			<SkeletonLine width={`${[58, 70][seed] ?? 64}%`} size="detail" className="usage-card-detail" />
			<div className="usage-breakdown-body">
				<span data-skeleton-ring="" className="plume-skeleton usage-skeleton-ring" />
				<div className="usage-legend">
					{Array.from({ length: rows }, (_, index) => (
						<div key={index}>
							<SkeletonLine width={`${[52, 44, 60, 48][(index + seed) % 4]}%`} size="body" />
							<SkeletonLine width={`${[30, 38, 26, 34][(index + seed) % 4]}%`} size="detail" className="usage-legend-detail" />
						</div>
					))}
				</div>
			</div>
			{footer && <SkeletonLine width="46%" size="detail" className="usage-breakdown-foot" />}
		</SettingsCard>
	);
}

/** 两张环图卡片还没数时的样子：排法和真卡片同一套，数据到了只是填进去。 */
export function UsageBreakdownSkeleton() {
	return (
		<div className="usage-breakdown" data-usage-breakdown-skeleton="true">
			<SkeletonBreakdownCard seed={0} rows={TOKEN_PARTS.length} footer />
			<SkeletonBreakdownCard seed={1} rows={4} footer={false} />
		</div>
	);
}
