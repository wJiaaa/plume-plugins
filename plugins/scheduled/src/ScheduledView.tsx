/**
 * 「定时任务」页面：一张卡片一个任务，名字、提示词、时间、开关都在卡片上直接改，改完就存。卡片上还有运行状态、
 * 「立即运行一次」、「打开上次会话」和上次失败的原因。
 */

import type { Remote, UiContext } from "@plume/contract/ui";
import { card as cardStyle } from "@plume/styles";
import {
	BreatheLoader,
	Button,
	IconButton,
	Input,
	motionReduced,
	NumberField,
	Scroller,
	Segmented,
	Text,
	TextArea,
	TimeField,
	Toggle,
	useConfirmer,
	useI18n,
} from "@plume/ui";
import { Clock, ExternalLink, Play, Plus, Trash2 } from "@plume/ui/icons";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ScheduledApi, ScheduledTask, TaskPatch } from "./api.ts";
import type { ScheduledClient } from "./client.ts";
import { MESSAGES } from "./messages.ts";
import { nextRunAt } from "./schedule.ts";

/** 页面要宿主做的两件事：看一个会话在不在跑、在不在等人处理，打开它。 */
type Host = Pick<UiContext, "useSession" | "openSession">;

export function ScheduledView({
	api,
	client,
	host,
	cwd,
	project,
}: {
	api: Remote<ScheduledApi>;
	client: ScheduledClient;
	host: Host;
	cwd: string;
	project: string | undefined;
}) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const live = useSyncExternalStore(client.subscribe, client.get);
	const [tasks, setTasks] = useState<ScheduledTask[] | null>(live?.tasks ?? null);
	/** 要滚进视野、边框亮一下的那张：刚新建的加在最后，可能落在可见区域下面；「查看」点的那个任务。 */
	const [focus, setFocus] = useState<string | null>(client.focus);
	useEffect(() => {
		client.focus = null;
	}, [client]);

	/*
	 * 先改手上这份，存完换成逻辑入口写下去的那份。只认最后一次的结果：连着点两下开关时，第一次存完回来的列表里
	 * 还没有第二下，拿它替换会让开关弹回去一下。逻辑入口推来的列表（运行记录写进去了）也一样，有没存完的就先不换。
	 */
	const saves = useRef(0);
	const pending = useRef(0);
	useEffect(() => {
		if (live && pending.current === 0) setTasks(live.tasks);
	}, [live]);
	const save = (request: PromiseLike<ScheduledTask[]>) => {
		const mine = ++saves.current;
		pending.current += 1;
		request.then(
			(list) => {
				pending.current -= 1;
				if (mine === saves.current) setTasks(list);
			},
			(error: unknown) => {
				pending.current -= 1;
				console.error("[plume.scheduled] 定时任务没存上：", error);
			},
		);
	};

	/* 页面在屏上就是看见了：输入框上方那一行、侧栏的数目说的就是下面这些卡片，开着时新来的失败也算。 */
	const unseen = live?.unseen.length ?? 0;
	useEffect(() => {
		if (unseen > 0) void api.markSeen().catch((error: unknown) => console.error("[plume.scheduled] 没标上已看：", error));
	}, [api, unseen]);
	if (!tasks) return null;

	const update = (id: string, patch: TaskPatch) => {
		setTasks(tasks.map((task) => (task.id === id ? { ...task, ...patch } : task)));
		save(api.update(id, patch));
	};
	const remove = (id: string) => {
		setTasks(tasks.filter((task) => task.id !== id));
		save(api.remove(id));
	};
	const add = () => {
		const task: ScheduledTask = {
			id: `task-${Date.now().toString(36)}`,
			name: text.newTask,
			cwd,
			...(project ? { project } : {}),
			prompt: text.samplePrompt,
			schedule: { kind: "daily", time: "09:00" },
			enabled: false,
		};
		setFocus(task.id);
		setTasks([...tasks, task]);
		save(api.add(task));
	};

	return (
		<div className="scheduled-page">
			<Scroller className="scheduled-scroll" contentClassName="scheduled-content">
				<header className="scheduled-header">
					<div>
						<Text as="h1" size="heading">
							{text.title}
						</Text>
						<Text as="p" tone="muted" className="scheduled-intro">
							{text.intro}
						</Text>
					</div>
					<Button size="sm" label={text.new} onClick={add} icon={<Plus size={12} strokeWidth={2} />} data-scheduled-add="" />
				</header>

				{tasks.length === 0 && (
					<Text as="p" tone="faint" className="scheduled-empty">
						{text.empty}
						<br />
						{text.emptyHint}
					</Text>
				)}

				<div className="scheduled-list">
					{tasks.map((task) => (
						<TaskCard
							key={task.id}
							task={task}
							started={live?.runs[task.id]}
							host={host}
							focused={focus === task.id}
							onFocused={() => setFocus(null)}
							onChange={(patch) => update(task.id, patch)}
							onRemove={() => remove(task.id)}
							onRun={() => api.runNow(task.id)}
						/>
					))}
				</div>
			</Scroller>
		</div>
	);
}

