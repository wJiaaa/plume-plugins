import type { PullRequestDetail, PullRequestSummary } from "../api";
import { rowId } from "./model.ts";

const PREFIX = "plume.pull-requests.";
export function readCache(key: string): unknown {
	try {
		const raw = localStorage.getItem(PREFIX + key);
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}
export function writeCache(key: string, value: unknown): void {
	try {
		localStorage.setItem(PREFIX + key, JSON.stringify(value));
	} catch {
		/* 存储满了仍可继续阅读。 */
	}
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
export function isSummary(value: unknown): value is PullRequestSummary {
	if (!record(value)) return false;
	const strings = ["accountId", "repo", "title", "author", "state", "url", "createdAt", "updatedAt"];
	return (
		strings.every((key) => typeof value[key] === "string") &&
		Boolean(value.accountId) &&
		typeof value.number === "number" &&
		Number.isSafeInteger(value.number) &&
		typeof value.isDraft === "boolean" &&
		typeof value.comments === "number" &&
		["reviewing", "authored", "reviewed"].includes(String(value.relation)) &&
		["avatarUrl", "headRefName", "reviewDecision"].every((key) => value[key] === null || typeof value[key] === "string") &&
		["additions", "deletions"].every((key) => value[key] === null || typeof value[key] === "number") &&
		(value.checkState === null || ["pass", "fail", "pending"].includes(String(value.checkState)))
	);
}
function rows(value: unknown, fields: string[]): boolean {
	return Array.isArray(value) && value.every((item) => record(item) && fields.every((key) => typeof item[key] === "string"));
}
export function isDetail(value: unknown): value is PullRequestDetail {
	if (!record(value) || !isSummary(value)) return false;
	const detail = value as unknown as Record<string, unknown>;
	return (
		["body", "headRefName", "baseRefName", "mergeable"].every((key) => typeof detail[key] === "string") &&
		(detail.changedFiles === null || typeof detail.changedFiles === "number") &&
		rows(detail.threads, ["author", "body", "createdAt"]) &&
		rows(detail.reviews, ["author", "body", "state", "submittedAt"]) &&
		rows(detail.reviewers, ["login", "state"]) &&
		rows(detail.commits, ["sha", "headline", "author", "at"]) &&
		Array.isArray(detail.labels) &&
		detail.labels.every((label) => typeof label === "string") &&
		(detail.checks === null ||
			(record(detail.checks) &&
				["total", "passed", "failed", "pending"].every((key) => typeof (detail.checks as Record<string, unknown>)[key] === "number") &&
				Array.isArray(detail.checks.items) &&
				detail.checks.items.every(
					(check) =>
						record(check) &&
						typeof check.name === "string" &&
						["pass", "fail", "pending"].includes(String(check.state)) &&
						(check.url === undefined || typeof check.url === "string"),
				)))
	);
}
export function readList(): PullRequestSummary[] {
	const stored = readCache("list");
	return Array.isArray(stored) ? stored.filter(isSummary) : [];
}
export function readSeen(): Record<string, string> | null {
	const stored = readCache("seen");
	return record(stored) && Object.values(stored).every((at) => typeof at === "string") ? (stored as Record<string, string>) : null;
}
export function readDetails(): Map<string, PullRequestDetail> {
	const stored = readCache("details");
	return new Map(Array.isArray(stored) ? stored.filter(isDetail).map((pr) => [rowId(pr), pr]) : []);
}
export function cacheDetail(cache: Map<string, PullRequestDetail>, detail: PullRequestDetail): void {
	const key = rowId(detail);
	cache.delete(key);
	cache.set(key, detail);
	while (cache.size > 24) cache.delete(cache.keys().next().value!);
	writeCache("details", [...cache.values()]);
}
