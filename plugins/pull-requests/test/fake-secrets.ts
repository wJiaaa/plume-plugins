import type { SecretsService } from "@plume/contract";

/**
 * 服务 `secrets` 的替身：前缀和真的一样，内容只做 base64，测的是插件有没有把令牌交给它、出错时怎么办。
 * `state` 设成 `lost` 时什么都解不开（钥匙丢了、换了），`unreadable` 时一解就抛错（钥匙文件读不出来）。
 */
export function fakeSecrets(): SecretsService & { state: "ok" | "lost" | "unreadable" } {
	const prefix = "plume-sealed:v1:";
	const fake = {
		state: "ok" as "ok" | "lost" | "unreadable",
		seal: async (value: string) => {
			if (fake.state === "unreadable") throw new Error("vault.key unreadable");
			return prefix + Buffer.from(value).toString("base64");
		},
		unseal: async (sealed: string) => {
			if (fake.state === "unreadable") throw new Error("vault.key unreadable");
			if (fake.state === "lost" || !sealed.startsWith(prefix)) return null;
			return Buffer.from(sealed.slice(prefix.length), "base64").toString();
		},
		isSealed: (value: string) => value.startsWith(prefix),
	};
	return fake;
}
