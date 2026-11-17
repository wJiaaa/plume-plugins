/**
 * Magpie 接管 Plume 的模型时写进这个插件数据目录 `credentials.json` 的东西，以及它变成的供应商。
 *
 * 写的一方是 Magpie 的 Agent 插件（同目录的 `magpie-agent/`）：它只会按点分路径原地改 JSON 的对象键，
 * 写的是顶层的 `magpie` 块和 `defaultModel`，断开时逐键恢复或删除，删空的 `magpie` 留成 `{}`（所以缺字段是常态，不是损坏）；
 * 它还靠「它写的 key 还在原处」判断这一行是否仍然接着。在 Plume 里的编辑也写回 `magpie` 块，模型沿用 Magpie 的字段名，
 * 额外的能力、价格和档位直接留在同一条模型上。文件里有网关的明文 key，只给本人读写。
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelEntry, ModelRef, PluginProvider, ProviderSettings } from "@plume/contract";

export const CREDENTIALS_FILE = "credentials.json";

/** 供应商 id，也是 Magpie 写的模型引用 `magpie/<网关里的模型 id>` 的前缀。 */
const PROVIDER_ID = "magpie";

/** 和新建模型的默认值一样：Magpie 不知道的就不给，不是 0。 */
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_OUTPUT = 32_000;

type ThinkingOption = NonNullable<ModelEntry["thinkingOptions"]>[number];

/** 标准档位，从浅到深；界面按 id 显示各语言的名字和说明，这里的 `label`、`detail` 只是兜底。 */
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/** Magpie 下发的模型，以及人在 Plume 里补充的配置。 */
interface MagpieModel extends Partial<Pick<ModelEntry, "supportsThinking" | "supportsTools" | "pricing" | "thinkingOptions" | "imageOutput">> {
	/** 网关认的 `<供应商>/<模型>`，或路由组的名字。 */
	id: string;
	name?: string;
	context?: number;
	output?: number;
	images?: boolean;
	/** Magpie 不知道档位时是 null。 */
	efforts?: string[] | null;
}

interface MagpieGateway extends Partial<Pick<ProviderSettings, "name" | "api" | "enabled">> {
	/** 不带 `/v1` 的网关地址；Plume 的适配器拼路径时会处理 `/v1`。 */
	baseUrl: string;
	/** Magpie 给 Plume 的 key，用量按它记在 Plume 名下。 */
	apiKey: string;
	models: MagpieModel[];
}

/** 文件里的内容；不认识的键原样留着，写回时不动。 */
export type Credentials = Record<string, unknown> & { magpie?: unknown; defaultModel?: unknown };

type Log = { warn(message: string): void };

/** 现读文件：没有是 `{}`；读不了、读不懂是 null（调用方保留上一份）。读不懂时不转述原文：里面有 key。 */
export async function readCredentials(dir: string, log: Log): Promise<Credentials | null> {
	const path = join(dir, CREDENTIALS_FILE);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		log.warn(`无法读取 ${path}`);
		return null;
	}
	try {
		const parsed: unknown = raw.trim() ? JSON.parse(raw.replace(/^\uFEFF/, "")) : {};
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid");
		return parsed as Credentials;
	} catch {
		log.warn(`${path} 不是有效的 JSON，先保留上一次读到的 Magpie 网关`);
		return null;
	}
}

/** 原地写回：保留文件（和它 0600 的权限），Magpie 认的是这个路径。 */
export async function writeCredentials(dir: string, credentials: Credentials): Promise<void> {
	await writeFile(join(dir, CREDENTIALS_FILE), `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
}

/** Magpie 写的默认模型；只认这个供应商下的引用，别的不是 Magpie 选的。 */
export function magpieDefaultModel(credentials: Credentials): ModelRef | undefined {
	const value = credentials.defaultModel;
	return typeof value === "string" && value.startsWith(`${PROVIDER_ID}/`) && value.length > PROVIDER_ID.length + 1 ? value : undefined;
}

/** `magpie` 块对应的供应商；不完整就是没接。 */
export function magpieProvider(credentials: Credentials): PluginProvider | undefined {
	const gateway = credentials.magpie;
	if (!gateway || typeof gateway !== "object") return undefined;
	const { baseUrl, apiKey, models, name, api, enabled } = gateway as Partial<MagpieGateway>;
	if (typeof baseUrl !== "string" || !baseUrl || typeof apiKey !== "string" || !apiKey) return undefined;
	return {
		id: PROVIDER_ID,
		name: name || "Magpie",
		// 网关对 Chat Completions、Responses、Anthropic Messages 都代为翻译，一个供应商只能选一种，选哪种都通。
		api: api ?? "openai-responses",
		baseUrl,
		apiKey,
		enabled: enabled ?? true,
		models: (Array.isArray(models) ? models : []).filter((model) => typeof model?.id === "string" && model.id).map(toModel),
	};
}

/** 设置页改过的供应商写回成 `magpie` 块。 */
export function magpieGateway(provider: PluginProvider): MagpieGateway {
	return {
		name: provider.name,
		api: provider.api,
		baseUrl: provider.baseUrl,
		apiKey: provider.apiKey,
		enabled: provider.enabled,
		models: provider.models.map(({ modelId, contextWindow, maxOutputTokens, supportsImages, pricing, ...model }) => ({
			...model,
			id: modelId,
			context: contextWindow,
			output: maxOutputTokens,
			images: supportsImages,
			// 按模型目录补的参考价不存：存下就成了快照，目录更新了也不跟着变。
			...(pricing && pricing.source !== "catalog" ? { pricing } : {}),
		})),
	};
}

function toModel(model: MagpieModel): ModelEntry {
	// Magpie 把「不思考」叫 none，Plume 叫 off；其余档位名两边相同，不认识的丢掉。
	const thinkingOptions = model.thinkingOptions ?? thinkingOptionsFor((model.efforts ?? []).map((effort) => (effort === "none" ? "off" : effort)));
	return {
		modelId: model.id,
		name: model.name || model.id,
		contextWindow: model.context || DEFAULT_CONTEXT_WINDOW,
		maxOutputTokens: model.output || DEFAULT_MAX_OUTPUT,
		// 没给档位不等于不会思考：留给 Plume 的默认几档。
		supportsThinking: model.supportsThinking ?? true,
		supportsImages: model.images ?? false,
		supportsTools: model.supportsTools ?? true,
		...(thinkingOptions.length > 0 ? { thinkingOptions } : {}),
		// Magpie 自己的价格不是 Plume 认的形状，Plume 不认时按模型目录补参考价；这里原样交过去。
		...(model.pricing ? { pricing: model.pricing } : {}),
		...(typeof model.imageOutput === "boolean" ? { imageOutput: model.imageOutput } : {}),
	};
}

/** 按标准顺序排好；默认档是「中」，没有就就近往深、再往浅找（不落到「关闭」），和 Plume 新建模型时一样。 */
function thinkingOptionsFor(levels: readonly string[]): ThinkingOption[] {
	const ids = LEVELS.filter((level) => levels.includes(level));
	const middle = LEVELS.indexOf("medium");
	const order = [...LEVELS.slice(middle), ...LEVELS.slice(1, middle).reverse(), "off"];
	const fallback = order.find((level) => ids.includes(level));
	return ids.map((id): ThinkingOption => ({ id, label: id, detail: "", ...(id === fallback ? { isDefault: true } : {}) }));
}
