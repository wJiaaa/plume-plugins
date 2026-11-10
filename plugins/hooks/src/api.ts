/** 逻辑入口经 `ctx.serve` 开给界面入口的接口，两个入口共用。 */

import type { CallContext } from "@plume/contract";
import type { HookDraft, HookEventName, HookScope } from "./config.ts";
import type { HookRunRecord } from "./runs.ts";

export type { HookDraft, HookEventName, HookRunRecord, HookScope };

/** 设置页上的一条钩子。 */
export interface HookView {
	id: string;
	scope: HookScope;
	event: HookEventName;
	matcher?: string;
	type: "command" | "process";
	command: string;
	args?: string[];
	async?: boolean;
	shell?: true | string;
	/** 秒。 */
	timeout?: number;
	statusMessage?: string;
	enabled: boolean;
	/** 认不出的键，原样留着。 */
	custom?: Record<string, unknown>;
	/** 只有项目钩子有：这一条的内容是否已被这台机器信任过。没信任的在会话里不运行。 */
	trusted?: boolean;
}

export interface HooksView {
	user: HookView[];
	/** 用户钩子的配置文件路径，给人看。 */
	file: string;
	/** 用户钩子的配置文件读不懂时的原因；这时 `user` 是空的，改动会被拒绝，免得把写坏了的那份冲掉。 */
	error?: string;
	/** 没选项目时是 null。 */
	project: HookView[] | null;
	/** 项目钩子所在的文件。 */
	projectPath?: string;
	/** 项目的 `.plume/config.json` 读不懂时，为什么。 */
	projectError?: string;
}

export interface HooksApi {
	/** `cwd` 是页上选的项目目录，null 只看用户钩子。 */
	list(cwd: string | null): Promise<HooksView>;
	/** `id` 为 null 是新建。 */
	save(scope: HookScope, cwd: string | null, id: string | null, draft: HookDraft): Promise<HooksView>;
	remove(scope: HookScope, cwd: string | null, id: string): Promise<HooksView>;
	setEnabled(scope: HookScope, cwd: string | null, id: string, enabled: boolean): Promise<HooksView>;
	/** 信任这个项目里的这几条钩子：按内容记指纹，命令改了要再信任一次。 */
	trust(cwd: string, ids: string[]): Promise<HooksView>;
	/** 一个会话的钩子运行记录，旧的在前。 */
	runs(sessionId: string): Promise<HookRunRecord[]>;
	/** 运行记录变了的会话 id，攒着一批推。 */
	watch(call: CallContext): AsyncGenerator<string[], void>;
}
