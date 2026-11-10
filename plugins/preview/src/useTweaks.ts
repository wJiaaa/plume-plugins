import { useEffect, useRef, useState, type RefObject } from "react";
import type { Locale } from "@plume/contract";
import { MESSAGES } from "./messages.ts";
import { readTweaks, tweakValue, TWEAK_SET_MESSAGE, type TweakControl, type TweakGroup, type TweakValue } from "./tweaks.ts";

export interface TweakChange {
	group: string;
	control: TweakControl;
	from: TweakValue;
	to: TweakValue;
}

export function usePreviewTweaks(frame: RefObject<HTMLIFrameElement | null>, run: number) {
	const [groups, setGroups] = useState<TweakGroup[]>([]);
	const [values, setValues] = useState<Record<string, TweakValue>>({});
	const originals = useRef(new Map<string, TweakValue>());

	useEffect(() => {
		originals.current = new Map();
		setGroups([]);
		setValues({});
		function onMessage(event: MessageEvent) {
			if (event.source !== frame.current?.contentWindow) return;
			const offered = readTweaks(event.data);
			if (!offered) return;
			for (const control of offered.flatMap((group) => group.controls))
				if (!originals.current.has(control.id)) originals.current.set(control.id, control.value);
			setGroups(offered);
		}
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [frame, run]);

	const controls = groups.flatMap((group) => group.controls.map((control) => ({ group: group.label, control })));
	const original = (control: TweakControl) => originals.current.get(control.id) ?? control.value;
	const current = (control: TweakControl) => values[control.id] ?? original(control);
	const changes: TweakChange[] = controls
		.filter(({ control }) => control.id in values && values[control.id] !== original(control))
		.map(({ group, control }) => ({ group, control, from: original(control), to: values[control.id]! }));

	function post(entries: { id: string; value: TweakValue }[]) {
		if (entries.length) frame.current?.contentWindow?.postMessage({ [TWEAK_SET_MESSAGE]: entries }, "*");
	}

	return {
		groups,
		changes,
		current,
		set(control: TweakControl, next: unknown) {
			const value = tweakValue(control, next);
			if (value === null) return;
			setValues((now) => ({ ...now, [control.id]: value }));
			post([{ id: control.id, value }]);
		},
		reset() {
			post(changes.map(({ control, from }) => ({ id: control.id, value: from })));
			setValues({});
		},
		peek(original: boolean) {
			post(changes.map(({ control, from, to }) => ({ id: control.id, value: original ? from : to })));
		},
	};
}

function shown(control: TweakControl, value: TweakValue, locale: Locale): string {
	if (control.kind === "slider") return `${value}${control.unit}`;
	if (control.kind === "toggle") return MESSAGES[locale][value ? "on" : "off"];
	if (control.kind === "select") return control.options.find((option) => option.value === value)?.label ?? String(value);
	return String(value);
}

export function tweakMessage(title: string, changes: TweakChange[], locale: Locale): { text: string; spoken: string } {
	const text = `${MESSAGES[locale].adjusted}${changes.map(({ control, from, to }) => `${control.label} ${shown(control, from, locale)} → ${shown(control, to, locale)}`).join(MESSAGES[locale].joiner)}`;
	const settings = changes.map(({ group, control, from, to }) => ({
		...(group ? { group } : {}),
		control: control.label,
		from,
		to,
		...(control.kind === "slider" && control.unit ? { unit: control.unit } : {}),
	}));
	return {
		text,
		spoken: `${text}\n\nWrite these design settings into the page ${JSON.stringify(title)} and show it again:\n<design-settings>${JSON.stringify(settings).replace(/</g, "\\u003c")}</design-settings>`,
	};
}
