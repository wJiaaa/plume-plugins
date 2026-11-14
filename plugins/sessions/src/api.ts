/** 逻辑入口经 `ctx.serve` 开给界面入口的接口。 */

import type { LetterFate } from "@plume/contract";

export interface SessionsApi {
	/** 这几封信有了着落的那些（读到了、钩子拦下了、对方删掉了），按信的 id；还没着落、应用重启前寄的不在里面。 */
	fates(ids: string[]): Promise<Record<string, LetterFate["status"]>>;
}
