/**
 * Magpie 写的默认模型（`credentials.json` 的 `defaultModel`）怎么变成 Plume 的默认模型。
 *
 * Magpie 选了一个模型：记下 Plume 原来的默认模型，把它设成默认。Magpie 断开（这一键恢复成没有）：Plume 的默认模型还是
 * Magpie 设的那个时换回原来的；人在 Plume 里另选过就不动。记的东西放在 `default-model.json`：只在 Magpie 改了这一键时才动
 * Plume 的设置，重启 Plume 不会把人后来在 Plume 里选的盖回去；Plume 关着时 Magpie 改的，下次启动照样跟上。
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelRef, PluginContext } from "@plume/contract";
import { type Credentials, magpieDefaultModel } from "./gateway.ts";

const STATE_FILE = "default-model.json";

interface State {
	/** 最近一次照 Magpie 设成默认的模型。 */
	applied?: ModelRef;
	/** 那之前 Plume 的默认模型，Magpie 断开时换回它。 */
	previous?: ModelRef;
}

export async function syncDefaultModel(ctx: Pick<PluginContext, "dataDir" | "providers" | "log">, credentials: Credentials): Promise<void> {
	const path = join(ctx.dataDir, STATE_FILE);
	const state = await readFile(path, "utf8").then(
		(raw) => JSON.parse(raw) as State,
		() => ({}) as State,
	);
	const wanted = magpieDefaultModel(credentials);
	if (wanted === state.applied) return;
	if (wanted) {
		const previous = state.applied ? state.previous : await ctx.providers.defaultModel();
		// 设不上（比如模型不在 Magpie 写的列表里）就不记，Magpie 下次改了再试。
		await ctx.providers.setDefaultModel(wanted);
		await writeFile(path, JSON.stringify({ applied: wanted, previous } satisfies State));
		return;
	}
	if (state.previous && (await ctx.providers.defaultModel()) === state.applied) {
		await ctx.providers.setDefaultModel(state.previous).catch((error: unknown) => {
			ctx.log.warn(`换回 Magpie 接管前的默认模型 ${state.previous} 失败：${error instanceof Error ? error.message : String(error)}`);
		});
	}
	await writeFile(path, "{}");
}
