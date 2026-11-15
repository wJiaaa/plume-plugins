import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { PanelProps, ToolCardProps, UiPlugin } from "@plume/contract/ui";
import { Collapse, FlowRow, IconButton, Text, useI18n } from "@plume/ui";
import { AppWindow, Check, Copy, ChevronsDown, ExternalLink, Minimize2, RotateCw, SlidersHorizontal } from "@plume/ui/icons";
import type { PreviewApi } from "./api.ts";
import { MESSAGES } from "./messages.ts";
import { previewTheme } from "./theme.ts";
import { isPreview, MAX_HEIGHT, stateJson, type Preview } from "./types.ts";
import { Draft } from "./Draft.tsx";
import { draftArguments, draftDocument } from "./draft.ts";
import { inlineCall, placements } from "./placement.ts";
import { Tweaks } from "./Tweaks.tsx";
import { usePreviewTweaks } from "./useTweaks.ts";
import { usePreviewCopy } from "./copy.ts";
import { settleSize } from "./settle.ts";
import css from "./preview.css";

export default {
	name: "plume.preview",
	apply(ui) {
		const style = document.createElement("style");
		style.dataset.pluginStyle = ui.name;
		style.textContent = css;
		document.head.append(style);
		ui.effect(() => style.remove());
		const api = ui.remote<PreviewApi>();
		const publishTheme = () => {
			void api.appearance(previewTheme()).catch(() => {});
		};
		const changes = new MutationObserver(publishTheme);
		changes.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
		const media = matchMedia("(prefers-color-scheme: dark)");
		media.addEventListener("change", publishTheme);
		publishTheme();
		ui.effect(() => {
			changes.disconnect();
			media.removeEventListener("change", publishTheme);
		});

		/*
		 * 面板里正看着的页面（会话 id + 页面 id → 几个面板在显示）。对话里的同一页这时停在当前帧：两份一起动，
		 * 重画和合成的活就是两份，而人正看着的是面板那份。只认同一个渲染进程里的面板，弹到独立窗口的面板管不到，
		 * 对话里那份照常动。人点进对话里那份时它自己拿到焦点、照常动（见 bridge.ts 的 HOLD_FRAMES）。
		 */
		const inPanel = new Map<string, number>();
		const panelWatchers = new Set<() => void>();
		const pageKey = (sessionId: string, id: string) => `${sessionId}\n${id}`;
		const watchPanels = (notify: () => void) => {
			panelWatchers.add(notify);
			return () => panelWatchers.delete(notify);
		};
		const showInPanel = (key: string) => {
			inPanel.set(key, (inPanel.get(key) ?? 0) + 1);
			for (const notify of panelWatchers) notify();
			return () => {
				const left = (inPanel.get(key) ?? 1) - 1;
				if (left > 0) inPanel.set(key, left);
				else inPanel.delete(key);
				for (const notify of panelWatchers) notify();
			};
		};

		function Page({
			sessionId,
			id,
			initial,
			panel = false,
			visible = false,
			setTitle,
			send,
			onShown,
			startHeight,
		}: {
			sessionId: string;
			id: string;
			initial?: Preview;
			panel?: boolean;
			/** 面板：这个标签正显示着（`PanelProps.shown`）。 */
			visible?: boolean;
			setTitle?: PanelProps["setTitle"];
			send?: ToolCardProps["send"];
			onShown?: () => void;
			startHeight?: number;
		}) {
			const words = MESSAGES[useI18n().resolvedLocale];
			const frame = useRef<HTMLIFrameElement>(null);
			const surface = useRef<HTMLDivElement>(null);
			const key = pageKey(sessionId, id);
			useEffect(() => {
				if (panel && visible) return showInPanel(key);
			}, [panel, visible, key]);
			const mirrored = useSyncExternalStore(watchPanels, () => !panel && inPanel.has(key));
			const held = useRef(mirrored);
			held.current = mirrored;
			// iframe 的像素尺寸经 CSS 变量给（见 preview.css 的 .preview-frame），不放进 React 的 style：整页复制会临时改 iframe 的高度再清掉。
			useEffect(() => {
				const element = surface.current;
				if (!element) return;
				const fit = settleSize(({ width, height }) => {
					element.style.setProperty("--preview-frame-width", `${width}px`);
					element.style.setProperty("--preview-frame-height", `${height}px`);
				});
				const observer = new ResizeObserver(([entry]) => {
					if (entry) fit.update({ width: entry.contentRect.width, height: entry.contentRect.height });
				});
				observer.observe(element);
				return () => {
					observer.disconnect();
					fit.dispose();
				};
			}, []);
			const [preview, setPreview] = useState(initial);
			const [src, setSrc] = useState("");
			const [nonce, setNonce] = useState(0);
			const [ready, setReady] = useState(false);
			const [error, setError] = useState("");
			const [collapsed, setCollapsed] = useState(false);
			const [full, setFull] = useState(false);
			const [tuning, setTuning] = useState(false);
			const [height, setHeight] = useState(startHeight ?? initial?.height ?? 440);
			const whole = useRef(height);
			whole.current = height;
			const copy = usePreviewCopy(frame, whole, ui, words.copyFailed);
			const tweaks = usePreviewTweaks(frame, nonce);
			const sender = useRef(send);
			sender.current = send;
			const shown = useRef(onShown);
			shown.current = onShown;
			const stateSave = useRef<Promise<unknown>>(Promise.resolve());
			const survey = useRef({ width: 0, adjustments: 0, measured: false });
			useEffect(() => {
				let alive = true;
				setSrc("");
				setReady(false);
				setError("");
				survey.current = { width: 0, adjustments: 0, measured: false };
				void stateSave.current
					.catch(() => {})
					.then(() => api.open(sessionId, id))
					.then(
						(opened) => {
							if (!alive) return;
							setPreview(opened.preview);
							setTitle?.(opened.preview.title);
							const params = new URLSearchParams({ state: stateJson(opened.state) });
							if (!panel) params.set("inline", "");
							if (opened.preview.themed) params.set("theme", JSON.stringify(previewTheme()));
							setSrc(`${opened.url}#${params}`);
						},
						() => {
							if (alive) {
								setError(words.failed);
								shown.current?.();
							}
						},
					);
				return () => {
					alive = false;
				};
			}, [sessionId, id, nonce, panel, setTitle, words.failed]);
			useEffect(() => {
				const postTheme = () => {
					if (preview?.themed) frame.current?.contentWindow?.postMessage({ preview: "theme", value: previewTheme() }, "*");
				};
				const observer = new MutationObserver(postTheme);
				observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
				media.addEventListener("change", postTheme);
				const receive = (event: MessageEvent) => {
					if (event.source !== frame.current?.contentWindow || !event.data || typeof event.data !== "object") return;
					const data = event.data;
					if (
						!copy.capturing &&
						data.preview === "height" &&
						Number.isFinite(data.height) &&
						Number.isFinite(data.width) &&
						data.height > 0 &&
						data.width > 0
					) {
						const sample = survey.current;
						const resized = sample.width !== data.width;
						if (resized) {
							sample.width = data.width;
							sample.adjustments = 0;
						}
						setHeight((current) => {
							const next = Math.min(100_000, Math.max(preview?.themed ? 40 : 160, Math.round(data.height)));
							if (!sample.measured || resized || (sample.adjustments < 8 && next > current + 8)) {
								sample.measured = true;
								sample.adjustments++;
								return next;
							}
							return current;
						});
					} else if (data.preview === "state") {
						try {
							stateJson(data.value);
						} catch {
							return;
						}
						stateSave.current = stateSave.current.catch(() => {}).then(() => api.state(sessionId, id, data.value));
						void stateSave.current.catch(() => setError(words.saveFailed));
					} else if (data.preview === "send" && !panel && typeof data.text === "string" && data.text.trim() && data.text.length <= 2000) {
						if (sender.current) void sender.current(data.text.trim(), event).catch(() => ui.notify(words.sendFailed, "error"));
					} else if (data.preview === "error" && typeof data.message === "string") setError(data.message.slice(0, 1000));
					else if (
						data.preview === "open" &&
						typeof data.url === "string" &&
						/^https?:\/\//i.test(data.url) &&
						document.activeElement === frame.current &&
						navigator.userActivation.isActive
					) {
						void ui.openExternal(data.url).catch(() => ui.notify(words.failed, "error"));
					}
				};
				window.addEventListener("message", receive);
				return () => {
					observer.disconnect();
					media.removeEventListener("change", postTheme);
					window.removeEventListener("message", receive);
				};
			}, [sessionId, id, preview?.themed, words, panel, copy.capturing]);
			/*
			 * 页面该不该停在当前帧：这扇窗不在前台（见 bridge.ts 的 HOLD_FRAMES）。问 `hasFocus()` 而不看是哪个事件：
			 * 点进页面拖动时窗口也会 blur，可焦点还在这扇窗里。对话里的这份在面板里正显示着时也停（见 inPanel）。
			 */
			const postPause = useCallback(() => {
				frame.current?.contentWindow?.postMessage({ preview: "pause", value: !document.hasFocus() || held.current }, "*");
			}, []);
			useEffect(postPause, [mirrored, postPause]);
			useEffect(() => {
				window.addEventListener("blur", postPause);
				window.addEventListener("focus", postPause);
				return () => {
					window.removeEventListener("blur", postPause);
					window.removeEventListener("focus", postPause);
				};
			}, [postPause]);
			const rerun = () => {
				// 先撤下旧地址；只改状态片段不会重载文档，会让新页面仍用旧状态启动。
				setSrc("");
				setFull(false);
				setNonce((value) => value + 1);
			};
			return (
				<div className={panel ? "preview-panel" : "preview-card"} data-preview-id={id} data-capturing={copy.capturing || undefined}>
					{!panel && (
						// 和别的工具调用同一种单行（图标、「网页预览 标题」、展开箭头），不另画一块标题栏。
						<FlowRow
							icon={<AppWindow size={13} strokeWidth={1.8} />}
							summary={preview ? `${words.title} ${preview.title}` : words.title}
							open={!collapsed}
							onToggle={() => setCollapsed((value) => !value)}
						/>
					)}
					<Collapse open={!collapsed} keepMounted bodyClassName={panel ? "preview-panel-body" : "preview-body"}>
						<div
							ref={surface}
							className="preview-surface"
							data-preview-themed={preview?.themed || undefined}
							style={{ height: panel ? "100%" : full ? height : Math.min(MAX_HEIGHT, height) }}
						>
							{!ready && !error && (
								<Text className="preview-loading" size="label" tone="faint">
									{words.loading}
								</Text>
							)}
							{src && (
								<iframe
									ref={frame}
									key={nonce}
									src={src}
									title={preview?.title ?? words.title}
									sandbox="allow-scripts allow-pointer-lock allow-forms allow-modals"
									className="preview-frame"
									data-ready={ready || undefined}
									onLoad={() => {
										setReady(true);
										shown.current?.();
										if (preview?.themed) frame.current?.contentWindow?.postMessage({ preview: "theme", value: previewTheme() }, "*");
										// 人在别的应用里时写好的页面，一开始就停着。
										postPause();
									}}
									onError={() => {
										setError(words.failed);
										shown.current?.();
									}}
								/>
							)}
							<div className="preview-actions">
								<IconButton
									icon={copy.copied ? <Check size={12} /> : <Copy size={12} />}
									label={copy.copied ? words.copied : words.copy}
									size="sm"
									disabled={!ready || copy.capturing}
									onClick={() => void copy.copy()}
								/>
								{full && <IconButton icon={<Minimize2 size={12} />} label={words.fit} size="sm" onClick={() => setFull(false)} />}
								<IconButton icon={<RotateCw size={12} />} label={words.rerun} size="sm" onClick={rerun} />
								{!panel && tweaks.groups.length > 0 && (
									<IconButton
										icon={<SlidersHorizontal size={12} />}
										label={words.tweak}
										size="sm"
										active={tuning}
										onClick={() => setTuning((value) => !value)}
									/>
								)}
								{!panel && (
									<IconButton icon={<ExternalLink size={12} />} label={words.panel} size="sm" onClick={() => ui.openPanel("preview", sessionId, { tab: id })} />
								)}
							</div>
							{!panel && !full && height > MAX_HEIGHT + 8 && (
								<div className="preview-more">
									<IconButton icon={<ChevronsDown size={13} />} label={words.longer} onClick={() => setFull(true)} />
								</div>
							)}
						</div>
						{!panel && tweaks.groups.length > 0 && (
							<div hidden={!tuning}>
								<Tweaks key={nonce} tweaks={tweaks} title={preview?.title ?? words.title} send={send} onError={() => ui.notify(words.sendFailed, "error")} />
							</div>
						)}
						{error && (
							<Text as="p" size="detail" tone="danger" className="preview-error">
								{error}
							</Text>
						)}
					</Collapse>
				</div>
			);
		}
		function Card({ sessionId, call, status, streaming, argumentsText, result, fallback, send }: ToolCardProps) {
			const session = ui.useSession(sessionId);
			const settled = session?.messages;
			const writing = session?.draft;
			const messages = useMemo(() => [...(settled ?? []), ...(writing ? [writing] : [])], [settled, writing]);
			const placement = useMemo(() => placements(messages, session?.summary.running ?? false).get(call.id), [messages, session?.summary.running, call.id]);
			const published =
				placement && "publishedBy" in placement
					? messages.find((m) => m.role === "toolResult" && m.toolCallId === placement.publishedBy && !m.isError)
					: undefined;
			const details = published && "details" in published ? published.details : result?.details;
			const candidate = (details as { preview?: unknown } | undefined)?.preview;
			const preview =
				status === "done" && isPreview(candidate) && candidate.published && candidate.sessionId === sessionId && !(placement && "publishing" in placement)
					? candidate
					: undefined;
			const waiting = !!placement && ("waiting" in placement || ("publishedBy" in placement && !preview));
			const [streamed] = useState(() => !preview && (status === "running" || waiting));
			const [covered, setCovered] = useState(true);
			const [landed, setLanded] = useState(false);
			const [height, setHeight] = useState<number>();
			useEffect(() => {
				if (!landed) return;
				const timer = setTimeout(() => setCovered(false), 260);
				return () => clearTimeout(timer);
			}, [landed]);
			const args = streamed ? draftArguments(call.args, argumentsText) : call.args;
			const draft = streamed && covered && status !== "failed" && (status === "running" || waiting || preview) ? draftDocument(args) : null;
			return (
				<div className="preview-call">
					{draft && <Draft page={draft} fallback={fallback} complete={!streaming} checked={status === "done"} onHeight={setHeight} />}
					{preview && (
						<div className={draft ? "preview-handover" : undefined}>
							<Page sessionId={sessionId} id={preview.id} initial={preview} startHeight={height} send={send} onShown={() => setLanded(true)} />
						</div>
					)}
					{!draft && !preview && fallback}
				</div>
			);
		}
		function Panel({ session, tab, shown, setTitle }: PanelProps) {
			return session ? <Page sessionId={session.summary.id} id={tab} panel visible={shown} setTitle={setTitle} /> : null;
		}
		ui.toolCard("preview", Card, { inline: inlineCall });
		ui.toolLine("preview", {
			verb: (locale) => MESSAGES[locale].title,
			subject: (args) => (typeof args.title === "string" ? args.title : undefined),
			icon: AppWindow,
		});
		ui.panel("preview", Panel, { title: (locale) => MESSAGES[locale].title, icon: AppWindow, multiple: true, listed: false, restore: true, detachable: true });
	},
} satisfies UiPlugin;
