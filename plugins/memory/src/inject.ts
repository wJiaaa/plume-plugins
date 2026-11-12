/**
 * 什么作为记忆进提示词，以及记下它进过。
 *
 * 两份来源、两种范围：人自己的偏好（用户记忆），这个项目的记忆（`learn` 写的、后台总结写的）。各占系统提示词的一段：
 * `userMemory`、`projectMemory`，插在项目指令前面（没有项目指令时接在个人指令或准则后面，见 `insertSections`）。两段都标 `category: "memory"`：
 * 上下文用量、使用统计按类别把它们算进「记忆」，不认段名。
 *
 * 一个会话里冻结，压缩、撤回或重新载入时刷新：第一次组提示词时读一次磁盘，之后同一个会话一直用这份。每轮重读的话，每次 `learn`（和后台总结写 `MEMORY.md`）
 * 都改一次系统提示词，整段对话的缓存跟着重写；而会话里 `learn` 的调用和结果本来就在历史里，模型看得到自己刚记下了什么。
 * 人在设置里删改记忆是另一回事：他要的是那条立刻不再进提示词，所以设置里的改动作废全部快照（`invalidate`）。
 * 压缩、撤回或重新载入会话时，历史里的 `learn` 结果可能没了，快照随之刷新；手改文件、别的会话里的 `learn`、后台总结在这个边界读入。
 */

import { join } from "node:path";
import type { PromptSection } from "@plume/contract";
import type { MemorySettings } from "./api.ts";
import { EXTRACTED_KEY, markInjected, projectInjectedFile, userInjectedFile } from "./injected.ts";
import { projectMemorySection, readExtractedMemory, readLessons } from "./project-memory.ts";
import { formatMemoryForPrompt, loadMemory } from "./user-memory.ts";

interface Snapshot {
	/** 读它时的目录和开关：换了项目或改了开关，同一个会话也要重读。 */
	readFor: string;
	sections: PromptSection[];
	userKeys: string[];
	projectKeys: string[];
}

export function createInjector(dataDir: string) {
	const snapshots = new Map<string, Snapshot>();

	async function read(readFor: string, dir: string, settings: MemorySettings): Promise<Snapshot> {
		const sections: PromptSection[] = [];
		let userKeys: string[] = [];
		if (settings.user) {
			// 记忆坏了也不能开不了会话：读不出就当没有。
			const entries = await loadMemory(dataDir).catch(() => []);
			const text = formatMemoryForPrompt(entries);
			if (text) sections.push({ id: "userMemory", text, category: "memory" });
			userKeys = entries.map((entry) => entry.id);
		}
		let projectKeys: string[] = [];
		if (settings.project) {
			const [lessons, extracted] = await Promise.all([readLessons(dir).catch(() => []), readExtractedMemory(dir).catch(() => "")]);
			const { text, files } = projectMemorySection(lessons, extracted);
			if (text)
				sections.push({ id: "projectMemory", text, category: "memory", files: files.map((file) => ({ path: join(dir, file.name), chars: file.chars })) });
			projectKeys = [...lessons.map((lesson) => lesson.text), ...(extracted.trim() ? [EXTRACTED_KEY] : [])];
		}
		return { readFor, sections, userKeys, projectKeys };
	}

	return {
		/** 这个会话这一次请求要加的段，并记下它们进了提示词。 */
		async sections(sessionId: string, dir: string, settings: MemorySettings, now = Date.now()): Promise<PromptSection[]> {
			if (!settings.user && !settings.project) return [];
			const readFor = `${dir}\0${settings.user}\0${settings.project}`;
			const held = snapshots.get(sessionId);
			const snapshot = held?.readFor === readFor ? held : await read(readFor, dir, settings);
			snapshots.set(sessionId, snapshot);
			// 时间戳写不下不能让这一轮跟着失败。
			await Promise.all([
				snapshot.userKeys.length > 0 && snapshot.sections.some((section) => section.id === "userMemory")
					? markInjected(userInjectedFile(dataDir), snapshot.userKeys, now).catch(() => false)
					: false,
				snapshot.projectKeys.length > 0 ? markInjected(projectInjectedFile(dir), snapshot.projectKeys, now).catch(() => false) : false,
			]);
			return snapshot.sections;
		},
		/** 历史被压缩或重新载入，下一次请求重新读取这个会话的记忆；删除会话时也释放它。 */
		refresh(sessionId: string): void {
			snapshots.delete(sessionId);
		},
		/** 人在设置里改了记忆：所有会话下一次请求重新读。 */
		invalidate(): void {
			snapshots.clear();
		},
	};
}

/**
 * 把记忆的段插在项目指令（`conventions`）前面；没有项目指令时接在最后一段个人指令（`instructions`）后面，
 * 也没有就接在准则（`guidelines`）后面；都没有接在最后。只按类别找，不认提供这些段的插件定的段名。
 */
export function insertSections(sections: PromptSection[], extra: PromptSection[]): PromptSection[] {
	if (extra.length === 0) return sections;
	const after = (category: string) => {
		const index = sections.findLastIndex((section) => section.category === category);
		return index < 0 ? -1 : index + 1;
	};
	let at = sections.findIndex((section) => section.category === "conventions");
	if (at < 0) at = after("instructions");
	if (at < 0) at = after("guidelines");
	if (at < 0) at = sections.length;
	return [...sections.slice(0, at), ...extra, ...sections.slice(at)];
}
