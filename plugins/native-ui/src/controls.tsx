import { Button, Input, Segmented, Select, Slider, Text, Toggle } from "@plume/ui";
import { optionsOf } from "./data.ts";
import { text } from "./expression.ts";
import type { Values } from "./language.ts";

export function Field({
	kind,
	props,
	values,
	disabled,
	change,
}: {
	kind: string;
	props: Values;
	values: Values;
	disabled: boolean;
	change: (values: Values) => void;
}) {
	const name = props.name as string;
	const label = (props.label as string | undefined) ?? name;
	const value = values[name];
	const set = (value: unknown) => {
		if (!disabled) change({ [name]: value });
	};
	if (kind === "Toggle")
		return (
			<div className="native-ui-toggle" data-native-ui-field={name}>
				<Text size="label">{label}</Text>
				<Toggle ariaLabel={label} checked={value === true} disabled={disabled} onChange={set} />
			</div>
		);
	if (kind === "Slider")
		return (
			<div className="native-ui-field" data-native-ui-field={name}>
				<div className="native-ui-row" data-align="between">
					<Text size="caption" tone="muted">
						{label}
					</Text>
					<Text size="caption" numeric>{`${value}${props.unit ?? ""}`}</Text>
				</div>
				<div inert={disabled || undefined} aria-disabled={disabled || undefined} className="native-ui-slider">
					<Slider
						label={label}
						value={value as number}
						min={(props.min as number | undefined) ?? 0}
						max={(props.max as number | undefined) ?? 100}
						step={(props.step as number | undefined) ?? 1}
						width="100%"
						onChange={set}
					/>
				</div>
			</div>
		);
	return (
		<div className="native-ui-field" data-native-ui-field={name}>
			<Text size="caption" tone="muted">
				{label}
			</Text>
			{kind === "Input" ? (
				<Text as="div" size="label">
					<Input
						name={name}
						aria-label={label}
						className="plume-field native-ui-input"
						type="text"
						inputMode={props.type === "number" ? "decimal" : undefined}
						placeholder={props.placeholder as string | undefined}
						value={text(value)}
						disabled={disabled}
						onChange={(event) => {
							const next = event.currentTarget.value;
							const number = Number(next);
							set(props.type === "number" && next.trim() !== "" && Number.isFinite(number) ? number : next);
						}}
					/>
				</Text>
			) : (
				<Options kind={kind} name={name} label={label} value={value} props={props} disabled={disabled} set={set} />
			)}
		</div>
	);
}

function Options({
	kind,
	name,
	label,
	value,
	props,
	disabled,
	set,
}: {
	kind: string;
	name: string;
	label: string;
	value: unknown;
	props: Values;
	disabled: boolean;
	set: (value: unknown) => void;
}) {
	const options = optionsOf(props.options);
	const pick = (value: string) => {
		const option = options.find((option) => option.value === value);
		if (option) set(option.original);
	};
	if (kind === "Select")
		return (
			<div inert={disabled || undefined} aria-disabled={disabled || undefined} className="native-ui-select">
				<Select ariaLabel={label} value={text(value)} options={options} onChange={pick} />
			</div>
		);
	if (!props.multiple)
		return (
			<div
				inert={disabled || undefined}
				aria-disabled={disabled || undefined}
				className="native-ui-choice"
				data-native-ui-choice={name}
				role="group"
				aria-label={label}
			>
				<Segmented value={text(value)} options={options} onChange={pick} />
			</div>
		);
	const picked = Array.isArray(value) ? value : [];
	return (
		<div className="native-ui-row" data-gap="sm" role="group" aria-label={label}>
			{options.map((option) => (
				<Button
					key={option.value}
					pressed={picked.includes(option.original)}
					disabled={disabled}
					data-native-ui-option={option.value}
					onClick={() =>
						set(
							picked.includes(option.original)
								? picked.filter((item) => item !== option.original)
								: options.filter((item) => item.original === option.original || picked.includes(item.original)).map((item) => item.original),
						)
					}
				>
					{option.label}
				</Button>
			))}
		</div>
	);
}
