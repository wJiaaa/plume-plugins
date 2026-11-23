/**
 * plume.chatgpt 的逻辑入口，跑在 agent 进程：用 ChatGPT 账号登录（Sign in with ChatGPT），把套餐额度经 `ctx.providers`
 * 交给模型设置，成为「ChatGPT」供应商。
 *
 * 供应商声明 `route: "chatgpt-plan"`：地址和 API key 一样是 `api.openai.com/v1`，请求体要守这条通道的规矩，由宿主按声明组。
 * 令牌只在这个进程里：经 `ctx.secrets` 封好存进数据目录，界面经 `ctx.store` 只看到连没连上、哪个账号、出了什么错。
 */

import type { Plugin } from "@plume/contract";
import { type ChatGptApi, INITIAL_STATE, STATE_KEY } from "./api.ts";
import { Connection } from "./connection.ts";
import { callbackPage, MESSAGES } from "./messages.ts";

/** 多久看一次令牌该不该刷新。比提前量（5 分钟）短得多，电脑睡醒后很快就补上。 */
const TICK_MS = 30_000;

export default {
	name: "plume.chatgpt",
	async apply(ctx) {
		const lifetime = new AbortController();
		ctx.effect(() => lifetime.abort());
		const state = ctx.store(STATE_KEY, INITIAL_STATE);
		/** 上一次交给本体的供应商：真变了才说 `changed()`，令牌没换、只是状态变了时不让设置页重取。 */
		let shown = "";

		const connection: Connection = new Connection({
			fetch: ctx.fetch,
			secrets: ctx.secrets,
			dataDir: ctx.dataDir,
			log: ctx.log,
			signal: lifetime.signal,
			callbackPage: (ok) => callbackPage(ctx.locale(), ok),
			describe: (code) => MESSAGES[ctx.locale()].errors[code],
			changed: () => {
				state.set(connection.state());
				const next = JSON.stringify(connection.provider() ?? null);
				if (next !== shown) {
					shown = next;
					ctx.providers.changed();
				}
			},
		});

		ctx.providers.provide({
			list: () => {
				const provider = connection.provider();
				return provider ? [provider] : [];
			},
			save: (provider) => connection.saveProvider(provider),
			remove: () => connection.removeProvider(),
			failed: (providerId, failure) => connection.failed(providerId, failure),
		});

		const api: ChatGptApi = {
			signIn: (fresh, call) => connection.signIn(call.signal, fresh),
			disconnect: () => connection.disconnect(),
		};
		ctx.serve(api);

		// 等读完再算启用好：开机就有 ChatGPT 的供应商，默认模型不会先落到别的上。
		await connection.load();
		const tick = () => void connection.tick().catch((error: unknown) => ctx.log.warn(`ChatGPT 连接的定时检查出错：${String(error)}`));
		tick();
		const timer = setInterval(tick, TICK_MS);
		timer.unref?.();
		ctx.effect(() => clearInterval(timer));
	},
} satisfies Plugin;
