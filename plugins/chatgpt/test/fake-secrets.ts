import type { PluginSecrets } from "@plume/contract";

/**
 * `ctx.secrets` 的替身：前缀和真的一样，内容只做 base64，测的是插件有没有把令牌交给它、钥匙换了时怎么办。
 * `rotate()` 换一把新钥匙，之前封的都解不开（null）。
 */
export function fakeSecrets(): PluginSecrets & { rotate(): void } {
	const prefix = "plume-sealed:v1:";
	let key = 0;
	return {
		rotate: () => void (key += 1),
		seal: async (value: string) => `${prefix}${key}.${Buffer.from(value).toString("base64")}`,
		unseal: async (sealed: string) => {
			if (!sealed.startsWith(prefix)) return null;
			const [sealedWith, body] = sealed.slice(prefix.length).split(".");
			return Number(sealedWith) === key && body !== undefined ? Buffer.from(body, "base64").toString() : null;
		},
		isSealed: (value: string) => value.startsWith(prefix),
	};
}
