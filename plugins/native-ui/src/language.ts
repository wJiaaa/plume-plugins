import { component, propSpec, type PropType } from "./catalog.ts";
import { chartData, optionsOf, pieSlices, record, scalar, tableData } from "./data.ts";
import { evaluate, FORBIDDEN, FUNCTIONS, parseExpression, references, text, type Expression } from "./expression.ts";
import { closingBrace, parseBlock, type PendingTag, type PropValue, type UiElement, type UiNode } from "./parse.ts";

export type Values = Record<string, unknown>;
export interface Drawing {
	node: UiElement;
	props: Values;
	children: (Drawing | string)[];
	locals: Values;
	path: string;
}
export interface Block {
	nodes: UiNode[];
	initial: Values;
	fields: UiElement[];
	pending?: PendingTag;
}

/** 引号里的模板也走同一表达式解析器，坏模板不能当成普通文字悄悄留下。 */
function templateParts(value: string): (string | Expression)[] {
	const parts: (string | Expression)[] = [];
	let at = 0;
	while (at < value.length) {
		const open = value.indexOf("{", at);
		if (open < 0) {
			parts.push(value.slice(at));
			break;
		}
		if (open > at) parts.push(value.slice(at, open));
		const close = closingBrace(value, open);
		if (close < 0) throw new Error("unclosed template");
		const parsed = parseExpression(value.slice(open + 1, close - 1));
		if (!parsed.ok) throw new Error(parsed.error);
		parts.push(parsed.expression);
		at = close;
	}
	return parts;
}
function usable(value: unknown): unknown {
	if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) throw new Error("expression has no finite value");
	return value;
}
function raw(value: PropValue, scope: Values, type: PropType): unknown {
	if (value.kind === "flag") return true;
	if (value.kind === "expression") {
		if (!value.expression) throw new Error("invalid expression");
		return usable(evaluate(value.expression, scope));
	}
	if (type !== "text" && type !== "value") return value.text;
	return templateParts(value.text)
		.map((part) => (typeof part === "string" ? part : text(usable(evaluate(part, scope)))))
		.join("");
}
function fit(type: PropType, value: unknown): unknown {
	if (typeof type !== "string") {
		if (typeof value !== "string" || !type.includes(value)) throw new Error("invalid enum value");
		return value;
	}
	switch (type) {
		case "text":
			if (!scalar(value)) throw new Error("text must be scalar");
			return text(value);
		case "number": {
			const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
			if (!Number.isFinite(number)) throw new Error("expected finite number");
			return number;
		}
		case "boolean":
			if (value !== true && value !== false && value !== "true" && value !== "false") throw new Error("expected boolean");
			return value === true || value === "true";
		case "array":
			if (!Array.isArray(value)) throw new Error("expected array");
			return value;
		case "object":
			if (!record(value)) throw new Error("expected object");
			return value;
		default:
			return value;
	}
}
function readProps(node: UiElement, scope: Values): Values {
	const spec = component(node.name);
	if (!spec) throw new Error("unknown component");
	const props: Values = {};
	for (const [key, value] of Object.entries(node.props)) {
		const definition = propSpec(spec, key);
		if (!definition) throw new Error("unknown prop");
		props[key] = fit(definition.type, raw(value, scope, definition.type));
	}
	return props;
}
function expressions(value: PropValue): Expression[] {
	if (value.kind === "flag") return [];
	if (value.kind === "expression") {
		if (!value.expression) throw new Error("invalid expression");
		return [value.expression];
	}
	return templateParts(value.text).filter((part): part is Expression => typeof part !== "string");
}
function checkExpression(expression: Expression, names: Set<string>): void {
	const found = references(expression);
	if ([...found.names].some((name) => !names.has(name)) || [...found.calls].some((name) => !Object.hasOwn(FUNCTIONS, name)))
		throw new Error("unknown state or function");
}

const DEFINITIONS = ["name", "value", "options", "multiple", "type", "min", "max", "step"];
function definitionOf(field: UiElement): UiElement {
	return { ...field, props: Object.fromEntries(Object.entries(field.props).filter(([key]) => DEFINITIONS.includes(key))) };
}
function identifier(name: string): boolean {
	return /^[A-Za-z_$][\w$]*$/.test(name) && !FORBIDDEN.has(name) && !["true", "false", "null", "undefined"].includes(name) && !Object.hasOwn(FUNCTIONS, name);
}
function aliases(node: UiElement): string[] {
	return ["as", "index"].flatMap((key) => {
		const prop = node.props[key];
		if (prop === undefined) return key === "as" ? ["item"] : [];
		if (prop.kind !== "text" || !identifier(prop.text)) throw new Error(`Each ${key} needs a literal identifier`);
		return [prop.text];
	});
}
function tabTitles(node: UiElement, values: Values): string[] {
	return node.children
		.filter((child): child is UiElement => child.kind === "element")
		.map((tab) => readProps({ ...tab, props: { title: tab.props.title! } }, values).title as string);
}

