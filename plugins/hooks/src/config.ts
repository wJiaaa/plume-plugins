/**
 * 钩子的配置：用户级的存在插件数据目录的 `hooks.json`，项目级的在 `<项目>/.plume/config.json` 的 `hooks` 键里。
 * 形状都是 `{ timeoutMs?, maxOutputBytes?, events: { 事件: [{ matcher?, hooks: [定义] }] } }`。
 * 每次用到都现读，设置页改完下一次调用就生效。读进来的东西都先规范化：认不出的事件、缺命令的条目丢掉，
 * 不让一处写错拖垮整份配置；认不出的键原样留着（设置页的「自定义字段」改的就是它们）。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Plume 接得上的事件。 */
export const HOOK_EVENTS = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PermissionRequest",
	"PostToolUse",
	"PostToolUseFailure",
	"Stop",
	"StopFailure",
	"SessionEnd",
] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];
/** 用户级（本机）还是项目级（跟着仓库走）。 */
export type HookScope = "user" | "project";

export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
export const DEFAULT_HOOK_MAX_OUTPUT_BYTES = 32_768;

interface HookDefinitionBase {
	command: string;
	enabled?: boolean;
	statusMessage?: string;
	timeoutMs?: number;
	[key: string]: unknown;
}

interface HookCommandDefinition extends HookDefinitionBase {
	type: "command";
	async?: boolean;
	shell?: true | string;
	/** 秒。 */
	timeout?: number;
}

interface HookProcessDefinition extends HookDefinitionBase {
	type: "process";
	args?: string[];
}

export type HookDefinition = HookCommandDefinition | HookProcessDefinition;

interface HookMatcherGroup {
	matcher?: string;
	hooks: HookDefinition[];
}

export interface HooksConfig {
	timeoutMs?: number;
	maxOutputBytes?: number;
	events: Partial<Record<HookEventName, HookMatcherGroup[]>>;
}

export interface HookEntry {
	/**
	 * `范围:事件:组:条:指纹前缀`：位置加内容。只有位置的话，文件被别处改过（拉下来一个提交）时，同一个位置上可能是另一条命令——
	 * 拿着它去改、去信任的就成了人没看过的那条。
	 */
	id: string;
	scope: HookScope;
	event: HookEventName;
	matcher?: string;
	definition: HookDefinition;
	/** 项目钩子的信任凭据：命令内容一变它就变，旧的信任随之失效。 */
	digest: string;
}

/** 设置页交来的一条。 */
export interface HookDraft {
	event: HookEventName;
	matcher?: string;
	type: "command" | "process";
	command: string;
	args?: string[];
	async?: boolean;
	shell?: true | string;
	statusMessage?: string;
	/** 秒。 */
	timeout?: number;
	enabled?: boolean;
	custom?: Record<string, unknown>;
}

const KNOWN_KEYS = new Set(["type", "command", "args", "async", "shell", "statusMessage", "timeout", "timeoutMs", "enabled"]);
const ID_DIGEST_CHARS = 16;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function positive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeDefinition(raw: unknown): HookDefinition | null {
	if (!isRecord(raw)) return null;
	if (raw.type !== "command" && raw.type !== "process") return null;
	if (typeof raw.command !== "string" || !raw.command.trim()) return null;
	const extra: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) if (!KNOWN_KEYS.has(key)) extra[key] = value;
	const timeoutMs = positive(raw.timeoutMs);
	const common = {
		...extra,
		command: raw.command,
		...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
		...(typeof raw.statusMessage === "string" && raw.statusMessage ? { statusMessage: raw.statusMessage } : {}),
		...(timeoutMs ? { timeoutMs } : {}),
	};
	if (raw.type === "process") {
		const args = Array.isArray(raw.args) ? raw.args.filter((arg): arg is string => typeof arg === "string") : undefined;
		return { ...common, type: "process", ...(args ? { args } : {}) };
	}
	const timeout = positive(raw.timeout);
	return {
		...common,
		type: "command",
		...(typeof raw.async === "boolean" ? { async: raw.async } : {}),
		...(raw.shell === true || (typeof raw.shell === "string" && raw.shell) ? { shell: raw.shell as true | string } : {}),
		...(timeout ? { timeout } : {}),
	};
}

