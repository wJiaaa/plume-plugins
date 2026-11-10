/** 表达式只读给定值；不把模型文字交给 JavaScript 执行，也不允许访问原型。 */
export type Expression =
	| { kind: "literal"; value: unknown }
	| { kind: "name"; name: string }
	| { kind: "array"; items: Expression[] }
	| { kind: "object"; entries: [string, Expression][] }
	| { kind: "member"; target: Expression; key: Expression }
	| { kind: "call"; name: string; args: Expression[] }
	| { kind: "unary"; op: string; operand: Expression }
	| { kind: "binary"; op: string; left: Expression; right: Expression }
	| { kind: "choice"; test: Expression; yes: Expression; no: Expression };

const num = (value: unknown): number =>
	typeof value === "number"
		? value
		: typeof value === "string" && value.trim() !== ""
			? Number(value)
			: typeof value === "boolean"
				? Number(value)
				: Number.NaN;
const spread = (values: unknown[]): number[] =>
	(values.length === 1 && Array.isArray(values[0]) ? values[0] : values).map(num).filter((value) => !Number.isNaN(value));
const digits = (value: unknown, max: number) => Math.min(max, Math.max(0, Math.trunc(num(value)) || 0));
export const FUNCTIONS: Record<string, (...args: unknown[]) => unknown> = {
	round: (value, places = 0) => {
		const scale = 10 ** digits(places, 12);
		return Math.round(num(value) * scale) / scale;
	},
	floor: (value) => Math.floor(num(value)),
	ceil: (value) => Math.ceil(num(value)),
	abs: (value) => Math.abs(num(value)),
	min: (...values) => Math.min(...spread(values)),
	max: (...values) => Math.max(...spread(values)),
	sum: (...values) => spread(values).reduce((total, value) => total + value, 0),
	avg: (...values) => {
		const list = spread(values);
		return list.length ? list.reduce((total, value) => total + value, 0) / list.length : 0;
	},
	len: (value) => (Array.isArray(value) || typeof value === "string" ? value.length : 0),
	fixed: (value, places = 0) => num(value).toFixed(digits(places, 20)),
	fmt: (value, places) =>
		num(value).toLocaleString(
			undefined,
			places === undefined ? undefined : { minimumFractionDigits: digits(places, 20), maximumFractionDigits: digits(places, 20) },
		),
	join: (value, separator = ", ") => (Array.isArray(value) ? value.map(text).join(text(separator)) : text(value)),
};

export function text(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
	if (typeof value === "string") return value;
	if (typeof value === "boolean") return value ? "true" : "false";
	if (Array.isArray(value)) return value.map(text).join(", ");
	return JSON.stringify(value);
}

export const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);
type Token = { kind: "number" | "string" | "name" | "op"; value: string };
const OPERATORS = [
	"===",
	"!==",
	"==",
	"!=",
	"<=",
	">=",
	"&&",
	"||",
	"??",
	"<",
	">",
	"+",
	"-",
	"*",
	"/",
	"%",
	"!",
	"?",
	":",
	".",
	",",
	"(",
	")",
	"[",
	"]",
	"{",
	"}",
];
const BINARY: Record<string, number> = {
	"??": 1,
	"||": 2,
	"&&": 3,
	"==": 4,
	"!=": 4,
	"<": 5,
	"<=": 5,
	">": 5,
	">=": 5,
	"+": 6,
	"-": 6,
	"*": 7,
	"/": 7,
	"%": 7,
};

function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	let at = 0;
	while (at < source.length) {
		const char = source[at]!;
		if (/\s/.test(char)) {
			at++;
			continue;
		}
		const number = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(source.slice(at));
		if (number) {
			tokens.push({ kind: "number", value: number[0] });
			at += number[0].length;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			let value = "";
			let end = at + 1;
			for (; end < source.length && source[end] !== char; end++) {
				if (source[end] === "\\" && end + 1 < source.length) {
					const next = source[++end]!;
					value += next === "n" ? "\n" : next === "t" ? "\t" : next;
				} else value += source[end];
			}
			if (end >= source.length) throw new SyntaxError("unterminated string");
			tokens.push({ kind: "string", value });
			at = end + 1;
			continue;
		}
		const name = /^[A-Za-z_$À-￿][\w$À-￿]*/.exec(source.slice(at));
		if (name) {
			tokens.push({ kind: "name", value: name[0] });
			at += name[0].length;
			continue;
		}
		const op = OPERATORS.find((candidate) => source.startsWith(candidate, at));
		if (!op) throw new SyntaxError(`unexpected "${char}"`);
		tokens.push({ kind: "op", value: op === "===" ? "==" : op === "!==" ? "!=" : op });
		at += op.length;
	}
	return tokens;
}

