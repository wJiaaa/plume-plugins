import { chartData, optionsOf, tableData } from "./data.ts";
import { text } from "./expression.ts";
import { prepareBlock, resolveBlock, type Drawing, type Values } from "./language.ts";
import { recall, stateKey } from "./state.ts";

const join = (parts: string[], between = "\n") => parts.filter(Boolean).join(between);
function table(header: string[], rows: unknown[][]): string {
	const line = (cells: unknown[]) =>
		`| ${cells
			.map((cell) =>
				text(cell)
					.replace(/\s*\n\s*/g, " ")
					.replace(/\|/g, "\\|"),
			)
			.join(" | ")} |`;
	return header.length ? [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n") : "";
}
function readable(list: (Drawing | string)[], values: Values, between = "\n"): string {
	return join(
		list.map((item) => {
			if (typeof item === "string") return item;
			const { node, props, children } = item;
			if (Object.hasOwn(props, "when") && !props.when) return "";
			const inner = () => readable(children, values);
			const labelled = (value: string) => join([text(props.label ?? props.name ?? ""), value], ": ");
			const value = values[String(props.name)];
			switch (node.name) {
				case "Button":
					return "";
				case "Divider":
					return "\n---\n";
				case "Row":
					return readable(children, values, " · ");
				case "Card":
					return join([props.title ? `**${text(props.title)}**` : "", text(props.subtitle ?? ""), inner()]);
				case "Heading":
					return `**${inner()}**`;
				case "Tab":
					return join([`**${text(props.title)}**`, inner()]);
				case "Tabs":
					return readable(children, values, "\n\n");
				case "Callout":
					return join([props.title ? `**${text(props.title)}**` : "", inner()]).replace(/^/gm, "> ");
				case "Stat": {
					const delta = props.delta === undefined ? "" : typeof props.delta === "number" && props.delta > 0 ? `+${props.delta}` : text(props.delta);
					return `${labelled(join([text(props.value), delta], " "))}${props.hint ? ` (${text(props.hint)})` : ""}`;
				}
				case "Progress":
					return labelled(
						`${Math.round(Math.min(1, Math.max(0, (props.value as number) / ((props.max as number) > 0 ? (props.max as number) : 100))) * 100)}%`,
					);
				case "Table": {
					const data = tableData(props);
					return table(data.header, data.cells);
				}
				case "Chart": {
					const data = chartData(props.data, props.x, props.y);
					return table(
						[text(props.x ?? ""), ...data.keys],
						data.values.map((row, at) => [data.labels[at], ...row]),
					);
				}
				case "Input":
					return labelled(text(value));
				case "Slider":
					return labelled(`${text(value)}${text(props.unit ?? "")}`);
				case "Toggle":
					return labelled(value === true ? "✓" : "✗");
				case "Select":
				case "Choice": {
					const options = optionsOf(props.options);
					return labelled(
						(Array.isArray(value) ? value : [value]).map((value) => options.find((option) => option.original === value)?.label ?? text(value)).join(", "),
					);
				}
				default:
					return inner();
			}
		}),
		between,
	);
}

/** 无法画出的声明保留源码；复制时现读状态，不能用父组件上次渲染的旧值。 */
export function copyText({ code, sessionId }: { code: string; sessionId: string }): string | undefined {
	const parsed = prepareBlock(code, true);
	if (!parsed.ok || !parsed.block.nodes.length) return undefined;
	const values = { ...parsed.block.initial, ...recall(stateKey(sessionId, code), parsed.block).values };
	try {
		return readable(resolveBlock(parsed.block, values), values, "\n\n");
	} catch {
		return undefined;
	}
}