export function normalizeHooksConfig(raw: unknown): HooksConfig {
	if (!isRecord(raw)) return { events: {} };
	const events: HooksConfig["events"] = {};
	const rawEvents = isRecord(raw.events) ? raw.events : {};
	for (const event of HOOK_EVENTS) {
		const groups = rawEvents[event];
		if (!Array.isArray(groups)) continue;
		const normalized: HookMatcherGroup[] = [];
		for (const group of groups) {
			if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
			const hooks = group.hooks.map(normalizeDefinition).filter((hook): hook is HookDefinition => hook !== null);
			if (hooks.length === 0) continue;
			const matcher = typeof group.matcher === "string" && group.matcher.trim() ? group.matcher.trim() : undefined;
			normalized.push({ ...(matcher ? { matcher } : {}), hooks });
		}
		if (normalized.length > 0) events[event] = normalized;
	}
	const timeoutMs = positive(raw.timeoutMs);
	const maxOutputBytes = positive(raw.maxOutputBytes);
	return { ...(timeoutMs ? { timeoutMs } : {}), ...(maxOutputBytes ? { maxOutputBytes } : {}), events };
}

/** 超时，毫秒：`timeoutMs` 优先，其次 command 的 `timeout`（秒），都没有就用整份配置的默认值。 */
export function hookTimeoutMs(definition: HookDefinition, fallbackMs: number): number {
	const ms = definition.timeoutMs ?? (definition.type === "command" && definition.timeout !== undefined ? definition.timeout * 1000 : fallbackMs);
	return Math.max(1, Math.round(ms));
}

/** 一条钩子的指纹。`enabled` 不算：开关一条钩子不改它是哪条。 */
function hookDigest(event: HookEventName, matcher: string | undefined, definition: HookDefinition): string {
	const { enabled: _enabled, ...rest } = definition;
	return createHash("sha256")
		.update(JSON.stringify({ event, matcher: matcher ?? "", definition: sortKeys(rest) }))
		.digest("hex");
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, sortKeys(value[key])]),
	);
}

export function hookEntries(config: HooksConfig, scope: HookScope): HookEntry[] {
	const entries: HookEntry[] = [];
	for (const event of HOOK_EVENTS) {
		for (const [groupIndex, group] of (config.events[event] ?? []).entries()) {
			for (const [hookIndex, definition] of group.hooks.entries()) {
				const digest = hookDigest(event, group.matcher, definition);
				entries.push({
					id: `${scope}:${event}:${groupIndex}:${hookIndex}:${digest.slice(0, ID_DIGEST_CHARS)}`,
					scope,
					event,
					...(group.matcher ? { matcher: group.matcher } : {}),
					definition,
					digest,
				});
			}
		}
	}
	return entries;
}

/** `id` 指的那条还在原处、内容也没变；对不上就是 null。 */
function locate(config: HooksConfig, id: string): { event: HookEventName; group: number; hook: number } | null {
	const [, event, group, hook, digest] = id.split(":");
	if (!event || !(HOOK_EVENTS as readonly string[]).includes(event)) return null;
	const at = { event: event as HookEventName, group: Number(group), hook: Number(hook) };
	const found = config.events[at.event]?.[at.group];
	const definition = found?.hooks[at.hook];
	return definition && digest && hookDigest(at.event, found.matcher, definition).startsWith(digest) ? at : null;
}

export function hasHook(config: HooksConfig, id: string): boolean {
	return locate(config, id) !== null;
}

function definitionFromDraft(draft: HookDraft): HookDefinition {
	const timeout = positive(draft.timeout);
	const common = {
		...draft.custom,
		command: draft.command.trim(),
		...(draft.enabled === false ? { enabled: false } : {}),
		...(draft.statusMessage?.trim() ? { statusMessage: draft.statusMessage.trim() } : {}),
	};
	if (draft.type === "process")
		return { ...common, type: "process", ...(draft.args?.length ? { args: draft.args } : {}), ...(timeout ? { timeoutMs: Math.round(timeout * 1000) } : {}) };
	return {
		...common,
		type: "command",
		...(draft.async ? { async: true } : {}),
		...(draft.shell ? { shell: draft.shell } : {}),
		...(timeout ? { timeout } : {}),
	};
}

/** 追加到同一事件下 matcher 相同的第一组里，没有就新开一组。 */
export function addHook(config: HooksConfig, draft: HookDraft): HooksConfig {
	const next = structuredClone(config);
	const matcher = draft.matcher?.trim() || undefined;
	const groups = (next.events[draft.event] ??= []);
	const group = groups.find((candidate) => candidate.matcher === matcher);
	const definition = definitionFromDraft(draft);
	if (group) group.hooks.push(definition);
	else groups.push({ ...(matcher ? { matcher } : {}), hooks: [definition] });
	return next;
}

