import type { ComposerItemProps, PanelProps, UiPlugin } from "@plume/contract/ui";
import { IconButton, useI18n } from "@plume/ui";
import { Palette } from "@plume/ui/icons";
import type { SkinStudioApi } from "./api.ts";
import { MESSAGES } from "./messages.ts";
import { StudioPanel } from "./StudioPanel.tsx";
import studioCss from "./studio.css";
import { createStudioStore } from "./ui-store.ts";

function mountStyles(): void {
	const id = "plume.skin-studio";
	let style = document.querySelector<HTMLStyleElement>(`style[data-plugin-style="${id}"]`);
	if (!style) {
		style = document.createElement("style");
		style.dataset.pluginStyle = id;
		document.head.append(style);
	}
	style.textContent = studioCss;
}

export default {
	name: "plume.skin-studio",
	apply(ui) {
		mountStyles();
		const api = ui.remote<SkinStudioApi>();
		const store = createStudioStore(ui, api);
		ui.effect(store.dispose);

		function Panel({ session }: PanelProps) {
			return <StudioPanel ui={ui} api={api} store={store} sessionId={session?.summary.id} />;
		}
		function ComposerButton({ sessionId }: ComposerItemProps) {
			const text = MESSAGES[useI18n().resolvedLocale];
			return <IconButton label={text.title} icon={<Palette size={16} />} size="composer" emphasis onClick={() => ui.openPanel("studio", sessionId)} />;
		}

		ui.panel("studio", Panel, {
			title: (locale) => MESSAGES[locale].title,
			description: (locale) => MESSAGES[locale].description,
			icon: Palette,
		});
		ui.composerItem("studio", ComposerButton);
		ui.toolLine("skin_studio_theme", {
			verb: (locale) => MESSAGES[locale].toolVerb,
			subject: (args) => (typeof args.name === "string" ? args.name : typeof args.id === "string" ? args.id : undefined),
			icon: Palette,
		});
		store.start();
	},
} satisfies UiPlugin;
