import type { Plugin } from "@plume/contract";
import { errorText } from "./errors.ts";
import { createStudioStore } from "./store.ts";
import { COLOR_KEYS, type StudioView } from "./types.ts";

function toolView(view: StudioView) {
	return {
		activeId: view.activeId,
		skins: view.skins.map((skin) => {
			if (!skin.background) return skin;
			const { image, ...settings } = skin.background;
			return { ...skin, background: { ...settings, embedded: true, mediaType: /^data:image\/([^;]+)/.exec(image)?.[1] ?? "image" } };
		}),
	};
}

export default {
	name: "plume.skin-studio",
	async apply(ctx) {
		const lifetime = new AbortController();
		ctx.effect(() => lifetime.abort());
		const store = await createStudioStore(ctx.dataDir, lifetime.signal);
		ctx.serve(store);
		ctx.tools.register({
			name: "skin_studio_theme",
			description: `Design and manage Plume color skins. list returns all built-in and saved skins and activeId, but omits embedded image bytes. apply with id switches to an existing skin; apply with name, base and colors saves a new skin and applies it immediately. save with name, base and colors only adds to the library; save with only name copies the active Studio skin. remove deletes a custom skin by id (ask the user first); reset releases the Studio skin and returns to the user's own appearance. The system/light/dark theme is the user's app setting, chosen in the Studio panel or Settings; this tool cannot change it. Never edit app settings or CSS to change skins. A skin contains exactly these 12 color roles: ${COLOR_KEYS.join(", ")}. Provide all colors as #RRGGBB. base is light or dark and sets the application mode. Primary and secondary text must have contrast >=4.5:1 and tertiary text >=3:1 against all six bg surfaces. Keep accent readable on its dim background. Optionally add backdrop { from, to } to paint the window frame and docked sidebar with a diagonal gradient from one #RRGGBB to another; text must meet the same contrast against from and to. A skin may also carry background { image, fit?, effect?, opacity?, onNewChat?, inChat? }; image must be a Base64 data URL for PNG, JPEG, GIF or WebP up to 5 MB. This background overrides display only while the skin is active and never replaces or deletes the user's global background. Film grain is a separate user setting, not part of a skin. Skins are local data, not executable code.`,
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
					backdrop: {
						type: "object",
						description: "Optional gradient behind the window frame and docked sidebar.",
						properties: {
							from: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
							to: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
						},
						required: ["from", "to"],
						additionalProperties: false,
					},
					background: {
						type: "object",
						description: "Optional skin-owned chat background. It overrides display while this skin is active without changing the user's global background.",
						properties: {
							image: { type: "string", pattern: "^data:image/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$" },
							fit: { type: "string", enum: ["cover", "tile"] },
							effect: { type: "string", enum: ["none", "dither", "ascii", "halftone", "scanlines", "grid", "haze"] },
							opacity: { type: "number", minimum: 0.05, maximum: 0.65 },
							onNewChat: { type: "boolean" },
							inChat: { type: "boolean" },
						},
						required: ["image"],
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
							if (
								args.id !== undefined &&
								(args.colors !== undefined ||
									args.name !== undefined ||
									args.base !== undefined ||
									args.backdrop !== undefined ||
									args.background !== undefined)
							) {
								return { output: "Use either id or name/base/colors/backdrop/background, not both.", isError: true };
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
					return { output: JSON.stringify(toolView(view)), details: { activeId: view.activeId } };
				} catch (error) {
					return { output: errorText(error, "en"), isError: true };
				}
			},
		});
	},
} satisfies Plugin;
