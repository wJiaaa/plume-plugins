/**
 * `image_generate` 交给卡片和画廊的 `details`，两个入口共用：开跑时经进度推一份（形状、模型），结果里再给完整的一份。
 */

export const IMAGE_TOOL = "image_generate";

export const ASPECT_RATIOS = ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9", "5:4", "4:5"] as const;
export const QUALITIES = ["low", "medium", "high", "max"] as const;

/** 进度里每一份是一行 JSON：宿主把进度块接在一起，卡片取最后一行完整的。 */
export const PROGRESS_SEPARATOR = "\n";

export interface ImageGenerateDetails {
	kind: typeof IMAGE_TOOL;
	/** 要的比例，`"16:9"`；`auto` 时没有。 */
	aspectRatio?: string;
	count: number;
	/**
	 * 输进去的图，按媒体目录里的名字，按给的顺序。画廊靠它画出一张图是怎么一步步改来的。
	 */
	sources?: string[];
	/**
	 * 没要比例时图多半会是的形状（改图照原图的形状），宽比高。卡片按它先占好位置，图到了不跳。
	 */
	shapeHint?: number;
	/** 哪个模型，id 和卡片上写的名字；连同下面两项，是估进度的依据。 */
	model?: string;
	modelName?: string;
	quality?: string;
	/** 有输入图：是改图，慢一点。 */
	edit?: boolean;
	startedAt?: number;
	/** 正在等着重试时有：卡片说在重试，而不是一个没在发生的阶段。 */
	retry?: { attempt: number; delayMs: number; reason: string };
	/** 为什么失败，给卡片：额度用完、key 不让用、内容被拒是人要去处理的事。 */
	error?: { summary: string; detail?: string; hint?: string; retryAfterMs?: number };
	/** 以下画出来以后才有。每张图存在哪，和 `images` 一一对应。 */
	paths?: string[];
	/** 同样这几张图，按媒体目录里的名字，带上从图片头读到的宽高：`#N` 和卡片读它。 */
	images?: { media: string; mimeType: string; width?: number; height?: number }[];
	references?: number;
	route?: "images" | "chat";
	revisedPrompt?: string;
	failures?: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** 认得出的 `details`；旧的、别的工具的、坏的都是 null，卡片回到通用样子。 */
export function readDetails(value: unknown): ImageGenerateDetails | null {
	if (!isRecord(value) || value.kind !== IMAGE_TOOL || typeof value.count !== "number") return null;
	if (value.images !== undefined && !(Array.isArray(value.images) && value.images.every((image) => isRecord(image) && typeof image.media === "string")))
		return null;
	return value as unknown as ImageGenerateDetails;
}

/** 进度里最后一份完整的 `details`。 */
export function lastProgress(progress: string | undefined): ImageGenerateDetails | null {
	if (!progress) return null;
	const lines = progress.split(PROGRESS_SEPARATOR).filter(Boolean);
	for (let index = lines.length - 1; index >= 0; index--) {
		try {
			const details = readDetails(JSON.parse(lines[index] ?? ""));
			if (details) return details;
		} catch {
			// 被截掉开头的那一行，往前找。
		}
	}
	return null;
}
