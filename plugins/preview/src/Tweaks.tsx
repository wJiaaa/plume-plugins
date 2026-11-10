import { useState, type ReactNode } from "react";
import type { ToolCardProps } from "@plume/contract/ui";
import { Button, ColorField, Select, Slider, Text, Toggle, useI18n } from "@plume/ui";
import { Check, Eye, RotateCcw } from "@plume/ui/icons";
import type { TweakControl, TweakValue } from "./tweaks.ts";
import { tweakMessage, type usePreviewTweaks } from "./useTweaks.ts";
import { MESSAGES } from "./messages.ts";

function Field({ label, aside, children }: { label: string; aside?: ReactNode; children: ReactNode }) {
	return (
		<div className="preview-tweak-field">
			<Text className="preview-tweak-label" size="caption" tone="muted">
				<span>{label}</span>
				{aside}
			</Text>
			{children}
		</div>
	);
}
function Control({ control: c, value, onChange }: { control: TweakControl; value: TweakValue; onChange(value: unknown): void }) {
	switch (c.kind) {
		case "slider":
			return (
				<Field label={c.label} aside={<span>{`${value}${c.unit}`}</span>}>
					<div className="preview-slider">
						<Slider value={Number(value)} min={c.min} max={c.max} step={c.step} width="100%" label={c.label} onChange={onChange} />
					</div>
				</Field>
			);
		case "color":
			return (
				<Field label={c.label}>
					<div className="preview-color">
						<ColorField value={String(value)} label={c.label} onChange={onChange} />
					</div>
				</Field>
			);
		case "toggle":
			return (
				<Field label={c.label}>
					<div className="preview-toggle">
						<Toggle checked={value === true} ariaLabel={c.label} onChange={onChange} />
					</div>
				</Field>
			);
		case "select":
			return (
				<Field label={c.label}>
					<Select value={String(value)} options={c.options} ariaLabel={c.label} onChange={onChange} />
				</Field>
			);
	}
}
export function Tweaks({
	tweaks,
	title,
	send,
	onError,
}: {
	tweaks: ReturnType<typeof usePreviewTweaks>;
	title: string;
	send?: ToolCardProps["send"];
	onError(): void;
}) {
	const locale = useI18n().resolvedLocale;
	const words = MESSAGES[locale];
	const [peeking, setPeeking] = useState(false);
	const [sent, setSent] = useState("");
	const [sending, setSending] = useState(false);
	const signature = JSON.stringify(tweaks.changes);
	const peek = (on: boolean) => {
		setPeeking(on);
		tweaks.peek(on);
	};
	const changed = tweaks.changes.length > 0;
	return (
		<section className="preview-tweaks" aria-label={words.tweak}>
			{tweaks.groups.map((group, index) => (
				<div className="preview-tweak-group" key={index}>
					{(group.label || tweaks.groups.length > 1) && (
						<Text as="h3" size="label">
							{group.label}
						</Text>
					)}
					<div className="preview-tweak-grid">
						{group.controls.map((control) => (
							<Control
								key={control.id}
								control={control}
								value={tweaks.current(control)}
								onChange={(value) => {
									if (peeking) peek(false);
									setSent("");
									tweaks.set(control, value);
								}}
							/>
						))}
					</div>
				</div>
			))}
			<div className="preview-tweak-actions">
				<Button
					size="sm"
					icon={<RotateCcw size={13} />}
					disabled={!changed}
					onClick={() => {
						if (peeking) peek(false);
						tweaks.reset();
						setSent("");
					}}
				>
					{words.reset}
				</Button>
				<Button size="sm" icon={<Eye size={13} />} disabled={!changed} pressed={peeking} onClick={() => peek(!peeking)}>
					{words.original}
				</Button>
				{send &&
					(sent === signature ? (
						<Text className="preview-sent" size="label" tone="muted">
							<Check size={13} />
							{words.sent}
						</Text>
					) : (
						<Button
							size="sm"
							variant="primary"
							disabled={!changed}
							loading={sending}
							onClick={(event) => {
								if (peeking) peek(false);
								setSending(true);
								const message = tweakMessage(title, tweaks.changes, locale);
								void send(message.spoken, event, message.text)
									.then(() => setSent(signature), onError)
									.finally(() => setSending(false));
							}}
						>
							{words.sendChanges}
						</Button>
					))}
			</div>
		</section>
	);
}
