import { useEffect, useRef, useState, type ReactNode } from "react";
import { Text, useI18n } from "@plume/ui";
import { draftPhase, draftSize, type DraftDocument } from "./draft.ts";
import { morph } from "./morph.ts";
import { previewTheme } from "./theme.ts";
import { MESSAGES } from "./messages.ts";
import { MAX_HEIGHT } from "./types.ts";

// 草稿只有静态内容，既不执行半截脚本，也不向网络加载资源。
const SHELL = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; base-uri 'none'; form-action 'none'"><style id="base"></style><style id="page"></style></head><body></body></html>`;

export function Draft({
	page,
	fallback,
	complete,
	checked,
	onHeight,
}: {
	page: DraftDocument;
	fallback: ReactNode;
	complete: boolean;
	checked: boolean;
	onHeight(height: number): void;
}) {
	const words = MESSAGES[useI18n().resolvedLocale];
	const frame = useRef<HTMLIFrameElement>(null);
	const latest = useRef(page);
	latest.current = page;
	const [loaded, setLoaded] = useState(false);
	const [shown, setShown] = useState(false);
	const [height, setHeight] = useState(160);
	useEffect(() => {
		if (!loaded) return;
		const wear = () => {
			const sheet = frame.current?.contentDocument?.getElementById("base");
			if (!sheet) return;
			const theme = previewTheme();
			sheet.textContent = `:root{color-scheme:${theme.scheme};${Object.entries(theme.vars)
				.map(([k, v]) => `${k}:${v};`)
				.join(
					"",
				)}}html{color:var(--foreground);font-family:var(--font-sans);font-size:var(--font-size);line-height:1.5}body{margin:0}html,body{overflow:hidden}code,pre{font-family:var(--font-mono)}`;
		};
		wear();
		const observer = new MutationObserver(wear);
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
		const media = matchMedia("(prefers-color-scheme: dark)");
		media.addEventListener("change", wear);
		return () => {
			observer.disconnect();
			media.removeEventListener("change", wear);
		};
	}, [loaded]);
	useEffect(() => {
		if (!loaded) return;
		let previous = "";
		const draw = () => {
			const target = frame.current?.contentDocument;
			const { html, css } = latest.current;
			const signature = html + css.join("\n");
			if (!target || signature === previous) return;
			previous = signature;
			const Parser = (target.defaultView as Window & typeof globalThis).DOMParser;
			const parsed = new Parser().parseFromString(html.replace(/<[^>]*$/, ""), "text/html");
			const sheet = target.getElementById("page");
			if (sheet) sheet.textContent = [...css, ...Array.from(parsed.querySelectorAll("style"), (s) => s.textContent)].join("\n");
			for (const node of parsed.body.querySelectorAll("style,script,link,meta,title,iframe,object,embed,base")) node.remove();
			morph(target.body, parsed.body);
			for (const name of ["class", "lang", "dir"]) {
				const value = parsed.documentElement.getAttribute(name);
				if (value === null) target.documentElement.removeAttribute(name);
				else target.documentElement.setAttribute(name, value);
			}
			setShown((was) => was || (draftPhase(html) !== "styles" && (parsed.body.children.length > 0 || !!parsed.body.textContent?.trim())));
			setHeight((was) => Math.max(was, Math.min(MAX_HEIGHT, target.documentElement.scrollHeight)));
		};
		draw();
		if (complete) return;
		const timer = setInterval(draw, 120);
		return () => clearInterval(timer);
	}, [loaded, complete]);
	useEffect(() => onHeight(height), [height, onHeight]);
	const status = `${words[checked ? "waiting" : complete ? "checking" : draftPhase(page.html)]} · ${draftSize(page)}`;
	return (
		<div className="preview-draft" data-preview-draft={shown ? "page" : "placeholder"} aria-busy="true">
			{!shown && fallback}
			<div className="preview-draft-surface" style={{ height: shown ? height : 0 }}>
				<iframe ref={frame} srcDoc={SHELL} sandbox="allow-same-origin" title={status} tabIndex={-1} onLoad={() => setLoaded(true)} style={{ height }} />
				{shown && (
					<Text className="preview-draft-status" size="caption" tone="muted" role="status">
						{status}
					</Text>
				)}
			</div>
		</div>
	);
}