/** 下次运行，写成字；没有下次（时间写坏了）时为空，调用方连这一项都不画。 */
function describeNext(task: ScheduledTask, locale: string, paused: string): string | null {
	if (!task.enabled) return paused;
	const at = nextRunAt(task);
	return at === null ? null : new Date(at).toLocaleString(locale);
}

/**
 * 刚新建的、「查看」点的那张卡片：滚进视野，边框亮一下。
 *
 * 只亮一下，不是一个状态：它回答的是「是哪一张」，答完就和别的卡片一样了。
 */
function useFocusedCard(focused: boolean, onFocused: () => void) {
	const ref = useRef<HTMLDivElement>(null);
	const [lit, setLit] = useState(false);
	useEffect(() => {
		if (!focused) return;
		onFocused();
		ref.current?.scrollIntoView({ block: "nearest", behavior: motionReduced() ? "auto" : "smooth" });
		setLit(true);
	}, [focused, onFocused]);
	// 单独一个 effect：上面那个在清掉 focus 时会再跑一遍，计时器放在那里会被一起取消。
	useEffect(() => {
		if (!lit) return;
		const timer = window.setTimeout(() => setLit(false), 1200);
		return () => window.clearTimeout(timer);
	}, [lit]);
	return { ref, lit };
}

/**
 * 这个任务的一次运行在不在跑、在不在等人处理。开跑以后看那个会话自己的状态；会话还没读到时，逻辑入口说开跑了就是在跑。
 * 等人处理单独说：卡在审批或提问（`approval` 里的两种请求）上的任务自己不会往下走。
 */
function useTaskStatus(task: ScheduledTask, started: string | undefined, host: Host): { status: "running" | "waiting" | null; last: boolean } {
	const view = host.useSession(started ?? task.lastSessionId);
	const status = view?.approval ? "waiting" : view?.summary.running ? "running" : started && !view ? "running" : null;
	// 「打开上次会话」只在那个会话还在时画：删掉了就没有可打开的。
	return { status, last: view !== undefined && view.summary.id === task.lastSessionId };
}

