/**
 * 一条记忆下面那一行：谁写的、什么时候写的、最后一次进提示词是什么时候。
 *
 * 第三件最容易漏：写下以后从没进过提示词的还不算记忆；几个月没进过的，它说的东西多半已经不在了。光看文字看不出这两件事。
 */

import { relativeTime, Text, useI18n } from "@plume/ui";
import type { MemorySource } from "./api.ts";
import { MESSAGES } from "./messages.ts";

export function MemoryMeta({
	source,
	createdAt,
	lastInjectedAt,
	now = Date.now(),
}: {
	source: MemorySource;
	createdAt: number;
	lastInjectedAt?: number;
	now?: number;
}) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const when = (at: number) => relativeTime(new Date(at).toISOString(), now);
	return (
		<Text size="caption" tone="faint" className="memory-meta" data-memory-meta="">
			<span data-memory-source="">{text.source[source]}</span>
			<span className="memory-meta-dot">·</span>
			<span>{text.writtenAt(when(createdAt))}</span>
			<span className="memory-meta-dot">·</span>
			{lastInjectedAt === undefined ? (
				<span data-memory-injected="never">{text.neverUsed}</span>
			) : (
				<span data-memory-injected="at">{text.injectedAt(when(lastInjectedAt))}</span>
			)}
		</Text>
	);
}
