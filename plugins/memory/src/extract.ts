/**
 * 后台总结：把结束了的会话读成下次还用得上的项目记忆，不用每次有人开口。
 *
 * `learn` 管的是当场注意到的；当场没人注意到的——在三个会话里都出现过的约定、每次都得先跑的命令、犯过两次的错——
 * 只有把几个会话放在一起读才看得见，而没有人会这么做。
 *
 * 能放心让它自己跑，靠这几条：
 *
 *   默认关。它会把会话内容发给模型，一个默认只在本地跑的东西不能悄悄开始这么做；开关旁边把代价说清楚。
 *   不碰 `learned.md`。那里是刻意记下的；它敢改写、删掉自己写的条目，正因为刻意记下的那一半在别处。
 *   每次只读上次之后结束的会话，在上一版 `MEMORY.md` 上合并，而不是每天从最近 30 天整份重写：那样来源会话一过 30 天结论就消失，
 *   同一个会话被重读近 30 遍。输入里带上当前指令和刻意记下的条目，是为了**不**复述它们。
 *   拿锁。几个进程同时写同一个文件，结果是各写一半。
 */

import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Message, SessionSummary } from "@plume/contract";
import { readText } from "./files.ts";
import { EXTRACT_CURSOR, readExtractedMemory, readLessons, redactSecrets, writeExtractedMemory } from "./project-memory.ts";

/** 结束不到这么久的不读：二十分钟前关掉的会话，人多半还在做，读它是把没做完的一半当成结论。 */
export const MIN_AGE_MS = 12 * 60 * 60 * 1000;
/** 再老的，它的结论多半已经不适用于现在的代码。 */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** 一次最多读几个会话。 */
export const MAX_SESSIONS = 40;
/** 少于这么多条消息的是一问一答，要找的教训来自干活，不来自查询。 */
const MIN_MESSAGES = 6;
/** 比这更老的锁属于一个已经不在的进程。 */
const LOCK_STALE_MS = 10 * 60 * 1000;
/**
 * 同一个项目两次总结之间至少隔多久。候选本身就要求至少 12 小时没动过，一天一次已经覆盖每一个会成为候选的会话；
 * 更勤只是把一天里那几个新会话拆成几次请求，每次都重发整份指令和上一版记忆。
 */
export const PASS_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface ExtractionCandidate {
	id: string;
	updatedAt: number;
	messages: Message[];
}

export interface ExtractionResult {
	/** 写进 `MEMORY.md` 的；这次没写时为空。 */
	memory: string;
	/** 读了几个会话。 */
	sessions: number;
	/** 没跑或没写的原因。 */
	skipped?: string;
	/** 模型给出了答复（包括「没有要改的」）：这批会话算读过了，游标可以往前走。 */
	answered?: boolean;
}

/** 按摘要能判断的那一半：年龄在窗口里、上次读过之后又动过、现在没在跑。消息条数要读了消息才知道，见 `findCandidates`。 */
export function isCandidate(session: Pick<SessionSummary, "updatedAt" | "running">, now = Date.now(), since = 0): boolean {
	const age = now - session.updatedAt;
	return !session.running && age >= MIN_AGE_MS && age <= MAX_AGE_MS && session.updatedAt > since;
}

/** 这个项目值得读的会话，新的在前，最多 `MAX_SESSIONS` 个。`sessions` 已经是这个项目的、最近活动的在前。 */
export async function findCandidates(
	sessions: readonly Pick<SessionSummary, "id" | "updatedAt" | "running">[],
	read: (sessionId: string) => Promise<Message[]>,
	now = Date.now(),
	since = 0,
): Promise<ExtractionCandidate[]> {
	const found: ExtractionCandidate[] = [];
	for (const session of sessions) {
		if (found.length >= MAX_SESSIONS) break;
		if (!isCandidate(session, now, since)) continue;
		const messages = await read(session.id).catch(() => []);
		if (messages.length < MIN_MESSAGES) continue;
		found.push({ id: session.id, updatedAt: session.updatedAt, messages });
	}
	return found;
}

/** 拿锁，或者说明别人拿着（null）。过期的锁直接接管：它说明一个进程跑到一半没了，不接管的话记忆就一直不更新。 */
export async function acquireLock(dir: string, now = Date.now()): Promise<(() => Promise<void>) | null> {
	await mkdir(dir, { recursive: true });
	const path = join(dir, ".lock");
	const existing = await stat(path).catch(() => null);
	if (existing && now - existing.mtimeMs < LOCK_STALE_MS) return null;
	await writeFile(path, String(process.pid), "utf8");
	return async () => {
		await rm(path, { force: true }).catch(() => {});
	};
}

