/**
 * plume.image 的逻辑入口：工具 `image_generate`，有生图模型时才进工具表、带上两句用法；画廊的数据经 `ctx.serve` 交给界面入口。
 */

import type { Plugin } from "@plume/contract";
import type { ImageApi } from "./api.ts";
import { GalleryReader } from "./gallery.ts";
import { imageTool, withImageGuidelines } from "./tool.ts";
import { IMAGE_TOOL } from "./types.ts";

export default {
	name: "plume.image",
	apply(ctx) {
		ctx.tools.register(imageTool(ctx));

		// 一个生图模型都没有时不给模型看这个工具：一个只会答「没配模型」的工具只会被拿来试。每次请求按当时的设置看。
		ctx.hook("model.context", async (input, next) => {
			const found = await ctx.model.findImageModel();
			if (!found.model && found.reason === "none") return next({ ...input, tools: input.tools.filter((tool) => tool.name !== IMAGE_TOOL) });
			if (!input.tools.some((tool) => tool.name === IMAGE_TOOL)) return next(input);
			return next({
				...input,
				sections: withImageGuidelines(
					input.sections,
					input.tools.some((tool) => tool.name === "preview"),
				),
			});
		});

		const gallery = new GalleryReader(ctx.sessions);
		ctx.sessions.onDeleted((sessionId) => gallery.forget(sessionId));
		ctx.serve({ gallery: () => gallery.list() } satisfies ImageApi);
	},
} satisfies Plugin;
