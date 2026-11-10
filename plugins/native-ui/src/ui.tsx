import type { CodeBlockProps, UiPlugin } from "@plume/contract/ui";
import { Button, TabStrip, Text, useI18n } from "@plume/ui";
import { Fragment, useMemo, useRef, useState, type CSSProperties, type ReactNode, type SyntheticEvent } from "react";
import { Chart } from "./Chart.tsx";
import { Callout, NativeCard, Progress, Stat, Table } from "./content.tsx";
import { copyText } from "./copy.ts";
import { Field } from "./controls.tsx";
import { actionOf, prepareBlock, resolveBlock, type Block, type Drawing, type Values } from "./language.ts";
import { MESSAGES } from "./messages.ts";
import { Growing, Pending, useArrivals } from "./motion.tsx";
import type { UiElement } from "./parse.ts";
import { createSubmission } from "./submission.ts";
import { recall, remember, stateKey, type BlockState } from "./state.ts";
import css from "./native-ui.css";

export function NativeBlock(props: CodeBlockProps) {
	const parsed = useMemo(() => prepareBlock(props.code, props.complete), [props.code, props.complete]);
	if (!parsed.ok || (!props.complete && !props.streaming) || (!parsed.block.nodes.length && props.complete)) return <>{props.fallback}</>;
	const identity = JSON.stringify([props.sessionId, props.messageId, props.blockId, props.complete ? props.code : "writing"]);
	return <Interface key={identity} {...props} block={parsed.block} />;
}