/**
 * 读会话、交回教训的提示词。大半篇幅在说**不要**交回什么：贵的失败不是空文件，是一文件会过期的事实。
 * 「（没有）」的意思是上一版原样保留，不是清空：模型偷懒答一句「没有」，代价只是这次没更新。
 */
function extractionPrompt(): string {
	// i18n-exempt：发给模型的提示词。
	return [
		"你在维护一个项目的「推断记忆」：从过去的会话里总结出的、**下次还用得上**的东西。",
		"",
		"输入有四部分：",
		"- 当前指令（项目指令和用户的全局指令）、刻意记下的条目：这些每轮都会原样给模型看",
		"- 上一版推断记忆：你要更新的对象，可能被人手改过",
		"- 新会话：上次更新之后才结束的会话",
		"",
		"产出更新后的**完整**推断记忆：",
		"- 上一版里仍然成立的条目保留，不要因为新会话没提到就删掉",
		"- 新会话里值得记的加进去；和已有条目说同一件事的合成一条",
		"- 新会话明确推翻了的条目改掉或删掉",
		"- 当前指令或刻意记下的条目里已经说过的不要写；上一版里与它们重复的删掉",
		"",
		"值得记的：",
		"- 这个仓库的约定，尤其是从代码里看不出来的（构建命令、部署流程、为什么某处要那么写）",
		"- 用户纠正过的做法，而且这个纠正会反复适用",
		"- 踩过并解决了的坑，下次还会踩的那种",
		"- 反复出现的工作流（「改完 X 之后总要跑 Y」）",
		"",
		"**不要记：**",
		"- 代码结构、文件位置、函数签名——读代码就知道，而且会过期",
		"- 某一次任务的具体内容",
		"- git 历史里已经有的信息",
		"- 你不确定是不是普遍成立的东西",
		"",
		"记忆库里一条过时的事实比没有这条更糟，因为模型会照着它做决定。宁可少写。",
		"",
		"输出 markdown 列表，每条一行，一两句话，具体可执行，只输出列表本身。",
		"上一版不需要任何改动（没有要加的，也没有要改或删的）时，只输出「（没有）」。",
	].join("\n");
}

