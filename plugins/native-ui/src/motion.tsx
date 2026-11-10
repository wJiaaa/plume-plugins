import { motionReduced } from "@plume/ui";
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

/** 流式整块到达时缓动高度，避免转录底部被一帧推下去；结束后恢复内容自身高度。 */
export function Growing({ active, children }: { active: boolean; children: ReactNode }) {
	const inner = useRef<HTMLDivElement>(null);
	const [height, setHeight] = useState<number>();
	useLayoutEffect(() => {
		if (!active || !inner.current) {
			setHeight(undefined);
			return;
		}
		const element = inner.current;
		const measure = () => setHeight(element.getBoundingClientRect().height);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [active]);
	return (
		<div className="native-ui-growing" data-writing={active} style={active && height !== undefined ? { height } : undefined}>
			<div ref={inner}>{children}</div>
		</div>
	);
}

const PENDING_HEIGHT: Record<string, number> = {
	Text: 28,
	Heading: 28,
	Stat: 72,
	Table: 130,
	Chart: 200,
	Input: 62,
	Select: 62,
	Choice: 62,
	Toggle: 34,
	Button: 32,
};
export function Pending({ name }: { name: string }) {
	const height = Object.hasOwn(PENDING_HEIGHT, name) ? PENDING_HEIGHT[name] : undefined;
	if (!height) return null;
	return (
		<div className="native-ui-pending" data-native-ui-pending={name} style={{ height }} aria-hidden>
			<i />
			<i />
			<i />
			<i />
			<span />
		</div>
	);
}

/** 到达时在旁层描出真实几何，不给控件加包装，避免破坏网格布局或丢失焦点。 */
export function useArrivals(drawing: RefObject<HTMLElement | null>, layer: RefObject<HTMLElement | null>, active: boolean) {
	useLayoutEffect(() => {
		const root = drawing.current;
		const effects = layer.current;
		if (!active || !root || !effects) return;
		const animations = new Set<Animation>();
		const added = new Set<Element>();
		const style = getComputedStyle(root);
		const base = parseFloat(style.getPropertyValue("--plume-t-base"));
		const slow = parseFloat(style.getPropertyValue("--plume-t-slow"));
		const easing = style.getPropertyValue("--plume-e-out").trim();
		const animate = (element: Element, frames: Keyframe[], options: KeyframeAnimationOptions) => {
			const animation = element.animate(frames, options);
			animations.add(animation);
			void animation.finished.then(
				() => animations.delete(animation),
				() => animations.delete(animation),
			);
			return animation;
		};
		const reveal = (node: HTMLElement, traced: boolean) => {
			const box = node.getBoundingClientRect();
			const origin = effects.getBoundingClientRect();
			if (!box.width || !box.height) return;
			const duration = Math.min(slow * 2, base + box.height * 0.8);
			const delay = traced ? slow : 0;
			animate(node, [{ clipPath: "inset(0 0 100% 0)" }, { clipPath: "inset(0 0 0 0)" }], { duration, delay, easing, fill: "backwards" });
			const cover = document.createElement("div");
			cover.className = "native-ui-fade";
			Object.assign(cover.style, { left: `${box.left - origin.left}px`, top: `${box.top - origin.top}px`, width: `${box.width}px`, height: `${box.height}px` });
			effects.append(cover);
			added.add(cover);
			if (traced) {
				const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
				svg.setAttribute("width", String(box.width));
				svg.setAttribute("height", String(box.height));
				cover.append(svg);
				const shapes = [...node.querySelectorAll("th, td, svg rect, svg polyline, svg line")].filter((item) => item.getAttribute("fill") !== "transparent");
				for (const shape of [node, ...shapes]) {
					const bounds = shape.getBoundingClientRect();
					const outline = document.createElementNS("http://www.w3.org/2000/svg", "rect");
					for (const [key, value] of Object.entries({
						x: bounds.left - box.left,
						y: bounds.top - box.top,
						width: Math.max(1, bounds.width),
						height: Math.max(1, bounds.height),
						pathLength: 1,
					}))
						outline.setAttribute(key, String(value));
					outline.setAttribute("class", "native-ui-trace");
					svg.append(outline);
					animate(outline, [{ strokeDashoffset: "1" }, { strokeDashoffset: "0" }], { duration: slow, easing, fill: "both" });
				}
			}
			const line = document.createElement("div");
			line.className = "native-ui-scan";
			Object.assign(line.style, { left: `${box.left - origin.left}px`, top: `${box.top - origin.top}px`, width: `${box.width}px` });
			effects.append(line);
			added.add(line);
			animate(
				line,
				[
					{ top: `${box.top - origin.top}px`, opacity: 1 },
					{ top: `${box.bottom - origin.top}px`, opacity: 0 },
				],
				{ duration, delay, easing, fill: "both" },
			);
			void animate(cover, [{ clipPath: "inset(0 0 0 0)" }, { clipPath: "inset(100% 0 0 0)" }], { duration, delay, easing, fill: "forwards" }).finished.then(
				() => {
					cover.remove();
					line.remove();
					added.delete(cover);
					added.delete(line);
				},
				() => {},
			);
		};
		const observer = new MutationObserver((records) => {
			if (motionReduced()) return;
			const handed = new Map<Node, string>();
			for (const record of records)
				for (const node of record.removedNodes)
					if (node instanceof HTMLElement && node.dataset.nativeUiPending) handed.set(record.target, node.dataset.nativeUiPending);
			for (const record of records)
				for (const node of record.addedNodes) {
					if (!(node instanceof HTMLElement) || node.dataset.nativeUiPending || node.closest(".native-ui-pending")) continue;
					const name = handed.get(record.target);
					reveal(node, name === "Chart" || name === "Table");
				}
		});
		observer.observe(root, { childList: true, subtree: true });
		return () => {
			observer.disconnect();
			animations.forEach((animation) => animation.cancel());
			added.forEach((element) => element.remove());
		};
	}, [drawing, layer, active]);
}
