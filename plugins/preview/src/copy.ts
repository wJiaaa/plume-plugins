/** 分片截取当前 iframe，避免重载丢失交互；等待跨进程绘制后再截下一片。 */
import { useEffect, useRef, useState, type RefObject } from "react";
import type { UiContext } from "@plume/contract/ui";

const CONFIRM_MS = 1400;
const RELAYOUT_MS = 120;
const MAX_CANVAS = 32767;

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function visibleRect(element: HTMLElement): DOMRect | null {
	let { left, top, right, bottom } = element.getBoundingClientRect();
	for (let node = element.parentElement; node; node = node.parentElement) {
		if (getComputedStyle(node).overflow === "visible") continue;
		const clip = node.getBoundingClientRect();
		left = Math.max(left, clip.left);
		top = Math.max(top, clip.top);
		right = Math.min(right, clip.right);
		bottom = Math.min(bottom, clip.bottom);
	}
	left = Math.ceil(Math.max(0, left));
	top = Math.ceil(Math.max(0, top));
	right = Math.floor(Math.min(right, window.innerWidth));
	bottom = Math.floor(Math.min(bottom, window.innerHeight));
	return right - left >= 1 && bottom - top >= 1 ? new DOMRect(left, top, right - left, bottom - top) : null;
}

function unmask(element: HTMLElement): () => void {
	const undo: (() => void)[] = [];
	for (let node = element.parentElement; node; node = node.parentElement) {
		const style = getComputedStyle(node);
		if (style.maskImage === "none" && style.webkitMaskImage === "none") continue;
		const { maskImage, webkitMaskImage } = node.style;
		node.style.maskImage = "none";
		node.style.webkitMaskImage = "none";
		const target = node;
		undo.push(() => {
			target.style.maskImage = maskImage;
			target.style.webkitMaskImage = webkitMaskImage;
		});
	}
	return () => {
		for (const step of undo) step();
	};
}

function load(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = reject;
		image.src = src;
	});
}

export function usePreviewCopy(frame: RefObject<HTMLIFrameElement | null>, whole: RefObject<number>, ui: UiContext, failed: string) {
	const [capturing, setCapturing] = useState(false);
	const busy = useRef(false);
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);

	async function slices(element: HTMLIFrameElement): Promise<string | null> {
		const box = element.getBoundingClientRect();
		const view = visibleRect(element);
		const anchor = element.parentElement!;
		const position = anchor.getBoundingClientRect();
		if (!view) return null;
		const height = Math.max(Math.round(box.height), Math.ceil(whole.current));
		if (height * devicePixelRatio > MAX_CANVAS) throw new Error("Page exceeds canvas limit");
		if (height > box.height) {
			element.style.height = `${height}px`;
			await pause(RELAYOUT_MS);
		}
		const shots: string[] = [];
		for (let y = 0; y < height; y += view.height) {
			element.style.transform = `translateY(${view.top - box.top - y}px)`;

			await nextFrame();
			await nextFrame();
			const now = anchor.getBoundingClientRect();
			if (!element.isConnected || frame.current !== element || (["x", "y", "width", "height"] as const).some((key) => Math.abs(now[key] - position[key]) > 1))
				return null;
			const shot = await ui.captureWindow({ x: view.x, y: view.y, width: view.width, height: Math.min(view.height, height - y) });
			if (!shot) return null;
			shots.push(shot);
		}
		if (shots.length === 1) return shots[0]!;
		const images = await Promise.all(shots.map(load));

		const scale = images[0]!.naturalWidth / view.width;
		const canvas = document.createElement("canvas");
		canvas.width = images[0]!.naturalWidth;
		canvas.height = Math.round(height * scale);
		const context = canvas.getContext("2d");
		if (!context) return null;
		images.forEach((image, index) => context.drawImage(image, 0, Math.round(index * view.height * scale)));
		return canvas.toDataURL("image/png");
	}

	async function copy() {
		const element = frame.current;
		if (!element || busy.current) return;
		busy.current = true;
		setCapturing(true);
		const restore = unmask(element);
		let image: string | null = null;
		try {
			await nextFrame();
			await nextFrame();
			image = await slices(element);
		} catch {
			image = null;
		} finally {
			element.style.height = "";
			element.style.transform = "";
			restore();
			setCapturing(false);
			busy.current = false;
		}
		let done = false;
		if (image) {
			try {
				// 这里必须确认写进剪贴板；通用 copyImage 的另存回退不能显示为「已复制」。
				const bytes = Uint8Array.from(atob(image.slice(image.indexOf(",") + 1)), (c) => c.charCodeAt(0));
				await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([bytes], { type: "image/png" }) })]);
				done = true;
			} catch {
				/* 下方统一提示失败。 */
			}
		}
		if (!done) {
			ui.notify(failed, "error");
			return;
		}
		setCopied(true);
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setCopied(false), CONFIRM_MS);
	}

	return { capturing, copied, copy };
}