function Interface({ block, code, sessionId, complete, streaming, send, fallback }: CodeBlockProps & { block: Block }) {
	const messages = MESSAGES[useI18n().resolvedLocale];
	const key = stateKey(sessionId, code);
	const [own, setOwn] = useState<BlockState>(() => (complete && !streaming ? recall(key, block) : { values: {}, tabs: {} }));
	const current = useRef(own);
	const save = (next: BlockState) => {
		current.current = next;
		setOwn(next);
		// 同步保存：换会话或复制可能紧接着这次事件发生，发送完成后即使已卸载也要记回执。
		if (complete && !streaming) remember(key, next);
	};
	const [status, setStatus] = useState<{ pending?: string; failed?: string; local?: boolean }>({});
	const submission = useRef(createSubmission());
	const drawingRoot = useRef<HTMLFieldSetElement>(null);
	const layer = useRef<HTMLDivElement>(null);
	useArrivals(drawingRoot, layer, streaming);
	const values = { ...block.initial, ...own.values };
	const disabled = !complete || streaming || !send || submission.current.busy();
	const change = (next: Values) => {
		if (!disabled) {
			save({ ...current.current, values: { ...current.current.values, ...next } });
			setStatus({});
		}
	};
	let drawing: (Drawing | string)[];
	try {
		drawing = resolveBlock(block, values);
	} catch {
		return (
			<div className="native-ui">
				{fallback}
				<Text tone="danger" role="alert">
					{messages.invalid}
				</Text>
				<Button
					disabled={disabled}
					onClick={() => {
						save({ values: {}, tabs: {} });
						setStatus({});
					}}
				>
					{messages.reset}
				</Button>
			</div>
		);
	}

	// send 必须在本次真实事件的同步调用栈里发生，不能先等别的异步操作。
	const press = (item: Drawing, event: SyntheticEvent) => {
		if (disabled || item.props.disabled || submission.current.busy()) return;
		try {
			const action = actionOf(block, item.node, values, item.locals);
			if (!action.payload) {
				save({ ...current.current, values: action.values });
				setStatus({ local: true });
				return;
			}
			if (!send) return;
			const request = submission.current.start(action.payload, () => send(action.payload, event));
			if (!request) return;
			setStatus({ pending: action.payload });
			void request.then(
				() => {
					save({ ...current.current, values: action.values, sent: { payload: action.payload, button: item.path, values: action.values } });
					setStatus({});
				},
				() => setStatus({ failed: action.payload }),
			);
		} catch {
			setStatus({ failed: "" });
		}
	};
	const render = (nodes: (Drawing | string)[], depth = 0, parent: UiElement | null = null): ReactNode => (
		<>
			{nodes.map((item, index) => {
				if (typeof item === "string")
					return (
						<Text key={index} size="label">
							{item}
						</Text>
					);
				const { node, props, children } = item;
				if (Object.hasOwn(props, "when") && !props.when) return null;
				const words = children.filter((child): child is string => typeof child === "string").join("");
				let content: ReactNode;
				switch (node.name) {
					case "Each":
					case "Tab":
						content = render(children, depth, node);
						break;
					case "Tabs": {
						const tabs = children.filter(
							(child): child is Drawing => typeof child !== "string" && (!Object.hasOwn(child.props, "when") || Boolean(child.props.when)),
						);
						const name = props.name as string | undefined;
						const titles = tabs.map((tab) => tab.props.title as string);
						const selected = name ? values[name] : (own.tabs[item.path] ?? props.value);
						const at = Math.max(0, titles.indexOf(selected as string));
						content = tabs.length ? (
							<div className="native-ui-stack" data-native-ui-tabs={name ?? item.path}>
								<div inert={disabled || undefined} className="native-ui-tab-strip">
									<TabStrip
										items={titles.map((title) => ({ id: title, label: title }))}
										value={titles[at]!}
										label={titles.join(" / ")}
										onChange={(title) => {
											if (disabled) return;
											if (name) change({ [name]: title });
											else save({ ...current.current, tabs: { ...current.current.tabs, [item.path]: title } });
										}}
									/>
								</div>
								<div role="tabpanel" aria-label={titles[at]}>
									{render(tabs[at]!.children, depth, tabs[at]!.node)}
								</div>
							</div>
						) : null;
						break;
					}
					case "Divider":
						content = <div role="separator" className="native-ui-divider" />;
						break;
					case "Badge":
						content = (
							<Text size="caption" className="native-ui-badge" data-tone={props.tone as string | undefined}>
								{words}
							</Text>
						);
						break;
					case "Callout":
						content = (
							<Callout title={props.title as string | undefined} tone={props.tone as string | undefined}>
								{render(children, depth, node)}
							</Callout>
						);
						break;
					case "Progress":
						content = (
							<Progress
								value={props.value as number}
								max={props.max as number | undefined}
								label={props.label as string | undefined}
								tone={props.tone as string | undefined}
							/>
						);
						break;
					case "Stack":
					case "Row":
					case "Grid":
						content = (
							<div
								className={`native-ui-${node.name.toLowerCase()}`}
								data-gap={(props.gap as string) ?? "md"}
								data-align={props.align as string | undefined}
								style={node.name === "Grid" ? ({ "--native-ui-cols": props.cols ?? 3 } as CSSProperties) : undefined}
							>
								{render(children, depth, node)}
							</div>
						);
						break;
					case "Card":
						content = (
							<NativeCard title={props.title as string | undefined} subtitle={props.subtitle as string | undefined} nested={depth > 0}>
								{render(children, depth + 1, node)}
							</NativeCard>
						);
						break;
					case "Heading": {
						const level = (props.level as number) ?? 2;
						content = (
							<Text
								size={level === 1 ? "title" : level === 2 ? "label" : "caption"}
								as={level === 1 ? "h1" : level === 2 ? "h2" : "h3"}
								weight={level === 3 ? "medium" : "semibold"}
							>
								{words}
							</Text>
						);
						break;
					}
					case "Text":
						content = (
							<Text
								as="p"
								size={props.size === "sm" ? "caption" : props.size === "lg" ? "title" : "label"}
								tone={
									props.tone === "muted"
										? "muted"
										: props.tone === "accent" || props.tone === "info"
											? "accent"
											: props.tone === "danger"
												? "danger"
												: "default"
								}
								weight={props.tone === "strong" ? "medium" : undefined}
								className="native-ui-words"
								data-tone={props.tone as string | undefined}
							>
								{words}
							</Text>
						);
						break;
					case "Stat":
						content = <Stat label={props.label as string} value={props.value} delta={props.delta} hint={props.hint as string | undefined} />;
						break;
					case "Table":
						content = <Table props={props} />;
						break;
					case "Chart":
						content = <Chart props={props} />;
						break;
					case "Input":
					case "Select":
					case "Choice":
					case "Toggle":
					case "Slider":
						content = <Field kind={node.name} props={props} values={values} disabled={disabled} change={change} />;
						break;
					case "Button": {
						let action: ReturnType<typeof actionOf> | undefined;
						try {
							action = actionOf(block, node, values, item.locals);
						} catch {
							/* 无效的局部更新不能提交，保留输入让人修正。 */
						}
						const payload = action?.payload ?? "";
						const remembered = own.sent?.button === item.path && JSON.stringify(own.sent.values) === JSON.stringify(values) ? own.sent : undefined;
						const sent = Boolean(payload) && (submission.current.sent(payload) || Boolean(remembered));
						const preview = remembered?.payload ?? action?.payload;
						content = (
							<div className="native-ui-action" data-native-ui-action="">
								{sent ? (
									<Text size="label" tone="muted" role="status" className="native-ui-sent" data-native-ui-sent="">
										{messages.sent}
									</Text>
								) : (
									<Button
										variant={props.primary ? "primary" : "ghost"}
										disabled={disabled || props.disabled === true || !action}
										loading={Boolean(payload) && status.pending === payload}
										data-native-ui-send={Boolean(payload)}
										onClick={(event) => press(item, event)}
									>
										{words}
									</Button>
								)}
								{preview ? (
									<div className="native-ui-send-preview" data-native-ui-preview="">
										<Text size="caption" tone="muted">
											{sent ? messages.sentPreview : messages.preview}
										</Text>
										<Text as="div" size="caption" mono className="native-ui-payload">
											{preview}
										</Text>
									</div>
								) : (
									<Text size="caption" tone="muted">
										{action ? messages.local : messages.invalid}
									</Text>
								)}
							</div>
						);
						break;
					}
					default:
						throw new Error("unrecognized component");
				}
				return <Fragment key={index}>{content}</Fragment>;
			})}
			{streaming && block.pending?.parent === parent && <Pending key="pending" name={block.pending.name} />}
		</>
	);
	return (
		<Growing active={streaming}>
			<div className="native-ui-frame">
				<div className="native-ui" data-native-ui={complete && !streaming ? "ready" : "writing"} aria-busy={streaming || Boolean(status.pending)}>
					{!complete || streaming ? (
						<Text size="caption" tone="muted">
							{messages.writing}
						</Text>
					) : !send ? (
						<Text size="caption" tone="muted">
							{messages.readOnly}
						</Text>
					) : null}
					<fieldset ref={drawingRoot} disabled={disabled} className="native-ui-body">
						{render(drawing)}
					</fieldset>
					{status.failed !== undefined && (
						<Text size="label" tone="danger" role="alert" data-native-ui-error="">
							{messages.failed}
						</Text>
					)}
					{status.local && (
						<Text size="caption" tone="muted" role="status">
							{messages.updated}
						</Text>
					)}
					{own.sent && (
						<Text as="div" size="caption" tone="muted" role="status" data-native-ui-receipt="">
							<Text size="caption" weight="medium">
								{messages.sent}
							</Text>
							<Text as="div" size="caption" mono className="native-ui-payload">
								{own.sent.payload}
							</Text>
						</Text>
					)}
				</div>
				<div ref={layer} className="native-ui-effects" aria-hidden />
			</div>
		</Growing>
	);
}

export default {
	name: "plume.native-ui",
	apply(ui) {
		const id = "plume.native-ui";
		let style = document.querySelector<HTMLStyleElement>(`style[data-plugin-style="${id}"]`);
		if (!style) {
			style = document.createElement("style");
			style.dataset.pluginStyle = id;
			document.head.append(style);
		}
		style.textContent = css;
		ui.codeBlock("ui", NativeBlock, { copyText });
		ui.toolLine("ui_help", { verb: (locale) => MESSAGES[locale].help, like: "read" });
	},
} satisfies UiPlugin;
