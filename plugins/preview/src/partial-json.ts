/** 未完成的字符串保留到当前字符，半截键和数值不展示；限制嵌套深度。 */
const END = Symbol("end");
const SPECIAL = /["\\]/g;
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };

export function partialJson(text: string): unknown {
	let at = 0;
	let depth = 0;
	const space = () => {
		while (at < text.length && (text[at] === " " || text[at] === "\n" || text[at] === "\r" || text[at] === "\t")) at++;
	};

	function string(): { value: string; done: boolean } {
		at++;
		let value = "";
		while (at < text.length) {
			SPECIAL.lastIndex = at;
			const found = SPECIAL.exec(text);
			const stop = found ? found.index : text.length;
			value += text.slice(at, stop);
			at = stop;
			if (!found) break;
			if (found[0] === '"') {
				at++;
				return { value, done: true };
			}
			const escaped = text[at + 1];

			if (escaped === undefined) return { value, done: false };
			if (escaped === "u") {
				const hex = text.slice(at + 2, at + 6);
				if (hex.length < 4) return { value, done: false };
				value += String.fromCharCode(Number.parseInt(hex, 16));
				at += 6;
				continue;
			}
			value += ESCAPES[escaped] ?? escaped;
			at += 2;
		}
		at = text.length;
		return { value, done: false };
	}

	function object(): Record<string, unknown> {
		at++;
		const out: Record<string, unknown> = Object.create(null);
		while (true) {
			space();
			const next = text[at];
			if (next === undefined) return out;
			if (next === "}") {
				at++;
				return out;
			}
			if (next === ",") {
				at++;
				continue;
			}
			if (next !== '"') return out;
			const key = string();
			if (!key.done) return out;
			space();
			if (text[at] !== ":") return out;
			at++;
			const item = value();
			if (item !== END) out[key.value] = item;
			if (at >= text.length) return out;
		}
	}

	function array(): unknown[] {
		at++;
		const out: unknown[] = [];
		while (true) {
			space();
			const next = text[at];
			if (next === undefined) return out;
			if (next === "]") {
				at++;
				return out;
			}
			if (next === ",") {
				at++;
				continue;
			}
			const before = at;
			const item = value();
			if (item !== END) out.push(item);
			if (at >= text.length || at === before) return out;
		}
	}

	function value(): unknown {
		space();
		const next = text[at];
		if (next === undefined) return END;
		if (next === "{" || next === "[") {
			if (++depth > 64) {
				at = text.length;
				return END;
			}
			const result = next === "{" ? object() : array();
			depth--;
			return result;
		}

		if (next === '"') return string().value;
		const literal = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(at, at + 32));
		if (!literal) {
			at = text.length;
			return END;
		}
		at += literal[0].length;

		if (at >= text.length && /\d$/.test(literal[0])) return END;
		try {
			return JSON.parse(literal[0]);
		} catch {
			return END;
		}
	}

	const result = value();
	return result === END ? undefined : result;
}
