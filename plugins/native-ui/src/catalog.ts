/** 提示和校验共用这张表，避免教会模型渲染器没有的属性。 */
export type PropType = "text" | "number" | "boolean" | "array" | "object" | "value" | readonly string[];
export interface PropSpec {
	type: PropType;
	required?: boolean;
}
export interface ComponentSpec {
	props: Record<string, PropSpec>;
	children: "none" | "text" | "nodes";
	declares?: boolean;
	note?: string;
}
const GAP = ["sm", "md", "lg"] as const;
export const COMPONENTS: Record<string, ComponentSpec> = {
	Stack: { props: { gap: { type: GAP } }, children: "nodes", note: "vertical" },
	Row: { props: { gap: { type: GAP }, align: { type: ["start", "center", "end", "between"] } }, children: "nodes", note: "horizontal; wraps when narrow" },
	Grid: { props: { cols: { type: "number" }, gap: { type: GAP } }, children: "nodes", note: "maximum 1–6 columns; fewer when narrow" },
	Card: { props: { title: { type: "text" }, subtitle: { type: "text" } }, children: "nodes" },
	Divider: { props: {}, children: "none" },
	Tabs: {
		props: { name: { type: "text" }, value: { type: "text" } },
		children: "nodes",
		declares: true,
		note: "holds only Tab; optional name declares the open title as state",
	},
	Tab: { props: { title: { type: "text", required: true } }, children: "nodes", note: "direct child of Tabs" },
	Each: {
		props: { of: { type: "array", required: true }, as: { type: "text" }, index: { type: "text" } },
		children: "nodes",
		note: "repeats children up to 200 times; as defaults to item; index is optional; aliases are literal identifiers",
	},
	Heading: { props: { level: { type: "number" } }, children: "text", note: "level 1–3" },
	Text: {
		props: { tone: { type: ["muted", "strong", "accent", "info", "ok", "warning", "danger"] }, size: { type: ["sm", "md", "lg"] } },
		children: "text",
		note: "plain text, not Markdown",
	},
	Stat: {
		props: { label: { type: "text", required: true }, value: { type: "value", required: true }, delta: { type: "value" }, hint: { type: "text" } },
		children: "none",
	},
	Badge: { props: { tone: { type: ["info", "ok", "warning", "danger"] } }, children: "text" },
	Callout: { props: { tone: { type: ["info", "ok", "warning", "danger"] }, title: { type: "text" } }, children: "nodes" },
	Progress: {
		props: { value: { type: "number", required: true }, max: { type: "number" }, label: { type: "text" }, tone: { type: ["info", "ok", "warning", "danger"] } },
		children: "none",
	},
	Table: {
		props: { columns: { type: "array" }, rows: { type: "array" }, data: { type: "array" } },
		children: "none",
		note: "columns=[strings], rows=[[cells]], OR data=[{key:cell}] with identical keys; not both rows and data",
	},
	Chart: {
		props: {
			kind: { type: ["bar", "line", "area", "pie"] },
			data: { type: "array", required: true },
			x: { type: "text" },
			y: { type: "value" },
			unit: { type: "text" },
			size: { type: ["sm", "md", "lg"] },
		},
		children: "none",
		note: "data=[{month:'Jan',sales:3}]; x labels; y key or key list, otherwise all numeric keys; up to 500 rows and 6 series",
	},
	Input: {
		props: {
			name: { type: "text", required: true },
			label: { type: "text" },
			placeholder: { type: "text" },
			type: { type: ["text", "number"] },
			value: { type: "value" },
		},
		children: "none",
		declares: true,
	},
	Select: {
		props: { name: { type: "text", required: true }, label: { type: "text" }, options: { type: "array", required: true }, value: { type: "value" } },
		children: "none",
		declares: true,
		note: "options are strings/numbers or {label,value}; defaults to first option",
	},
	Choice: {
		props: {
			name: { type: "text", required: true },
			label: { type: "text" },
			options: { type: "array", required: true },
			value: { type: "value" },
			multiple: { type: "boolean" },
		},
		children: "none",
		declares: true,
		note: "single segmented choice, or multiple=true list; defaults to first option or []",
	},
	Toggle: { props: { name: { type: "text", required: true }, label: { type: "text" }, value: { type: "boolean" } }, children: "none", declares: true },
	Slider: {
		props: {
			name: { type: "text", required: true },
			label: { type: "text" },
			min: { type: "number" },
			max: { type: "number" },
			step: { type: "number" },
			value: { type: "number" },
			unit: { type: "text" },
		},
		children: "none",
		declares: true,
	},
	Button: {
		props: { send: { type: "text" }, set: { type: "object" }, primary: { type: "boolean" }, disabled: { type: "boolean" } },
		children: "text",
		note: "send sends a user message with ALL named values; set updates named values locally; both: set first, then evaluate send",
	},
};
const COMMON_PROPS: Record<string, PropSpec> = { when: { type: "value" } };
export function component(name: string): ComponentSpec | undefined {
	return Object.hasOwn(COMPONENTS, name) ? COMPONENTS[name] : undefined;
}
export function propSpec(spec: ComponentSpec, name: string): PropSpec | undefined {
	return Object.hasOwn(spec.props, name) ? spec.props[name] : Object.hasOwn(COMMON_PROPS, name) ? COMMON_PROPS[name] : undefined;
}
