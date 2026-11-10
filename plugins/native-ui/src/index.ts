import type { Plugin } from "@plume/contract";
import { NATIVE_UI_HINT, uiReference } from "./prompt.ts";
import { withInterfaceNotes } from "./notes.ts";

export default {
	name: "plume.native-ui",
	apply(ctx) {
		ctx.hook("model.context", (input, next) =>
			next({
				...input,
				messages: withInterfaceNotes(input.messages),
				sections: [...input.sections.filter((section) => section.id !== "native-ui"), { id: "native-ui", text: NATIVE_UI_HINT }],
			}),
		);
		ctx.tools.register({
			name: "ui_help",
			description:
				"Read the complete supported native-ui JSX-like syntax, component catalog, state, send rules, limits, and examples. Call before writing a fenced ui block. No arguments, no side effects.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			mutating: false,
			async execute(args) {
				if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length)
					return { output: "ui_help accepts only an empty object.", isError: true };
				return { output: uiReference() };
			},
		});
	},
} satisfies Plugin;
