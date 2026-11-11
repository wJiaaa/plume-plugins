import type { Locale } from "@plume/contract";
import type { WelcomeLine } from "@plume/contract/ui";

/** 逻辑入口经 `ctx.serve` 开给界面入口的接口。 */
export interface WelcomeApi {
	/** 今天的那一句（按界面语言）；没配模型、没写出来时是 undefined，欢迎页显示宿主默认的那一行。 */
	today(locale: Locale): Promise<WelcomeLine | undefined>;
}
