/**
 * 图下面：说要怎么改，连同这张图发到它所在的对话。
 *
 * 话说不清的时候先标注——圈出帽子、画个箭头指到该放的地方。笔打开看图器直接进标注，标完的副本作为一张小图
 * 停在输入框里等着发，发出去改的就是这份副本而不是原图。
 */

import type { UiContext } from "@plume/contract/ui";
import { composingKey, IconButton, Input, Text, Tooltip, useI18n } from "@plume/ui";
import { PenLine, X } from "@plume/ui/icons";
import { type MouseEvent, useState } from "react";
import { GALLERY_MESSAGES as MESSAGES } from "../messages.ts";

export function EditBar({
	ui,
	marked,
	running,
	onAnnotate,
	onUnmark,
	onSend,
	onStop,
}: {
	ui: UiContext;
	/** 等着发的标注副本，`data:` URL。 */
	marked: string | null;
	running: boolean;
	onAnnotate: () => void;
	onUnmark: () => void;
	/** 什么都没发出去时得到 false，字留着再试一次。 */
	onSend: (words: string) => Promise<boolean>;
	onStop: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
	const { resolvedLocale } = useI18n();
	const m = MESSAGES[resolvedLocale];
	const [words, setWords] = useState("");
	const [sending, setSending] = useState(false);
	// 光有标注也是一个要求：带着标注副本打开对话，到那里再补一句。
	const ready = (Boolean(words.trim()) || Boolean(marked)) && !sending;

	const send = async () => {
		if (!ready) return;
		setSending(true);
		try {
			if (await onSend(words)) setWords("");
		} finally {
			setSending(false);
		}
	};

	return (
		<form
			data-image-gallery-edit=""
			className="image-gallery-edit"
			onSubmit={(event) => {
				event.preventDefault();
				void send();
			}}
		>
			<IconButton data-image-gallery-annotate="" label={m.annotate} tipSide="top" icon={<PenLine size={16} strokeWidth={1.8} />} onClick={onAnnotate} />
			{marked && (
				<span data-image-gallery-marked="" className="image-gallery-marked">
					<img src={marked} alt={m.marked} />
					<Tooltip label={m.unmark} side="top">
						<button type="button" aria-label={m.unmark} onClick={onUnmark} className="image-gallery-unmark">
							<X size={10} strokeWidth={2.4} />
						</button>
					</Tooltip>
				</span>
			)}
			{/* 原生输入框跟着外面这层 Text 的字号走。 */}
			<Text size="body" className="image-gallery-words">
				<Input
					data-image-gallery-words=""
					value={words}
					onChange={(event) => setWords(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Escape") event.currentTarget.blur();
						// 页面上 ← → 是翻图；在输入框里是挪光标。
						if (event.key === "ArrowLeft" || event.key === "ArrowRight") event.stopPropagation();
						/*
						 * 回车自己接，不交给表单的隐式提交：输入法上屏用的也是这个回车，组字时这个键归输入法。
						 */
						if (event.key === "Enter") {
							event.preventDefault();
							if (!composingKey(event.nativeEvent)) void send();
						}
					}}
					placeholder={marked ? m.editMarkedPlaceholder : m.editPlaceholder}
				/>
			</Text>
			{/* 按钮跟主输入框一样停止当前轮；运行中按回车仍把这句话排到后面。 */}
			<span data-image-gallery-send="" className="image-gallery-send">
				<ui.ComposerSend running={running} disabled={!ready} tip={m.send} onSend={() => void send()} onStop={onStop} />
			</span>
		</form>
	);
}
