/** 增量读取声明：完整标签才出现；未写完的属性和表达式留到下一帧。 */
import { parseExpression, type Expression } from "./expression.ts";

export type PropValue = { kind: "text"; text: string } | { kind: "expression"; source: string; expression: Expression | null } | { kind: "flag" };
export interface UiElement {
	kind: "element";
	name: string;
	props: Record<string, PropValue>;
	children: UiNode[];
	open: boolean;
}
type TextPart = string | { source: string; expression: Expression | null };
export type UiNode = UiElement | { kind: "text"; parts: TextPart[] };
export interface PendingTag {
	name: string;
	parent: UiElement | null;
}
export interface ParsedBlock {
	nodes: UiNode[];
	problems: string[];
	incomplete: boolean;
	pending?: PendingTag;
}

/** 引号内的大括号不是表达式的边界。 */
export function closingBrace(source: string, start: number): number {
	let depth = 0;
	let quote: string | null = null;
	for (let at = start; at < source.length; at++) {
		const char = source[at]!;
		if (quote) {
			if (char === "\\") at++;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") quote = char;
		else if (char === "{") depth++;
		else if (char === "}" && --depth === 0) return at + 1;
	}
	return -1;
}

export function parseBlock(source: string): ParsedBlock {
	const problems: string[] = [];
	if (source.length > 50000) return { nodes: [], problems: ["block too long"], incomplete: false };
	let incomplete = false;
	let pending: PendingTag | undefined;
	let count = 0;
	const root: UiElement = { kind: "element", name: "", props: {}, children: [], open: true };
	const stack = [root];
	const expressionOf = (source: string) => {
		const parsed = parseExpression(source);
		if (!parsed.ok) problems.push(parsed.error);
		return { source, expression: parsed.ok ? parsed.expression : null };
	};
	const flushText = (raw: string) => {
		const parts: TextPart[] = [];
		let at = 0;
		while (at < raw.length) {
			const open = raw.indexOf("{", at);
			const end = open < 0 ? raw.length : open;
			const literal = jsxText(raw.slice(at, end));
			if (literal) parts.push(literal);
			if (open < 0) break;
			const close = closingBrace(raw, open);
			if (close < 0) {
				incomplete = true;
				break;
			}
			parts.push(expressionOf(raw.slice(open + 1, close - 1).trim()));
			at = close;
		}
		if (parts.length) stack.at(-1)!.children.push({ kind: "text", parts });
	};
	const readTag = (start: number): { props: Record<string, PropValue>; end: number; selfClosing: boolean } | null => {
		const props: Record<string, PropValue> = {};
		let at = start;
		for (;;) {
			while (at < source.length && /\s/.test(source[at]!)) at++;
			if (at >= source.length) return null;
			if (source[at] === ">") return { props, end: at + 1, selfClosing: false };
			if (source.startsWith("/>", at)) return { props, end: at + 2, selfClosing: true };
			const name = NAME.exec(source.slice(at));
			if (!name) {
				problems.push(`unexpected "${source[at]}" inside tag`);
				at++;
				continue;
			}
			at += name[0].length;
			if (Object.hasOwn(props, name[0])) problems.push(`duplicate prop ${name[0]}`);
			while (at < source.length && /\s/.test(source[at]!)) at++;
			if (at >= source.length) return null;
			if (source[at] !== "=") {
				props[name[0]] = { kind: "flag" };
				continue;
			}
			at++;
			while (at < source.length && /\s/.test(source[at]!)) at++;
			if (at >= source.length) return null;
			const quote = source[at]!;
			if (quote === '"' || quote === "'") {
				const close = source.indexOf(quote, at + 1);
				if (close < 0) return null;
				props[name[0]] = { kind: "text", text: source.slice(at + 1, close) };
				at = close + 1;
			} else if (quote === "{") {
				const close = closingBrace(source, at);
				if (close < 0) return null;
				props[name[0]] = { kind: "expression", ...expressionOf(source.slice(at + 1, close - 1).trim()) };
				at = close;
			} else {
				problems.push("attribute values must be quoted or braced");
				const value = /^[^\s>]+/.exec(source.slice(at))![0];
				at += value.length;
			}
		}
	};
	let at = 0;
	while (at < source.length) {
		if (++count > 1000 || stack.length > 65) {
			problems.push("block too complex");
			break;
		}
		// 按完整表达式跳过，多个表达式里的小于号也不能被误认成标签。
		let next = at;
		while (next < source.length && source[next] !== "<") {
			if (source[next] === "{") {
				const close = closingBrace(source, next);
				if (close < 0) {
					next = source.length;
					break;
				}
				next = close;
			} else next++;
		}
		if (next >= source.length) {
			flushText(source.slice(at));
			break;
		}
		if (next > at) flushText(source.slice(at, next));
		if (source.startsWith("<!--", next)) {
			const end = source.indexOf("-->", next + 4);
			if (end < 0) {
				incomplete = true;
				break;
			}
			at = end + 3;
			continue;
		}
		if (source[next + 1] === "/") {
			const end = source.indexOf(">", next);
			if (end < 0) {
				incomplete = true;
				break;
			}
			const name = source.slice(next + 2, end).trim();
			if (stack.length > 1 && stack.at(-1)!.name === name) stack.pop()!.open = false;
			else problems.push(`mismatched closing tag ${name}`);
			at = end + 1;
			continue;
		}
		const name = NAME.exec(source.slice(next + 1));
		if (!name) {
			if (next + 1 >= source.length) {
				incomplete = true;
				break;
			}
			problems.push("literal < must be written as an expression");
			at = next + 1;
			continue;
		}
		const tag = readTag(next + 1 + name[0].length);
		if (!tag) {
			incomplete = true;
			pending = { name: name[0], parent: stack.length > 1 ? stack.at(-1)! : null };
			break;
		}
		const element: UiElement = { kind: "element", name: name[0], props: tag.props, children: [], open: !tag.selfClosing };
		stack.at(-1)!.children.push(element);
		if (!tag.selfClosing) stack.push(element);
		at = tag.end;
	}
	return { nodes: root.children, problems, incomplete: incomplete || stack.length > 1, ...(pending ? { pending } : {}) };
}
const NAME = /^[A-Za-z][\w.-]*/;
function jsxText(part: string): string {
	if (!part.includes("\n")) return part;
	const lines = part.split(/\r?\n/);
	return lines
		.map((line, at) => {
			let kept = line.replace(/\t/g, " ");
			if (at > 0) kept = kept.replace(/^ +/, "");
			if (at < lines.length - 1) kept = kept.replace(/ +$/, "");
			return kept;
		})
		.filter(Boolean)
		.join(" ");
}
