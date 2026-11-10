/**
 * 设置 › 智能体 › 会话里的一行：后台总结项目记忆用哪个模型。名字和说明由宿主画，这里只画右边的下拉。
 * 它不在哪个会话里跑，没选时用的是新会话的默认模型，不是「主会话」的。
 */

import type { Remote, UiContext } from "@plume/contract/ui";
import { useI18n } from "@plume/ui";
import { useEffect, useState } from "react";
import type { MemoryApi } from "./api.ts";
import { MESSAGES } from "./messages.ts";

export function MemoryModel({ ui, api }: { ui: UiContext; api: Remote<MemoryApi> }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const defaults = ui.useModelDefaults();
	const [model, setModel] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState(true);
	useEffect(() => {
		let alive = true;
		void api
			.model()
			.then(
				(value: string | undefined) => {
					if (alive) setModel(value);
				},
				(error: unknown) => ui.notify(error instanceof Error ? error.message : String(error), "error"),
			)
			.finally(() => {
				if (alive) setBusy(false);
			});
		return () => {
			alive = false;
		};
	}, [api, ui]);
	return (
		<ui.ModelSelect
			ariaLabel={text.modelTitle}
			value={model ?? ""}
			disabled={busy}
			inheritLabel={text.followDefault}
			{...(defaults.defaultModel ? { inheritedModelId: defaults.defaultModel } : {})}
			inheritedSource={text.byDefault}
			inheritDetail={text.modelDetail}
			onChange={(next) => {
				const previous = model;
				setModel(next || undefined);
				void api.setModel(next || undefined).catch((error: unknown) => {
					setModel(previous);
					ui.notify(error instanceof Error ? error.message : String(error), "error");
				});
			}}
		/>
	);
}
