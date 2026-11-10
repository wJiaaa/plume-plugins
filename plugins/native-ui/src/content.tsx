import { Card, Scroller, Text, useI18n } from "@plume/ui";
import type { ReactNode } from "react";
import { tableData, type TableData } from "./data.ts";
import { text } from "./expression.ts";
import { MESSAGES } from "./messages.ts";

export function NativeCard({ title, subtitle, nested, children }: { title?: string; subtitle?: string; nested: boolean; children: ReactNode }) {
	if (nested)
		return (
			<section className="native-ui-section">
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
				{children}
			</section>
		);
	return (
		<Card
			title={
				title ? (
					<Text size="label" weight="semibold">
						{title}
					</Text>
				) : null
			}
			subtitle={
				subtitle ? (
					<Text size="caption" tone="muted">
						{subtitle}
					</Text>
				) : undefined
			}
		>
			<div className="native-ui-stack native-ui-card-body">{children}</div>
		</Card>
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

export function DataTable({ table }: { table: TableData }) {
	const messages = MESSAGES[useI18n().resolvedLocale];
	return (
		<div className="native-ui-table">
			<Scroller overscroll="auto" top="none" bottom="none">
				<table>
					{table.header.length > 0 && (
						<thead>
							<tr>
								{table.header.map((header, at) => (
									<th key={at} scope="col" data-numeric={table.numeric[at]}>
										<Text size="label" weight="medium">
											{header}
										</Text>
									</th>
								))}
							</tr>
						</thead>
					)}
					<tbody>
						{table.cells.map((row, at) => (
							<tr key={at}>
								{row.map((value, column) => (
									<td key={column} data-numeric={table.numeric[column]}>
										<Text size="label" numeric={table.numeric[column]}>
											{text(value)}
										</Text>
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</Scroller>
			{!table.cells.length && (
				<Text size="label" tone="muted" role="status">
					{messages.empty}
				</Text>
			)}
		</div>
	);
}
export function Table({ props }: { props: Record<string, unknown> }) {
	return <DataTable table={tableData(props)} />;
}
