import assert from "node:assert/strict";
import { test } from "node:test";
import { chartData, optionsOf, pieSlices, tableData, ticks } from "../src/data.ts";
import { prepareBlock } from "../src/language.ts";

test("环形饼图处理整圆、零值、负数和总和溢出，面积图接受多系列负值", () => {
	const whole = pieSlices([3], 96);
	assert.equal(whole.total, 3);
	assert.equal(whole.paths[0]!.split(" A ").length - 1, 4);
	const mixed = pieSlices([0, -2, 3, 5], 96);
	assert.deepEqual(mixed.values, [0, 0, 3, 5]);
	assert.equal(mixed.total, 8);
	assert.equal(mixed.paths[0], "");
	assert.equal(pieSlices([0, 0], 96).total, 0);
	assert.throws(() => pieSlices([1e308, 1e308], 96));
	for (const kind of ["area", "pie"]) assert.equal(prepareBlock(`<Chart kind="${kind}" data={[{x:"a",n:-2,m:3},{x:"b",n:4,m:6}]}/>`, true).ok, true);
});

test("表格的数组行、对象行、数值对齐与空状态", () => {
	assert.deepEqual(
		tableData({
			columns: ["city", "pieces"],
			rows: [
				["Kyoto", 83],
				["Tainan", 100],
			],
		}),
		{
			header: ["city", "pieces"],
			cells: [
				["Kyoto", 83],
				["Tainan", 100],
			],
			numeric: [false, true],
		},
	);
	assert.deepEqual(tableData({ data: [{ city: "Kyoto", pieces: 83 }] }).cells, [["Kyoto", 83]]);
	assert.deepEqual(tableData({ data: [] }), { header: [], cells: [], numeric: [] });
	assert.deepEqual(tableData({ columns: ["pieces"], rows: [] }).cells, []);
	for (const props of [
		{},
		{ rows: [], data: [] },
		{ columns: ["a"], rows: [[1, 2]] },
		{ columns: ["a"], data: [{ a: 1, b: 2 }] },
		{ data: [{ a: 1 }, { b: 2 }] },
		{ data: [{ a: {} }] },
		{ columns: ["a", "a"], rows: [] },
	])
		assert.throws(() => tableData(props));
});

test("图表推断标签和系列，支持负数、多系列与单点", () => {
	const data = [
		{ month: "Sep", output: -17, target: 23 },
		{ month: "Oct", output: 29, target: 31 },
	];
	const result = chartData(data, undefined, undefined);
	assert.deepEqual(result.labels, ["Sep", "Oct"]);
	assert.deepEqual(result.keys, ["output", "target"]);
	assert.deepEqual(result.values, [
		[-17, 23],
		[29, 31],
	]);
	assert.deepEqual(chartData([{ n: "-3.5e2" }], undefined, "n").values, [[-350]]);
	assert.deepEqual(chartData([], undefined, undefined).values, []);
	assert.ok(ticks(0, 0).length > 1);
	assert.ok(ticks(-17, 31)[0]! <= -17);
	assert.ok(ticks(-17, 31).at(-1)! >= 31);
	for (const amount of [0, -1, 1e-8, 1e20]) assert.ok(ticks(Math.min(0, amount), Math.max(0, amount)).every(Number.isFinite));
});

test("坏图表值、缺失系列和超限数据不假装画成功", () => {
	for (const [data, x, y] of [
		[[{ label: "a", n: "" }], "label", "n"],
		[[{ n: 3 }, { n: "bad" }], undefined, "n"],
		[[{ label: "a", n: 3 }, { n: 5 }], "label", "n"],
		[[{ n: 3 }], undefined, ["missing"]],
		[[3], undefined, "n"],
		[[{ n: 3 }], undefined, ["n", "n"]],
		[[{ n: Infinity }], undefined, "n"],
		[[{ n: Number.MAX_VALUE }], undefined, "n"],
	] as [unknown, unknown, unknown][])
		assert.throws(() => chartData(data, x, y));
	assert.throws(() =>
		chartData(
			Array.from({ length: 501 }, () => ({ n: 3 })),
			undefined,
			"n",
		),
	);
	assert.equal(prepareBlock('<Chart kind="bar" data={[{x:"A",n:3},{x:"B",n:-2}]}/>', true).ok, true);
	assert.equal(prepareBlock('<Chart kind="line" data={[]}/>', true).ok, true);
	assert.equal(prepareBlock('<Chart data={[{x:"A",n:"bad"}]} y="n"/>', true).ok, false);
});

test("选项保留数字原值，拒绝重名、未知键和非标量", () => {
	assert.deepEqual(optionsOf([{ label: "Two", value: 2 }, "Three"]), [
		{ value: "2", label: "Two", original: 2 },
		{ value: "Three", label: "Three", original: "Three" },
	]);
	for (const value of [[], [""], [2, "2"], [{ label: "A", value: "a", hidden: true }], [{ value: {} }], [null]]) assert.throws(() => optionsOf(value));
});
