import { join } from "node:path";
import type { Plugin } from "@plume/contract";
import type { ImApi } from "./api.ts";
import { createImStore } from "./config.ts";

export default {
	name: "plume.im",
	inject: ["secrets"],
	apply(ctx) {
		const store = createImStore(join(ctx.dataDir, "settings.json"), ctx.use("secrets"));
		const api: ImApi = {
			settings: () => store.view(),
			setEnabled: (channel, enabled) => store.setEnabled(channel, enabled),
			setConfig: (input) => store.setConfig(input),
			setSecret: (channel, secret) => store.setSecret(channel, secret),
			clearSecret: (channel) => store.setSecret(channel, ""),
		};
		ctx.serve(api);
	},
} satisfies Plugin;
