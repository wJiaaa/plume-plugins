/**
 * 钩子交回来的东西怎么读：stdout 上的 JSON，按事件取出决定，再把几条钩子的结论并成一个。
 *
 * 语义：`continue: false` / `decision: "block"` 是拦，PreToolUse 的 `permissionDecision`
 * 几条之间取最严（deny > ask > allow），Stop 上的 block 是「别停，接着干」。
 */

import type { HookEventName } from "./config.ts";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

type HookPermissionDecision = "allow" | "ask" | "deny";
type PermissionRequestHookDecision =
	| { behavior: "allow"; updatedInput?: unknown; updatedPermissions?: unknown }
	| { behavior: "deny"; message?: string; interrupt?: boolean };

export interface HookJSONOutput {
	continue?: boolean;
	stopReason?: string;
	decision?: "approve" | "block";
	reason?: string;
	systemMessage?: string;
	suppressOutput?: boolean;
	/** Claude Code 替钩子往终端写的转义序列（桌面通知、窗口标题）。Plume 没有终端可写，认得、不用。 */
	terminalSequence?: string;
	additionalContext?: string;
	additional_context?: string;
	hookSpecificOutput?: {
		hookEventName: HookEventName;
		additionalContext?: string;
		/** `defer` 是 `claude -p` 里把这次调用挂起、交给外面答的，Plume 没有这种模式，照 Claude Code 交互模式的做法忽略。 */
		permissionDecision?: HookPermissionDecision | "defer";
		permissionDecisionReason?: string;
		updatedInput?: unknown;
		decision?: PermissionRequestHookDecision;
	};
}

/**
 * 几条钩子并起来的结论，按调用方要问的事各留一个字段。
 *
 * `decision` 是「拦 / 问 / 放」：PreToolUse、PermissionRequest 用它决定这次调用，UserPromptSubmit 的
 * `deny` 是拦下这条消息，其余事件上的 `deny` 只进记录。Stop 不进 `decision`——它的 block 意思是「别停」，
 * 放在 `continueStop`。
 */
export interface HookRunResult {
	additionalContexts: string[];
	decision?: HookPermissionDecision;
	/** 胜出的那个 `decision` 的原因：被拦时说给人和模型听，放行或要确认时随审批一起交出。 */
	reason?: string;
	updatedInput?: unknown;
	/** Stop：钩子要它接着干。 */
	continueStop?: boolean;
}

export class HookOutputError extends Error {}

const TOP_LEVEL = new Set([
	"continue",
	"stopReason",
	"decision",
	"reason",
	"systemMessage",
	"suppressOutput",
	"terminalSequence",
	"additionalContext",
	"additional_context",
	"hookSpecificOutput",
]);

function optional(value: Record<string, unknown>, key: string, type: "string" | "boolean"): void {
	if (value[key] !== undefined && typeof value[key] !== type) throw new HookOutputError(`${key} must be a ${type}`);
}

/**
 * stdout 读成钩子输出。
 *
 * 不是 `{` 开头、或者根本不是 JSON 的，当作诊断文本忽略——钩子打一行日志不该让当前动作失败。
 * 是 JSON 但形状不对的，报错：那是一条想表达决定却写错了的钩子，照常放行等于替它做了决定。
 */
export function parseHookStdout(stdout: string): HookJSONOutput | undefined {
	const trimmed = stdout.trim();
	if (!trimmed.startsWith("{")) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	for (const key of Object.keys(parsed)) if (!TOP_LEVEL.has(key)) throw new HookOutputError(`unknown field "${key}"`);
	optional(parsed, "continue", "boolean");
	optional(parsed, "suppressOutput", "boolean");
	for (const key of ["stopReason", "reason", "systemMessage", "terminalSequence", "additionalContext", "additional_context"]) optional(parsed, key, "string");
	if (parsed.decision !== undefined && parsed.decision !== "approve" && parsed.decision !== "block")
		throw new HookOutputError('decision must be "approve" or "block"');
	const specific = parsed.hookSpecificOutput;
	if (specific !== undefined) {
		if (!isRecord(specific) || typeof specific.hookEventName !== "string") throw new HookOutputError("hookSpecificOutput.hookEventName is required");
		optional(specific, "additionalContext", "string");
		optional(specific, "permissionDecisionReason", "string");
		if (specific.permissionDecision !== undefined && !["allow", "ask", "deny", "defer"].includes(specific.permissionDecision as string)) {
			throw new HookOutputError('permissionDecision must be "allow", "ask", "deny" or "defer"');
		}
		if (specific.decision !== undefined) {
			const decision = specific.decision;
			if (!isRecord(decision) || (decision.behavior !== "allow" && decision.behavior !== "deny")) {
				throw new HookOutputError('decision.behavior must be "allow" or "deny"');
			}
		}
	}
	return parsed as HookJSONOutput;
}

function isPermissionEvent(event: HookEventName): boolean {
	return event === "PreToolUse" || event === "PermissionRequest";
}