function textOf(message: Message): string {
	if (message.role === "toolResult") return "";
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/**
 * 把会话压成几个能塞进一次请求的样子。工具结果整个不要：它们是转录的大头、意义最少，文件内容和命令输出描述的是代码某一刻的状态，
 * 正是不能变成记忆的那种东西。发给模型之前先脱敏：模型没见过的密钥，它回显不出来。
 */
export function renderSessions(candidates: ExtractionCandidate[]): string {
	const blocks: string[] = [];
	for (const session of candidates) {
		// i18n-exempt：发给模型的输入。
		const lines: string[] = [`## 会话 ${session.id}`];
		for (const message of session.messages) {
			// i18n-exempt：发给模型的输入。
			if (message.role === "user" && !message.synthetic) lines.push(`用户：${textOf(message).slice(0, 600)}`);
			else if (message.role === "assistant") {
				const said = textOf(message).trim();
				// i18n-exempt：发给模型的输入。
				if (said) lines.push(`助手：${said.slice(0, 600)}`);
			}
		}
		blocks.push(lines.join("\n"));
	}
	return redactSecrets(blocks.join("\n\n"));
}

export interface ExtractionInput {
	/** 这个项目当前的指令（项目指令文件、用户的全局指令），原文；没拿到时为空。 */
	instructions: string;
	candidates: ExtractionCandidate[];
}

/** 合并时要看的全部东西。 */
async function extractionInput(dir: string, input: ExtractionInput): Promise<string> {
	const [lessons, previous] = await Promise.all([readLessons(dir).catch(() => []), readExtractedMemory(dir).catch(() => "")]);
	// i18n-exempt：发给模型的输入。
	return redactSecrets(
		[
			`## 当前指令\n${input.instructions.trim() || "（没有）"}`,
			`## 刻意记下的条目\n${lessons.map((lesson) => `- ${lesson.text}`).join("\n") || "（没有）"}`,
			`## 上一版推断记忆\n${previous || "（还没有）"}`,
			`## 新会话\n${renderSessions(input.candidates)}`,
		].join("\n\n"),
	);
}

/**
 * 读会话、写 `MEMORY.md`、不碰 `learned.md`。`complete` 只接受完整回复；抛错（模型没配、服务商出错、被中止或截断）就当这次没跑：
 * 它在后台自己跑，没人在等，把错误摆到一个什么都没要的人面前不对。
 */
export async function extractMemory(
	dir: string,
	input: ExtractionInput,
	complete: (systemPrompt: string, prompt: string) => Promise<string>,
): Promise<ExtractionResult> {
	// i18n-exempt：只进日志的原因。
	if (input.candidates.length === 0) return { memory: "", sessions: 0, skipped: "没有符合条件的会话" };
	const release = await acquireLock(dir);
	// i18n-exempt：只进日志的原因。
	if (!release) return { memory: "", sessions: 0, skipped: "另一个进程正在总结" };
	try {
		let reply: string;
		try {
			reply = await complete(extractionPrompt(), await extractionInput(dir, input));
		} catch (error) {
			// i18n-exempt：只进日志的原因。
			return { memory: "", sessions: input.candidates.length, skipped: `模型没能返回：${error instanceof Error ? error.message : String(error)}` };
		}
		const text = reply.trim();
		// 「（没有）」是一个真的答案，不能当成一条教训写下：被要求找东西的模型总能找到点什么，给它一个说没有的出口，文件才不会塞满对常识的复述。
		// i18n-exempt：认模型的答复。
		if (!text || /^（?没有）?$/.test(text)) return { memory: "", sessions: input.candidates.length, skipped: "这些会话里没有值得记的", answered: true };
		// 写盘前再脱一次：模型可能凭形状拼出一个像密钥的串，或者输入那边的正则漏了一种新格式。
		const clean = redactSecrets(text);
		// i18n-exempt：记忆文件的文件头，给打开它的人看；`readExtractedMemory` 读时去掉。
		const body = [
			"# 从会话里总结的",
			"",
			`由后台抽取生成，每次在这一版上合并新结束的会话（上次读了 ${input.candidates.length} 次）。可以手改，下次合并照着改过的继续——`,
			"要保留的内容请移到 `learned.md`：这里的条目合并时可能被改写或删掉，那个文件抽取永远不碰。",
			"",
			clean,
			"",
		].join("\n");
		await writeExtractedMemory(dir, body);
		return { memory: clean, sessions: input.candidates.length, answered: true };
	} finally {
		await release();
	}
}

async function readStamp(dir: string, file: string): Promise<number | null> {
	const raw = await readText(join(dir, file)).catch(() => null);
	const at = raw === null ? Number.NaN : Number.parseInt(raw.trim(), 10);
	return Number.isFinite(at) ? at : null;
}

async function writeStamp(dir: string, file: string, at: number): Promise<void> {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, file), String(at), "utf8");
}

export interface PassOptions {
	/** 这个项目的记忆目录。 */
	dir: string;
	/** 这个项目的会话，最近活动的在前。 */
	sessions: readonly Pick<SessionSummary, "id" | "updatedAt" | "running">[];
	read: (sessionId: string) => Promise<Message[]>;
	instructions: string;
	complete: (systemPrompt: string, prompt: string) => Promise<string>;
	now?: number;
}

/**
 * 跑一遍，或者说清楚为什么没跑。
 *
 * 时间戳在跑之前就写下：一次没找到候选或模型没返回的空跑，和一次成功的总结花掉的是同一批工作（读几十个会话）；
 * 不记下来，一个没有候选的项目每次空闲都要重读一遍全部会话。
 * 游标和它分开，只在这批会话真的被读过时才往前走，走到「此刻已满 12 小时」的那条线：还没满 12 小时的会话这次没读，下次要读到。
 */
export async function runPass(options: PassOptions): Promise<ExtractionResult> {
	const now = options.now ?? Date.now();
	const last = await readStamp(options.dir, ".last-pass");
	// i18n-exempt：只进日志的原因。
	if (last !== null && now - last < PASS_INTERVAL_MS) return { memory: "", sessions: 0, skipped: "离上次不到一天" };
	const candidates = await findCandidates(options.sessions, options.read, now, (await readStamp(options.dir, EXTRACT_CURSOR)) ?? 0);
	await writeStamp(options.dir, ".last-pass", now);
	const result = await extractMemory(options.dir, { instructions: options.instructions, candidates }, options.complete);
	if (candidates.length === 0 || result.answered) await writeStamp(options.dir, EXTRACT_CURSOR, now - MIN_AGE_MS);
	return result;
}
