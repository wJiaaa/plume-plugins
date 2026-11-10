export const TWEAKS_MESSAGE = "plumePreviewTweaks";
export const TWEAK_SET_MESSAGE = "plumePreviewTweakSet";
export const MAX_TWEAK_GROUPS = 12;
export const MAX_TWEAK_CONTROLS = 12;
const MAX_TWEAK_OPTIONS = 12;

export type TweakValue = number | string | boolean;
export type TweakControl = { id: string; label: string; value: TweakValue } & (
	| { kind: "slider"; min: number; max: number; step: number; unit: string }
	| { kind: "color" }
	| { kind: "toggle" }
	| { kind: "select"; options: { label: string; value: string }[] }
);
export interface TweakGroup {
	label: string;
	controls: TweakControl[];
}

const HEX = /^#[0-9a-f]{6}$/i;
const short = (value: unknown, fallback = "") => (typeof value === "string" || typeof value === "number" ? String(value).slice(0, 80) : fallback);

export function tweakValue(control: TweakControl, value: unknown): TweakValue | null {
	switch (control.kind) {
		case "slider": {
			if (typeof value !== "number" || !Number.isFinite(value)) return null;
			const stepped = control.min + Math.round((value - control.min) / control.step) * control.step;
			return Math.min(control.max, Math.max(control.min, Number(stepped.toFixed(6))));
		}
		case "color":
			return typeof value === "string" && HEX.test(value) ? value.toLowerCase() : null;
		case "toggle":
			return typeof value === "boolean" ? value : null;
		case "select":
			return typeof value === "string" && control.options.some((option) => option.value === value) ? value : null;
	}
}

function readControl(raw: unknown): TweakControl | null {
	if (typeof raw !== "object" || raw === null) return null;
	const record = raw as Record<string, unknown>;
	if (typeof record.id !== "string" || !/^\d{1,2}\.\d{1,2}$/.test(record.id)) return null;
	const base = { id: record.id, label: short(record.label, record.id), value: false as TweakValue };
	let control: TweakControl;
	if (record.kind === "slider") {
		const min = Number(record.min ?? 0),
			max = Number(record.max ?? 100),
			step = Number(record.step ?? 1);
		if (![min, max, step].every(Number.isFinite) || max <= min || step <= 0) return null;
		control = { ...base, kind: "slider", min, max, step, unit: short(record.unit) };
	} else if (record.kind === "color" || record.kind === "toggle") control = { ...base, kind: record.kind };
	else if (record.kind === "select" && Array.isArray(record.options)) {
		const options = record.options.slice(0, MAX_TWEAK_OPTIONS).map((option: unknown) => {
			const item = typeof option === "object" && option !== null ? (option as Record<string, unknown>) : { value: option };
			return { label: short(item.label ?? item.value), value: short(item.value) };
		});
		if (!options.length) return null;
		control = { ...base, kind: "select", options };
	} else return null;
	const value = tweakValue(control, record.value);
	return value === null ? null : { ...control, value };
}

export function readTweaks(data: unknown): TweakGroup[] | null {
	if (typeof data !== "object" || data === null) return null;
	const raw = (data as Record<string, unknown>)[TWEAKS_MESSAGE];
	if (!Array.isArray(raw)) return null;
	return raw.slice(0, MAX_TWEAK_GROUPS).flatMap((group: unknown) => {
		if (typeof group !== "object" || group === null) return [];
		const record = group as Record<string, unknown>;
		const controls = (Array.isArray(record.controls) ? record.controls : [])
			.slice(0, MAX_TWEAK_CONTROLS)
			.map(readControl)
			.filter((control): control is TweakControl => control !== null);
		return controls.length ? [{ label: short(record.label), controls }] : [];
	});
}