export function prepareBlock(source: string, complete: boolean): { ok: true; block: Block } | { ok: false; error: string } {
	try {
		const parsed = parseBlock(source);
		if (parsed.problems.length || (complete && parsed.incomplete)) throw new Error(parsed.problems[0] ?? "unfinished block");
		const fields: UiElement[] = [];
		const names = new Set<string>();
		const structure = (node: UiNode, parent?: UiElement) => {
			if (parent?.name === "Tabs" && (node.kind !== "element" || node.name !== "Tab")) throw new Error("Tabs holds only Tab");
			if (node.kind === "text") return;
			const spec = component(node.name);
			if (!spec) throw new Error(`unknown component ${node.name}`);
			for (const [key, definition] of Object.entries(spec.props)) if (definition.required && !Object.hasOwn(node.props, key)) throw new Error(`missing ${key}`);
			for (const key of Object.keys(node.props)) if (!propSpec(spec, key)) throw new Error(`unknown prop ${key}`);
			if ((spec.children === "none" && node.children.length) || (spec.children === "text" && node.children.some((child) => child.kind !== "text")))
				throw new Error("invalid children");
			if (node.name === "Tab" && parent?.name !== "Tabs") throw new Error("Tab must be directly inside Tabs");
			if (spec.declares && (node.name !== "Tabs" || node.props.name)) {
				const name = node.props.name;
				if (name?.kind !== "text" || !identifier(name.text) || names.has(name.text)) throw new Error("invalid or duplicate state name");
				names.add(name.text);
				fields.push(node);
				for (const key of DEFINITIONS)
					if (node.props[key] && expressions(node.props[key]!).some((expression) => references(expression).names.size > 0))
						throw new Error("field definitions must be constant");
			}
			if (node.name === "Tab" && parent?.props.name && expressions(node.props.title!).some((expression) => references(expression).names.size > 0))
				throw new Error("named Tabs titles must be constant");
			if (node.name === "Button" && !node.props.send && !node.props.set) throw new Error("button needs send or set");
			node.children.forEach((child) => structure(child, node));
		};
		parsed.nodes.forEach((node) => structure(node));
		const inspect = (node: UiNode, scope: Set<string>) => {
			if (node.kind === "text") {
				for (const part of node.parts)
					if (typeof part !== "string") {
						if (!part.expression) throw new Error("invalid expression");
						checkExpression(part.expression, scope);
					}
				return;
			}
			for (const value of Object.values(node.props)) for (const expression of expressions(value)) checkExpression(expression, scope);
			const inner = new Set(scope);
			if (node.name === "Each")
				for (const name of aliases(node)) {
					if (inner.has(name)) throw new Error(`Each alias shadows ${name}`);
					inner.add(name);
				}
			node.children.forEach((child) => inspect(child, inner));
		};
		parsed.nodes.forEach((node) => inspect(node, names));
		const initial: Values = {};
		for (const field of fields) {
			// when 和标签可以引用其他字段，初始化只读取恒定的字段定义。
			const props = readProps(definitionOf(field), {});
			initial[props.name as string] =
				props.value ??
				(field.name === "Tabs"
					? (tabTitles(field, {})[0] ?? "")
					: field.name === "Slider"
						? (props.min ?? 0)
						: field.name === "Toggle"
							? false
							: field.name === "Choice" && props.multiple
								? []
								: field.name === "Choice" || field.name === "Select"
									? optionsOf(props.options)[0]!.original
									: "");
		}
		const block = { nodes: parsed.nodes, fields, initial, ...(parsed.pending ? { pending: parsed.pending } : {}) };
		resolveBlock(block, initial);
		return { ok: true, block };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export function validateValues(block: Block, values: Values): void {
	if (Object.keys(values).length !== block.fields.length) throw new Error("unknown state key");
	for (const field of block.fields) {
		const name = (field.props.name as { kind: "text"; text: string }).text;
		if (!Object.hasOwn(values, name)) throw new Error("missing state");
		const value = values[name];
		const props = readProps(definitionOf(field), values);
		if (field.name === "Toggle") {
			if (typeof value !== "boolean") throw new Error("toggle needs boolean");
		} else if (field.name === "Tabs") {
			if (typeof value !== "string" || (!field.open && !tabTitles(field, values).includes(value))) throw new Error("value not in tabs");
		} else if (field.name === "Slider") {
			const min = (props.min as number | undefined) ?? 0;
			const max = (props.max as number | undefined) ?? 100;
			const step = (props.step as number | undefined) ?? 1;
			if (max <= min || !Number.isFinite(max - min) || step <= 0 || typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
				throw new Error("slider needs min < max, positive step and value in range");
			const stops = ((value as number) - min) / step;
			if (!Number.isFinite(stops) || Math.abs(stops - Math.round(stops)) > 1e-7) throw new Error("slider value must align with step");
		} else if (field.name === "Input") {
			if (typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error("input needs text or number");
		} else {
			const options = optionsOf(props.options);
			const has = (value: unknown) => options.some((option) => option.original === value);
			if (field.name === "Choice" && props.multiple) {
				if (!Array.isArray(value) || value.some((item) => !has(item)) || new Set(value).size !== value.length) throw new Error("invalid multiple choice");
			} else if (!has(value)) throw new Error("value not in options");
		}
	}
}
function validate(node: UiElement, props: Values, values: Values): void {
	if (node.name === "Grid" && props.cols !== undefined && (!Number.isInteger(props.cols) || (props.cols as number) < 1 || (props.cols as number) > 6))
		throw new Error("cols must be 1–6");
	if (node.name === "Heading" && props.level !== undefined && ![1, 2, 3].includes(props.level as number)) throw new Error("level must be 1–3");
	if (node.name === "Table") tableData(props);
	if (node.name === "Chart") {
		const data = chartData(props.data, props.x, props.y);
		if (props.kind === "pie")
			pieSlices(
				data.values.map((row) => row[0]!),
				1,
			);
	}
	if (node.name === "Tabs") {
		const titles = tabTitles(node, values);
		if ((!node.open && !titles.length) || titles.some((title) => !title.trim()) || new Set(titles).size !== titles.length)
			throw new Error("Tabs needs distinct nonempty titles");
	}
	if (node.name === "Stat" && (!scalar(props.value) || (props.delta !== undefined && !scalar(props.delta)))) throw new Error("stat needs scalar values");
	if (node.name === "Button") {
		if (props.send !== undefined && !(props.send as string).trim()) throw new Error("empty send");
		if (
			props.set !== undefined &&
			(!Object.keys(props.set as object).length || Object.keys(props.set as object).some((key) => !Object.hasOwn(values, key) || FORBIDDEN.has(key)))
		)
			throw new Error("set needs existing state keys");
	}
}
function wordsOf(nodes: UiNode[], values: Values): string {
	return nodes
		.map((node) =>
			node.kind === "text"
				? node.parts.map((part) => (typeof part === "string" ? part : part.expression ? text(usable(evaluate(part.expression, values))) : "")).join("")
				: "",
		)
		.join("");
}
export function resolveBlock(block: Block, values: Values): (Drawing | string)[] {
	validateValues(block, values);
	let remaining = 4000;
	const resolve = (node: UiNode, path: string, locals: Values): Drawing | string => {
		if (--remaining < 0) throw new Error("expanded block exceeds 4000 nodes");
		const scope = { ...values, ...locals };
		if (node.kind === "text") return wordsOf([node], scope);
		const props = readProps(node, scope);
		validate(node, props, scope);
		if (node.name === "Button" && props.set) validateValues(block, { ...values, ...(props.set as Values) });
		let children: (Drawing | string)[];
		if (node.name === "Each") {
			const items = props.of as unknown[];
			if (items.length > 200) throw new Error("Each exceeds 200 items");
			const [as, index] = aliases(node);
			children = items.flatMap((item, at) =>
				node.children.map((child, i) => resolve(child, `${path}:${at}:${i}`, { ...locals, [as!]: item, ...(index ? { [index]: at } : {}) })),
			);
		} else children = node.children.map((child, i) => resolve(child, `${path}:${i}`, locals));
		if (node.name === "Button" && !wordsOf(node.children, scope).trim()) throw new Error("button needs visible text");
		return { node, props, children, locals, path };
	};
	return block.nodes.map((node, i) => resolve(node, String(i), {}));
}

export function actionOf(block: Block, node: UiElement, values: Values, locals: Values = {}): { values: Values; words: string; payload: string } {
	const props = readProps(node, { ...values, ...locals });
	const next = props.set ? { ...values, ...(props.set as Values) } : values;
	resolveBlock(block, next);
	const words = text(readProps(node, { ...next, ...locals }).send).trim();
	const payload = words ? spoken(words, next) : "";
	return { values: next, words, payload };
}
/** 可见预览和实际提交用同一字符串，用户值不是隐藏的旁路协议。 */
export function spoken(words: string, values: Values): string {
	return Object.keys(values).length ? `${words}\n\n<interface-values>${JSON.stringify(values)}</interface-values>` : words;
}
