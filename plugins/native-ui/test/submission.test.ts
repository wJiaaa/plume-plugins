import assert from "node:assert/strict";
import { test } from "node:test";
import { createSubmission } from "../src/submission.ts";

test("发送在事件调用栈里同步发生，待处理和成功提交都防重复", async () => {
	const submission = createSubmission();
	let calls = 0;
	let done: (() => void) | undefined;
	const pending = new Promise<void>((resolve) => {
		done = resolve;
	});
	const first = submission.start("message with values", () => {
		calls++;
		return pending;
	});
	assert.equal(calls, 1);
	assert.equal(submission.busy(), true);
	assert.equal(
		submission.start("another message", async () => {
			calls++;
		}),
		undefined,
	);
	assert.equal(calls, 1);
	done!();
	await first;
	assert.equal(submission.busy(), false);
	assert.equal(submission.sent("message with values"), true);
	assert.equal(
		submission.start("message with values", async () => {
			calls++;
		}),
		undefined,
	);
	await submission.start("changed values", async () => {
		calls++;
	});
	assert.equal(calls, 2);
});

test("异步失败和宿主同步拒绝都解锁，同值可以重试", async () => {
	const submission = createSubmission();
	await assert.rejects(
		submission.start("payload", () => Promise.reject(new Error("host refused")))!,
		/host refused/,
	);
	assert.equal(submission.busy(), false);
	assert.equal(submission.sent("payload"), false);
	await assert.rejects(
		submission.start("payload", () => {
			throw new Error("stale registration");
		})!,
		/stale registration/,
	);
	assert.equal(submission.busy(), false);
	await submission.start("payload", async () => {});
	assert.equal(submission.sent("payload"), true);
});
