import type { Plugin } from "@plume/contract";
import { errorText } from "./errors.ts";
import { createStudioStore } from "./store.ts";
import { COLOR_KEYS, DEFAULT_MODES, type StudioView } from "./types.ts";

export default {
	name: "plume.skin-studio",
	async apply(ctx) {
		const lifetime = new AbortController();
		ctx.effect(() => lifetime.abort());
		const store = await createStudioStore(ctx.dataDir, lifetime.signal);
		ctx.serve(store);
		ctx.tools.register({
			name: "skin_studio_theme",
			description: `Design and manage Plume color skins. list returns all built-in and saved skins, defaults, and activeId. The default-system, default-light, and default-dark ids use native Plume colors with system/light/dark mode; they do not erase user preferences and cannot be copied as a 12-color skin. apply with id switches to an existing skin; apply with name, base and colors saves a new skin and applies it immediately. save with name, base and colors only adds to the library; save with only name copies the active Studio skin. remove deletes a custom skin by id (ask the user first); reset releases the Studio skin and restores prior appearance preferences. Never edit app settings or CSS to change skins. A skin contains exactly these 12 color roles: ${COLOR_KEYS.join(", ")}. Provide all colors as #RRGGBB. base is light or dark and sets the application mode. Primary and secondary text must have contrast >=4.5:1 and tertiary text >=3:1 against all six bg surfaces. Keep accent readable on its dim background. Skins are local data, not executable code.`,
			parameters: {
				type: "object",
				properties: {
					action: { type: "string", enum: ["list", "apply", "save", "remove", "reset"] },
					id: { type: "string", description: "An id returned by list, for apply or remove." },
					name: { type: "string", description: "Name for the new skin, in the user's language; at most 80 characters." },
					base: { type: "string", enum: ["light", "dark"] },
					colors: {
						type: "object",
						properties: Object.fromEntries(COLOR_KEYS.map((key) => [key, { type: "string", pattern: "^#[0-9a-fA-F]{6}$" }])),
						required: [...COLOR_KEYS],
						additionalProperties: false,
					},
				},
				required: ["action"],
				additionalProperties: false,
			},
			mutating: true,
			readsOnly: (args) => args.action === "list",
			async execute(args, run) {
				try {
					run.signal.throwIfAborted();
					if (args.action !== "list" && run.readOnly) throw new Error("readOnly");
					let view: StudioView;
					switch (args.action) {
						case "list":
							view = await store.view();
							break;
						case "reset":
							view = await store.apply(null);
							break;
						case "apply":
							if (args.id !== undefined && (args.colors !== undefined || args.name !== undefined || args.base !== undefined)) {
								return { output: "Use either id or name/base/colors, not both.", isError: true };
							}
							view = typeof args.id === "string" ? await store.apply(args.id) : await store.save(args, true);
							break;
						case "save": {
							const current = await store.view();
							const active = current.skins.find((skin) => skin.id === current.activeId);
							if (args.colors === undefined && !active) throw new Error("noCurrent");
							view = await store.save(args.colors === undefined ? { ...active, name: args.name } : args, false);
							break;
						}
						case "remove":
							if (typeof args.id !== "string") return { output: "remove requires id.", isError: true };
							view = await store.remove(args.id);
							break;
						default:
							return { output: "Unknown action. Use list, apply, save, remove or reset.", isError: true };
					}
					return {
						output: JSON.stringify({ ...view, defaults: DEFAULT_MODES.map((mode) => ({ id: `default-${mode}`, mode })) }),
						details: { activeId: view.activeId },
					};
				} catch (error) {
					return { output: errorText(error, "en"), isError: true };
				}
			},
		});
	},
} satisfies Plugin;
