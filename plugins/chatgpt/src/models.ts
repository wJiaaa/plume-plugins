/**
 * 账号能用的模型：`GET https://api.openai.com/v1/models`，带登录拿到的令牌（官方「Models and inference」页）。
 * 返回的是 `{ models: [{ slug, display_name, visibility }] }`，不是 API key 那条路上的 `{ data: [...] }`；只留
 * `visibility: "list"` 的，按服务端给的顺序。
 *
 * 文档只说了 slug 和显示名。上下文窗口、能不能看图这些，响应里带了（`context_window`、`input_modalities`）就照用，
 * 没带用下面的默认值——没在真实账号上核对过响应里到底有哪些字段。
 */

import type { ModelEntry, PluginFetch } from "@plume/contract";
import { ChatGptError } from "./errors.ts";
import { RESOURCE, readJson } from "./oauth.ts";

/** 没给上下文窗口时按这个算：比 GPT-5 系的窗口小，宁可早一点压缩，也不让请求撞上限。 */
const DEFAULT_CONTEXT = 200_000;
/** 这条通道不收 `max_output_tokens`（宿主不发），这个数只用来给输出留出上下文的余量。 */
const DEFAULT_OUTPUT = 32_000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function entryOf(raw: Record<string, unknown>): ModelEntry | undefined {
	if (raw.visibility !== "list" || typeof raw.slug !== "string" || !raw.slug.trim() || raw.slug.length > 200) return undefined;
	const name = typeof raw.display_name === "string" && raw.display_name.trim() ? raw.display_name.trim() : raw.slug;
	const context =
		typeof raw.context_window === "number" && Number.isInteger(raw.context_window) && raw.context_window > 0 ? raw.context_window : DEFAULT_CONTEXT;
	const modalities = Array.isArray(raw.input_modalities) ? raw.input_modalities : undefined;
	return {
		modelId: raw.slug,
		name,
		contextWindow: context,
		maxOutputTokens: Math.min(DEFAULT_OUTPUT, Math.floor(context / 4)),
		// 官方模型表只承诺 slug 和显示名。没有能力字段时只开放这条通道明确支持的文本和本地函数工具，不猜思考或图片能力。
		supportsThinking: raw.supports_reasoning === true,
		supportsImages: modalities?.includes("image") ?? false,
		supportsTools: raw.supports_tools !== false,
		// 花的是套餐额度，不按 token 计费：写成手填的 0，宿主不按模型目录补一个不存在的参考价。
		pricing: { input: 0, output: 0, source: "manual" },
		imageOutput: false,
	};
}

export async function listModels(fetch: PluginFetch, accessToken: string, signal: AbortSignal): Promise<ModelEntry[]> {
	let response: Response;
	try {
		response = await fetch(`${RESOURCE}/models`, {
			headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
			signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
		});
	} catch (error) {
		if (signal.aborted) throw error;
		throw new ChatGptError("models_failed", "model list request failed");
	}
	const data = await readJson(response);
	if (!response.ok || !isRecord(data) || !Array.isArray(data.models)) throw new ChatGptError("models_failed", `model list returned ${response.status}`);
	const seen = new Set<string>();
	const models: ModelEntry[] = [];
	for (const raw of data.models) {
		const entry = isRecord(raw) ? entryOf(raw) : undefined;
		if (!entry || seen.has(entry.modelId)) continue;
		seen.add(entry.modelId);
		models.push(entry);
	}
	return models;
}

/**
 * 新拉到的模型表和人在设置页改过的合起来：还在的用人改过的那份，新出现的用默认的；表里没有了的去掉（账号用不了了）。
 * 人删掉的模型下次重新登录、重新拉表时会回来。
 */
export function mergeModels(fetched: ModelEntry[], edited: ModelEntry[] | undefined): ModelEntry[] {
	if (!edited) return fetched;
	const byId = new Map(edited.map((model) => [model.modelId, model]));
	return fetched.map((model) => byId.get(model.modelId) ?? model);
}
