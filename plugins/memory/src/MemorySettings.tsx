/**
 * 「个性化」页里记忆那一节：三个开关、用户记忆的列表、按项目看项目记住了什么。
 *
 * 用户记忆和项目记忆放在一起，因为问的是同一件事：模型知道我什么，它们真的到了模型那里没有。
 * 项目在这里选，而不是跟着打开着的会话：跟着会话的话，想看另一个项目的记忆只能先去打开它的一个会话。
 * 磁盘上的文件才是这份清单的本体，而它不止这一处在写（`learn`、后台总结）：删完重读，不在界面上就地抠掉一条。
 */

import { useCallback, useEffect, useState } from "react";
import { field } from "@plume/styles";
import { Button, IconButton, InlineSelect, Input, SettingsCard, SettingsRow, SettingsSectionTitle, Text, Toggle, useConfirmer, useI18n } from "@plume/ui";
import { Brain, Plus, Trash2 } from "@plume/ui/icons";
import type { Remote } from "@plume/contract/ui";
import type { MemoryApi, MemoryEntry, MemorySettings as Settings, ProjectMemoryView } from "./api.ts";
import { MemoryMeta } from "./MemoryMeta.tsx";
import { MESSAGES } from "./messages.ts";

export function MemorySettings({ api }: { api: Remote<MemoryApi> }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const confirm = useConfirmer();
	const [settings, setSettings] = useState<Settings | null>(null);
	const [entries, setEntries] = useState<MemoryEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [draft, setDraft] = useState("");
	const [projects, setProjects] = useState<string[]>([]);
	const [picked, setPicked] = useState<string | null>(null);
	const project = projects.find((path) => path === picked) ?? projects[0] ?? null;
	/** 按项目分开存：刚离开的那个读得慢，结果也落不到现在选的这个上。`undefined` 是在读，`null` 是读不出。 */
	const [projectMemories, setProjectMemories] = useState<Record<string, ProjectMemoryView | null>>({});
	const projectMemory = project ? projectMemories[project] : null;
	const hasProjectMemory = Boolean(projectMemory && (projectMemory.lessons.length > 0 || projectMemory.extracted));

	const loadEntries = useCallback(async () => {
		try {
			setEntries(await api.list());
		} catch {
			// 读不出就当没有，设置页照常能用。
		} finally {
			setLoading(false);
		}
	}, [api]);

	useEffect(() => {
		void api.settings().then(setSettings);
		void api.projects().then(setProjects);
		void loadEntries();
	}, [api, loadEntries]);

	const loadProjectMemory = useCallback(() => {
		if (!project) return;
		const store = (memory: ProjectMemoryView | null) => setProjectMemories((current) => ({ ...current, [project]: memory }));
		void api
			.projectMemory(project)
			.then(store)
			.catch(() => store(null));
	}, [api, project]);

	useEffect(() => loadProjectMemory(), [loadProjectMemory]);

	const change = async (patch: Partial<Settings>) => setSettings(await api.setSettings(patch));

	const add = async () => {
		if (!draft.trim()) return;
		try {
			const entry = await api.add(draft.trim());
			setEntries((current) => [entry, ...current]);
			setDraft("");
		} catch {
			// 记忆文件读不出时不覆盖它，这次就没加上。
		}
	};

	const remove = async (id: string) => {
		await api.remove(id).catch(() => false);
		await loadEntries();
	};

	const forget = async (work: (path: string) => PromiseLike<unknown>) => {
		if (!project) return;
		await Promise.resolve(work(project)).catch(() => undefined);
		loadProjectMemory();
	};

	return (
		<>
			<div className="memory-head">
				<div>
					<SettingsSectionTitle>{text.title}</SettingsSectionTitle>
					<Text as="p" size="caption" tone="muted" className="memory-intro">
						{text.intro}
					</Text>
				</div>
				{entries.length > 0 && (
					<Button
						variant="danger"
						size="sm"
						label={text.clearMemory}
						icon={<Trash2 size={13} strokeWidth={1.8} />}
						onClick={() =>
							confirm.ask({
								title: text.confirmClear,
								confirmLabel: text.confirm,
								onConfirm: () =>
									void api
										.clear()
										.then(() => setEntries([]))
										.catch(() => undefined),
							})
						}
					/>
				)}
			</div>

			<SettingsCard>
				<SettingsRow
					title={text.user}
					detail={text.userDetail}
					control={<Toggle checked={settings?.user !== false} onChange={(user) => void change({ user })} />}
				/>
				{/* 说清代价：这一条要把对话内容发出去，跟上面只在本机读写的两条不同。 */}
				<SettingsRow
					title={text.project}
					detail={text.projectDetail}
					control={<Toggle checked={settings?.project !== false} onChange={(project) => void change({ project })} />}
				/>
				<SettingsRow
					title={text.autoProject}
					detail={text.autoProjectDetail}
					control={<Toggle checked={settings?.extraction === true} onChange={(extraction) => void change({ extraction })} />}
				/>
			</SettingsCard>

			{settings?.user !== false && (
				<div className="memory-list">
					<Text as="div" size="label" className="memory-add">
						<Input
							type="text"
							value={draft}
							onChange={(event) => setDraft(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && draft.trim()) void add();
							}}
							placeholder={text.addPlaceholder}
							className={`${field} memory-add-input`}
						/>
						<Button variant="primary" disabled={!draft.trim()} onClick={() => void add()} icon={<Plus size={14} strokeWidth={2} />} label={text.add} />
					</Text>
					{entries.length > 0 ? (
						<div className="memory-items">
							{entries.map((entry) => (
								<div key={entry.id} className="memory-item">
									<div className="memory-item-main">
										<Brain size={15} strokeWidth={1.8} className="memory-item-icon" />
										<div className="memory-item-body">
											<Text size="detail" className="memory-item-text">
												{entry.content}
											</Text>
											<MemoryMeta source={entry.source ?? "user"} createdAt={entry.createdAt} lastInjectedAt={entry.lastInjectedAt} />
										</div>
									</div>
									<IconButton tone="danger" label={text.deleteOne} onClick={() => void remove(entry.id)} icon={<Trash2 size={13.5} strokeWidth={1.8} />} />
								</div>
							))}
						</div>
					) : (
						<Text as="div" size="caption" tone="faint" className="memory-empty">
							{loading ? text.reading : text.empty}
						</Text>
					)}
				</div>
			)}

			{project && (
				<div className="memory-project" data-project-memory="">
					<div className="memory-project-head">
						<div className="memory-project-pick">
							<Text as="p" size="caption" tone="muted" className="memory-project-label">
								{text.rememberedByProject}
							</Text>
							<InlineSelect
								value={project}
								onChange={setPicked}
								options={projects.map((path) => ({ value: path, label: path.split(/[\\/]/).findLast(Boolean) ?? path, detail: path }))}
								ariaLabel={text.projectLabel}
							/>
						</div>
						{/* 「全部忘掉」和逐条删是两种意图：逐条删是修一条错的，全部忘掉是这个项目重新开始。 */}
						{hasProjectMemory && (
							<Button
								variant="danger"
								size="sm"
								onClick={() =>
									confirm.ask({
										title: text.confirmForgetAllProject,
										confirmLabel: text.confirm,
										onConfirm: () => void forget((path) => api.forgetAll(path)),
									})
								}
								data-project-memory-clear=""
							>
								{text.forgetAllProject}
							</Button>
						)}
					</div>
					{!projectMemory || !hasProjectMemory ? (
						<Text as="div" size="caption" tone="faint" className="memory-empty" data-project-memory-empty="">
							{projectMemory === undefined ? text.reading : text.projectMemoryEmpty}
						</Text>
					) : (
						<div className="memory-items">
							{/* 每一条都要能删：它们进这个项目的每一次请求，一条过时的记忆是一句对模型永远重复的指示。 */}
							{projectMemory.lessons.map((lesson) => (
								<div key={`${lesson.at}-${lesson.text}`} className="memory-item memory-item-top" data-project-lesson="">
									<div className="memory-item-body">
										<Text size="detail" className="memory-item-text">
											{lesson.text}
										</Text>
										{lesson.context && (
											<Text size="caption" tone="muted" className="memory-item-text">
												{text.appliesTo(lesson.context)}
											</Text>
										)}
										<MemoryMeta source="learn" createdAt={lesson.at} lastInjectedAt={lesson.lastInjectedAt} />
									</div>
									<IconButton
										tone="danger"
										label={text.deleteOne}
										onClick={() => void forget((path) => api.forgetLesson(path, lesson.at))}
										icon={<Trash2 size={13.5} strokeWidth={1.8} />}
									/>
								</div>
							))}
							{projectMemory.extracted && (
								<div className="memory-item memory-item-top" data-project-extracted="">
									<div className="memory-item-body">
										<Text as="p" size="detail" className="memory-extracted">
											{projectMemory.extracted.text}
										</Text>
										<MemoryMeta
											source="extracted"
											createdAt={projectMemory.extracted.updatedAt ?? Date.now()}
											lastInjectedAt={projectMemory.extracted.lastInjectedAt}
										/>
									</div>
									{/* 后台总结的那一份是整份重写的，所以只有「整份丢掉」这一个动作，下次总结会重新写。 */}
									<IconButton
										tone="danger"
										label={text.deleteExtracted}
										onClick={() => void forget((path) => api.forgetExtracted(path))}
										icon={<Trash2 size={13.5} strokeWidth={1.8} />}
									/>
								</div>
							)}
						</div>
					)}
				</div>
			)}
			{confirm.element}
		</>
	);
}
