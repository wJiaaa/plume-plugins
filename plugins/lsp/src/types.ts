/**
 * What "who uses this symbol" means, and how sure we are about the answer.
 *
 * The whole reason this layer exists is one failure that does not announce itself. `grep` cannot
 * see an aliased import — `import { parse as p }` and then `p(...)` at the call site — and it
 * cannot follow a re-export chain. So a rename done with text tools finds most of the callsites,
 * misses some, and looks finished. The compiler catches it, or the runtime does.
 *
 * Which is why `confidence` is on every result rather than implied. "Found 6 places" and "text
 * search found 6 places, which may be missing aliased imports" are different pieces of information
 * to act on: the second one is a reason to check.
 */

/** A place in a file. Lines and columns are 1-based, matching what `read` shows. */
export interface CodeLocation {
	path: string;
	line: number;
	column: number;
	/** The source line, for a result a person can read without opening anything. */
	text?: string;
}

export interface Diagnostic {
	path: string;
	line: number;
	column: number;
	severity: "error" | "warning" | "info";
	message: string;
	code?: string | number;
}

export interface TextEdit {
	path: string;
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	newText: string;
}

/**
 * One language's code intelligence.
 *
 * The interface is deliberately narrow. omp's LSP layer is 8487 lines and covers hover, completion,
 * formatting, semantic tokens, inlay hints and call hierarchy; none of those help an agent. It
 * reads source directly rather than hovering, it writes whole functions rather than completing
 * them, and the project's own formatter is more correct than the server's.
 */
export interface CodeIntelBackend {
	name: string;
	/** File extensions this backend can answer for, lowercase and dotted. */
	extensions: string[];
	/**
	 * What to install when `available()` is false, for the sentence the tool returns instead. Absent
	 * for a backend that ships with the app (tsserver), where "not installed" cannot happen.
	 */
	install?: string;
	/** Whether the backend can run at all — a binary that is not installed is not an error. */
	available(): Promise<boolean>;
	/** Bring it up for a project root. Safe to call repeatedly. */
	start(root: string): Promise<void>;
	/** Whether it can answer now. A finished handshake is not the same as a built program. */
	ready(): boolean;
	references(file: string, line: number, column: number): Promise<CodeLocation[]>;
	definition(file: string, line: number, column: number): Promise<CodeLocation[]>;
	diagnostics(file: string): Promise<Diagnostic[]>;
	rename(file: string, line: number, column: number, newName: string): Promise<TextEdit[]>;
	dispose(): Promise<void>;
}
