import assert from "node:assert/strict";
import { test } from "node:test";
import { settleSize, type FrameSize } from "../src/settle.ts";

test("外框连着变时页面只贴头尾两次，一次性的变化当场贴，宽或高为 0 的不算", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const applied: FrameSize[] = [];
	const fit = settleSize((size) => applied.push(size), 100);

	fit.update({ width: 600, height: 400 });
	assert.deepEqual(applied, [{ width: 600, height: 400 }]);

	// 拖动：每帧一个新宽度，拖动中一次都不贴。
	for (let i = 1; i <= 30; i++) {
		t.mock.timers.tick(16);
		fit.update({ width: 600 + i * 10, height: 400 });
	}
	assert.equal(applied.length, 1);
	t.mock.timers.tick(99);
	assert.equal(applied.length, 1);
	t.mock.timers.tick(1);
	assert.deepEqual(applied.at(-1), { width: 900, height: 400 });
	assert.equal(applied.length, 2);

	// 停下以后的一次变化（展开、内容长高）不用等。
	t.mock.timers.tick(500);
	fit.update({ width: 900, height: 720 });
	assert.deepEqual(applied.at(-1), { width: 900, height: 720 });

	// 尺寸没变的通知不贴；拖了一圈回到头一下贴上的尺寸，尾上不重贴。
	t.mock.timers.tick(500);
	fit.update({ width: 900, height: 720 });
	assert.equal(applied.length, 3);
	fit.update({ width: 850, height: 720 });
	fit.update({ width: 900, height: 720 });
	fit.update({ width: 850, height: 720 });
	t.mock.timers.tick(100);
	assert.equal(applied.length, 4);

	// 面板区收起、卡片折叠：留着上一次的尺寸。
	t.mock.timers.tick(500);
	fit.update({ width: 0, height: 720 });
	fit.update({ width: 900, height: 0 });
	t.mock.timers.tick(100);
	assert.equal(applied.length, 4);

	// 卸掉后排着的尾巴不再贴。
	fit.update({ width: 500, height: 300 });
	fit.update({ width: 520, height: 300 });
	fit.dispose();
	t.mock.timers.tick(100);
	assert.deepEqual(applied.at(-1), { width: 500, height: 300 });
});
