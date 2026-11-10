/**
 * 逻辑入口经 ctx.serve 开给设置页的接口，两个入口共用这一份类型。索引在逻辑入口那边建、存、搜，设置页只是看和触发。
 */

import type { IndexStats } from "./symbols.ts";

export type { IndexStats };

export interface SymbolHit {
	name: string;
	kind: string;
	/** 相对项目目录。 */
	file: string;
	line: number;
}

export interface IndexApi {
	stats(path: string): Promise<IndexStats>;
	/** 重新建这个目录的索引并存下；开在这个目录的会话下一次查时用新的。 */
	rebuild(path: string): Promise<IndexStats>;
	/** 按名字搜，最多 50 条；还没建过就先建一份（不存）。 */
	search(path: string, query: string): Promise<SymbolHit[]>;
	/** 用默认应用打开项目里的一个文件；只认项目目录里面的。 */
	open(path: string, file: string): Promise<void>;
}
