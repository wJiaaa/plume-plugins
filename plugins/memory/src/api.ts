/**
 * 逻辑入口经 ctx.serve 开给设置分区的接口，两个入口共用这一份类型。记忆存在逻辑入口那边，设置分区只是读写它。
 */

export interface MemorySettings {
	/** 用户记忆进不进提示词。 */
	user: boolean;
	/** 项目记忆读不读、`learn` 记不记。 */
	project: boolean;
	/** 后台从旧会话总结项目记忆。会把会话内容发给模型，默认关。 */
	extraction: boolean;
}

/** `user` 是人在设置里加的；`auto`、`session` 留给以后自动记下的用户记忆，现在不会出现。 */
export type MemorySource = "user" | "auto" | "session" | "learn" | "extracted";

export interface MemoryEntry {
	id: string;
	content: string;
	createdAt: number;
	updatedAt: number;
	source?: MemorySource;
	/** 最后一次进提示词的时间；还没进过时没有。 */
	lastInjectedAt?: number;
}

export interface LessonView {
	text: string;
	context?: string;
	/** 记下的时间，也是删它时认的那个键。 */
	at: number;
	lastInjectedAt?: number;
}

export interface ProjectMemoryView {
	lessons: LessonView[];
	/** 后台总结的那一份；还没有时为空。 */
	extracted?: { text: string; updatedAt?: number; lastInjectedAt?: number };
}

export interface MemoryApi {
	settings(): Promise<MemorySettings>;
	setSettings(change: Partial<MemorySettings>): Promise<MemorySettings>;
	/** 后台总结用的模型（`SessionModel.id`）；没选时是 undefined，用新会话的默认模型。 */
	model(): Promise<string | undefined>;
	setModel(model: string | undefined): Promise<void>;
	/** 用户记忆，新加的在前。 */
	list(): Promise<MemoryEntry[]>;
	add(content: string): Promise<MemoryEntry>;
	remove(id: string): Promise<boolean>;
	clear(): Promise<void>;
	/** 可选的项目目录：会话开在项目里的那些目录，加上已经存了记忆的目录，最近用过的在前。 */
	projects(): Promise<string[]>;
	projectMemory(path: string): Promise<ProjectMemoryView>;
	forgetLesson(path: string, at: number): Promise<boolean>;
	forgetExtracted(path: string): Promise<boolean>;
	forgetAll(path: string): Promise<void>;
}
