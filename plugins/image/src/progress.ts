/**
 * 一张图大概画到哪了，这一段叫什么。
 *
 * 生图接口不报进度（中转一次把整张图交回来），卡片上的数是按这类图通常要多久估的：先涨得快，接近预期时间时放慢，
 * 到不了头——什么都没来就走到 100% 的读数是在撒谎。真正的终点是图到了，那时才跳过去。
 */

/** 一张图通常要的时长，在中转上量的：Gemini 的 flash 快，OpenAI 的慢。 */
function baseMs(modelId: string): number {
	const id = modelId.toLowerCase();
	if (/gpt-image|chatgpt-image|dall-e/.test(id)) return 45_000;
	if (/pro-image|imagen-4\.0-ultra|seedream/.test(id)) return 35_000;
	return 22_000;
}

/** 这一次预计要多久。几张图并排画，多一张只多一点，不是乘 n。 */
export function expectedMs(modelId: string, quality?: string, count = 1, edit = false): number {
	const detail = quality === "max" ? 2.6 : quality === "high" ? 1.5 : quality === "low" ? 0.8 : 1;
	return baseMs(modelId) * detail * (1 + 0.12 * (count - 1)) * (edit ? 1.15 : 1);
}

/** 估计值自己走不到的上限。 */
export const ESTIMATE_CEILING = 0.96;

/**
 * 过去的时间折成比例：到预期时间时约 85%，之后慢慢逼近上限。
 *
 * 用指数而不是直线：画得久的那一次读数还在动，不停在一个数上——人读成「卡住了」的，正是不再变的那个数。
 */
export function progressAt(elapsedMs: number, expected: number): number {
	if (elapsedMs <= 0) return 0;
	return ESTIMATE_CEILING * (1 - Math.exp((-elapsedMs * 2) / expected));
}

export type Stage = "brief" | "draft" | "scene" | "detail" | "finish";

const STAGES: [number, Stage][] = [
	[0.12, "brief"],
	[0.38, "draft"],
	[0.66, "scene"],
	[0.88, "detail"],
	[Infinity, "finish"],
];

export function stageAt(progress: number): Stage {
	return STAGES.find(([upTo]) => progress < upTo)?.[1] ?? "finish";
}
