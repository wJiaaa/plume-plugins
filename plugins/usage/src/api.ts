/** 逻辑入口经 `ctx.serve` 开给界面入口的接口，两个入口共用这一份类型。 */

import type { UsageScan } from "@plume/contract";

export interface UsageApi {
	/** 花销表里的全部调用，按小时、供应商、模型合好，带上供应商现在的名字。 */
	scan(): Promise<UsageScan>;
}
