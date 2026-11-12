/**
 * 设置页「索引库」。页头由宿主画。
 *
 * 这一页自己选项目，不跟着打开的会话走：跟着走的话，想看另一个项目的索引只能先去开它的一个会话。
 * 索引是目录的，两个项目开在同一个目录上时是同一份，只列一次，名字把这几个项目都写上。
 */

import type { ProjectInfo, Remote, UiContext } from "@plume/contract/ui";
import { ActionSpinner, DialogAction, InlineSelect, Scroller, SearchField, SettingsCard, SettingsRow, SettingsSectionTitle, Text, useI18n } from "@plume/ui";
import { Database, RefreshCw } from "@plume/ui/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import type { IndexApi, IndexStats, SymbolHit } from "./api.ts";
import { MESSAGES } from "./messages.ts";

type Notify = (message: string, level?: "info" | "warn" | "error") => void;

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** 每个目录一项，按侧栏顺序，排在前面的那个项目代表它。 */
function onePerFolder(projects: readonly ProjectInfo[]): string[] {
	return [...new Set(projects.map((project) => project.path))];
}

/** 开在这个目录上的项目的名字，按语言的习惯连起来：`codex和B`、`codex and B`。 */
function folderChoiceName(projects: readonly ProjectInfo[], path: string, locale: string): string {
	const names = projects.filter((project) => project.path === path).map((project) => project.name);
	return new Intl.ListFormat(locale, { type: "conjunction" }).format(names);
}

function Empty({ children }: { children: React.ReactNode }) {
	return (
		<div className="index-empty">
			<Text as="p" size="label" tone="faint">
				{children}
			</Text>
		</div>
	);
}

export function IndexSettings({
	api,
	notify,
	openPath,
	useProjects,
}: {
	api: Remote<IndexApi>;
	notify: Notify;
	openPath: UiContext["openPath"];
	useProjects: () => readonly ProjectInfo[];
}) {
	const { resolvedLocale } = useI18n();
	const text = MESSAGES[resolvedLocale];
	const listed = useProjects();
	const projects = onePerFolder(listed);
	const [picked, setPicked] = useState<string | null>(null);
	const path = projects.find((p) => p === picked) ?? projects[0] ?? null;
	const pathRef = useRef(path);
	pathRef.current = path;
	const [stats, setStats] = useState<IndexStats | null>(null);
	// 正在建的是哪个目录：建到一半换了项目，转圈和结果都不落到别的项目上。
	const [building, setBuilding] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<SymbolHit[]>([]);

	const refresh = useCallback(async () => {
		setStats(null);
		if (!path) return;
		try {
			const result = await api.stats(path);
			if (pathRef.current === path) setStats(result);
		} catch (error) {
			notify(text.loadFailed(reasonOf(error)), "error");
		}
	}, [api, path, notify, text]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// 边打边搜：索引在逻辑入口那边，搜一次很便宜。
	useEffect(() => {
		if (!path || query.trim().length < 2) {
			setHits([]);
			return;
		}
		let cancelled = false;
		api.search(path, query.trim()).then(
			(result) => {
				if (!cancelled) setHits(result);
			},
			() => {
				if (!cancelled) setHits([]);
			},
		);
		return () => {
			cancelled = true;
		};
	}, [api, path, query]);

	const isBuilding = building !== null && building === path;
	const actionLabel = isBuilding ? text.building : stats?.exists ? text.rebuild : text.build;

	const rebuild = () => {
		const target = path;
		if (!target) return;
		void (async () => {
			setBuilding(target);
			try {
				const result = await api.rebuild(target);
				if (pathRef.current === target) setStats(result);
			} catch (error) {
				notify(text.rebuildFailed(reasonOf(error)), "error");
			} finally {
				setBuilding(null);
			}
		})();
	};

	return (
		<div data-index-settings="">
			{!path ? (
				<SettingsCard>
					<Empty>{text.noProjects}</Empty>
				</SettingsCard>
			) : (
				<>
					<SettingsSectionTitle>{text.status}</SettingsSectionTitle>
					<SettingsCard className="index-card">
						<SettingsRow
							title={text.project}
							detail={path}
							control={
								<div className="index-actions">
									<InlineSelect
										value={path}
										onChange={setPicked}
										options={projects.map((p) => ({ value: p, label: folderChoiceName(listed, p, resolvedLocale), detail: p }))}
										ariaLabel={text.project}
									/>
									<DialogAction disabled={building !== null} onClick={rebuild} label={actionLabel} data-index-rebuild="">
										{isBuilding ? <ActionSpinner size={13} /> : <RefreshCw size={13} strokeWidth={2} aria-hidden />}
										{actionLabel}
									</DialogAction>
								</div>
							}
						/>
						<SettingsRow
							title={text.symbols}
							control={
								<Text size="label" mono>
									{stats?.symbols?.toLocaleString(resolvedLocale)}
								</Text>
							}
						/>
						<SettingsRow
							title={text.files}
							control={
								<Text size="label" mono>
									{stats?.files?.toLocaleString(resolvedLocale)}
								</Text>
							}
						/>
						<SettingsRow
							title={text.size}
							control={
								<Text size="label" mono>
									{stats?.bytes ? `${(stats.bytes / 1024).toFixed(0)} KB` : null}
								</Text>
							}
						/>
						<SettingsRow
							title={text.lastBuilt}
							control={
								<Text size="label" tone="muted">
									{stats?.builtAt ? new Date(stats.builtAt).toLocaleString(resolvedLocale) : text.never}
								</Text>
							}
						/>
					</SettingsCard>

					<SettingsSectionTitle>{text.trySearch}</SettingsSectionTitle>
					<SettingsCard>
						<div className="index-search">
							<SearchField size="comfortable" value={query} onChange={setQuery} placeholder={text.searchPlaceholder} />
						</div>

						{hits.length === 0 ? (
							<Empty>{query.trim().length < 2 ? text.tooShort : stats?.exists ? text.noSymbols : text.buildFirst}</Empty>
						) : (
							<Scroller className="index-hits" overscroll="auto">
								{hits.map((hit) => (
									<button
										key={`${hit.file}:${hit.line}`}
										type="button"
										className="index-hit"
										onClick={() =>
											void api
												.file(path, hit.file)
												.then(openPath)
												.catch((error: unknown) => notify(text.openFailed(reasonOf(error)), "error"))
										}
									>
										<Database size={12} strokeWidth={1.8} className="index-hit-icon" />
										<Text size="label" mono className="index-hit-name">
											{hit.name}
										</Text>
										<Text size="caption" tone="faint" className="index-hit-kind">
											{hit.kind}
										</Text>
										<Text size="detail" tone="muted" mono className="index-hit-file">
											{hit.file}:{hit.line}
										</Text>
									</button>
								))}
							</Scroller>
						)}
					</SettingsCard>
				</>
			)}
		</div>
	);
}