export function removeHook(config: HooksConfig, id: string): HooksConfig {
	const at = locate(config, id);
	if (!at) return config;
	const next = structuredClone(config);
	const groups = next.events[at.event] ?? [];
	groups[at.group]?.hooks.splice(at.hook, 1);
	if (groups[at.group]?.hooks.length === 0) groups.splice(at.group, 1);
	if (groups.length === 0) delete next.events[at.event];
	return next;
}

/** 事件和 matcher 都没变就原地替换，位置不动；变了就挪到新的那一组。 */
export function updateHook(config: HooksConfig, id: string, draft: HookDraft): HooksConfig {
	const at = locate(config, id);
	if (!at) return addHook(config, draft);
	const matcher = draft.matcher?.trim() || undefined;
	if (at.event === draft.event && config.events[at.event]?.[at.group]?.matcher === matcher) {
		const next = structuredClone(config);
		const hooks = next.events[at.event]?.[at.group]?.hooks;
		if (hooks) hooks[at.hook] = definitionFromDraft(draft);
		return next;
	}
	return addHook(removeHook(config, id), draft);
}

export function setHookEnabled(config: HooksConfig, id: string, enabled: boolean): HooksConfig {
	const at = locate(config, id);
	if (!at) return config;
	const next = structuredClone(config);
	const hooks = next.events[at.event]?.[at.group]?.hooks;
	const current = hooks?.[at.hook];
	if (!hooks || !current) return config;
	const { enabled: _previous, ...rest } = current;
	hooks[at.hook] = (enabled ? rest : { ...rest, enabled: false }) as HookDefinition;
	return next;
}

export function configFile(dataDir: string): string {
	return join(dataDir, "hooks.json");
}

/** 文件不在是空配置；在但读不懂时报错，免得设置页存一下就把写坏了的那份连同别的钩子一起冲掉。 */
export async function readHooks(dataDir: string): Promise<HooksConfig> {
	let raw: string;
	try {
		raw = await readFile(configFile(dataDir), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { events: {} };
		throw error;
	}
	return normalizeHooksConfig(JSON.parse(raw));
}

export async function writeHooks(dataDir: string, config: HooksConfig): Promise<void> {
	await writeAtomic(configFile(dataDir), config);
}

async function writeAtomic(file: string, value: unknown): Promise<void> {
	const temp = `${file}.${process.pid}.tmp`;
	await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(temp, file);
}

/** 项目配置文件：宿主读它的其余键当项目设置，`hooks` 只由这个插件读，信任过才跑。 */
export function projectConfigFile(cwd: string): string {
	return join(cwd, ".plume", "config.json");
}

/** 读项目配置的整个对象：文件不在是空对象；读不懂、不是对象时抛错，消息只说位置，不带原文。 */
async function readProjectConfig(cwd: string): Promise<Record<string, unknown>> {
	const file = projectConfigFile(cwd);
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	let parsed: unknown;
	try {
		// 记事本存的「UTF-8 带 BOM」开头多一个 U+FEFF，整份文件就成了语法错误。
		parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
	} catch (error) {
		// JSON.parse 的错误可能带上配置原文；只留位置。
		const message = error instanceof Error ? error.message : "";
		throw new Error(message.match(/at position \d+(?: \(line \d+ column \d+\))?/)?.[0] ?? "invalid JSON", { cause: error });
	}
	if (!isRecord(parsed)) throw new Error("not a JSON object");
	return parsed;
}

/** 项目钩子。文件读不懂时抛错，调用方当作没有项目钩子、把原因告诉人。 */
export async function readProjectHooks(cwd: string): Promise<HooksConfig> {
	return normalizeHooksConfig((await readProjectConfig(cwd)).hooks);
}

/**
 * 写回项目文件，只动 `hooks` 这一个键——这份文件还装着别的项目设置，而且是进版本库的。
 * 文件读不懂时拒绝写（`readProjectConfig` 抛错）：覆盖它等于把别人没写完的东西连同错误一起删掉。
 */
export async function writeProjectHooks(cwd: string, hooks: HooksConfig): Promise<void> {
	const next = { ...(await readProjectConfig(cwd)) };
	if (Object.keys(hooks.events).length === 0 && hooks.timeoutMs === undefined && hooks.maxOutputBytes === undefined) delete next.hooks;
	else next.hooks = hooks;
	const file = projectConfigFile(cwd);
	await mkdir(dirname(file), { recursive: true });
	await writeAtomic(file, next);
}
