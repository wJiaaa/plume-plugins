import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, parseExpression, references } from "../src/expression.ts";

function value(source: string, scope: Record<string, unknown> = {}) {
	const parsed = parseExpression(source);
	assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
	return evaluate(parsed.expression, scope);
}

test("表达式沿用算术优先级、严格比较、短路和字段访问", () => {
	assert.equal(value("budget * 12 + 3", { budget: 4 }), 51);
	assert.equal(value('"0" == 0'), false);
	assert.equal(value("2 === 2 && !false"), true);
	assert.equal(value('city == "Kyoto" ? 17 : 9', { city: "Kyoto" }), 17);
	assert.equal(value("missing ?? 8"), 8);
	assert.equal(value("false && missing"), false);
	assert.equal(value("true || missing"), true);
	assert.equal(value("[3, 8][-1]"), 8);
	assert.equal(value("{x: [17, 23]}.x[1]"), 23);
	assert.equal(value('"Tea".length'), 3);
	assert.equal(value('"a\\nb"'), "a\nb");
});

test("白名单函数与数字格式，不执行模型函数", () => {
	assert.equal(value("round(1.235, 2)"), 1.24);
	assert.equal(value("fixed(8.3, 2)"), "8.30");
	assert.equal(value("sum([2,3,8])"), 13);
	assert.equal(value("avg(2,4,9)"), 5);
	assert.equal(value("min([3,7]) + max(3,7)"), 10);
	assert.equal(value('join(["tea", "notes"], " / ")'), "tea / notes");
	assert.equal(value("floor(1.7) + ceil(1.2) + abs(-3) + len([8,9])"), 8);
	assert.equal(typeof value("fmt(1873.2, 1)"), "string");
	assert.equal(value("evil(1)"), undefined);
});

test("赋值、函数、浏览器入口和原型访问不会运行", () => {
	for (const source of ["x = 3", "() => 1", "new Date()", "this.constructor", "x.constructor", "x.__proto__", '{"__proto__": {x:1}}', "x.push(3)", "1e999"])
		assert.equal(parseExpression(source).ok, false, source);
	assert.equal(value('x["constructor"]', { x: {} }), undefined);
	assert.equal(value('x["__proto__"]', { x: {} }), undefined);
	assert.equal(value("x.toString", { x: {} }), undefined);
	assert.equal(parseExpression("(".repeat(100) + "1" + ")".repeat(100)).ok, false);
	assert.equal(parseExpression("1".repeat(4001)).ok, false);
	const parsed = parseExpression("budget * rate + sum(extras)");
	assert.ok(parsed.ok);
	assert.deepEqual([...references(parsed.expression).names], ["budget", "rate", "extras"]);
	assert.deepEqual([...references(parsed.expression).calls], ["sum"]);
});