export function processHookOutput(event: HookEventName, output: HookJSONOutput | undefined): HookRunResult {
	const result: HookRunResult = { additionalContexts: [] };
	if (!output) return result;
	const decide = (decision: HookPermissionDecision, reason?: string) => mergeHookRunResult(result, { additionalContexts: [], decision, reason });

	const said = output.stopReason ?? output.reason;
	if (event === "Stop") {
		if (output.continue === true || output.decision === "block") result.continueStop = true;
		if (output.decision === "block") {
			if (output.systemMessage) result.additionalContexts.push(output.systemMessage);
			if (output.reason) result.additionalContexts.push(output.reason);
		}
	} else {
		if (output.continue === false) decide("deny", said);
		if (output.decision === "block") decide("deny", said ?? output.systemMessage);
		if (output.decision === "approve" && isPermissionEvent(event)) decide("allow");
	}
	if (output.additionalContext) result.additionalContexts.push(output.additionalContext);
	if (output.additional_context) result.additionalContexts.push(output.additional_context);

	const specific = output.hookSpecificOutput;
	if (!specific) return result;
	if (specific.hookEventName !== event) throw new HookOutputError(`hookSpecificOutput is for ${specific.hookEventName}, not ${event}`);
	if (event === "PreToolUse") {
		// Claude Code 文档：说 defer 时 updatedInput、additionalContext 都不用。
		if (specific.permissionDecision === "defer") return result;
		if (specific.permissionDecision) decide(specific.permissionDecision, specific.permissionDecisionReason);
		if (specific.updatedInput !== undefined) result.updatedInput = specific.updatedInput;
	}
	if (event === "PermissionRequest" && specific.decision) {
		decide(specific.decision.behavior, specific.decision.behavior === "deny" ? specific.decision.message : undefined);
		if (specific.decision.behavior === "allow" && specific.decision.updatedInput !== undefined) result.updatedInput = specific.decision.updatedInput;
	}
	if (event !== "PermissionRequest" && specific.additionalContext) result.additionalContexts.push(specific.additionalContext);
	return result;
}

function strictest(current: HookPermissionDecision | undefined, next: HookPermissionDecision): HookPermissionDecision {
	if (current === "deny" || next === "deny") return "deny";
	if (current === "ask" || next === "ask") return "ask";
	return next;
}

/** 并进一条钩子的结论：决定取最严，原因跟着胜出的那个决定走——更严的换掉原因，同样严的后说的算。 */
export function mergeHookRunResult(target: HookRunResult, next: HookRunResult): void {
	target.additionalContexts.push(...next.additionalContexts);
	if (next.decision) {
		const merged = strictest(target.decision, next.decision);
		if (merged !== target.decision) target.reason = next.reason;
		else if (merged === next.decision && next.reason) target.reason = next.reason;
		target.decision = merged;
	}
	if (next.updatedInput !== undefined) target.updatedInput = next.updatedInput;
	if (next.continueStop) target.continueStop = true;
}

/**
 * 照 Claude Code：空或 `*` 匹配全部；只由字母、数字、`_`、`-`、空格、`,`、`|` 组成的按名字精确匹配，`|` 和 `,` 都分隔、
 * 两边的空白不算（`Edit, Write`）；其余当不加锚的正则，写错了的正则不匹配。StopFailure 只认字母、数字、`_`、`|`，
 * 带 `-`、空格、`,` 的走正则。
 */
export function matchesHookMatcher(value: string | undefined, matcher: string | undefined, event?: HookEventName): boolean {
	if (!matcher || matcher === "*") return true;
	if (!value) return false;
	if (event === "StopFailure" ? /^[a-zA-Z0-9_|]+$/u.test(matcher) : /^[a-zA-Z0-9_\- ,|]+$/u.test(matcher))
		return matcher
			.split(/[|,]/u)
			.map((name) => name.trim())
			.includes(value);
	try {
		return new RegExp(matcher).test(value);
	} catch {
		return false;
	}
}

const SENSITIVE_KEY = "(?:access[_-]?token|api[_-]?key|credential|password|private[_-]?key|secret|token)";
const SENSITIVE_IDENTIFIER = `(?:[A-Za-z0-9]+[_-])*${SENSITIVE_KEY}(?:[_-][A-Za-z0-9]+)*`;
const MASK = "••••";

/** 命令和原因要画到会话里、写进会话记录，里面的口令先盖住。 */
export function sanitizeHookDisplayText(value: string): string {
	if (!value) return value;
	return value
		.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/giu, `$1${MASK}:${MASK}@`)
		.replace(/(authorization\s*:\s*(?:basic|bearer)\s+)(?:"[^"]*"|'[^']*'|[^\s,;"']+)/giu, `$1${MASK}`)
		.replace(new RegExp(`([?&](?:authorization|${SENSITIVE_IDENTIFIER})=)[^&\\s"']+`, "giu"), `$1${MASK}`)
		.replace(/(\bauthorization\b\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s,"']+)/giu, `$1${MASK}`)
		.replace(new RegExp(`((?:"${SENSITIVE_IDENTIFIER}"|'${SENSITIVE_IDENTIFIER}')\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,"']+)`, "giu"), `$1${MASK}`)
		.replace(new RegExp(`(^|[^A-Za-z0-9_])(${SENSITIVE_IDENTIFIER}\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,"']+)`, "gimu"), `$1$2${MASK}`)
		.replace(new RegExp(`((?:--)?${SENSITIVE_IDENTIFIER})(\\s+)(?:"[^"]*"|'[^']*'|[^\\s]+)`, "giu"), `$1$2${MASK}`);
}