export type Parsed = { ok: true; expression: Expression } | { ok: false; error: string };
export function parseExpression(source: string): Parsed {
	if (source.length > 4000) return { ok: false, error: "expression too long" };
	try {
		const tokens = tokenize(source);
		if (!tokens.length) throw new SyntaxError("empty expression");
		let at = 0;
		let depth = 0;
		const peek = (value: string) => tokens[at]?.kind === "op" && tokens[at]!.value === value;
		const expect = (value: string) => {
			if (!peek(value)) throw new SyntaxError(`expected "${value}"`);
			at++;
		};
		const list = (close: string, item: () => void) => {
			while (!peek(close)) {
				item();
				if (!peek(close)) expect(",");
			}
			at++;
		};
		const primary = (): Expression => {
			if (++depth > 64) throw new SyntaxError("expression too deep");
			try {
				return atom();
			} finally {
				depth--;
			}
		};
		const atom = (): Expression => {
			const token = tokens[at++];
			if (!token) throw new SyntaxError("unexpected end");
			if (token.kind === "number") {
				if (!Number.isFinite(Number(token.value))) throw new SyntaxError("non-finite number");
				return { kind: "literal", value: Number(token.value) };
			}
			if (token.kind === "string") return { kind: "literal", value: token.value };
			if (token.kind === "name") {
				if (FORBIDDEN.has(token.value)) throw new SyntaxError("forbidden name");
				if (token.value === "true" || token.value === "false") return { kind: "literal", value: token.value === "true" };
				if (token.value === "null" || token.value === "undefined") return { kind: "literal", value: null };
				if (peek("(")) {
					at++;
					const args: Expression[] = [];
					list(")", () => args.push(choice()));
					return { kind: "call", name: token.value, args };
				}
				return { kind: "name", name: token.value };
			}
			if (token.value === "(") {
				const inner = choice();
				expect(")");
				return inner;
			}
			if (token.value === "[") {
				const items: Expression[] = [];
				list("]", () => items.push(choice()));
				return { kind: "array", items };
			}
			if (token.value === "{") {
				const entries: [string, Expression][] = [];
				list("}", () => {
					const key = tokens[at++];
					if (!key || key.kind === "op" || key.kind === "number" || FORBIDDEN.has(key.value) || entries.some(([name]) => name === key.value))
						throw new SyntaxError("invalid object key");
					if (peek(":")) {
						at++;
						entries.push([key.value, choice()]);
					} else if (key.kind === "name") entries.push([key.value, { kind: "name", name: key.value }]);
					else throw new SyntaxError("expected colon");
				});
				return { kind: "object", entries };
			}
			if (["!", "-", "+"].includes(token.value)) return { kind: "unary", op: token.value, operand: postfix(primary()) };
			throw new SyntaxError(`unexpected "${token.value}"`);
		};
		const postfix = (value: Expression): Expression => {
			for (;;) {
				if (peek(".")) {
					at++;
					const key = tokens[at++];
					if (key?.kind !== "name" || FORBIDDEN.has(key.value)) throw new SyntaxError("invalid member");
					value = { kind: "member", target: value, key: { kind: "literal", value: key.value } };
				} else if (peek("[")) {
					at++;
					const key = choice();
					expect("]");
					value = { kind: "member", target: value, key };
				} else return value;
			}
		};
		const binary = (floor: number): Expression => {
			let left = postfix(primary());
			for (;;) {
				const token = tokens[at];
				const power = token?.kind === "op" ? BINARY[token.value] : undefined;
				if (power === undefined || power <= floor) return left;
				at++;
				left = { kind: "binary", op: token!.value, left, right: binary(power) };
			}
		};
		const choice = (): Expression => {
			const test = binary(0);
			if (!peek("?")) return test;
			at++;
			const yes = choice();
			expect(":");
			return { kind: "choice", test, yes, no: choice() };
		};
		const expression = choice();
		if (at < tokens.length) throw new SyntaxError(`unexpected "${tokens[at]!.value}"`);
		return { ok: true, expression };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function member(target: unknown, key: unknown): unknown {
	if (typeof key !== "string" && typeof key !== "number") return undefined;
	const name = String(key);
	if (FORBIDDEN.has(name)) return undefined;
	if (typeof target === "string") return name === "length" ? target.length : /^\d+$/.test(name) ? target[Number(name)] : undefined;
	if (Array.isArray(target)) return name === "length" ? target.length : /^-?\d+$/.test(name) ? target.at(Number(name)) : undefined;
	if (target && typeof target === "object" && Object.getPrototypeOf(target) === Object.prototype && Object.hasOwn(target, name))
		return (target as Record<string, unknown>)[name];
	return undefined;
}

export function evaluate(expression: Expression, scope: Readonly<Record<string, unknown>>): unknown {
	switch (expression.kind) {
		case "literal":
			return expression.value;
		case "name":
			return Object.hasOwn(scope, expression.name) ? scope[expression.name] : undefined;
		case "array":
			return expression.items.map((item) => evaluate(item, scope));
		case "object":
			return Object.fromEntries(expression.entries.filter(([key]) => !FORBIDDEN.has(key)).map(([key, value]) => [key, evaluate(value, scope)]));
		case "member":
			return member(evaluate(expression.target, scope), evaluate(expression.key, scope));
		case "call": {
			const run = Object.hasOwn(FUNCTIONS, expression.name) ? FUNCTIONS[expression.name] : undefined;
			return run?.(...expression.args.map((arg) => evaluate(arg, scope)));
		}
		case "unary": {
			const value = evaluate(expression.operand, scope);
			return expression.op === "!" ? !value : expression.op === "-" ? -num(value) : num(value);
		}
		case "choice":
			return evaluate(expression.test, scope) ? evaluate(expression.yes, scope) : evaluate(expression.no, scope);
		case "binary": {
			const left = evaluate(expression.left, scope);
			if (expression.op === "&&") return left ? evaluate(expression.right, scope) : left;
			if (expression.op === "||") return left || evaluate(expression.right, scope);
			if (expression.op === "??") return left ?? evaluate(expression.right, scope);
			const right = evaluate(expression.right, scope);
			switch (expression.op) {
				case "==":
					return left === right;
				case "!=":
					return left !== right;
				case "+":
					return typeof left === "string" || typeof right === "string" ? text(left) + text(right) : num(left) + num(right);
				case "-":
					return num(left) - num(right);
				case "*":
					return num(left) * num(right);
				case "/":
					return num(left) / num(right);
				case "%":
					return num(left) % num(right);
				default:
					return typeof left === "string" && typeof right === "string" ? compare(expression.op, left, right) : compare(expression.op, num(left), num(right));
			}
		}
	}
}
function compare<T extends string | number>(op: string, left: T, right: T): boolean {
	return op === "<" ? left < right : op === "<=" ? left <= right : op === ">" ? left > right : left >= right;
}

export function references(expression: Expression, into = { names: new Set<string>(), calls: new Set<string>() }): { names: Set<string>; calls: Set<string> } {
	switch (expression.kind) {
		case "name":
			into.names.add(expression.name);
			break;
		case "array":
			expression.items.forEach((item) => references(item, into));
			break;
		case "object":
			expression.entries.forEach(([, value]) => references(value, into));
			break;
		case "member":
			references(expression.target, into);
			references(expression.key, into);
			break;
		case "call":
			into.calls.add(expression.name);
			expression.args.forEach((arg) => references(arg, into));
			break;
		case "unary":
			references(expression.operand, into);
			break;
		case "binary":
			references(expression.left, into);
			references(expression.right, into);
			break;
		case "choice":
			references(expression.test, into);
			references(expression.yes, into);
			references(expression.no, into);
			break;
	}
	return into;
}
