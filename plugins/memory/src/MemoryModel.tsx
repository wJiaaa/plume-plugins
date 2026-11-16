/**
 * 设置 › 智能体 › 会话里的一行：后台总结项目记忆用哪个模型。名字和说明由宿主画，这里只画右边的下拉。
 * 它不在哪个会话里跑，没选时用的是新会话的默认模型，不是「主会话」的。
 */

import type { UiContext } from "@plume/contract/ui";
import { useI18n } from "@plume/ui";
import type { MemorySettings } from "./api.ts";
import { MESSAGES } from "./messages.ts";

export function MemoryModel({ ui }: { ui: UiContext }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const defaults = ui.useModelDefaults();
	const [settings, set] = ui.useSettings<MemorySettings>();
	return (
		<ui.ModelSelect
			ariaLabel={text.modelTitle}
			value={settings?.model ?? ""}
			disabled={settings === undefined}
			inheritLabel={text.followDefault}
			{...(defaults.defaultModel ? { inheritedModelId: defaults.defaultModel } : {})}
			inheritedSource={text.byDefault}
			inheritDetail={text.modelDetail}
			onChange={(next) =>
				void set({ model: next || undefined }).catch((error: unknown) => ui.notify(error instanceof Error ? error.message : String(error), "error"))
			}
		/>
	);
}