function TaskCard({
	task,
	started,
	host,
	focused,
	onFocused,
	onChange,
	onRemove,
	onRun,
}: {
	task: ScheduledTask;
	started: string | undefined;
	host: Host;
	focused: boolean;
	onFocused: () => void;
	onChange: (patch: TaskPatch) => void;
	onRemove: () => void;
	onRun: () => PromiseLike<void>;
}) {
	const { resolvedLocale } = useI18n();
	const text = MESSAGES[resolvedLocale];
	const card = useFocusedCard(focused, onFocused);
	const { status, last } = useTaskStatus(task, started, host);
	const [prompt, setPrompt] = useState(task.prompt);
	const [name, setName] = useState(task.name);
	const [starting, setStarting] = useState(false);
	const confirm = useConfirmer();
	const next = describeNext(task, resolvedLocale, text.paused);

	return (
		<div
			ref={card.ref}
			data-scheduled-task={task.id}
			className={`${cardStyle.frame} ${cardStyle.tone.default.frame} ${card.lit ? "scheduled-card scheduled-card-lit" : "scheduled-card"}`}
		>
			{/* 名字输入框继承这一行的字号。 */}
			<Text as="div" size="body" className="scheduled-card-head">
				<Clock size={14} strokeWidth={1.8} className="scheduled-card-icon" />
				<Input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== task.name && onChange({ name })} className="scheduled-name" />
				{status && (
					<Text size="detail" tone="muted" className="scheduled-status" data-scheduled-status={status}>
						<span className="scheduled-status-mark" aria-label={status === "waiting" ? text.waiting : text.running} role="img">
							{status === "waiting" ? (
								<svg width={7} height={7} viewBox="0 0 7 7" aria-hidden className="scheduled-waiting-dot">
									<circle cx={3.5} cy={3.5} r={3.5} fill="currentColor" />
								</svg>
							) : (
								<BreatheLoader size={12} />
							)}
						</span>
						{/* 记号已经替读屏说了状态，这几个字是给眼睛看的。 */}
						<span aria-hidden>{status === "waiting" ? text.waiting : text.running}</span>
					</Text>
				)}
				<IconButton
					label={text.runNow}
					disabled={starting}
					onClick={() => {
						setStarting(true);
						Promise.resolve(onRun())
							.catch((error: unknown) => console.error("[plume.scheduled] 没能立即运行：", error))
							.finally(() => window.setTimeout(() => setStarting(false), 1500));
					}}
					data-scheduled-run=""
					icon={<Play size={12} strokeWidth={2} />}
				/>
				<Toggle checked={task.enabled} onChange={(enabled) => onChange({ enabled })} />
				<IconButton
					size="sm"
					tone="danger"
					label={text.deleteOne(task.name)}
					onClick={() =>
						confirm.ask({
							title: text.deleteConfirm(task.name),
							detail: text.deleteDetail,
							confirmLabel: text.delete,
							onConfirm: onRemove,
						})
					}
					icon={<Trash2 size={13} strokeWidth={1.8} />}
				/>

				{confirm.element}
			</Text>

			<div className="scheduled-card-body">
				<label className="scheduled-field">
					<Text size="detail" tone="muted" className="scheduled-field-label">
						{text.prompt}
					</Text>
					<TextArea value={prompt} onChange={setPrompt} onBlur={() => prompt !== task.prompt && onChange({ prompt })} rows={2} />
				</label>

				<div className="scheduled-row">
					<Segmented
						value={task.schedule.kind}
						onChange={(kind) => onChange({ schedule: kind === "daily" ? { kind: "daily", time: "09:00" } : { kind: "interval", minutes: 60 } })}
						options={[
							{ value: "daily", label: text.daily },
							{ value: "interval", label: text.every },
						]}
					/>

					{task.schedule.kind === "daily" ? (
						<TimeField value={task.schedule.time} onChange={(time) => onChange({ schedule: { kind: "daily", time } })} label={text.dailyTime} />
					) : (
						<div className="scheduled-interval">
							<NumberField
								value={task.schedule.minutes}
								// 最快一分钟一次：负号和 0 敲不进去，加减按钮停在 1 和一天。
								min={1}
								max={60 * 24}
								onChange={(minutes) => onChange({ schedule: { kind: "interval", minutes } })}
								label={text.intervalMinutes}
								name="intervalMinutes"
							/>
							<Text size="detail" tone="faint">
								{text.minutes}
							</Text>
						</div>
					)}

					<div className="scheduled-spacer" />
					<Text size="detail" tone="faint" mono>
						{task.cwd || text.noWorkspace}
					</Text>
				</div>

				<Text as="div" size="detail" tone="faint" className="scheduled-runs">
					{/* 时间放进句子里，不跟在冒号结尾的标签后面：冒号后面要不要空格是语言的事。 */}
					<span>{text.lastRun(task.lastRunAt ? new Date(task.lastRunAt).toLocaleString(resolvedLocale) : text.never)}</span>
					{next && <span>{text.nextRun(next)}</span>}
					{last && task.lastSessionId && (
						<IconButton
							size="xs"
							label={text.openLast}
							onClick={() => host.openSession(task.lastSessionId!)}
							data-scheduled-open-last=""
							icon={<ExternalLink size={13} strokeWidth={1.8} />}
						/>
					)}
					{task.lastError && (
						<Text size="detail" tone="danger" data-scheduled-error="">
							{text.failedBecause(task.lastError)}
						</Text>
					)}
				</Text>
			</div>
		</div>
	);
}
