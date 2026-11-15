import type { UiContext } from "@plume/contract/ui";
import { Text, useI18n } from "@plume/ui";
import type { ReactNode } from "react";
import { tableData } from "./data.ts";
import { text } from "./expression.ts";
import { MESSAGES } from "./messages.ts";

/**
 * 一张卡片，或者卡片里的一节。不用工具卡片的 `Card`：那是标题行加分隔线、副标题挤在标题右边一行的外框，
 * 界面块是回复的一部分，外层一圈淡框、标题压在副标题上面；卡片里再套卡片只铺一层底，不再画框。
 */
export function NativeCard({ title, subtitle, nested, children }: { title?: string; subtitle?: string; nested: boolean; children: ReactNode }) {
	return (
		<section className="native-ui-card" data-nested={nested || undefined}>
			{(title || subtitle) && (
				<header className="native-ui-card-head">
					{title && (
						<Text size="label" weight="semibold">
							{title}
						</Text>
					)}
					{subtitle && (
						<Text size="caption" tone="muted">
							{subtitle}
						</Text>
					)}
				</header>
			)}
			{children}
		</section>
	);
}

export function Stat({ label, value, delta, hint }: { label: string; value: unknown; delta?: unknown; hint?: string }) {
	const change = delta === undefined ? "" : typeof delta === "number" ? `${delta > 0 ? "+" : ""}${delta}` : text(delta);
	const direction = /^[+↑]/.test(change) ? "up" : /^[-−↓]/.test(change) ? "down" : undefined;
	return (
		<div className="native-ui-stat">
			<Text size="caption" tone="muted">
				{label}
			</Text>
			<div className="native-ui-row" data-gap="sm">
				<Text size="heading" weight="semibold" numeric>
					{text(value)}
				</Text>
				{change && (
					<Text size="caption" numeric className="native-ui-delta" data-direction={direction}>
						{change}
					</Text>
				)}
			</div>
			{hint && (
				<Text size="caption" tone="muted">
					{hint}
				</Text>
			)}
		</div>
	);
}

export function Callout({ title, tone = "info", children }: { title?: string; tone?: string; children: ReactNode }) {
	return (
		<div className="native-ui-callout" data-tone={tone}>
			{title && (
				<Text size="label" weight="medium">
					{title}
				</Text>
			)}
			<div className="native-ui-stack">{children}</div>
		</div>
	);
}
export function Progress({ value, max = 100, label, tone = "info" }: { value: number; max?: number; label?: string; tone?: string }) {
	const whole = max > 0 ? max : 100;
	const current = Math.min(whole, Math.max(0, value));
	return (
		<div className="native-ui-field" data-tone={tone}>
			<div className="native-ui-row" data-align="between">
				<Text size="caption" tone="muted">
					{label}
				</Text>
				<Text size="caption" numeric>{`${Math.round((current / whole) * 100)}%`}</Text>
			</div>
			<div className="native-ui-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={whole} aria-valuenow={current}>
				<div style={{ transform: `scaleX(${current / whole})` }} />
			</div>
		</div>
	);
}

let host: UiContext | undefined;
/** 界面入口启用时交进来：表格交给产品的正文渲染，和回复里的 Markdown 表格同一个样子。 */
export function setHost(ui: UiContext) {
	host = ui;
}

/** 单元格是纯文字，不是 Markdown：ASCII 标点全部转义，换行并成空格，`|` 不会切开列。 */
function cell(value: unknown): string {
	return text(value)
		.replace(/\s*\n\s*/g, " ")
		.replace(/[!-/:-@[-`{-~]/g, "\\$&");
}

export function Table({ props }: { props: Record<string, unknown> }) {
	const messages = MESSAGES[useI18n().resolvedLocale];
	const table = tableData(props);
	if (!table.header.length)
		return (
			<Text size="label" tone="muted" role="status">
				{messages.empty}
			</Text>
		);
	const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
	const markdown = [
		line(table.header.map(cell)),
		line(table.numeric.map((numeric) => (numeric ? "---:" : "---"))),
		...table.cells.map((row) => line(row.map(cell))),
	].join("\n");
	const Markdown = host!.Markdown;
	return (
		<div className="native-ui-table">
			{/* apply 先于 codeBlock 注册交进 host，块画出来时一定在。 */}
			<Markdown text={markdown} />
		</div>
	);
}
