import type { PluginSecrets } from "@plume/contract";

/**
 * `ctx.secrets` 的替身：前缀和真的一样，内容只做 base64，测的是插件有没有把令牌交给它、出错时怎么办。
 * 密文里记着封它的是第几把钥匙：`rotate()` 换一把新的（钥匙丢了、换了），之前封的都解不开（null），之后封的照常；
 * `unreadable` 设成 true 时一解就抛错（钥匙文件读不出来）。
 */
export function fakeSecrets(): PluginSecrets & { unreadable: boolean; rotate(): void } {
	const prefix = "plume-sealed:v1:";
	let key = 0;
	const fake = {
		unreadable: false,
		rotate: () => void (key += 1),
		seal: async (value: string) => {
			if (fake.unreadable) throw new Error("vault.key unreadable");
			return `${prefix}${key}.${Buffer.from(value).toString("base64")}`;
		},
		unseal: async (sealed: string) => {
			if (fake.unreadable) throw new Error("vault.key unreadable");
			if (!sealed.startsWith(prefix)) return null;
			const [sealedWith, body] = sealed.slice(prefix.length).split(".");
			return Number(sealedWith) === key && body !== undefined ? Buffer.from(body, "base64").toString() : null;
		},
		isSealed: (value: string) => value.startsWith(prefix),
	};
	return fake;
}
